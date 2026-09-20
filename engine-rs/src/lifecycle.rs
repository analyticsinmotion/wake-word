//! The engine state machine: config, prepare, capture, pause, resume, stop.
//!
//! Everything here is driven by events and holds no threads of its own, so the
//! cases that are hard to reach in a running process are reachable in a test:
//! a `pause` or a `stop` that lands while the microphone is still opening, a
//! `pause` that lands before the microphone has ever opened, and an event that
//! arrives after shutdown has started.
//!
//! Three flags carry the whole thing:
//!
//! - `stopping`: shutdown has begun, so every later command and event is
//!   ignored. `RELEASED` is said once.
//! - `capture_wanted`: whether the microphone should be open. A `pause` that
//!   arrives before the first open clears it, and the microphone is then not
//!   opened until a `resume` arrives.
//! - `CaptureSession::wanted`: the same question for one open in flight. A
//!   `pause` or `stop` during an open has already been acknowledged, so the
//!   microphone that open eventually produces is closed instead of being kept.
//!
//! Loading the keyword spotter, opening the microphone, and running it happen
//! elsewhere, behind the [`Spawner`] and [`CaptureDevice`] traits
//! (`crate::capture` implements both, over `crate::spotter` and decibri). Each
//! open carries an id, and everything a running microphone reports comes back
//! tagged with it, so a line from a microphone that has since been closed, a
//! detection included, is dropped here rather than acted on.

use std::path::PathBuf;
use std::time::Instant;

use crate::assets;
use crate::config::{AudioDevice, Config, PhraseMap};
use crate::mic_errors::{mic_error_message, CaptureError};
use crate::protocol::{parse_control_line, ControlLine, Reporter, Sink};

/// A monotonic millisecond clock, so a test can pin the timing lines.
pub trait Clock: Send {
    fn now_ms(&self) -> u64;
}

/// The real clock, counting from the moment the engine started.
pub struct MonotonicClock {
    origin: Instant,
}

impl MonotonicClock {
    pub fn new() -> MonotonicClock {
        MonotonicClock {
            origin: Instant::now(),
        }
    }
}

impl Default for MonotonicClock {
    fn default() -> MonotonicClock {
        MonotonicClock::new()
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// An open microphone.
pub trait CaptureDevice: Send {
    /// Close the microphone. Called at most once, and called even for a
    /// microphone that arrived after the pause or stop that made it unwanted.
    /// Once this returns, nothing from this microphone reaches the downstream
    /// consumer.
    fn close(&mut self);
}

/// Everything needed to open one microphone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenRequest {
    /// Tags every [`Event::Capture`] this microphone produces.
    pub id: u64,
    /// The resolved `wakeWord.audioDevice` setting.
    pub device: AudioDevice,
    /// The Silero voice activity model file.
    pub vad_model: PathBuf,
    /// The ONNX Runtime library, when the config names one. Otherwise decibri
    /// searches for it (see `crate::assets`).
    pub ort_library: Option<PathBuf>,
    /// Whether the capture loop should report debug lines.
    pub debug: bool,
}

/// Everything needed to build the keyword spotter.
#[derive(Debug, Clone, PartialEq)]
pub struct PrepareRequest {
    /// The keyword lines from the config, as sent.
    pub keyword_lines: Vec<String>,
    /// Decoded keyword to configured phrase, from the config.
    pub phrase_map: PhraseMap,
    /// The clamped trigger threshold, passed as the spotter-wide threshold.
    pub threshold: f64,
    /// Where the extension unpacked the keyword spotting model.
    pub model_dir: String,
}

/// What preparation has to say while it runs. Written only in debug mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareProgress {
    /// A diagnostic line.
    Debug(String),
    /// One phase finished, and how long it took.
    Timing {
        phase: &'static str,
        elapsed_ms: u64,
    },
}

/// Preparation finished and the keyword spotter is loaded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prepared {
    /// The phrases the spotter reports, for the debug line that follows the
    /// first `READY`.
    pub listening_for: Vec<String>,
}

/// Why preparation failed. Fatal; the wording is what the extension logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareError {
    /// The transducer could not be loaded, or a keyword line is one it cannot
    /// take.
    ModelLoad(String),
}

impl PrepareError {
    /// The text of the `ERROR:` line.
    pub fn message(&self) -> String {
        match self {
            PrepareError::ModelLoad(detail) => format!("Failed to load KWS model: {detail}"),
        }
    }
}

/// Starts the slow work the state machine waits on, and holds the keyword
/// spotter that work produces. `spawn_prepare` and `spawn_open` return at once
/// and the result arrives later as an [`Event`].
pub trait Spawner: Send {
    /// Load the keyword spotter.
    fn spawn_prepare(&mut self, request: PrepareRequest);
    /// Open a microphone and, once it is open, run it.
    fn spawn_open(&mut self, request: OpenRequest);
    /// Give the keyword spotter a new stream. Called once a pause has closed
    /// the microphone, so nothing heard before the pause can complete a phrase
    /// after it.
    fn reset_spotter(&mut self);
    /// Shutdown has started: drop the keyword spotter, and abandon preparation
    /// if it is still running.
    fn release(&mut self);
}

/// Something a running microphone has to say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureReport {
    /// A diagnostic line, written only in debug mode.
    Debug(String),
    /// The keyword spotter heard this configured phrase.
    Detected(String),
    /// The stream failed while running: the device went away, the driver
    /// failed, or the voice activity detector could not score a chunk.
    Failed(CaptureError),
}

/// Everything the state machine reacts to.
pub enum Event {
    /// One complete line read from stdin.
    Line(String),
    /// stdin reached EOF: the parent closed the pipe.
    StdinClosed,
    /// SIGTERM, SIGINT, or the Windows console equivalent.
    Signal(&'static str),
    /// Preparation has something to say before it finishes.
    Preparing(PrepareProgress),
    /// Preparation finished, with the spotter loaded or the reason it is not.
    Prepared(Result<Prepared, PrepareError>),
    /// An open finished, with the microphone or the reason it failed.
    CaptureOpened(Result<Box<dyn CaptureDevice>, CaptureError>),
    /// A report from the microphone opened with this id.
    Capture { id: u64, report: CaptureReport },
}

/// What the state machine writes to and calls out to. Held apart from the
/// state itself so a [`CaptureSession`] can report without owning any of it.
pub struct Ctx {
    out: Reporter,
    spawner: Box<dyn Spawner>,
    clock: Box<dyn Clock>,
    /// A fatal error raised from inside a session call, drained by the
    /// lifecycle as soon as that call returns.
    fatal: Option<String>,
}

impl Ctx {
    /// Report a fatal error. The first one wins.
    fn fail(&mut self, message: String) {
        if self.fatal.is_none() {
            self.fatal = Some(message);
        }
    }
}

/// How every microphone in this session is opened.
struct CaptureOptions {
    device: AudioDevice,
    vad_model: PathBuf,
    ort_library: Option<PathBuf>,
    debug: bool,
    /// The phrases the spotter reports, for the debug line after the first
    /// `READY`.
    listening_for: Vec<String>,
}

/// The microphone's lifecycle: open, pause, resume, stop.
///
/// The engine process outlives a pause: `pause()` closes the microphone and says `PAUSED`,
/// `resume()` opens a new one and says `READY`, and `stop()` closes it for good
/// and says `RELEASED`.
pub struct CaptureSession {
    options: CaptureOptions,
    device: Option<Box<dyn CaptureDevice>>,
    /// An open is in flight.
    opening: bool,
    /// Capture is wanted: `start()` and `resume()` set it, `pause()` and
    /// `stop()` clear it. An open that completes when it is clear closes the
    /// microphone it produced.
    wanted: bool,
    stopped: bool,
    /// The id given to the most recent open.
    open_id: u64,
    /// The id of the microphone currently held, whose reports are acted on.
    current: Option<u64>,
    open_label: &'static str,
    open_began: u64,
}

/// The timing phase of the open that starts the engine.
const START_LABEL: &str = "mic-open";
/// The timing phase of an open that follows a pause.
const RESUME_LABEL: &str = "resume-mic-open";

impl CaptureSession {
    fn new(options: CaptureOptions) -> CaptureSession {
        CaptureSession {
            options,
            device: None,
            opening: false,
            wanted: false,
            stopped: false,
            open_id: 0,
            current: None,
            open_label: START_LABEL,
            open_began: 0,
        }
    }

