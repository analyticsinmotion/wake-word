//! Microphone capture through decibri, and the loop that gates it.
//!
//! Each microphone gets one thread. The thread builds the voice activity
//! detector, opens the microphone, reports the outcome to the event loop, and
//! then runs the capture loop for that microphone until it is closed. For each
//! 100 ms chunk the loop:
//!
//! 1. scores the chunk's detector feed with Silero. decibri's detector feed is
//!    the resampled mono signal before DC removal, the highpass, and AGC, so
//!    conditioning does not change detection;
//! 2. clamps the delivered chunk (see `crate::samples`);
//! 3. turns the score into speech and silence transitions (see
//!    `crate::hysteresis`);
//! 4. hands the chunk to the gate (see `crate::gate`), which passes it
//!    downstream, holds it as pre-roll, or drops it with the pre-roll.
//!
//! Scoring before gating is what puts the chunk that trips the detector on the
//! right side of the gate: it is delivered with the speech it starts, after
//! the pre-roll that precedes it. That chunk is the last 100 ms of the 500 ms
//! lead-in, so the ring holds the four chunks before it. The Node engine hands
//! its spotter the same five chunks: decibri's Node.js microphone emits a chunk
//! before scoring it, so that engine's five-chunk ring already holds the
//! tripping chunk when speech is declared. The keyword spotter decodes in steps
//! of 320 ms counted from the first sample it is given, so one chunk more or
//! less of lead-in moves every step and changes which phrases complete before
//! a segment ends.
//!
//! Nothing here writes to stdout. Everything a microphone has to say goes back
//! to the event loop as an `Event::Capture` tagged with that microphone's id,
//! and the state machine drops reports from a microphone it has closed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use decibri::{
    DecibriError, DeviceSelector, HighpassFilter, Microphone, MicrophoneConfig, MicrophoneStream,
    SileroVad, VadConfig,
};

use crate::config::AudioDevice;
use crate::gate::VadGate;
use crate::hysteresis::{SpeechHysteresis, Transition};
use crate::lifecycle::{
    CaptureDevice, CaptureReport, Event, OpenRequest, PrepareRequest, Prepared, Spawner,
};
use crate::mic_errors::CaptureError;
use crate::samples::clamp_in_place;
use crate::spotter::{self, SpotterSlot};

/// Capture rate. The keyword spotting model and Silero both take 16 kHz; the
/// device is opened at its native rate and decibri resamples.
pub const SAMPLE_RATE: u32 = 16_000;
/// Samples per chunk: 100 ms at 16 kHz, decibri's default buffer size.
pub const CHUNK_SAMPLES: usize = 1600;
/// AGC target in dBFS: quiet input is driven toward a consistent level, which
/// is the level the keyword threshold is calibrated against.
pub const AGC_TARGET_DBFS: i8 = -18;
/// Lead-in handed to the spotter when speech starts: 5 chunks, 500 ms,
/// counting the chunk that trips the detector.
pub const PREROLL_CHUNKS: usize = 5;
/// Speech probability at or above which a chunk is speech.
pub const SPEECH_THRESHOLD: f32 = 0.5;
/// How long the probability must stay below the threshold before silence,
/// counted from the arrival of the first quiet chunk (see `crate::hysteresis`).
pub const SILENCE_HOLDOFF_MS: u32 = 300;
/// How often debug mode checks the stream's overrun counter.
pub const OVERRUN_CHECK_MS: u64 = 30_000;
/// How long one read waits for a chunk before the loop checks whether its
/// microphone has been closed. This bounds how long a close waits for the
/// capture thread.
const READ_TIMEOUT: Duration = Duration::from_millis(20);
/// Upper bound on how long closing a microphone waits for its capture thread.
/// The thread notices a close within one read timeout plus one Silero
/// inference; the bound only matters if an inference never returns.
const CLOSE_WAIT: Duration = Duration::from_millis(500);

/// The `MicrophoneConfig` the engine opens every microphone with: mono 16 kHz,
/// DC removal, an 80 Hz highpass, and AGC at -18 dBFS. Samples are always
/// `f32` in decibri's Rust API.
pub fn microphone_config(device: &AudioDevice) -> MicrophoneConfig {
    let mut config = MicrophoneConfig::default();
    config.sample_rate = SAMPLE_RATE;
    config.channels = 1;
    config.frames_per_buffer = CHUNK_SAMPLES as u32;
    // Strips a constant offset some capture hardware adds.
    config.dc_removal = true;
    // Removes rumble below the voice band.
    config.highpass = Some(HighpassFilter::Hz80);
    config.agc = Some(AGC_TARGET_DBFS);
    config.device = match device {
        AudioDevice::Default => DeviceSelector::Default,
        AudioDevice::Index(index) => DeviceSelector::Index(*index as usize),
        AudioDevice::Name(name) => DeviceSelector::Name(name.clone()),
    };
    config
}

