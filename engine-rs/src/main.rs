//! `wake-word-engine`: the child process the Wake Word extension talks to.
//!
//! Replaces `engine/audio-engine.js` and speaks the same protocol, word for
//! word. The extension writes a JSON config line to stdin, then `pause`,
//! `resume`, and `stop` commands; the engine answers on stdout with `READY`,
//! `DETECTED:<phrase>`, `PAUSED`, `RELEASED`, `ERROR:<msg>`, and, in debug
//! mode, `DEBUG:<msg>`.
//!
//! This relay is the skeleton: the protocol, the config parser, and the
//! lifecycle state machine. There is no audio capture and no keyword spotting
//! yet, so no `DETECTED` line is ever written. The Node engine in `engine/` is
//! still the engine the extension runs, and it is untouched.
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
//! The slow steps (preparation, opening the capture device) run on short-lived
//! threads of their own and report back through the same channel, which is
//! what lets a `pause` or a `stop` be answered while an open is still in
//! flight.

mod config;
mod lifecycle;
mod protocol;

use std::io::{self, Read};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use lifecycle::{Event, Lifecycle, MonotonicClock, ThreadSpawner};
use protocol::{flush_and_exit, LineSplitter, Reporter, StdoutSink};

/// How long shutdown waits for a capture device that is still opening, so it
/// can be closed rather than left to the operating system to reclaim.
/// `RELEASED` has already been written by then, so nothing the extension is
/// waiting for is held up.
const SHUTDOWN_DRAIN_MS: u64 = 250;

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
            drain_open_in_flight(&mut engine, &incoming);
            flush_and_exit(code);
        }
    }
}

/// Confirm the engine runs on this platform and exit.
///
/// CI runs this on every target. Relays 2 and 3 add the decibri and
/// sherpa-onnx load checks here, which is where a missing shared library or a
/// bad build shows up; the Node engine's equivalent caught exactly that
/// failure twice.
fn run_self_test() -> ! {
    let mut out = Reporter::new(Box::new(StdoutSink));
    match self_test_checks() {
        Ok(()) => {
            out.self_test("OK");
            out.self_test(&format!(
                "platform={}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            out.self_test(&format!("version={}", env!("CARGO_PKG_VERSION")));
            flush_and_exit(0)
        }
        Err(message) => {
            out.self_test(&format!("FAIL:{message}"));
            flush_and_exit(1)
        }
    }
}

/// What the self-test actually checks. Nothing yet: this relay links no audio
/// or model libraries, so running at all is the whole test.
fn self_test_checks() -> Result<(), String> {
    Ok(())
}

/// Read stdin and post one event per complete line, then one for EOF.
///
/// A trailing partial line at EOF is dropped, as it is in the Node engine: an
/// unterminated line is not a command.
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

/// Wait briefly for a capture device that was still opening when shutdown
/// started, so the state machine can close it.
fn drain_open_in_flight(engine: &mut Lifecycle, incoming: &Receiver<Event>) {
    if !engine.open_in_flight() {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(SHUTDOWN_DRAIN_MS);

    while engine.open_in_flight() {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return;
        };
        match incoming.recv_timeout(remaining) {
            Ok(opened @ Event::CaptureOpened(_)) => engine.handle(opened),
            // A command or a signal after shutdown changes nothing.
            Ok(_) => {}
            Err(_) => return,
        }
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