    /// Open the microphone and say `READY`.
    fn start(&mut self, ctx: &mut Ctx) {
        self.capture(ctx, START_LABEL);
    }

    /// Reopen the microphone after a pause and say `READY`.
    fn resume(&mut self, ctx: &mut Ctx) {
        self.capture(ctx, RESUME_LABEL);
    }

    /// Close the microphone, give the spotter a new stream, and say `PAUSED`.
    ///
    /// The close waits for the microphone's capture thread, so nothing is
    /// feeding the spotter by the time its stream is replaced, and nothing
    /// heard before the pause can complete a phrase after it.
    ///
    /// Says `PAUSED` even when nothing was open: the acknowledgement is what
    /// the extension waits for before it hands the microphone to an assistant,
    /// and it force-kills the child if it does not arrive within 500 ms.
    fn pause(&mut self, ctx: &mut Ctx) {
        if self.stopped {
            return;
        }
        self.wanted = false;
        self.close();
        ctx.spawner.reset_spotter();
        ctx.out.paused();
    }

    /// Close the microphone for good and say `RELEASED`.
    fn stop(&mut self, ctx: &mut Ctx) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        self.wanted = false;
        self.close();
        ctx.out.released();
    }

    fn capture(&mut self, ctx: &mut Ctx, label: &'static str) {
        if self.stopped {
            return;
        }
        self.wanted = true;
        // Already open, or an open is in flight that will say READY itself.
        if self.device.is_some() || self.opening {
            return;
        }
        self.opening = true;
        self.open_id += 1;
        self.open_label = label;
        self.open_began = ctx.clock.now_ms();
        ctx.spawner.spawn_open(OpenRequest {
            id: self.open_id,
            device: self.options.device.clone(),
            vad_model: self.options.vad_model.clone(),
            ort_library: self.options.ort_library.clone(),
            debug: self.options.debug,
        });
    }

    /// An open finished.
    fn opened(&mut self, ctx: &mut Ctx, result: Result<Box<dyn CaptureDevice>, CaptureError>) {
        if !self.opening {
            // No open was in flight, so this microphone belongs to nothing.
            // Close it rather than leak it.
            if let Ok(mut device) = result {
                device.close();
            }
            return;
        }
        self.opening = false;

        match result {
            Err(error) => {
                // A pause or stop during the open has been acknowledged and
                // the next resume tries again; the failure changes nothing now.
                if self.wanted && !self.stopped {
                    ctx.fail(mic_error_message(
                        &error,
                        "Failed to open microphone",
                        &self.options.device,
                    ));
                }
            }
            Ok(mut device) => {
                if !self.wanted || self.stopped {
                    // The pause or stop that made this microphone unwanted was
                    // answered while the open was still in flight. Closing it
                    // here is what keeps it from being left open on a process
                    // that is on its way out.
                    device.close();
                    ctx.out
                        .debug("closed a microphone that arrived after a pause or a stop");
                    return;
                }
                self.device = Some(device);
                self.current = Some(self.open_id);
                let elapsed = ctx.clock.now_ms().saturating_sub(self.open_began);
                ctx.out.timing(self.open_label, elapsed);
                ctx.out.ready();
                // Said once, for the open that started the engine, as the Node
                // engine does; a resume only says READY.
                if self.open_label == START_LABEL {
                    ctx.out.debug(&format!(
                        "mic open, VAD-gated, listening for: {}",
                        self.options.listening_for.join(", ")
                    ));
                }
            }
        }
    }

    /// A running microphone reported something. Only the microphone currently
    /// held is listened to: a report from one that has been closed, or that
    /// was closed on arrival, is dropped.
    fn report(&mut self, ctx: &mut Ctx, id: u64, report: CaptureReport) {
        if self.current != Some(id) {
            return;
        }
        match report {
            CaptureReport::Debug(line) => ctx.out.debug(&line),
            CaptureReport::Detected(phrase) => ctx.out.detected(&phrase),
            CaptureReport::Failed(error) => {
                // The stream has already ended; closing lets its capture
                // thread finish before the process exits.
                self.close();
                ctx.fail(mic_error_message(
                    &error,
                    "Microphone error",
                    &self.options.device,
                ));
            }
        }
    }

    fn close(&mut self) {
        // Cleared before the close: anything this microphone reports from here
        // on, including during the close itself, belongs to a closed session.
        self.current = None;
        if let Some(mut device) = self.device.take() {
            device.close();
        }
    }
}

/// The engine's overall state.
pub struct Lifecycle {
    ctx: Ctx,
    config: Option<Config>,
    session: Option<CaptureSession>,
    /// Shutdown has started; every later command and event is ignored.
    stopping: bool,
    /// Whether capture should be open once the engine is ready. A pause that
    /// arrives while preparation is still running clears it, so the
    /// microphone is not opened until a resume. The extension only pauses an
    /// engine that has said READY, so this is defensive.
    capture_wanted: bool,
    /// Preparation has been started and has not reported back.
    preparing: bool,
    exit_code: Option<i32>,
}

impl Lifecycle {
    pub fn new(sink: Box<dyn Sink>, spawner: Box<dyn Spawner>, clock: Box<dyn Clock>) -> Lifecycle {
        Lifecycle {
            ctx: Ctx {
                out: Reporter::new(sink),
                spawner,
                clock,
                fatal: None,
            },
            config: None,
            session: None,
            stopping: false,
            capture_wanted: true,
            preparing: false,
            exit_code: None,
        }
    }

    /// The code to exit with, once one has been decided. `Some` means the
    /// event loop is finished.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    /// True while an open is in flight. The event loop uses this to wait a
    /// moment for the microphone on the way out, so it can be closed rather
    /// than left to the operating system.
    pub fn open_in_flight(&self) -> bool {
        self.session.as_ref().is_some_and(|session| session.opening)
    }

    /// True while preparation is running. The event loop uses this to let a
    /// model load finish on the way out rather than exit underneath it.
    pub fn prepare_in_flight(&self) -> bool {
        self.preparing
    }