/// The `VadConfig` for one open.
pub fn vad_config(request: &OpenRequest) -> VadConfig {
    let mut config = VadConfig::default();
    config.model_path = request.vad_model.clone();
    config.sample_rate = SAMPLE_RATE;
    config.threshold = SPEECH_THRESHOLD;
    config.ort_library_path = request.ort_library.clone();
    config
}

/// Where gated audio goes: every chunk of a speech segment in order, then the
/// end of that segment, so two segments are never joined into one phrase. The
/// keyword spotter implements it (see `crate::spotter`).
pub trait SpeechSink: Send {
    fn accept(&mut self, samples: &[f32], report: &mut dyn FnMut(CaptureReport));
    fn end_segment(&mut self, report: &mut dyn FnMut(CaptureReport));
    /// Listening paused: forget everything accepted so far, decoded or not.
    /// Called from the event loop, never from a capture thread.
    fn reset(&mut self);
}

/// One read from a capture stream.
pub enum Read {
    /// A chunk of delivered samples.
    Chunk(Vec<f32>),
    /// Nothing arrived within the timeout; the stream is still open.
    Timeout,
    /// The stream has closed and every buffered sample has been delivered.
    Closed,
}

/// The capture stream, as the loop sees it. `MicrophoneStream` implements it;
/// the tests implement it with a script.
pub trait ChunkSource {
    fn read(&self, samples: usize, timeout: Duration) -> Result<Read, CaptureError>;
    /// The detector's view of a delivered chunk, or `None` when the chunk
    /// itself is what the detector should read.
    fn detector_feed(&self, delivered: &[f32]) -> Option<Vec<f32>>;
    fn overrun_count(&self) -> u64;
    /// Why the stream closed, when a device or driver failure closed it.
    fn take_last_error(&self) -> Option<CaptureError>;
    fn stop(&self);
}

impl ChunkSource for MicrophoneStream {
    fn read(&self, samples: usize, timeout: Duration) -> Result<Read, CaptureError> {
        match self.next_chunk(samples, Some(timeout)) {
            Ok(Some(chunk)) => Ok(Read::Chunk(chunk.data)),
            Ok(None) => Ok(Read::Timeout),
            Err(DecibriError::MicrophoneStreamClosed) => Ok(Read::Closed),
            Err(error) => Err(error.into()),
        }
    }

    fn detector_feed(&self, delivered: &[f32]) -> Option<Vec<f32>> {
        MicrophoneStream::detector_feed(self, delivered)
    }

    fn overrun_count(&self) -> u64 {
        MicrophoneStream::overrun_count(self)
    }

    fn take_last_error(&self) -> Option<CaptureError> {
        MicrophoneStream::take_last_error(self).map(CaptureError::from)
    }

    fn stop(&self) {
        MicrophoneStream::stop(self);
    }
}

/// Scores audio for speech. `SileroVad` implements it.
pub trait SpeechDetector {
    /// The speech probability for these samples, from 0 to 1.
    fn score(&mut self, samples: &[f32]) -> Result<f32, CaptureError>;
}

impl SpeechDetector for SileroVad {
    fn score(&mut self, samples: &[f32]) -> Result<f32, CaptureError> {
        // The detector's own is_speech is not used: the threshold is applied
        // by the hysteresis, together with the holdoff.
        Ok(self.process(samples)?.probability)
    }
}

/// Decides when debug mode reports the overrun count: every
/// [`OVERRUN_CHECK_MS`], and only when the count has changed since the last
/// report. One per microphone, so each microphone counts from zero.
pub struct OverrunReporter {
    next_check: u64,
    reported: u64,
}

impl OverrunReporter {
    pub fn new(now_ms: u64) -> OverrunReporter {
        OverrunReporter {
            next_check: now_ms + OVERRUN_CHECK_MS,
            reported: 0,
        }
    }

    /// The count to report now, if a check is due and it has changed.
    pub fn poll(&mut self, now_ms: u64, count: u64) -> Option<u64> {
        if now_ms < self.next_check {
            return None;
        }
        self.next_check = now_ms + OVERRUN_CHECK_MS;
        if count == self.reported {
            return None;
        }
        self.reported = count;
        Some(count)
    }
}

/// The error reported when a stream ends without a recorded cause.
fn stream_closed() -> CaptureError {
    CaptureError::from(DecibriError::MicrophoneStreamClosed)
}

