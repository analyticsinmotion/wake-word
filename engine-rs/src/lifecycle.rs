//! The engine state machine: config, prepare, capture, pause, resume, stop.
//!
//! Port of the lifecycle in `engine/audio-engine.js` (`main()`,
//! `pauseCapture()`, `resumeCapture()`, `shutdown()`, the `stopping` and
//! `captureWanted` flags) together with `CaptureSession` in
//! `engine/lib/capture.js`.
//!
//! Everything here is driven by events and holds no threads of its own, so the
//! cases that are hard to reach in a running process are reachable in a test:
//! a `pause` or a `stop` that lands while the capture device is still opening,
//! a `pause` that lands before the device has ever opened, and an event that
//! arrives after shutdown has started.
//!
//! Three flags carry the whole thing, and they are the Node engine's:
//!
//! - `stopping`: shutdown has begun, so every later command and event is
//!   ignored. `RELEASED` is said once.
//! - `capture_wanted`: whether the device should be open. A `pause` that
//!   arrives before the first open clears it, and the device is then not
//!   opened until a `resume` arrives.
//! - `CaptureSession::wanted`: the same question for one open in flight. A
//!   `pause` or `stop` during an open has already been acknowledged, so the
//!   device that open eventually produces is closed instead of being kept.
//!
//! This relay has no microphone and no keyword spotter. The device is a
//! placeholder that opens after a short delay, which is what makes the
//! in-flight cases real rather than theoretical. Relay 2 replaces it with
//! decibri capture and Relay 3 adds the spotter; the state machine does not
//! change when they do.

use std::sync::mpsc::Sender;
use std::thread;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::protocol::{parse_control_line, ControlLine, Reporter, Sink};

/// How long the placeholder preparation step takes. Relay 3 replaces it with
/// the module, BPE, tokenisation and model loads, which take seconds.
const PREPARE_DELAY_MS: u64 = 20;

/// How long the placeholder capture device takes to open. Long enough that a
/// command written straight after the config lands while the open is in
/// flight, which is the case the Node engine got wrong twice.
const OPEN_DELAY_MS: u64 = 25;

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

/// An open capture device. Relay 2 implements this over a decibri microphone.
pub trait CaptureDevice: Send {
    /// Close the device. Called at most once, and called even for a device
    /// that arrived after the pause or stop that made it unwanted.
    fn close(&mut self);
}

/// Starts the slow work the state machine waits on. Both calls return at once
/// and the result arrives later as an [`Event`].
pub trait Spawner: Send {
    /// Load whatever the engine needs before capture can start.
    fn spawn_prepare(&mut self);
    /// Open the capture device.
    fn spawn_open(&mut self);
}

/// Everything the state machine reacts to.
pub enum Event {
    /// One complete line read from stdin.
    Line(String),
    /// stdin reached EOF: the parent closed the pipe.
    StdinClosed,
    /// SIGTERM, SIGINT, or the Windows console equivalent.
    Signal(&'static str),
    /// The preparation step finished.
    Prepared(Result<(), String>),
    /// An open finished, with the device or the reason it failed.
    CaptureOpened(Result<Box<dyn CaptureDevice>, String>),
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
    /// Report a capture failure. The message format is the fallback branch of
    /// `micErrorMessage()` in `engine/lib/mic-errors.js`; Relay 2 brings the
    /// rest of that mapping across with the typed decibri errors.
    fn fail(&mut self, prefix: &str, message: &str) {
        if self.fatal.is_none() {
            self.fatal = Some(format!("{prefix}: {message}"));
        }
    }
}

/// The capture device's lifecycle: open, pause, resume, stop.
///
/// Port of `CaptureSession` in `engine/lib/capture.js`. The engine process and
/// its loaded models outlive a pause: `pause()` closes the device and says
/// `PAUSED`, `resume()` opens a new one and says `READY`, and `stop()` closes
/// it for good and says `RELEASED`.
pub struct CaptureSession {
    device: Option<Box<dyn CaptureDevice>>,
    /// An open is in flight.
    opening: bool,
    /// Capture is wanted: `start()` and `resume()` set it, `pause()` and
    /// `stop()` clear it. An open that completes when it is clear closes the
    /// device it produced.
    wanted: bool,
    stopped: bool,
    open_label: &'static str,
    open_began: u64,
}

impl CaptureSession {
    fn new() -> CaptureSession {
        CaptureSession {
            device: None,
            opening: false,
            wanted: false,
            stopped: false,
            open_label: "mic-open",
            open_began: 0,
        }
    }

