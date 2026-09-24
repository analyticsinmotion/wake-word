//! `wake-word-engine`: the child process the Wake Word extension talks to.
//!
//! The extension writes a JSON config line to stdin, then `pause`,
//! `resume`, and `stop` commands; the engine answers on stdout with `READY`,
//! `DETECTED:<phrase>`, `PAUSED`, `RELEASED`, `ERROR:<msg>`, and, in debug
//! mode, `DEBUG:<msg>`.
//!
//! The engine captures audio through decibri, gates it with Silero voice
//! activity detection, and feeds what passes the gate to a sherpa-onnx keyword
//! spotter, which listens for the configured phrases.
//!
//! Three threads and one channel:
//!
//! - the main thread owns the state machine and does nothing but read events;
//! - a reader thread turns stdin into complete lines, so a command split
//!   across two chunks still arrives whole and a `stop` sitting behind another
//!   command is never dropped;
//! - a signal thread turns SIGTERM and SIGINT, or their Windows console
//!   equivalents, into the same shutdown the `stop` command causes.
//!
//! The keyword spotting model loads on a thread of its own, and each
//! microphone gets one too, which opens it, reports back through the same
//! channel, and then runs its capture loop, keyword spotting included, until
//! it is closed. That is what lets a `pause` or a `stop` be answered while a
//! load or an open is still in flight.

mod assets;
mod capture;
mod config;
mod gate;
mod hysteresis;
mod lifecycle;
mod mic_errors;
mod protocol;
mod samples;
mod spotter;

use std::io::{self, Read};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use capture::ThreadSpawner;
use lifecycle::{Event, Lifecycle, MonotonicClock};
use protocol::{flush_and_exit, LineSplitter, Reporter, StdoutSink};

/// The decibri release this binary is built against, as pinned in
/// `Cargo.toml`. The crate exports no version constant of its own; a test
/// keeps the two in step.
const DECIBRI_VERSION: &str = "6.3.0";

/// How long shutdown waits for a microphone that is still opening, so it can
/// be closed rather than left to the operating system to reclaim. `RELEASED`
/// has already been written by then, so nothing the extension is waiting for
/// is held up.
const SHUTDOWN_DRAIN_MS: u64 = 250;

/// How long shutdown waits for a model load that is still running. Exiting
/// runs the C++ runtime's static destructors, and doing that underneath a
/// thread that is inside the model loader can crash the process on its way
/// out. The load is told to stop at its next step, so this is the most one
/// step can take; the last line has already been written.
const PREPARE_DRAIN_MS: u64 = 3000;

fn main() {
    // --self-test runs before the stdin wiring below, which would otherwise
    // hold the process open waiting for a config line that CI never sends.
    if std::env::args()
        .skip(1)
        .any(|argument| argument == "--self-test")
    {
        run_self_test();
    }

    let (events, incoming) = mpsc::channel::<Event>();
    spawn_stdin_reader(events.clone());
    signals::install(events.clone());

    let mut engine = Lifecycle::new(
        Box::new(StdoutSink),
        Box::new(ThreadSpawner::new(events.clone())),
        Box::new(MonotonicClock::new()),
    );
    // The reader thread, the signal thread, and the spawner each keep a sender.
    drop(events);

    loop {
        match incoming.recv() {
            Ok(event) => engine.handle(event),
            // Every sender is gone, which cannot happen while the engine owns
            // its spawner. Release the device and go rather than block.
            Err(_) => engine.handle(Event::StdinClosed),
        }
        if let Some(code) = engine.exit_code() {
            drain_in_flight(&mut engine, &incoming);
            flush_and_exit(code);
        }
    }
}