/// Run one microphone until it is closed or fails.
///
/// `closed` is set by [`CaptureDevice::close`] before it stops the stream.
/// It is checked after every read and again under the sink's lock, so once it
/// is set nothing further reaches the sink, including the tail decibri
/// flushes after the stream stops, and a stream that then reports closed is
/// not taken for a failure.
pub fn run_capture(
    source: &dyn ChunkSource,
    detector: &mut dyn SpeechDetector,
    sink: &Mutex<dyn SpeechSink>,
    closed: &AtomicBool,
    debug: bool,
    now_ms: &dyn Fn() -> u64,
    report: &mut dyn FnMut(CaptureReport),
) {
    // Debug lines are dropped here rather than sent and discarded later, so a
    // capture outside debug mode posts nothing but failures.
    let mut report = |line: CaptureReport| {
        if debug || !matches!(line, CaptureReport::Debug(_)) {
            report(line);
        }
    };
    // The tripping chunk is delivered as the end of the lead-in, so the ring
    // holds one chunk fewer than the lead-in.
    let mut gate: VadGate<Vec<f32>> = VadGate::new(PREROLL_CHUNKS - 1);
    let mut hysteresis = SpeechHysteresis::new(SPEECH_THRESHOLD, SILENCE_HOLDOFF_MS, SAMPLE_RATE);
    let mut overruns = OverrunReporter::new(now_ms());

    loop {
        if closed.load(Ordering::SeqCst) {
            return;
        }
        if debug {
            if let Some(count) = overruns.poll(now_ms(), source.overrun_count()) {
                report(CaptureReport::Debug(format!("overruns: {count}")));
            }
        }

        let read = source.read(CHUNK_SAMPLES, READ_TIMEOUT);
        if closed.load(Ordering::SeqCst) {
            return;
        }
        let mut chunk = match read {
            Ok(Read::Chunk(chunk)) => chunk,
            Ok(Read::Timeout) => continue,
            Ok(Read::Closed) => {
                // Nobody closed this microphone, so the device or its driver
                // did. decibri records the cause when there is one.
                let cause = source.take_last_error().unwrap_or_else(stream_closed);
                report(CaptureReport::Failed(cause));
                return;
            }
            Err(error) => {
                report(CaptureReport::Failed(error));
                source.stop();
                return;
            }
        };

        let scored = match source.detector_feed(&chunk) {
            Some(feed) => detector.score(&feed),
            None => detector.score(&chunk),
        };
        let probability = match scored {
            Ok(probability) => probability,
            Err(error) => {
                report(CaptureReport::Failed(error));
                source.stop();
                return;
            }
        };
        clamp_in_place(&mut chunk);
        let transition = hysteresis.update(probability, chunk.len());

        let mut sink = sink.lock().unwrap_or_else(PoisonError::into_inner);
        if closed.load(Ordering::SeqCst) {
            return;
        }
        match transition {
            Some(Transition::Speech) => {
                // Counted the way the Node engine counts it: the chunks held
                // back, and the chunk that tripped the detector.
                report(CaptureReport::Debug(format!(
                    "VAD: speech ({} pre-roll chunks)",
                    gate.preroll_len() + 1
                )));
                for held in gate.speech_started() {
                    sink.accept(&held, &mut report);
                }
                if let Some(chunk) = gate.push(chunk) {
                    sink.accept(&chunk, &mut report);
                }
            }
            Some(Transition::Silence) => {
                // The chunk that completes the holdoff is the tail of the
                // segment, so it is delivered before the segment ends.
                if let Some(chunk) = gate.push(chunk) {
                    sink.accept(&chunk, &mut report);
                }
                gate.speech_ended();
                report(CaptureReport::Debug("VAD: silence".to_string()));
                sink.end_segment(&mut report);
            }
            None => {
                if let Some(chunk) = gate.push(chunk) {
                    sink.accept(&chunk, &mut report);
                }
            }
        }
    }
}

/// A running decibri microphone, as the state machine holds it.
struct MicrophoneCapture {
    stream: Arc<MicrophoneStream>,
    closed: Arc<AtomicBool>,
    /// Disconnects when the capture thread finishes.
    finished: Receiver<()>,
}

impl CaptureDevice for MicrophoneCapture {
    fn close(&mut self) {
        // The flag goes first: whatever the stream still delivers on its way
        // down, the flushed tail included, is dropped rather than fed onward.
        self.closed.store(true, Ordering::SeqCst);
        self.stream.stop();
        // Waiting for the thread means nothing it holds, the sink included, is
        // touched after close() returns.
        let _ = self.finished.recv_timeout(CLOSE_WAIT);
    }
}