    /// True while a microphone is open and held.
    #[cfg(test)]
    fn holds_device(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| session.device.is_some())
    }

    /// The engine is on its way out, either through a shutdown or a fatal
    /// error. Every command and every slow step that reports back after this
    /// is ignored, so nothing is opened on a process that is already leaving
    /// and nothing is said after the last line.
    fn finished(&self) -> bool {
        self.stopping || self.exit_code.is_some()
    }

    pub fn handle(&mut self, event: Event) {
        match event {
            Event::Line(line) => self.on_line(&line),
            Event::StdinClosed => {
                // stdin closed without a stop command: shut down cleanly.
                self.ctx.out.debug("stdin closed");
                self.shutdown();
            }
            Event::Signal(name) => {
                self.ctx.out.debug(&format!("received {name}"));
                self.shutdown();
            }
            Event::Preparing(progress) => self.on_preparing(progress),
            Event::Prepared(result) => self.on_prepared(result),
            Event::CaptureOpened(result) => self.on_opened(result),
            Event::Capture { id, report } => self.on_capture(id, report),
        }
        self.settle();
    }

    fn on_line(&mut self, line: &str) {
        if self.exit_code.is_some() {
            return;
        }
        match parse_control_line(line) {
            ControlLine::Stop => self.shutdown(),
            ControlLine::Pause => self.pause_capture(),
            ControlLine::Resume => self.resume_capture(),
            ControlLine::Empty => {}
            ControlLine::Invalid(message) => self.fatal(&message),
            ControlLine::Config(config) => self.on_config(config),
        }
    }

    fn on_config(&mut self, config: Config) {
        if self.finished() {
            return;
        }
        if self.config.is_some() {
            // The extension sends exactly one config line per child, so a
            // second one cannot arrive from the host. Acting on it would load
            // a second model and open a second microphone beside the first, so
            // it is ignored.
            self.ctx
                .out
                .debug("ignoring a second config line: the engine is already configured");
            return;
        }

        self.ctx.out.set_debug(config.debug_mode);
        self.ctx.out.debug(&format!(
            "wake-word-engine starting, modelDir={}",
            config.model_dir
        ));

        // The extension tokenises the phrases and sends the keyword lines and
        // the phrase map; the engine cannot listen without either.
        let Some(keyword_lines) = config.keyword_lines.clone() else {
            self.fatal("Startup error: the config has no keywordLines, and the engine does not tokenise phrases itself");
            return;
        };
        if keyword_lines.is_empty() {
            self.fatal("No valid phrases to detect");
            return;
        }
        if config.phrase_map.is_empty() {
            self.fatal(
                "Startup error: the config has no phraseMap, so no detection could be reported",
            );
            return;
        }
        let request = PrepareRequest {
            keyword_lines,
            phrase_map: config.phrase_map.clone(),
            threshold: config.threshold,
            model_dir: config.model_dir.clone(),
        };
        self.config = Some(config);
        self.preparing = true;
        self.ctx.spawner.spawn_prepare(request);
    }

    fn on_preparing(&mut self, progress: PrepareProgress) {
        // Nothing follows the last line: not RELEASED, and not ERROR.
        if self.finished() {
            return;
        }
        match progress {
            PrepareProgress::Debug(line) => self.ctx.out.debug(&line),
            PrepareProgress::Timing { phase, elapsed_ms } => self.ctx.out.timing(phase, elapsed_ms),
        }
    }

    fn on_prepared(&mut self, result: Result<Prepared, PrepareError>) {
        self.preparing = false;
        if self.session.is_some() {
            return;
        }
        let prepared = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                // A stop during preparation has already said RELEASED and the
                // process is on its way out; an error line after it would only
                // confuse the extension's reader.
                if !self.finished() {
                    self.fatal(&error.message());
                }
                return;
            }
        };

        // A stop during preparation has already said RELEASED, and a fatal
        // error has already said ERROR. Opening the microphone now would only
        // hold that exit up. The spotter that was just loaded is dropped.
        if self.finished() {
            self.ctx.spawner.release();
            return;
        }

        let Some(config) = self.config.as_ref() else {
            return;
        };

        let options = CaptureOptions {
            device: config.audio_device.clone(),
            vad_model: assets::vad_model_path(config.vad_model_path.as_deref()),
            ort_library: config.ort_library_path.as_ref().map(PathBuf::from),
            debug: config.debug_mode,
            listening_for: prepared.listening_for,
        };
        let ort = assets::ort_location(config.ort_library_path.as_deref());
        let device = config.audio_device.describe();
        self.ctx.out.debug(&format!(
            "voice activity model={}, ONNX Runtime={}",
            options.vad_model.display(),
            ort.describe()
        ));
        self.session = Some(CaptureSession::new(options));

        if !self.capture_wanted {
            self.ctx
                .out
                .debug("models loaded; paused before the microphone opened, waiting for resume");
            return;
        }

        let opening = match device {
            Some(described) => format!("opening microphone (device: {described})..."),
            None => "opening microphone...".to_string(),
        };
        self.ctx.out.debug(&opening);
        if let Some(session) = self.session.as_mut() {
            session.start(&mut self.ctx);
        }
    }

    fn on_opened(&mut self, result: Result<Box<dyn CaptureDevice>, CaptureError>) {
        match self.session.as_mut() {
            Some(session) => session.opened(&mut self.ctx, result),
            // Nothing is holding this microphone: preparation never finished,
            // or the engine was torn down. Close it rather than leak it.
            None => {
                if let Ok(mut device) = result {
                    device.close();
                }
            }
        }
    }

    fn on_capture(&mut self, id: u64, report: CaptureReport) {
        if self.finished() {
            return;
        }
        if let Some(session) = self.session.as_mut() {
            session.report(&mut self.ctx, id, report);
        }
    }

    /// `pause`: close the microphone and keep everything else loaded.
    fn pause_capture(&mut self) {
        if self.finished() {
            return;
        }
        self.capture_wanted = false;
        match self.session.as_mut() {
            Some(session) => session.pause(&mut self.ctx),
            // Still preparing, so nothing is open. on_prepared() leaves the
            // microphone closed.
            None => self.ctx.out.paused(),
        }
    }

    /// `resume`: reopen the microphone.
    fn resume_capture(&mut self) {
        if self.finished() {
            return;
        }
        self.capture_wanted = true;
        // Still preparing: on_prepared() opens the microphone once it is
        // ready.
        if let Some(session) = self.session.as_mut() {
            session.resume(&mut self.ctx);
        }
    }

    /// `stop`, stdin EOF, SIGTERM, or SIGINT.
    ///
    /// The microphone is closed and said to be closed before anything else:
    /// the extension waits for `RELEASED` before it kills the process, rather
    /// than killing it and trusting the operating system to have reclaimed
    /// the device by then. The keyword spotter is freed after that, so freeing
    /// it never holds the acknowledgement up.
    fn shutdown(&mut self) {
        if self.finished() {
            return;
        }
        self.stopping = true;
        self.capture_wanted = false;
        match self.session.as_mut() {
            Some(session) => session.stop(&mut self.ctx),
            None => self.ctx.out.released(),
        }
        self.ctx.spawner.release();
        self.exit_code = Some(0);
    }

    /// Say `ERROR:` and leave with exit code 1.
    ///
    /// The line goes first. The microphone is then closed and the spotter
    /// dropped, so no capture thread and no model load is still running native
    /// code when the process exits underneath it.
    fn fatal(&mut self, message: &str) {
        if self.exit_code.is_some() {
            return;
        }
        self.ctx.out.error(message);
        if let Some(session) = self.session.as_mut() {
            session.close();
        }
        self.ctx.spawner.release();
        self.exit_code = Some(1);
    }

    /// Raise a fatal error a session call left behind.
    fn settle(&mut self) {
        if let Some(message) = self.ctx.fatal.take() {
            self.fatal(&message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RecordingSink;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct SpawnLog {
        prepares: Vec<PrepareRequest>,
        opens: Vec<OpenRequest>,
        /// Everything asked of the spawner and every microphone close, in
        /// order, so a test can pin what happens before what.
        order: Vec<String>,
    }

    #[derive(Clone, Default)]
    struct FakeSpawner {
        log: Arc<Mutex<SpawnLog>>,
    }

    impl Spawner for FakeSpawner {
        fn spawn_prepare(&mut self, request: PrepareRequest) {
            let mut log = self.log.lock().expect("spawn log");
            log.prepares.push(request);
            log.order.push("prepare".to_string());
        }

        fn spawn_open(&mut self, request: OpenRequest) {
            let mut log = self.log.lock().expect("spawn log");
            log.order.push(format!("open {}", request.id));
            log.opens.push(request);
        }

        fn reset_spotter(&mut self) {
            let mut log = self.log.lock().expect("spawn log");
            log.order.push("reset spotter".to_string());
        }

        fn release(&mut self) {
            let mut log = self.log.lock().expect("spawn log");
            log.order.push("release".to_string());
        }
    }

    #[derive(Clone, Default)]
    struct FakeClock {
        ms: Arc<Mutex<u64>>,
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            *self.ms.lock().expect("clock")
        }
    }

    #[derive(Clone, Default)]
    struct CloseLog {
        closed: Arc<Mutex<Vec<u32>>>,
    }

    /// A microphone whose opens each test completes by hand, the way
    /// `tests/engine/capture.test.js` drives the Node `CaptureSession`.
    struct FakeCapture {
        id: u32,
        log: CloseLog,
        spawned: Arc<Mutex<SpawnLog>>,
    }

    impl CaptureDevice for FakeCapture {
        fn close(&mut self) {
            self.log.closed.lock().expect("close log").push(self.id);
            self.spawned
                .lock()
                .expect("spawn log")
                .order
                .push(format!("close {}", self.id));
        }
    }

    const CONFIG: &str = r#"{"phrases":[{"phrase":"hey claude","label":"Claude"}],"threshold":0.05,"modelDir":"/models","debugMode":false,"audioDevice":"","keywordLines":["▁HE Y ▁C LA U DE :3.0 #0.05"],"phraseMap":{"HEY CLAUDE":"hey claude"}}"#;
    const DEBUG_CONFIG: &str = r#"{"modelDir":"/models","debugMode":true,"keywordLines":["▁HE Y ▁C LA U DE :3.0 #0.05"],"phraseMap":{"HEY CLAUDE":"hey claude"}}"#;

    /// A config line with one keyword line and its phrase map entry, plus
    /// `fields`, which are JSON members without the braces.
    fn config_with(fields: &str) -> String {
        format!(
            r#"{{"keywordLines":["▁HE Y ▁C LA U DE :3.0 #0.05"],"phraseMap":{{"HEY CLAUDE":"hey claude"}},{fields}}}"#
        )
    }

    struct Harness {
        lifecycle: Lifecycle,
        sink: RecordingSink,
        spawner: FakeSpawner,
        clock: FakeClock,
        closes: CloseLog,
        devices: u32,
    }

    impl Harness {
        fn new() -> Harness {
            let sink = RecordingSink::new();
            let spawner = FakeSpawner::default();
            let clock = FakeClock::default();
            let lifecycle = Lifecycle::new(
                Box::new(sink.clone()),
                Box::new(spawner.clone()),
                Box::new(clock.clone()),
            );
            Harness {
                lifecycle,
                sink,
                spawner,
                clock,
                closes: CloseLog::default(),
                devices: 0,
            }
        }

        fn sent(&self) -> Vec<String> {
            self.sink.lines()
        }

        /// The protocol lines alone, without the debug lines.
        fn protocol(&self) -> Vec<String> {
            self.sent()
                .into_iter()
                .filter(|line| !line.starts_with("DEBUG:"))
                .collect()
        }

        fn prepares(&self) -> usize {
            self.spawner.log.lock().expect("spawn log").prepares.len()
        }

        fn prepare_requests(&self) -> Vec<PrepareRequest> {
            self.spawner.log.lock().expect("spawn log").prepares.clone()
        }

        /// What the spawner was asked to do and which microphones were
        /// closed, in order.
        fn order(&self) -> Vec<String> {
            self.spawner.log.lock().expect("spawn log").order.clone()
        }

        fn releases(&self) -> usize {
            self.order()
                .iter()
                .filter(|step| *step == "release")
                .count()
        }

        fn opens(&self) -> usize {
            self.spawner.log.lock().expect("spawn log").opens.len()
        }

        fn requests(&self) -> Vec<OpenRequest> {
            self.spawner.log.lock().expect("spawn log").opens.clone()
        }

        /// The id the most recent open was given.
        fn last_open_id(&self) -> u64 {
            self.requests().last().expect("an open was requested").id
        }

        fn closed(&self) -> Vec<u32> {
            self.closes.closed.lock().expect("close log").clone()
        }

        fn advance(&mut self, ms: u64) {
            *self.clock.ms.lock().expect("clock") += ms;
        }

        fn line(&mut self, line: &str) {
            self.lifecycle.handle(Event::Line(line.to_string()));
        }

        fn complete_prepare(&mut self) {
            self.lifecycle.handle(Event::Prepared(Ok(Prepared {
                listening_for: vec!["hey claude".to_string(), "open chat".to_string()],
            })));
        }

        fn fail_prepare(&mut self, error: PrepareError) {
            self.lifecycle.handle(Event::Prepared(Err(error)));
        }

        fn preparing(&mut self, progress: PrepareProgress) {
            self.lifecycle.handle(Event::Preparing(progress));
        }

        /// Complete the open in flight after `elapsed` milliseconds and return
        /// the identifier of the microphone it produced.
        fn complete_open(&mut self, elapsed: u64) -> u32 {
            self.advance(elapsed);
            self.devices += 1;
            let device = FakeCapture {
                id: self.devices,
                log: self.closes.clone(),
                spawned: Arc::clone(&self.spawner.log),
            };
            self.lifecycle
                .handle(Event::CaptureOpened(Ok(Box::new(device))));
            self.devices
        }

        fn fail_open(&mut self, message: &str) {
            self.lifecycle
                .handle(Event::CaptureOpened(Err(CaptureError::uncoded(message))));
        }

        fn fail_open_with(&mut self, code: &'static str, message: &str) {
            self.lifecycle
                .handle(Event::CaptureOpened(Err(CaptureError {
                    code: Some(code),
                    message: message.to_string(),
                })));
        }

        fn report(&mut self, id: u64, report: CaptureReport) {
            self.lifecycle.handle(Event::Capture { id, report });
        }

        /// Send the config line and finish preparation.
        fn prepared(&mut self) {
            self.line(CONFIG);
            self.complete_prepare();
        }

        /// Reach the listening state: config, preparation, and the first open.
        fn listening(&mut self) -> u32 {
            self.prepared();
            self.complete_open(0)
        }
    }

    #[test]
    fn starts_and_says_ready_once_the_device_is_open() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        assert_eq!(harness.prepares(), 1);
        assert_eq!(harness.opens(), 0);
        assert!(harness.sent().is_empty());

        harness.complete_prepare();
        assert_eq!(harness.opens(), 1);
        assert!(harness.sent().is_empty(), "READY waits for the device");

        harness.complete_open(0);
        assert_eq!(harness.sent(), ["READY"]);
        assert!(harness.lifecycle.exit_code().is_none());
    }

    #[test]
    fn pauses_and_resumes_on_one_engine() {
        let mut harness = Harness::new();
        let first = harness.listening();

        harness.line("pause");
        assert_eq!(harness.sent(), ["READY", "PAUSED"]);
        assert_eq!(harness.closed(), [first]);

        harness.line("resume");
        assert_eq!(harness.opens(), 2);
        let second = harness.complete_open(0);
        assert_eq!(harness.sent(), ["READY", "PAUSED", "READY"]);
        assert_eq!(harness.closed(), [first]);
        assert_ne!(first, second);
    }

    #[test]
    fn survives_repeated_pause_and_resume_cycles() {
        let mut harness = Harness::new();
        harness.listening();
        for _ in 0..3 {
            harness.line("pause");
            harness.line("resume");
            harness.complete_open(0);
        }
        assert_eq!(
            harness.sent(),
            ["READY", "PAUSED", "READY", "PAUSED", "READY", "PAUSED", "READY"]
        );
        assert_eq!(harness.closed(), [1, 2, 3]);
        assert_eq!(harness.opens(), 4);
    }

    #[test]
    fn does_not_open_twice_or_say_ready_twice_when_asked_again() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("resume");
        assert_eq!(harness.opens(), 1);
        assert_eq!(harness.sent(), ["READY"]);
    }

    #[test]
    fn stops_and_exits_zero() {
        let mut harness = Harness::new();
        let device = harness.listening();
        harness.line("stop");
        assert_eq!(harness.sent(), ["READY", "RELEASED"]);
        assert_eq!(harness.closed(), [device]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn releases_a_paused_engine() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("pause");
        harness.line("stop");
        assert_eq!(harness.sent(), ["READY", "PAUSED", "RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn closes_the_device_an_in_flight_open_produces_when_a_pause_lands_first() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.line("pause");
        assert_eq!(harness.sent(), ["PAUSED"]);

        let device = harness.complete_open(0);
        assert_eq!(
            harness.closed(),
            [device],
            "the device that arrived is closed"
        );
        assert_eq!(
            harness.sent(),
            ["PAUSED"],
            "no READY for a device nobody wanted"
        );
    }

    #[test]
    fn closes_the_device_an_in_flight_open_produces_when_a_stop_lands_first() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.line("stop");
        assert_eq!(harness.sent(), ["RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
        assert!(harness.lifecycle.open_in_flight());

        let device = harness.complete_open(0);
        assert_eq!(harness.closed(), [device]);
        assert_eq!(harness.sent(), ["RELEASED"]);
    }

    #[test]
    fn says_in_debug_mode_that_it_closed_a_device_nobody_wanted() {
        let mut harness = Harness::new();
        harness.line(DEBUG_CONFIG);
        harness.complete_prepare();
        harness.line("stop");
        harness.complete_open(0);
        assert!(
            harness.sent().iter().any(
                |line| line == "DEBUG:closed a microphone that arrived after a pause or a stop"
            ),
            "lines were {:?}",
            harness.sent()
        );
    }

    #[test]
    fn keeps_the_device_when_a_pause_and_a_resume_both_land_during_one_open() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.line("pause");
        harness.line("resume");
        assert_eq!(harness.opens(), 1, "the open in flight is reused");

        harness.complete_open(0);
        assert!(harness.closed().is_empty());
        assert_eq!(harness.sent(), ["PAUSED", "READY"]);
    }

    #[test]
    fn does_not_open_the_device_when_a_pause_lands_before_preparation_finishes() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.line("pause");
        assert_eq!(harness.sent(), ["PAUSED"]);

        harness.complete_prepare();
        assert_eq!(
            harness.opens(),
            0,
            "capture was not wanted when the engine was ready"
        );
        assert_eq!(harness.sent(), ["PAUSED"]);

        harness.line("resume");
        assert_eq!(harness.opens(), 1);
        harness.complete_open(0);
        assert_eq!(harness.sent(), ["PAUSED", "READY"]);
    }

    #[test]
    fn answers_released_for_a_stop_that_arrives_before_ready() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.line("stop");
        assert_eq!(harness.sent(), ["RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));

        // Preparation finishing after the stop opens nothing.
        harness.complete_prepare();
        assert_eq!(harness.opens(), 0);
        assert_eq!(harness.sent(), ["RELEASED"]);
    }

    #[test]
    fn answers_released_for_a_stop_that_arrives_before_the_config() {
        let mut harness = Harness::new();
        harness.line("stop");
        assert_eq!(harness.sent(), ["RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
        assert_eq!(harness.prepares(), 0);
    }

    #[test]
    fn says_paused_when_nothing_is_open() {
        let mut harness = Harness::new();
        harness.line("pause");
        assert_eq!(harness.sent(), ["PAUSED"]);
    }

    #[test]
    fn ignores_every_command_and_event_once_stopping() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("stop");
        harness.line("stop");
        harness.line("pause");
        harness.line("resume");
        harness.line(CONFIG);
        harness.complete_prepare();
        harness.lifecycle.handle(Event::StdinClosed);
        harness.lifecycle.handle(Event::Signal("SIGTERM"));
        harness.report(
            1,
            CaptureReport::Failed(CaptureError::uncoded("late failure")),
        );
        assert_eq!(harness.sent(), ["READY", "RELEASED"]);
        assert_eq!(harness.opens(), 1);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn ignores_every_command_and_event_once_a_fatal_error_has_been_reported() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.line("paws");
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
        let after_error = harness.sent();

        // Preparation finishing after the error must not open anything, and a
        // late stop must not write RELEASED behind the ERROR line.
        harness.complete_prepare();
        harness.line("resume");
        harness.lifecycle.handle(Event::StdinClosed);
        harness.lifecycle.handle(Event::Signal("SIGTERM"));
        assert_eq!(harness.sent(), after_error);
        assert_eq!(harness.opens(), 0);
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
    }

    #[test]
    fn closes_a_device_that_arrives_with_no_session_to_hold_it() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        let device = harness.complete_open(0);
        assert_eq!(harness.closed(), [device]);
        assert!(harness.sent().is_empty());
    }

    #[test]
    fn shuts_down_when_stdin_closes() {
        let mut harness = Harness::new();
        harness.listening();
        harness.lifecycle.handle(Event::StdinClosed);
        assert_eq!(harness.sent(), ["READY", "RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn shuts_down_on_a_signal() {
        for name in ["SIGTERM", "SIGINT"] {
            let mut harness = Harness::new();
            harness.listening();
            harness.lifecycle.handle(Event::Signal(name));
            assert_eq!(harness.sent(), ["READY", "RELEASED"], "{name}");
            assert_eq!(harness.lifecycle.exit_code(), Some(0), "{name}");
        }
    }

    #[test]
    fn reports_an_open_that_failed_and_exits_one() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.fail_open("no device");
        assert_eq!(
            harness.sent(),
            ["ERROR:Failed to open microphone: no device"]
        );
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
    }

    #[test]
    fn reports_a_typed_open_failure_with_its_mapped_message() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.fail_open_with("PERMISSION_DENIED", "Microphone permission denied.");
        assert_eq!(
            harness.sent(),
            ["ERROR:Microphone access denied. Enable microphone access for VS Code in your system privacy settings."]
        );
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
    }

    #[test]
    fn names_the_configured_device_when_the_open_cannot_find_it() {
        let mut harness = Harness::new();
        harness.line(&config_with(r#""audioDevice":"Desk Mic 2""#));
        harness.complete_prepare();
        harness.fail_open_with(
            "MICROPHONE_NOT_FOUND",
            "No microphone found matching \"Desk Mic 2\"",
        );
        assert_eq!(
            harness.sent(),
            ["ERROR:No microphone matching \"Desk Mic 2\" was found. Check wakeWord.audioDevice against the input devices on this machine."]
        );
    }

    #[test]
    fn reports_a_detector_that_could_not_start() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.fail_open_with(
            "ORT_LOAD_FAILED",
            "decibri: failed to load ONNX Runtime from x",
        );
        assert_eq!(
            harness.sent(),
            ["ERROR:Failed to start voice activity detection: decibri: failed to load ONNX Runtime from x"]
        );
    }

    #[test]
    fn does_not_report_an_open_that_failed_after_a_pause_or_a_stop() {
        let mut paused = Harness::new();
        paused.prepared();
        paused.line("pause");
        paused.fail_open("gone");
        assert_eq!(paused.sent(), ["PAUSED"]);
        assert!(paused.lifecycle.exit_code().is_none());

        let mut stopped = Harness::new();
        stopped.prepared();
        stopped.line("stop");
        stopped.fail_open("gone");
        assert_eq!(stopped.sent(), ["RELEASED"]);
        assert_eq!(stopped.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn a_failed_open_leaves_a_resume_free_to_try_again() {
        let mut harness = Harness::new();
        harness.prepared();
        harness.line("pause");
        harness.fail_open("gone");
        harness.line("resume");
        assert_eq!(harness.opens(), 2);
        harness.complete_open(0);
        assert_eq!(harness.sent(), ["PAUSED", "READY"]);
    }

    #[test]
    fn a_stream_that_fails_while_listening_is_fatal_and_closes_the_microphone() {
        let mut harness = Harness::new();
        let device = harness.listening();
        let id = harness.last_open_id();
        harness.report(
            id,
            CaptureReport::Failed(CaptureError {
                code: Some("DEVICE_FAILED"),
                message: "decibri: audio device error: device unplugged".to_string(),
            }),
        );
        assert_eq!(
            harness.sent(),
            [
                "READY",
                "ERROR:The microphone stopped responding: decibri: audio device error: device unplugged"
            ]
        );
        assert_eq!(harness.closed(), [device]);
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
    }

    #[test]
    fn a_stream_that_closes_without_a_cause_is_reported_under_the_microphone_prefix() {
        let mut harness = Harness::new();
        harness.listening();
        let id = harness.last_open_id();
        harness.report(
            id,
            CaptureReport::Failed(CaptureError {
                code: Some("MICROPHONE_STREAM_CLOSED"),
                message: "Microphone stream is closed".to_string(),
            }),
        );
        assert_eq!(
            harness.protocol(),
            [
                "READY",
                "ERROR:Microphone error: Microphone stream is closed"
            ]
        );
    }

    #[test]
    fn ignores_a_failure_from_a_microphone_that_has_been_closed() {
        let mut harness = Harness::new();
        harness.listening();
        let first = harness.last_open_id();
        harness.line("pause");
        harness.line("resume");
        harness.complete_open(0);

        // The first microphone's thread was still on its way out.
        harness.report(first, CaptureReport::Failed(CaptureError::uncoded("stale")));
        assert_eq!(harness.sent(), ["READY", "PAUSED", "READY"]);
        assert!(harness.lifecycle.exit_code().is_none());
    }

    #[test]
    fn ignores_reports_from_a_microphone_closed_on_arrival() {
        let mut harness = Harness::new();
        harness.line(DEBUG_CONFIG);
        harness.complete_prepare();
        let id = harness.last_open_id();
        harness.line("pause");
        harness.complete_open(0);
        harness.report(
            id,
            CaptureReport::Debug("VAD: speech (5 pre-roll chunks)".into()),
        );
        harness.report(id, CaptureReport::Failed(CaptureError::uncoded("stale")));
        assert!(!harness.sent().iter().any(|line| line.contains("VAD:")));
        assert!(harness.lifecycle.exit_code().is_none());
    }

    #[test]
    fn forwards_debug_reports_from_the_current_microphone_in_debug_mode_only() {
        let mut debug = Harness::new();
        debug.line(DEBUG_CONFIG);
        debug.complete_prepare();
        debug.complete_open(0);
        let id = debug.last_open_id();
        debug.report(id, CaptureReport::Debug("VAD: silence".into()));
        assert_eq!(
            debug.sent().last().map(String::as_str),
            Some("DEBUG:VAD: silence")
        );

        let mut quiet = Harness::new();
        quiet.listening();
        let id = quiet.last_open_id();
        quiet.report(id, CaptureReport::Debug("VAD: silence".into()));
        assert_eq!(quiet.sent(), ["READY"]);
    }

    #[test]
    fn gives_every_open_its_own_id() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("pause");
        harness.line("resume");
        harness.complete_open(0);
        let ids: Vec<u64> = harness
            .requests()
            .iter()
            .map(|request| request.id)
            .collect();
        assert_eq!(ids, [1, 2]);
    }

    #[test]
    fn opens_with_the_configured_device_and_paths() {
        let mut harness = Harness::new();
        harness.line(&config_with(
            r#""audioDevice":"2","debugMode":true,
                "vadModelPath":"/models/silero_vad.onnx","ortLibraryPath":"/ort/libonnxruntime.so""#,
        ));
        harness.complete_prepare();
        let request = harness.requests().pop().expect("an open was requested");
        assert_eq!(request.device, AudioDevice::Index(2));
        assert_eq!(request.vad_model, PathBuf::from("/models/silero_vad.onnx"));
        assert_eq!(
            request.ort_library,
            Some(PathBuf::from("/ort/libonnxruntime.so"))
        );
        assert!(request.debug);
    }

    #[test]
    fn leaves_the_onnx_runtime_to_decibri_when_none_is_configured() {
        let mut harness = Harness::new();
        harness.prepared();
        let request = harness.requests().pop().expect("an open was requested");
        assert_eq!(request.ort_library, None);
        assert_eq!(request.device, AudioDevice::Default);
        assert!(!request.debug);
    }

    #[test]
    fn refuses_a_config_without_keyword_lines_before_preparing() {
        for json in [
            r#"{"phrases":[{"phrase":"hey claude"}],"modelDir":"/models","phraseMap":{"HEY CLAUDE":"hey claude"}}"#,
            r#"{"keywordLines":"▁HE Y :3.0 #0.05","phraseMap":{"HEY":"hey"}}"#,
        ] {
            let mut harness = Harness::new();
            harness.line(json);
            assert_eq!(
                harness.sent(),
                ["ERROR:Startup error: the config has no keywordLines, and the engine does not tokenise phrases itself"],
                "{json}"
            );
            assert_eq!(harness.lifecycle.exit_code(), Some(1));
            assert_eq!(harness.prepares(), 0);
        }
    }

    #[test]
    fn refuses_a_config_without_a_phrase_map_before_preparing() {
        for json in [
            r#"{"keywordLines":["▁HE Y :3.0 #0.05"]}"#,
            r#"{"keywordLines":["▁HE Y :3.0 #0.05"],"phraseMap":{}}"#,
            r#"{"keywordLines":["▁HE Y :3.0 #0.05"],"phraseMap":{"HEY":7}}"#,
        ] {
            let mut harness = Harness::new();
            harness.line(json);
            assert_eq!(
                harness.sent(),
                ["ERROR:Startup error: the config has no phraseMap, so no detection could be reported"],
                "{json}"
            );
            assert_eq!(harness.prepares(), 0);
        }
    }

    #[test]
    fn reports_a_model_that_could_not_load() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.fail_prepare(PrepareError::ModelLoad(
            "/models/tokens.txt does not exist".to_string(),
        ));
        assert_eq!(
            harness.sent(),
            ["ERROR:Failed to load KWS model: /models/tokens.txt does not exist"]
        );
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
        assert_eq!(harness.opens(), 0);
    }

    #[test]
    fn stays_quiet_about_a_preparation_failure_after_a_stop() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.line("stop");
        harness.fail_prepare(PrepareError::ModelLoad(
            "/models/tokens.txt does not exist".to_string(),
        ));
        assert_eq!(harness.sent(), ["RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn refuses_a_config_with_no_keyword_line_before_preparing() {
        // The extension found no phrase it could tokenise. Lines that are not
        // strings are no lines either.
        for json in [
            r#"{"keywordLines":[],"phraseMap":{"HEY CLAUDE":"hey claude"},"modelDir":"/models"}"#,
            r#"{"keywordLines":[42,null],"phraseMap":{"HEY CLAUDE":"hey claude"}}"#,
        ] {
            let mut harness = Harness::new();
            harness.line(json);
            assert_eq!(
                harness.sent(),
                ["ERROR:No valid phrases to detect"],
                "{json}"
            );
            assert_eq!(harness.lifecycle.exit_code(), Some(1));
            assert_eq!(harness.prepares(), 0);
            assert_eq!(harness.opens(), 0);
        }
    }

    #[test]
    fn hands_preparation_the_keyword_lines_the_phrase_map_the_threshold_and_the_model_directory() {
        let mut harness = Harness::new();
        harness.line(
            r#"{"phrases":[{"phrase":["Hey Claude","open claude"]}],
                "keywordLines":["▁HE Y ▁C LA U DE :3.0 #0.3","▁O P EN ▁C LA U DE :3.0 #0.3"],
                "phraseMap":{"HEY CLAUDE":"hey claude","OPEN CLAUDE":"open claude"},
                "threshold":0.3,"modelDir":"/models/kws"}"#,
        );
        let mut phrase_map = PhraseMap::default();
        phrase_map.insert("HEY CLAUDE".to_string(), "hey claude".to_string());
        phrase_map.insert("OPEN CLAUDE".to_string(), "open claude".to_string());
        assert_eq!(
            harness.prepare_requests(),
            [PrepareRequest {
                keyword_lines: vec![
                    "\u{2581}HE Y \u{2581}C LA U DE :3.0 #0.3".to_string(),
                    "\u{2581}O P EN \u{2581}C LA U DE :3.0 #0.3".to_string(),
                ],
                phrase_map,
                threshold: 0.3,
                model_dir: "/models/kws".to_string(),
            }]
        );
    }

    #[test]
    fn reports_a_detection_from_the_current_microphone() {
        let mut harness = Harness::new();
        harness.listening();
        let id = harness.last_open_id();
        harness.report(id, CaptureReport::Detected("hey claude".to_string()));
        assert_eq!(harness.sent(), ["READY", "DETECTED:hey claude"]);
        assert!(harness.lifecycle.exit_code().is_none());
    }

    #[test]
    fn does_not_report_a_detection_from_a_closed_microphone() {
        let mut harness = Harness::new();
        harness.listening();
        let first = harness.last_open_id();

        // Paused: the capture thread's last report was already in the queue.
        harness.line("pause");
        harness.report(first, CaptureReport::Detected("hey claude".to_string()));
        assert_eq!(harness.sent(), ["READY", "PAUSED"]);

        // Resumed on a new microphone: the old one still has no say.
        harness.line("resume");
        harness.complete_open(0);
        harness.report(first, CaptureReport::Detected("hey claude".to_string()));
        assert_eq!(harness.sent(), ["READY", "PAUSED", "READY"]);

        let second = harness.last_open_id();
        harness.report(second, CaptureReport::Detected("open chat".to_string()));
        assert_eq!(
            harness.sent(),
            ["READY", "PAUSED", "READY", "DETECTED:open chat"]
        );
    }

    #[test]
    fn does_not_report_a_detection_once_stopping() {
        let mut harness = Harness::new();
        harness.listening();
        let id = harness.last_open_id();
        harness.line("stop");
        harness.report(id, CaptureReport::Detected("hey claude".to_string()));
        assert_eq!(harness.sent(), ["READY", "RELEASED"]);
    }

    #[test]
    fn a_pause_gives_the_spotter_a_new_stream_once_the_microphone_is_closed() {
        let mut harness = Harness::new();
        let device = harness.listening();
        harness.line("pause");
        assert_eq!(
            harness.order(),
            [
                "prepare".to_string(),
                "open 1".to_string(),
                format!("close {device}"),
                "reset spotter".to_string(),
            ],
            "the stream is replaced after the close, which waits for the capture thread"
        );
        assert_eq!(harness.sent(), ["READY", "PAUSED"]);
    }

    #[test]
    fn every_pause_replaces_the_stream() {
        let mut harness = Harness::new();
        harness.listening();
        for _ in 0..3 {
            harness.line("pause");
            harness.line("resume");
            harness.complete_open(0);
        }
        let resets = harness
            .order()
            .iter()
            .filter(|step| *step == "reset spotter")
            .count();
        assert_eq!(resets, 3);
    }

    #[test]
    fn a_pause_before_the_spotter_is_loaded_resets_nothing() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.line("pause");
        assert_eq!(harness.sent(), ["PAUSED"]);
        assert_eq!(harness.order(), ["prepare"]);
    }

    #[test]
    fn a_stop_frees_the_spotter_after_it_has_said_released() {
        let mut harness = Harness::new();
        let device = harness.listening();
        harness.line("stop");
        assert_eq!(
            harness.order(),
            [
                "prepare".to_string(),
                "open 1".to_string(),
                format!("close {device}"),
                "release".to_string(),
            ]
        );
        assert_eq!(harness.sent(), ["READY", "RELEASED"]);
    }

    #[test]
    fn a_stop_during_preparation_abandons_it_and_drops_a_spotter_that_arrives_late() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        assert!(harness.lifecycle.prepare_in_flight());
        harness.line("stop");
        assert_eq!(harness.releases(), 1, "preparation is told to stop");
        assert!(harness.lifecycle.prepare_in_flight());

        harness.complete_prepare();
        assert!(!harness.lifecycle.prepare_in_flight());
        assert_eq!(harness.releases(), 2, "the late spotter is dropped");
        assert_eq!(harness.opens(), 0);
        assert_eq!(harness.sent(), ["RELEASED"]);
    }

    #[test]
    fn a_fatal_error_closes_the_microphone_and_frees_the_spotter_after_the_error_line() {
        let mut harness = Harness::new();
        let device = harness.listening();
        harness.line("paws");
        assert_eq!(harness.closed(), [device]);
        assert_eq!(harness.releases(), 1);
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
        assert!(harness.sent()[1].starts_with("ERROR:Invalid config JSON: "));
    }

    #[test]
    fn writes_preparation_progress_in_debug_mode_as_it_arrives() {
        let mut harness = Harness::new();
        harness.line(DEBUG_CONFIG);
        harness.preparing(PrepareProgress::Debug(
            "loading sherpa-onnx KWS model...".to_string(),
        ));
        harness.preparing(PrepareProgress::Timing {
            phase: "model-load",
            elapsed_ms: 212,
        });
        assert_eq!(
            harness.sent()[1..],
            [
                "DEBUG:loading sherpa-onnx KWS model...",
                "DEBUG:Timing: model-load 212ms",
            ]
        );
    }

    #[test]
    fn writes_no_preparation_progress_outside_debug_mode_or_after_the_last_line() {
        let mut quiet = Harness::new();
        quiet.line(CONFIG);
        quiet.preparing(PrepareProgress::Timing {
            phase: "model-load",
            elapsed_ms: 212,
        });
        assert!(quiet.sent().is_empty());

        let mut stopped = Harness::new();
        stopped.line(DEBUG_CONFIG);
        stopped.line("stop");
        let after_stop = stopped.sent();
        stopped.preparing(PrepareProgress::Timing {
            phase: "model-load",
            elapsed_ms: 212,
        });
        assert_eq!(stopped.sent(), after_stop);
    }

    #[test]
    fn names_the_phrases_once_after_the_first_ready_and_not_after_a_resume() {
        let mut harness = Harness::new();
        harness.line(DEBUG_CONFIG);
        harness.complete_prepare();
        harness.complete_open(0);
        let listening = "DEBUG:mic open, VAD-gated, listening for: hey claude, open chat";
        let lines = harness.sent();
        let ready = lines
            .iter()
            .position(|line| line == "READY")
            .expect("READY");
        assert_eq!(lines[ready + 1], listening, "straight after READY");

        harness.line("pause");
        harness.line("resume");
        harness.complete_open(0);
        let count = harness
            .sent()
            .iter()
            .filter(|line| *line == listening)
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn an_unknown_command_is_fatal() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("paws");
        let lines = harness.sent();
        assert_eq!(lines[0], "READY");
        assert!(
            lines[1].starts_with("ERROR:Invalid config JSON: "),
            "unexpected line: {}",
            lines[1]
        );
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
    }

    #[test]
    fn a_malformed_config_line_is_fatal() {
        let mut harness = Harness::new();
        harness.line("{ not json");
        assert_eq!(harness.sent().len(), 1);
        assert!(harness.sent()[0].starts_with("ERROR:Invalid config JSON: "));
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
        assert_eq!(harness.prepares(), 0);
    }

    #[test]
    fn ignores_a_blank_line() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("");
        harness.line("   ");
        assert_eq!(harness.sent(), ["READY"]);
        assert!(harness.lifecycle.exit_code().is_none());
    }

    #[test]
    fn ignores_a_second_config_line() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line(CONFIG);
        assert_eq!(harness.sent(), ["READY"]);
        assert_eq!(harness.prepares(), 1);
        assert_eq!(harness.opens(), 1);
    }

    #[test]
    fn writes_the_timing_lines_in_debug_mode() {
        let mut harness = Harness::new();
        harness.line(DEBUG_CONFIG);
        harness.advance(12);
        harness.complete_prepare();
        harness.complete_open(87);
        harness.line("pause");
        harness.line("resume");
        harness.complete_open(34);

        let timings: Vec<String> = harness
            .sent()
            .into_iter()
            .filter(|line| line.starts_with("DEBUG:Timing:"))
            .collect();
        assert_eq!(
            timings,
            [
                "DEBUG:Timing: mic-open 87ms",
                "DEBUG:Timing: resume-mic-open 34ms",
            ]
        );
    }

    #[test]
    fn writes_no_debug_lines_outside_debug_mode() {
        let mut harness = Harness::new();
        harness.listening();
        harness.line("pause");
        harness.lifecycle.handle(Event::StdinClosed);
        assert_eq!(harness.sent(), ["READY", "PAUSED", "RELEASED"]);
    }

    #[test]
    fn names_the_configured_device_in_the_opening_debug_line() {
        let mut harness = Harness::new();
        harness.line(&config_with(
            r#""debugMode":true,"audioDevice":"Desk Mic 2""#,
        ));
        harness.complete_prepare();
        assert!(
            harness
                .sent()
                .contains(&"DEBUG:opening microphone (device: \"Desk Mic 2\")...".to_string()),
            "lines were {:?}",
            harness.sent()
        );
    }

    #[test]
    fn names_the_voice_activity_model_in_a_debug_line() {
        let mut harness = Harness::new();
        harness.line(&config_with(
            r#""debugMode":true,
                "vadModelPath":"/m/silero_vad.onnx","ortLibraryPath":"/o/ort.so""#,
        ));
        harness.complete_prepare();
        let expected = format!(
            "DEBUG:voice activity model={}, ONNX Runtime={}",
            PathBuf::from("/m/silero_vad.onnx").display(),
            PathBuf::from("/o/ort.so").display()
        );
        assert!(
            harness.sent().contains(&expected),
            "lines were {:?}",
            harness.sent()
        );
    }

    #[test]
    fn reports_that_it_is_waiting_for_a_resume_when_paused_before_the_first_open() {
        let mut harness = Harness::new();
        harness.line(DEBUG_CONFIG);
        harness.line("pause");
        harness.complete_prepare();
        assert!(
            harness.sent().iter().any(|line| line
                == "DEBUG:models loaded; paused before the microphone opened, waiting for resume"),
            "lines were {:?}",
            harness.sent()
        );
    }

    #[test]
    fn reports_no_open_in_flight_until_one_is() {
        let mut harness = Harness::new();
        assert!(!harness.lifecycle.open_in_flight());
        harness.prepared();
        assert!(harness.lifecycle.open_in_flight());
        harness.complete_open(0);
        assert!(!harness.lifecycle.open_in_flight());
    }

    #[test]
    fn holds_the_device_only_while_listening() {
        let mut harness = Harness::new();
        harness.prepared();
        assert!(
            !harness.lifecycle.holds_device(),
            "nothing is open during the first open"
        );
        harness.complete_open(0);
        assert!(harness.lifecycle.holds_device());
        harness.line("pause");
        assert!(
            !harness.lifecycle.holds_device(),
            "a pause closes the device"
        );
    }
}