    /// Open the device and say `READY`.
    fn start(&mut self, ctx: &mut Ctx) {
        self.capture(ctx, "mic-open");
    }

    /// Reopen the device after a pause and say `READY`.
    fn resume(&mut self, ctx: &mut Ctx) {
        self.capture(ctx, "resume-mic-open");
    }

    /// Close the device and say `PAUSED`.
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
        // Relay 3 resets the spotter here, so nothing heard before the pause
        // can complete a phrase after it.
        ctx.out.paused();
    }

    /// Close the device for good and say `RELEASED`.
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
        self.open_label = label;
        self.open_began = ctx.clock.now_ms();
        ctx.spawner.spawn_open();
    }

    /// An open finished.
    fn opened(&mut self, ctx: &mut Ctx, result: Result<Box<dyn CaptureDevice>, String>) {
        if !self.opening {
            // No open was in flight, so this device belongs to nothing. Close
            // it rather than leak it.
            if let Ok(mut device) = result {
                device.close();
            }
            return;
        }
        self.opening = false;

        match result {
            Err(message) => {
                // A pause or stop during the open has been acknowledged and
                // the next resume tries again; the failure changes nothing now.
                if self.wanted && !self.stopped {
                    ctx.fail("Failed to open microphone", &message);
                }
            }
            Ok(mut device) => {
                if !self.wanted || self.stopped {
                    // The pause or stop that made this device unwanted was
                    // answered while the open was still in flight. Closing it
                    // here is what keeps the device from being left open on a
                    // process that is on its way out.
                    device.close();
                    ctx.out
                        .debug("closed a capture device that arrived after a pause or a stop");
                    return;
                }
                self.device = Some(device);
                let elapsed = ctx.clock.now_ms().saturating_sub(self.open_began);
                ctx.out.timing(self.open_label, elapsed);
                ctx.out.ready();
            }
        }
    }

    fn close(&mut self) {
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
    /// arrives while preparation is still running clears it, so the device is
    /// not opened until a resume. The extension only pauses an engine that has
    /// said READY, so this is defensive.
    capture_wanted: bool,
    prepare_began: u64,
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
            prepare_began: 0,
            exit_code: None,
        }
    }

    /// The code to exit with, once one has been decided. `Some` means the
    /// event loop is finished.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    /// True while an open is in flight. The event loop uses this to wait a
    /// moment for the device on the way out, so it can be closed rather than
    /// left to the operating system.
    pub fn open_in_flight(&self) -> bool {
        self.session.as_ref().is_some_and(|session| session.opening)
    }

    /// True while a capture device is open and held.
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
            Event::Prepared(result) => self.on_prepared(result),
            Event::CaptureOpened(result) => self.on_opened(result),
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
            // The Node engine calls main() again for a second config line,
            // which loads a second model and opens a second capture device
            // while the first is still open and running. The extension sends
            // exactly one config line per child, so that path is unreachable
            // from the host, and ignoring it is the safe reading.
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
        self.prepare_began = self.ctx.clock.now_ms();
        self.config = Some(config);
        self.ctx.spawner.spawn_prepare();
    }

    fn on_prepared(&mut self, result: Result<(), String>) {
        if self.session.is_some() {
            return;
        }
        if let Err(message) = result {
            // A stop during preparation has already said RELEASED and the
            // process is on its way out; an error line after it would only
            // confuse the extension's reader.
            if !self.finished() {
                self.fatal(&format!("Startup error: {message}"));
            }
            return;
        }

        let elapsed = self.ctx.clock.now_ms().saturating_sub(self.prepare_began);
        self.ctx.out.timing("prepare", elapsed);

        // A stop during preparation has already said RELEASED, and a fatal
        // error has already said ERROR. Opening the capture device now would
        // only hold that exit up.
        if self.finished() {
            return;
        }

        let Some(config) = self.config.as_ref() else {
            return;
        };
        let no_phrases = config.phrases.is_empty();
        let device = config.audio_device.describe();

        if no_phrases {
            self.fatal("No valid phrases to detect");
            return;
        }

        self.session = Some(CaptureSession::new());

        if !self.capture_wanted {
            self.ctx
                .out
                .debug("ready; paused before the capture device opened, waiting for resume");
            return;
        }

        let opening = match device {
            Some(described) => format!("opening capture device (device: {described})..."),
            None => "opening capture device...".to_string(),
        };
        self.ctx.out.debug(&opening);
        if let Some(session) = self.session.as_mut() {
            session.start(&mut self.ctx);
        }
    }

    fn on_opened(&mut self, result: Result<Box<dyn CaptureDevice>, String>) {
        match self.session.as_mut() {
            Some(session) => session.opened(&mut self.ctx, result),
            // Nothing is holding this device: preparation never finished, or
            // the engine was torn down. Close it rather than leak it.
            None => {
                if let Ok(mut device) = result {
                    device.close();
                }
            }
        }
    }

    /// `pause`: close the capture device and keep everything else loaded.
    fn pause_capture(&mut self) {
        if self.finished() {
            return;
        }
        self.capture_wanted = false;
        match self.session.as_mut() {
            Some(session) => session.pause(&mut self.ctx),
            // Still preparing, so nothing is open. on_prepared() leaves the
            // device closed.
            None => self.ctx.out.paused(),
        }
    }

    /// `resume`: reopen the capture device.
    fn resume_capture(&mut self) {
        if self.finished() {
            return;
        }
        self.capture_wanted = true;
        // Still preparing: on_prepared() opens the device once it is ready.
        if let Some(session) = self.session.as_mut() {
            session.resume(&mut self.ctx);
        }
    }

    /// `stop`, stdin EOF, SIGTERM, or SIGINT.
    ///
    /// The capture device is closed and said to be closed before anything
    /// else: the extension waits for `RELEASED` before it kills the process,
    /// rather than killing it and trusting the operating system to have
    /// reclaimed the device by then.
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
        // Relay 3 frees the keyword spotter here.
        self.exit_code = Some(0);
    }

    fn fatal(&mut self, message: &str) {
        if self.exit_code.is_some() {
            return;
        }
        self.ctx.out.error(message);
        self.exit_code = Some(1);
    }

    /// Raise a fatal error a session call left behind.
    fn settle(&mut self) {
        if let Some(message) = self.ctx.fatal.take() {
            self.fatal(&message);
        }
    }
}