/// Build the detector, then open and start the microphone.
///
/// The detector goes first because it needs no device: a missing ONNX Runtime
/// or model is then reported without a microphone having been opened.
/// decibri initialises ONNX Runtime once per process, on the first detector;
/// every later open only loads the model.
fn open(request: &OpenRequest) -> Result<(Microphone, MicrophoneStream, SileroVad), CaptureError> {
    let detector = SileroVad::new(vad_config(request))?;
    let microphone = Microphone::new(microphone_config(&request.device))?;
    let stream = microphone.start()?;
    Ok((microphone, stream, detector))
}

/// One microphone's thread: open, report, then capture until closed.
fn capture_thread(request: OpenRequest, events: Sender<Event>, sink: Arc<Mutex<dyn SpeechSink>>) {
    let (microphone, stream, mut detector) = match open(&request) {
        Ok(opened) => opened,
        Err(error) => {
            let _ = events.send(Event::CaptureOpened(Err(error)));
            return;
        }
    };

    let stream = Arc::new(stream);
    let closed = Arc::new(AtomicBool::new(false));
    let (finished_sender, finished) = mpsc::channel::<()>();
    let device = MicrophoneCapture {
        stream: Arc::clone(&stream),
        closed: Arc::clone(&closed),
        finished,
    };
    if events
        .send(Event::CaptureOpened(Ok(Box::new(device))))
        .is_err()
    {
        // The event loop has gone, so nothing will ever close this.
        stream.stop();
        return;
    }

    let origin = Instant::now();
    let now_ms = || u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX);
    let id = request.id;
    run_capture(
        &*stream,
        &mut detector,
        &*sink,
        &closed,
        request.debug,
        &now_ms,
        &mut |report| {
            let _ = events.send(Event::Capture { id, report });
        },
    );

    drop(microphone);
    drop(finished_sender);
}

/// Runs preparation and microphone opens for the real engine, and holds the
/// keyword spotter between them.
pub struct ThreadSpawner {
    events: Sender<Event>,
    /// The keyword spotter, once preparation has loaded it. Shared by every
    /// microphone this engine opens, because the spotter outlives a pause.
    /// Only one microphone captures at a time: a microphone's thread has
    /// finished before its close returns.
    spotter: Arc<Mutex<SpotterSlot>>,
}

impl ThreadSpawner {
    pub fn new(events: Sender<Event>) -> ThreadSpawner {
        ThreadSpawner {
            events,
            spotter: Arc::new(Mutex::new(SpotterSlot::default())),
        }
    }
}

impl Spawner for ThreadSpawner {
    /// The transducer loads on a thread of its own, so a `pause` or a `stop`
    /// is still answered while it does.
    fn spawn_prepare(&mut self, request: PrepareRequest) {
        let events = self.events.clone();
        let slot = Arc::clone(&self.spotter);
        thread::spawn(move || {
            let outcome = spotter::prepare_into(&request, &slot, &mut |progress| {
                let _ = events.send(Event::Preparing(progress));
            });
            // Nothing to report means shutdown overtook the load. The event
            // loop is waiting to hear that preparation is over either way.
            let result = outcome.unwrap_or_else(|| Ok(Prepared::default()));
            let _ = events.send(Event::Prepared(result));
        });
    }

    fn spawn_open(&mut self, request: OpenRequest) {
        let events = self.events.clone();
        let sink: Arc<Mutex<dyn SpeechSink>> = self.spotter.clone();
        thread::spawn(move || capture_thread(request, events, sink));
    }

    fn reset_spotter(&mut self) {
        self.spotter
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .reset();
    }