/// Confirm the engine runs on this platform and exit.
///
/// CI runs this on every target: a missing or incompatible shared library
/// shows up here rather than on a user's machine. It opens no microphone and
/// loads no keyword spotting model; the sherpa-onnx line is the version the
/// statically linked library reports, which proves it linked and runs.
fn run_self_test() -> ! {
    let mut out = Reporter::new(Box::new(StdoutSink));
    match self_test::run() {
        Ok(report) => {
            out.self_test("OK");
            out.self_test(&format!(
                "platform={}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            out.self_test(&format!("version={}", env!("CARGO_PKG_VERSION")));
            out.self_test(&format!("decibri={DECIBRI_VERSION}"));
            out.self_test(&format!("sherpa-onnx={}", sherpa_onnx::version()));
            out.self_test(&format!("ort={}", report.ort));
            out.self_test(&format!("vad-model={}", report.vad_model));
            flush_and_exit(0)
        }
        Err(message) => {
            out.self_test(&format!("FAIL:{message}"));
            flush_and_exit(1)
        }
    }
}

/// Read stdin and post one event per complete line, then one for EOF.
///
/// A trailing partial line at EOF is dropped: an unterminated line is not a
/// command.
fn spawn_stdin_reader(events: Sender<Event>) {
    thread::spawn(move || {
        let mut splitter = LineSplitter::new();
        let mut stdin = io::stdin().lock();
        let mut buffer = [0u8; 8192];

        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    for line in splitter.push(&buffer[..read]) {
                        if events.send(Event::Line(line)).is_err() {
                            return;
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        let _ = events.send(Event::StdinClosed);
    });
}

/// Wait briefly for whatever was still in flight when the engine decided to
/// exit: a microphone that was opening, so the state machine can close it, and
/// a model load, so the process does not exit underneath it.
fn drain_in_flight(engine: &mut Lifecycle, incoming: &Receiver<Event>) {
    let started = Instant::now();
    let open_deadline = started + Duration::from_millis(SHUTDOWN_DRAIN_MS);
    let prepare_deadline = started + Duration::from_millis(PREPARE_DRAIN_MS);

    loop {
        let deadline = if engine.prepare_in_flight() {
            prepare_deadline
        } else if engine.open_in_flight() {
            open_deadline
        } else {
            return;
        };
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return;
        };
        match incoming.recv_timeout(remaining) {
            Ok(finished @ (Event::CaptureOpened(_) | Event::Prepared(_))) => {
                engine.handle(finished);
            }
            // A command or a signal after shutdown changes nothing.
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

/// The checks behind `--self-test`.
mod self_test {
    use decibri::{SileroVad, VadConfig};

    use crate::assets;
    use crate::capture::{SAMPLE_RATE, SPEECH_THRESHOLD};
    use crate::config::AudioDevice;
    use crate::mic_errors::{mic_error_message, CaptureError};

    /// What the self-test found.
    pub struct Report {
        /// The ONNX Runtime library that initialised, or `not found`.
        pub ort: String,
        /// The Silero model that loaded, or `not found`.
        pub vad_model: String,
    }

    /// Initialise ONNX Runtime and load the Silero model the way an open
    /// does, without opening a microphone.
    ///
    /// decibri initialises ONNX Runtime before it loads the model, so a model
    /// failure proves the runtime loaded. No runtime at all, with none named
    /// and none beside the executable, is reported as `not found` rather than
    /// as a failure, and so is a missing model: both are installed beside the
    /// binary, and the binary itself is sound without them. A runtime or model
    /// that is present but cannot be used is a failure.
    pub fn run() -> Result<Report, String> {
        let model = assets::vad_model_path(None);
        let model_found = model.is_file();
        let ort = assets::ort_location(None);

        let mut config = VadConfig::default();
        config.model_path = model.clone();
        config.sample_rate = SAMPLE_RATE;
        config.threshold = SPEECH_THRESHOLD;

        let (ort_line, model_line) = match SileroVad::new(config) {
            Ok(_) => (ort.describe(), model.display().to_string()),
            Err(error) if error.code() == "VAD_MODEL_LOAD_FAILED" && !model_found => {
                (ort.describe(), "not found".to_string())
            }
            Err(error) if error.variant_name() == "OrtPathInvalid" && !ort.is_explicit() => {
                let model_line = if model_found {
                    format!("{} (not loaded: no ONNX Runtime)", model.display())
                } else {
                    "not found".to_string()
                };
                ("not found".to_string(), model_line)
            }
            Err(error) => {
                // The self-test runs from a terminal or CI, with no editor
                // behind it to name.
                return Err(mic_error_message(
                    &CaptureError::from(error),
                    "decibri failed to initialise",
                    &AudioDevice::Default,
                    None,
                ));
            }
        };
        Ok(Report {
            ort: ort_line,
            vad_model: model_line,
        })
    }
}

/// SIGTERM and SIGINT, and the Windows console events that stand in for them.
///
/// The extension's usual shutdown is the `stop` command or closing stdin;
/// these are what a terminal or an operating system shutdown sends instead.
#[cfg(unix)]
mod signals {
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::mpsc::Sender;
    use std::thread;

    use crate::lifecycle::Event;

    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;

    /// The write end of the self-pipe, read by the signal handler.
    static WRITE_FD: AtomicI32 = AtomicI32::new(-1);

    extern "C" {
        fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
        fn pipe(fds: *mut i32) -> i32;
        fn read(fd: i32, buffer: *mut u8, count: usize) -> isize;
        fn write(fd: i32, buffer: *const u8, count: usize) -> isize;
    }

    /// A signal handler may only call async-signal-safe functions, so this
    /// writes one byte to a pipe and does nothing else. Sending on a channel,
    /// allocating, or writing a protocol line here would all be undefined.
    extern "C" fn on_signal(signum: i32) {
        let descriptor = WRITE_FD.load(Ordering::Relaxed);
        if descriptor >= 0 {
            let byte = signum as u8;
            let _ = unsafe { write(descriptor, &byte, 1) };
        }
    }

    pub fn install(events: Sender<Event>) {
        let mut descriptors = [-1i32; 2];
        // Without the pipe there is nothing to wake the reader, so leave the
        // default disposition in place: the process still dies on a signal,
        // it just does not say RELEASED first.
        if unsafe { pipe(descriptors.as_mut_ptr()) } != 0 {
            return;
        }
        let (read_end, write_end) = (descriptors[0], descriptors[1]);
        WRITE_FD.store(write_end, Ordering::Relaxed);

        unsafe {
            signal(SIGTERM, on_signal);
            signal(SIGINT, on_signal);
        }

        thread::spawn(move || {
            let mut failures = 0;
            loop {
                let mut byte = 0u8;
                let count = unsafe { read(read_end, &mut byte, 1) };
                if count == 1 {
                    failures = 0;
                    let name = if i32::from(byte) == SIGINT {
                        "SIGINT"
                    } else {
                        "SIGTERM"
                    };
                    if events.send(Event::Signal(name)).is_err() {
                        return;
                    }
                } else if count == 0 {
                    return;
                } else {
                    // read() was interrupted, most likely by the very signal
                    // that woke it. Retry, but do not spin on a pipe that has
                    // gone bad.
                    failures += 1;
                    if failures > 100 {
                        return;
                    }
                }
            }
        });
    }
}

#[cfg(windows)]
mod signals {
    use std::sync::mpsc::Sender;
    use std::sync::Mutex;

    use crate::lifecycle::Event;

    const TRUE: i32 = 1;
    const FALSE: i32 = 0;
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;
    const CTRL_CLOSE_EVENT: u32 = 2;

    static EVENTS: Mutex<Option<Sender<Event>>> = Mutex::new(None);

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }

    /// Windows runs a console control handler on a thread it creates for the
    /// purpose, so an ordinary channel send is allowed here; a POSIX signal
    /// handler could not do this.
    unsafe extern "system" fn on_console_event(event: u32) -> i32 {
        let name = match event {
            CTRL_C_EVENT => "SIGINT",
            CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT => "SIGTERM",
            _ => return FALSE,
        };
        if let Ok(guard) = EVENTS.lock() {
            if let Some(events) = guard.as_ref() {
                if events.send(Event::Signal(name)).is_ok() {
                    // Handled: the engine says RELEASED and exits on its own.
                    return TRUE;
                }
            }
        }
        FALSE
    }

    /// A child process spawned by the extension host has no console, so this
    /// handler never fires there and the `stop` command and stdin EOF are the
    /// shutdown paths. It is what answers Ctrl-C when the engine is run by
    /// hand in a terminal.
    pub fn install(events: Sender<Event>) {
        if let Ok(mut guard) = EVENTS.lock() {
            *guard = Some(events);
        }
        let _ = unsafe { SetConsoleCtrlHandler(Some(on_console_event), TRUE) };
    }
}

#[cfg(test)]
mod tests {
    use super::DECIBRI_VERSION;

    #[test]
    fn the_reported_decibri_version_is_the_pinned_one() {
        let manifest = include_str!("../Cargo.toml");
        let pin = format!("decibri = {{ version = \"={DECIBRI_VERSION}\"");
        assert!(
            manifest.lines().any(|line| line.starts_with(&pin)),
            "Cargo.toml does not pin decibri {DECIBRI_VERSION}"
        );
    }

    #[test]
    fn the_linked_sherpa_onnx_library_is_the_pinned_version() {
        // The version comes from the C library that was linked in, not from
        // the Rust crate, so this also catches prebuilt libraries of another
        // release being picked up at build time.
        let linked = sherpa_onnx::version();
        let manifest = include_str!("../Cargo.toml");
        let pin = format!("sherpa-onnx = {{ version = \"={linked}\"");
        assert!(
            manifest.lines().any(|line| line.starts_with(&pin)),
            "the linked sherpa-onnx library is {linked}, which Cargo.toml does not pin"
        );
    }
}