/// The placeholder capture device for this relay. Relay 2 replaces it with a
/// decibri microphone; nothing else in the state machine changes.
struct PlaceholderCapture;

impl CaptureDevice for PlaceholderCapture {
    fn close(&mut self) {
        // Nothing is open yet, so there is nothing to close.
    }
}

/// Runs the placeholder prepare and open steps on short-lived threads, so the
/// state machine sees them arrive the way the real ones will.
pub struct ThreadSpawner {
    events: Sender<Event>,
    prepare_delay: Duration,
    open_delay: Duration,
}

impl ThreadSpawner {
    pub fn new(events: Sender<Event>) -> ThreadSpawner {
        ThreadSpawner {
            events,
            prepare_delay: Duration::from_millis(PREPARE_DELAY_MS),
            open_delay: Duration::from_millis(OPEN_DELAY_MS),
        }
    }
}

impl Spawner for ThreadSpawner {
    fn spawn_prepare(&mut self) {
        let events = self.events.clone();
        let delay = self.prepare_delay;
        thread::spawn(move || {
            thread::sleep(delay);
            let _ = events.send(Event::Prepared(Ok(())));
        });
    }

    fn spawn_open(&mut self) {
        let events = self.events.clone();
        let delay = self.open_delay;
        thread::spawn(move || {
            thread::sleep(delay);
            let _ = events.send(Event::CaptureOpened(Ok(Box::new(PlaceholderCapture))));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RecordingSink;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct SpawnLog {
        prepares: usize,
        opens: usize,
    }

    #[derive(Clone, Default)]
    struct FakeSpawner {
        log: Arc<Mutex<SpawnLog>>,
    }

    impl Spawner for FakeSpawner {
        fn spawn_prepare(&mut self) {
            self.log.lock().expect("spawn log").prepares += 1;
        }

        fn spawn_open(&mut self) {
            self.log.lock().expect("spawn log").opens += 1;
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

    struct FakeCapture {
        id: u32,
        log: CloseLog,
    }

    impl CaptureDevice for FakeCapture {
        fn close(&mut self) {
            self.log.closed.lock().expect("close log").push(self.id);
        }
    }

    const CONFIG: &str = r#"{"phrases":[{"phrase":"hey claude","label":"Claude"}],"threshold":0.05,"modelDir":"/models","debugMode":false,"audioDevice":""}"#;
    const DEBUG_CONFIG: &str =
        r#"{"phrases":[{"phrase":"hey claude"}],"modelDir":"/models","debugMode":true}"#;

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

        fn prepares(&self) -> usize {
            self.spawner.log.lock().expect("spawn log").prepares
        }

        fn opens(&self) -> usize {
            self.spawner.log.lock().expect("spawn log").opens
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
            self.lifecycle.handle(Event::Prepared(Ok(())));
        }

        /// Complete the open in flight after `elapsed` milliseconds and return
        /// the identifier of the device it produced.
        fn complete_open(&mut self, elapsed: u64) -> u32 {
            self.advance(elapsed);
            self.devices += 1;
            let device = FakeCapture {
                id: self.devices,
                log: self.closes.clone(),
            };
            self.lifecycle
                .handle(Event::CaptureOpened(Ok(Box::new(device))));
            self.devices
        }

        fn fail_open(&mut self, message: &str) {
            self.lifecycle
                .handle(Event::CaptureOpened(Err(message.to_string())));
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
            harness
                .sent()
                .iter()
                .any(|line| line
                    == "DEBUG:closed a capture device that arrived after a pause or a stop"),
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
    fn reports_a_preparation_failure_as_a_startup_error() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness
            .lifecycle
            .handle(Event::Prepared(Err("bpe.model is missing".to_string())));
        assert_eq!(
            harness.sent(),
            ["ERROR:Startup error: bpe.model is missing"]
        );
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
    }

    #[test]
    fn stays_quiet_about_a_preparation_failure_after_a_stop() {
        let mut harness = Harness::new();
        harness.line(CONFIG);
        harness.line("stop");
        harness
            .lifecycle
            .handle(Event::Prepared(Err("bpe.model is missing".to_string())));
        assert_eq!(harness.sent(), ["RELEASED"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(0));
    }

    #[test]
    fn refuses_a_config_with_no_usable_phrase() {
        let mut harness = Harness::new();
        harness.line(r#"{"phrases":[{"phrase":42},{"phrase":"  "}],"modelDir":"/models"}"#);
        harness.complete_prepare();
        assert_eq!(harness.sent(), ["ERROR:No valid phrases to detect"]);
        assert_eq!(harness.lifecycle.exit_code(), Some(1));
        assert_eq!(harness.opens(), 0);
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
                "DEBUG:Timing: prepare 12ms",
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
        harness.line(
            r#"{"phrases":[{"phrase":"hey claude"}],"debugMode":true,"audioDevice":"Blue Yeti"}"#,
        );
        harness.complete_prepare();
        assert!(
            harness
                .sent()
                .contains(&"DEBUG:opening capture device (device: \"Blue Yeti\")...".to_string()),
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
                == "DEBUG:ready; paused before the capture device opened, waiting for resume"),
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