    fn release(&mut self) {
        self.spotter
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::rc::Rc;

    /// One scripted step of a fake stream.
    enum Step {
        /// A chunk whose samples are all `marker`, scored at `probability`.
        Chunk {
            marker: f32,
            probability: f32,
        },
        /// A chunk with the given samples, scored at `probability`.
        Samples {
            samples: Vec<f32>,
            probability: f32,
        },
        Timeout,
        /// The stream closes, recording this cause when there is one.
        Closed(Option<CaptureError>),
        Error(CaptureError),
        /// Set the closed flag, as a close on the event loop thread would, and
        /// then deliver this chunk as the flushed tail.
        CloseThenChunk {
            marker: f32,
        },
    }

    struct FakeSource {
        steps: RefCell<VecDeque<Step>>,
        /// Probabilities for the detector, in chunk order.
        scores: Rc<RefCell<VecDeque<f32>>>,
        /// When set, the detector feed is the chunk with this offset added,
        /// standing in for decibri's pre-conditioning tap.
        feed_offset: Option<f32>,
        last_error: RefCell<Option<CaptureError>>,
        overruns: Cell<u64>,
        stopped: Cell<bool>,
        clock: Rc<Cell<u64>>,
        closed: Arc<AtomicBool>,
    }

    impl FakeSource {
        fn new(steps: Vec<Step>) -> FakeSource {
            FakeSource {
                steps: RefCell::new(steps.into()),
                scores: Rc::new(RefCell::new(VecDeque::new())),
                feed_offset: None,
                last_error: RefCell::new(None),
                overruns: Cell::new(0),
                stopped: Cell::new(false),
                clock: Rc::new(Cell::new(0)),
                closed: Arc::new(AtomicBool::new(false)),
            }
        }

        fn chunk_of(&self, samples: Vec<f32>, probability: f32) -> Result<Read, CaptureError> {
            self.scores.borrow_mut().push_back(probability);
            Ok(Read::Chunk(samples))
        }
    }

    impl ChunkSource for FakeSource {
        fn read(&self, samples: usize, _timeout: Duration) -> Result<Read, CaptureError> {
            // Every read stands for 100 ms of audio.
            self.clock.set(self.clock.get() + 100);
            let Some(step) = self.steps.borrow_mut().pop_front() else {
                return Ok(Read::Closed);
            };
            match step {
                Step::Chunk {
                    marker,
                    probability,
                } => self.chunk_of(vec![marker; samples], probability),
                Step::Samples {
                    samples,
                    probability,
                } => self.chunk_of(samples, probability),
                Step::Timeout => Ok(Read::Timeout),
                Step::Closed(cause) => {
                    *self.last_error.borrow_mut() = cause;
                    Ok(Read::Closed)
                }
                Step::Error(error) => Err(error),
                Step::CloseThenChunk { marker } => {
                    self.closed.store(true, Ordering::SeqCst);
                    self.chunk_of(vec![marker; samples], 0.9)
                }
            }
        }

        fn detector_feed(&self, delivered: &[f32]) -> Option<Vec<f32>> {
            let offset = self.feed_offset?;
            Some(delivered.iter().map(|sample| sample + offset).collect())
        }

        fn overrun_count(&self) -> u64 {
            self.overruns.get()
        }

        fn take_last_error(&self) -> Option<CaptureError> {
            self.last_error.borrow_mut().take()
        }

        fn stop(&self) {
            self.stopped.set(true);
        }
    }

    /// Scores each chunk with the next scripted probability and records the
    /// first sample of what it was given.
    struct FakeDetector {
        scores: Rc<RefCell<VecDeque<f32>>>,
        seen: Vec<f32>,
        fail_on_call: Option<usize>,
    }

    impl SpeechDetector for FakeDetector {
        fn score(&mut self, samples: &[f32]) -> Result<f32, CaptureError> {
            self.seen.push(samples.first().copied().unwrap_or(f32::NAN));
            if self.fail_on_call == Some(self.seen.len()) {
                return Err(CaptureError {
                    code: Some("ORT_INFERENCE_FAILED"),
                    message: "Silero VAD inference failed: boom".to_string(),
                });
            }
            Ok(self.scores.borrow_mut().pop_front().unwrap_or(0.0))
        }
    }

    /// What the sink saw: the first sample of every accepted chunk, and a
    /// marker for each segment end.
    #[derive(Default)]
    struct RecordingSink {
        events: Vec<String>,
        samples: Vec<Vec<f32>>,
    }

    impl SpeechSink for RecordingSink {
        fn accept(&mut self, samples: &[f32], _report: &mut dyn FnMut(CaptureReport)) {
            self.events.push(format!("{}", samples[0]));
            self.samples.push(samples.to_vec());
        }

        fn end_segment(&mut self, report: &mut dyn FnMut(CaptureReport)) {
            self.events.push("end".to_string());
            report(CaptureReport::Debug("sink: segment ended".to_string()));
        }

        fn reset(&mut self) {
            self.events.push("reset".to_string());
        }
    }

    /// A sink that completes a keyword on a chosen chunk, the way the spotter
    /// does, so the loop's handling of a detection can be pinned.
    struct DetectingSink {
        accepted: usize,
        detect_on: usize,
    }

    impl SpeechSink for DetectingSink {
        fn accept(&mut self, _samples: &[f32], report: &mut dyn FnMut(CaptureReport)) {
            self.accepted += 1;
            if self.accepted == self.detect_on {
                report(CaptureReport::Debug("KWS result: {}".to_string()));
                report(CaptureReport::Detected("hey claude".to_string()));
            }
        }

        fn end_segment(&mut self, _report: &mut dyn FnMut(CaptureReport)) {}

        fn reset(&mut self) {}
    }

    /// Run a scripted stream into a [`DetectingSink`] and return the reports.
    fn run_detecting(steps: Vec<Step>, debug: bool, detect_on: usize) -> Vec<CaptureReport> {
        let source = FakeSource::new(steps);
        let sink = Mutex::new(DetectingSink {
            accepted: 0,
            detect_on,
        });
        let mut detector = FakeDetector {
            scores: Rc::clone(&source.scores),
            seen: Vec::new(),
            fail_on_call: None,
        };
        let clock = Rc::clone(&source.clock);
        let closed = Arc::clone(&source.closed);
        let mut reports = Vec::new();
        run_capture(
            &source,
            &mut detector,
            &sink,
            &closed,
            debug,
            &|| clock.get(),
            &mut |report| reports.push(report),
        );
        reports
    }

    struct Run {
        sink: Vec<String>,
        sink_samples: Vec<Vec<f32>>,
        reports: Vec<CaptureReport>,
        detector_saw: Vec<f32>,
        stopped: bool,
    }

    fn run_with(source: FakeSource, debug: bool, fail_on_call: Option<usize>) -> Run {
        let sink = Mutex::new(RecordingSink::default());
        let mut detector = FakeDetector {
            scores: Rc::clone(&source.scores),
            seen: Vec::new(),
            fail_on_call,
        };
        let clock = Rc::clone(&source.clock);
        let closed = Arc::clone(&source.closed);
        let mut reports = Vec::new();
        run_capture(
            &source,
            &mut detector,
            &sink,
            &closed,
            debug,
            &|| clock.get(),
            &mut |report| reports.push(report),
        );
        let sink = sink.into_inner().expect("sink");
        Run {
            sink: sink.events,
            sink_samples: sink.samples,
            reports,
            detector_saw: detector.seen,
            stopped: source.stopped.get(),
        }
    }

    fn run(steps: Vec<Step>) -> Run {
        run_with(FakeSource::new(steps), true, None)
    }

    fn chunk(marker: f32, probability: f32) -> Step {
        Step::Chunk {
            marker,
            probability,
        }
    }

    fn quiet(marker: f32) -> Step {
        chunk(marker, 0.1)
    }

    fn loud(marker: f32) -> Step {
        chunk(marker, 0.9)
    }

    /// Everything but the final report, which for a scripted stream running
    /// out is the closed-stream failure.
    fn debug_lines(run: &Run) -> Vec<String> {
        run.reports
            .iter()
            .filter_map(|report| match report {
                CaptureReport::Debug(line) => Some(line.clone()),
                _ => None,
            })
            .collect()
    }

    fn failures(run: &Run) -> Vec<CaptureError> {
        run.reports
            .iter()
            .filter_map(|report| match report {
                CaptureReport::Failed(error) => Some(error.clone()),
                _ => None,
            })
            .collect()
    }

    /// A stream ending with a close that nobody asked for, which is what
    /// every scripted run below ends with unless it says otherwise.
    fn ends_closed(run: &Run) -> bool {
        matches!(
            run.reports.last(),
            Some(CaptureReport::Failed(CaptureError {
                code: Some("MICROPHONE_STREAM_CLOSED"),
                ..
            }))
        )
    }

    #[test]
    fn opens_the_microphone_with_the_node_engines_options() {
        let config = microphone_config(&AudioDevice::Default);
        assert_eq!(config.sample_rate, 16_000);
        assert_eq!(config.channels, 1);
        assert_eq!(config.frames_per_buffer, 1600);
        assert!(config.dc_removal);
        assert_eq!(config.highpass, Some(HighpassFilter::Hz80));
        assert_eq!(config.agc, Some(-18));
        assert!(matches!(config.device, DeviceSelector::Default));
        assert_eq!(config.limiter, None, "the engine clamps instead");
    }

    #[test]
    fn selects_a_device_by_index_or_by_name() {
        let by_index = microphone_config(&AudioDevice::Index(3));
        assert!(matches!(by_index.device, DeviceSelector::Index(3)));
        let by_name = microphone_config(&AudioDevice::Name("Desk Mic".to_string()));
        assert!(matches!(by_name.device, DeviceSelector::Name(ref name) if name == "Desk Mic"));
    }

    #[test]
    fn builds_the_detector_with_the_requested_model_and_runtime() {
        let request = OpenRequest {
            id: 1,
            device: AudioDevice::Default,
            vad_model: PathBuf::from("/m/silero_vad.onnx"),
            ort_library: Some(PathBuf::from("/o/ort.so")),
            debug: false,
        };
        let config = vad_config(&request);
        assert_eq!(config.model_path, PathBuf::from("/m/silero_vad.onnx"));
        assert_eq!(config.ort_library_path, Some(PathBuf::from("/o/ort.so")));
        assert_eq!(config.sample_rate, 16_000);
        assert!((config.threshold - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn holds_silent_chunks_and_flushes_them_ahead_of_the_chunk_that_trips_speech() {
        let run = run(vec![quiet(0.01), quiet(0.02), loud(0.03), loud(0.04)]);
        assert_eq!(run.sink, ["0.01", "0.02", "0.03", "0.04"]);
        assert_eq!(debug_lines(&run), ["VAD: speech (3 pre-roll chunks)"]);
        assert!(ends_closed(&run));
    }

    #[test]
    fn hands_over_five_chunks_of_lead_in_counting_the_one_that_trips_speech() {
        let steps: Vec<Step> = (1..=8)
            .map(|index| quiet(index as f32 / 100.0))
            .chain([loud(0.5)])
            .collect();
        let run = run(steps);
        assert_eq!(run.sink, ["0.05", "0.06", "0.07", "0.08", "0.5"]);
        assert_eq!(debug_lines(&run), ["VAD: speech (5 pre-roll chunks)"]);
    }

    #[test]
    fn ends_the_segment_after_the_holdoff_and_delivers_the_quiet_tail_first() {
        // Four quiet chunks follow the speech into the sink before the
        // segment ends: the one that starts the holdoff and the 300 ms after
        // it. The fifth is held as pre-roll for whatever comes next.
        let run = run(vec![
            loud(0.1),
            quiet(0.2),
            quiet(0.3),
            quiet(0.4),
            quiet(0.5),
            quiet(0.6),
        ]);
        assert_eq!(run.sink, ["0.1", "0.2", "0.3", "0.4", "0.5", "end"]);
        assert_eq!(
            debug_lines(&run),
            [
                "VAD: speech (1 pre-roll chunks)",
                "VAD: silence",
                "sink: segment ended"
            ]
        );
    }

    #[test]
    fn runs_several_segments_without_delivering_a_chunk_twice() {
        let run = run(vec![
            quiet(0.01),
            loud(0.02),
            quiet(0.03),
            quiet(0.04),
            quiet(0.05),
            quiet(0.06),
            quiet(0.07),
            loud(0.08),
            quiet(0.09),
            quiet(0.10),
            quiet(0.11),
            quiet(0.12),
        ]);
        assert_eq!(
            run.sink,
            [
                "0.01", "0.02", "0.03", "0.04", "0.05", "0.06", "end", "0.07", "0.08", "0.09",
                "0.1", "0.11", "0.12", "end"
            ]
        );
    }

    #[test]
    fn reports_nothing_but_failures_outside_debug_mode() {
        let run = run_with(
            FakeSource::new(vec![
                loud(0.1),
                quiet(0.2),
                quiet(0.3),
                quiet(0.4),
                quiet(0.5),
            ]),
            false,
            None,
        );
        assert!(debug_lines(&run).is_empty());
        assert_eq!(run.sink, ["0.1", "0.2", "0.3", "0.4", "0.5", "end"]);
        assert!(ends_closed(&run));
    }

    #[test]
    fn clamps_what_it_delivers_but_scores_the_unclamped_feed() {
        let run = run(vec![Step::Samples {
            samples: vec![2.0, -3.0, f32::NAN, 0.25],
            probability: 0.9,
        }]);
        assert_eq!(run.sink_samples, [vec![1.0, -1.0, 0.0, 0.25]]);
        assert_eq!(run.detector_saw, [2.0]);
    }

    #[test]
    fn scores_the_detector_feed_when_the_stream_provides_one() {
        let mut source = FakeSource::new(vec![loud(0.25)]);
        source.feed_offset = Some(0.5);
        let run = run_with(source, true, None);
        assert_eq!(run.detector_saw, [0.75]);
        assert_eq!(
            run.sink,
            ["0.25"],
            "the delivered chunk is what goes downstream"
        );
    }

    #[test]
    fn scores_the_chunk_itself_when_there_is_no_separate_feed() {
        let run = run(vec![loud(0.25)]);
        assert_eq!(run.detector_saw, [0.25]);
    }

    #[test]
    fn keeps_reading_through_timeouts() {
        let run = run(vec![Step::Timeout, loud(0.1), Step::Timeout, loud(0.2)]);
        assert_eq!(run.sink, ["0.1", "0.2"]);
    }

    #[test]
    fn reports_a_stream_that_closes_mid_capture_with_its_recorded_cause() {
        let cause = CaptureError {
            code: Some("DEVICE_FAILED"),
            message: "decibri: audio device error: unplugged".to_string(),
        };
        let run = run(vec![
            loud(0.1),
            Step::Closed(Some(cause.clone())),
            loud(0.2),
        ]);
        assert_eq!(failures(&run), [cause]);
        assert_eq!(run.sink, ["0.1"], "nothing is read after the close");
    }

    #[test]
    fn reports_a_stream_that_closes_mid_capture_with_no_recorded_cause() {
        let run = run(vec![loud(0.1), Step::Closed(None)]);
        assert_eq!(failures(&run), [stream_closed()]);
        assert_eq!(failures(&run)[0].code, Some("MICROPHONE_STREAM_CLOSED"));
    }

    #[test]
    fn reports_a_read_error_and_stops_the_stream() {
        let error = CaptureError::uncoded("read failed");
        let run = run(vec![loud(0.1), Step::Error(error.clone())]);
        assert_eq!(failures(&run), [error]);
        assert!(run.stopped);
    }

    #[test]
    fn a_closed_microphone_delivers_nothing_more_and_reports_no_failure() {
        let run = run(vec![
            loud(0.1),
            Step::CloseThenChunk { marker: 0.2 },
            loud(0.3),
            Step::Closed(None),
        ]);
        assert_eq!(run.sink, ["0.1"], "the flushed tail is dropped");
        assert!(failures(&run).is_empty(), "a close is not a failure");
    }

    #[test]
    fn a_microphone_closed_before_the_first_read_does_nothing() {
        let source = FakeSource::new(vec![loud(0.1)]);
        source.closed.store(true, Ordering::SeqCst);
        let run = run_with(source, true, None);
        assert!(run.sink.is_empty());
        assert!(run.reports.is_empty());
    }

    #[test]
    fn reports_a_detector_failure_and_stops_the_stream() {
        let run = run_with(
            FakeSource::new(vec![loud(0.1), loud(0.2), loud(0.3)]),
            true,
            Some(2),
        );
        assert_eq!(run.sink, ["0.1"]);
        let failed = failures(&run);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].code, Some("ORT_INFERENCE_FAILED"));
        assert!(run.stopped);
    }

    #[test]
    fn reports_overruns_every_thirty_seconds_only_when_the_count_changed() {
        // 700 reads of 100 ms each is 70 seconds: checks fall at 30 s and 60 s.
        let steps: Vec<Step> = (0..700).map(|_| Step::Timeout).collect();
        let source = FakeSource::new(steps);
        source.overruns.set(3);
        let run = run_with(source, true, None);
        assert_eq!(
            debug_lines(&run),
            ["overruns: 3"],
            "reported once, not twice"
        );
    }

    #[test]
    fn does_not_report_overruns_outside_debug_mode() {
        let steps: Vec<Step> = (0..400).map(|_| Step::Timeout).collect();
        let source = FakeSource::new(steps);
        source.overruns.set(3);
        let run = run_with(source, false, None);
        assert!(debug_lines(&run).is_empty());
    }

    #[test]
    fn the_overrun_reporter_waits_thirty_seconds_and_reports_only_changes() {
        let mut reporter = OverrunReporter::new(1_000);
        assert_eq!(reporter.poll(30_999, 5), None, "not due yet");
        assert_eq!(reporter.poll(31_000, 0), None, "due, but nothing to say");
        assert_eq!(reporter.poll(45_000, 2), None, "the next check is at 61 s");
        assert_eq!(reporter.poll(61_000, 2), Some(2));
        assert_eq!(
            reporter.poll(91_000, 2),
            None,
            "unchanged since the last report"
        );
        assert_eq!(reporter.poll(121_000, 7), Some(7));
    }

    #[test]
    fn passes_a_detection_on_whether_or_not_debug_mode_is_on() {
        let steps = || vec![loud(0.1), loud(0.2), loud(0.3)];
        let detected = CaptureReport::Detected("hey claude".to_string());

        let quiet = run_detecting(steps(), false, 2);
        assert_eq!(
            quiet
                .iter()
                .filter(|report| !matches!(report, CaptureReport::Failed(_)))
                .collect::<Vec<_>>(),
            [&detected],
            "outside debug mode the detection is all that is said"
        );

        let debug = run_detecting(steps(), true, 2);
        assert_eq!(
            debug[..3],
            [
                CaptureReport::Debug("VAD: speech (1 pre-roll chunks)".to_string()),
                CaptureReport::Debug("KWS result: {}".to_string()),
                detected,
            ]
        );
    }

    #[test]
    fn a_detection_in_the_pre_roll_is_reported_while_the_ring_is_flushed() {
        // The phrase can finish inside the audio held back as pre-roll, so
        // the sink must be able to report from the flush itself.
        let reports = run_detecting(vec![quiet(0.01), quiet(0.02), loud(0.03)], false, 1);
        assert_eq!(
            reports.first(),
            Some(&CaptureReport::Detected("hey claude".to_string()))
        );
    }
}
