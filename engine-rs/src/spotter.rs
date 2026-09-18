//! The keyword spotter: the decode loop, the sherpa-onnx engine underneath it,
//! and the preparation step that builds both.
//!
//! Port of `engine/lib/spotter.js` and of the model half of `main()` in
//! `engine/audio-engine.js`.
//!
//! The model is a streaming transducer. It is loaded once and kept for the life
//! of the process; what changes is its stream, the decoding state for the audio
//! fed so far. The stream is restarted in three places, and each one exists to
//! stop audio from two different moments being read as one phrase:
//!
//! - after a detection, so one utterance is reported once and the next search
//!   starts clean;
//! - at the end of a speech segment, so the two sides of a silence are never
//!   spliced together into a phrase nobody said in one breath;
//! - on a pause, where the stream is replaced rather than reset. A reset starts
//!   a new search but leaves audio the stream has accepted and not yet decoded
//!   in place, and that audio would be decoded ahead of whatever is heard after
//!   the resume. A new stream holds nothing from before the pause.
//!
//! The spotter reports a keyword as the decoded text of its pieces, so a hit is
//! mapped back to the configured phrase through the lookup the keyword builder
//! made. A keyword with no entry is dropped, and the search still restarts.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use sherpa_onnx::OnlineTransducerModelConfig;
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig, OnlineStream};

use crate::capture::{SpeechSink, SAMPLE_RATE};
use crate::keywords::{build_keyword_spec, KeywordSpec, PhraseMap};
use crate::lifecycle::{CaptureReport, PrepareError, PrepareProgress, PrepareRequest, Prepared};
use crate::protocol::js_trim;
use crate::tokeniser::{Tokeniser, TOKENISER_MODEL_FILE};

/// The transducer's three networks, int8 quantised, and its token table.
pub const ENCODER_FILE: &str = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const DECODER_FILE: &str = "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const JOINER_FILE: &str = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const TOKENS_FILE: &str = "tokens.txt";

/// Mel filterbank bins per frame, which is what the model was trained on.
pub const FEATURE_DIM: i32 = 80;
/// Hypotheses kept alive during the search.
pub const MAX_ACTIVE_PATHS: i32 = 4;
/// Blank frames that must follow a keyword's last piece before it is reported.
pub const NUM_TRAILING_BLANKS: i32 = 1;
/// The spotter-wide boost. Every keyword line carries its own, so this is only
/// what a line without one would get.
pub const KEYWORDS_SCORE: f32 = 1.0;

/// A keyword the spotter has completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeywordHit {
    /// The decoded text of the keyword's pieces.
    pub keyword: String,
    /// The spotter's full result, for the debug log.
    pub json: String,
}

/// The keyword spotting engine, as the decode loop drives it. sherpa-onnx
/// implements it in the binary and a script implements it in the tests.
pub trait KeywordEngine: Send {
    /// Append audio to the stream.
    fn accept_waveform(&mut self, sample_rate: i32, samples: &[f32]);
    /// True while the stream holds enough audio for another decode step.
    fn is_ready(&mut self) -> bool;
    /// Run one decode step.
    fn decode(&mut self);
    /// The keyword the stream has completed, if it has completed one.
    fn result(&mut self) -> Option<KeywordHit>;
    /// Start a new search on the same stream.
    fn reset(&mut self);
    /// Discard the stream and start a new one that has accepted nothing.
    fn replace_stream(&mut self);
}

/// The decode loop and the lookup from a decoded keyword to its phrase.
pub struct Spotter {
    engine: Box<dyn KeywordEngine>,
    phrase_map: PhraseMap,
}

impl Spotter {
    pub fn new(engine: Box<dyn KeywordEngine>, phrase_map: PhraseMap) -> Spotter {
        Spotter { engine, phrase_map }
    }
}

impl SpeechSink for Spotter {
    /// Feed one chunk and report every keyword it completes.
    fn accept(&mut self, samples: &[f32], report: &mut dyn FnMut(CaptureReport)) {
        self.engine.accept_waveform(SAMPLE_RATE as i32, samples);

        while self.engine.is_ready() {
            self.engine.decode();
            let Some(hit) = self.engine.result() else {
                continue;
            };
            match self.phrase_map.get(js_trim(&hit.keyword)) {
                Some(phrase) => {
                    report(CaptureReport::Debug(format!("KWS result: {}", hit.json)));
                    report(CaptureReport::Detected(phrase.to_string()));
                }
                None => report(CaptureReport::Debug(format!(
                    "Unmatched KWS result: {}",
                    hit.json
                ))),
            }
            self.engine.reset();
        }
    }

    fn end_segment(&mut self, _report: &mut dyn FnMut(CaptureReport)) {
        self.engine.reset();
    }

    fn reset(&mut self) {
        self.engine.replace_stream();
    }
}

/// Where the spotter lives once it is built.
///
/// The capture threads feed it, the event loop resets it on a pause, and the
/// preparation thread is what puts it there, so it sits behind one lock. Until
/// the spotter arrives, and after it has been released, audio is dropped.
#[derive(Default)]
pub struct SpotterSlot {
    spotter: Option<Spotter>,
    /// Shutdown has started: a spotter that arrives now is dropped instead of
    /// kept, and preparation stops at its next step.
    released: bool,
}

impl SpotterSlot {
    /// Keep the spotter, unless the engine is already shutting down.
    fn install(&mut self, spotter: Spotter) {
        if !self.released {
            self.spotter = Some(spotter);
        }
    }

    /// Drop the spotter and refuse any that arrives later.
    pub fn release(&mut self) {
        self.released = true;
        self.spotter = None;
    }

    pub fn is_released(&self) -> bool {
        self.released
    }
}

impl SpeechSink for SpotterSlot {
    fn accept(&mut self, samples: &[f32], report: &mut dyn FnMut(CaptureReport)) {
        if let Some(spotter) = self.spotter.as_mut() {
            spotter.accept(samples, report);
        }
    }

    fn end_segment(&mut self, report: &mut dyn FnMut(CaptureReport)) {
        if let Some(spotter) = self.spotter.as_mut() {
            spotter.end_segment(report);
        }
    }

    fn reset(&mut self) {
        if let Some(spotter) = self.spotter.as_mut() {
            spotter.reset();
        }
    }
}

/// The spotter configuration.
///
/// Every value is the one the Node engine passes to `createKws()`, so the
/// model, the keyword lines, the boost, and the thresholds mean the same thing
/// in both engines. The keyword lines are handed over in memory; nothing is
/// written to disk.
///
/// `keywords_threshold` is the spotter-wide trigger threshold. Every keyword
/// line carries its own `#` threshold, which replaces it, so the value decides
/// nothing; it is passed because a line without the field would fall back to
/// it. `modeling_unit` and `bpe_vocab` are validated by the library and are
/// otherwise unused by the keyword spotter, which expects lines that are
/// already tokenised.
pub fn spotter_config(model_dir: &str, threshold: f64, keywords: &str) -> KeywordSpotterConfig {
    let file = |name: &str| {
        Some(
            Path::new(model_dir)
                .join(name)
                .to_string_lossy()
                .into_owned(),
        )
    };
    let mut feat_config = KeywordSpotterConfig::default().feat_config;
    feat_config.sample_rate = SAMPLE_RATE as i32;
    feat_config.feature_dim = FEATURE_DIM;

    KeywordSpotterConfig {
        feat_config,
        model_config: OnlineModelConfig {
            transducer: OnlineTransducerModelConfig {
                encoder: file(ENCODER_FILE),
                decoder: file(DECODER_FILE),
                joiner: file(JOINER_FILE),
            },
            tokens: file(TOKENS_FILE),
            provider: Some("cpu".to_string()),
            num_threads: 1,
            modeling_unit: Some("bpe".to_string()),
            bpe_vocab: file(TOKENISER_MODEL_FILE),
            debug: false,
            ..OnlineModelConfig::default()
        },
        max_active_paths: MAX_ACTIVE_PATHS,
        num_trailing_blanks: NUM_TRAILING_BLANKS,
        keywords_score: KEYWORDS_SCORE,
        keywords_threshold: threshold as f32,
        keywords_file: None,
        keywords_buf: Some(keywords.to_string()),
    }
}

/// The first of the files the spotter loads that is not in the model
/// directory, if any is missing. Checked before anything is read, so a partial
/// model directory is reported the same way whichever file is absent.
fn missing_model_file(model_dir: &str) -> Option<PathBuf> {
    [
        ENCODER_FILE,
        DECODER_FILE,
        JOINER_FILE,
        TOKENS_FILE,
        TOKENISER_MODEL_FILE,
    ]
    .iter()
    .map(|name| Path::new(model_dir).join(name))
    .find(|path| !path.is_file())
}

/// The sherpa-onnx keyword spotter and its current stream.
struct SherpaEngine {
    // Declared before the spotter so that it is dropped first: a stream must
    // not outlive the spotter that created it.
    stream: OnlineStream,
    spotter: KeywordSpotter,
}

impl SherpaEngine {
    /// Load the model and create the first stream.
    fn create(model_dir: &str, threshold: f64, keywords: &str) -> Result<SherpaEngine, String> {
        // The bindings turn every string into a C string and panic on an
        // interior NUL, which a phrase or a path from the config line can
        // carry.
        if model_dir.contains('\0') {
            return Err("the model directory path contains a NUL character".to_string());
        }
        if keywords.contains('\0') {
            return Err("a phrase contains a NUL character".to_string());
        }
        if let Some(path) = missing_model_file(model_dir) {
            return Err(format!("{} does not exist", path.display()));
        }

        let config = spotter_config(model_dir, threshold, keywords);
        // The library reports what it objected to on stderr, which the
        // extension forwards to its log.
        let spotter = KeywordSpotter::create(&config)
            .ok_or_else(|| "sherpa-onnx rejected the spotter configuration".to_string())?;
        let stream = spotter.create_stream();
        Ok(SherpaEngine { stream, spotter })
    }
}

impl KeywordEngine for SherpaEngine {
    fn accept_waveform(&mut self, sample_rate: i32, samples: &[f32]) {
        self.stream.accept_waveform(sample_rate, samples);
    }

    fn is_ready(&mut self) -> bool {
        self.spotter.is_ready(&self.stream)
    }

    fn decode(&mut self) {
        self.spotter.decode(&self.stream);
    }

    fn result(&mut self) -> Option<KeywordHit> {
        let result = self.spotter.get_result(&self.stream)?;
        if result.keyword.is_empty() {
            return None;
        }
        Some(KeywordHit {
            keyword: result.keyword,
            json: result.json,
        })
    }

    fn reset(&mut self) {
        self.spotter.reset(&self.stream);
    }

    fn replace_stream(&mut self) {
        self.stream = self.spotter.create_stream();
    }
}

/// A loaded tokeniser: upper-cased phrase in, pieces out.
pub type Encoder = Box<dyn Fn(&str) -> Result<Vec<String>, String>>;

/// What preparation loads from the model directory, so a test can stand in
/// for all of it.
pub trait PrepareBackend {
    fn load_tokeniser(&self, model_dir: &str) -> Result<Encoder, String>;
    /// Every token in the model's token table.
    fn load_vocabulary(&self, model_dir: &str) -> Result<HashSet<String>, String>;
    fn create_engine(
        &self,
        model_dir: &str,
        threshold: f64,
        keywords: &str,
    ) -> Result<Box<dyn KeywordEngine>, String>;
}

/// SentencePiece and sherpa-onnx.
pub struct ModelBackend;

impl PrepareBackend for ModelBackend {
    fn load_tokeniser(&self, model_dir: &str) -> Result<Encoder, String> {
        let tokeniser = Tokeniser::load(model_dir)?;
        Ok(Box::new(move |text| tokeniser.encode_pieces(text)))
    }

    fn load_vocabulary(&self, model_dir: &str) -> Result<HashSet<String>, String> {
        if let Some(path) = missing_model_file(model_dir) {
            return Err(format!("{} does not exist", path.display()));
        }
        let path = Path::new(model_dir).join(TOKENS_FILE);
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        Ok(parse_vocabulary(&text))
    }

    fn create_engine(
        &self,
        model_dir: &str,
        threshold: f64,
        keywords: &str,
    ) -> Result<Box<dyn KeywordEngine>, String> {
        SherpaEngine::create(model_dir, threshold, keywords)
            .map(|engine| Box::new(engine) as Box<dyn KeywordEngine>)
    }
}

/// The tokens of a `tokens.txt`: one `<token> <id>` pair per line.
fn parse_vocabulary(tokens_txt: &str) -> HashSet<String> {
    tokens_txt
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').rsplit_once(' '))
        .map(|(token, _id)| token.to_string())
        .collect()
}

/// Refuse a phrase the spotter cannot take.
///
/// The spotter looks every piece of a keyword line up in the model's token
/// table. The tokeniser returns text the model does not cover as itself, a
/// digit or an accented letter for instance, and such a piece is not in the
/// table. The library does not report that as an error: it ends the process
/// from inside the call that creates the spotter, so nothing is written for
/// the extension to show. Checking first turns it into an ordinary fatal error
/// that names the phrase.
fn check_pieces(spec: &KeywordSpec, vocabulary: &HashSet<String>) -> Result<(), String> {
    for detail in &spec.details {
        if let Some(piece) = detail
            .tokens
            .split(' ')
            .find(|piece| !vocabulary.contains(*piece))
        {
            return Err(format!(
                "the phrase {:?} cannot be spotted: {piece:?} is not in the model's vocabulary",
                detail.phrase
            ));
        }
    }
    Ok(())
}

/// Load the tokeniser, build the keyword lines, and load the model.
///
/// The order is the Node engine's, and so is where each failure lands: a
/// tokeniser that cannot load is a startup error, no usable phrase is refused
/// once the phrases have been tokenised, and a model that cannot load says so.
/// `progress` carries the debug lines and the phase timings as they happen.
///
/// Returns `Ok(None)` when `cancelled` said so before the model load, which is
/// the expensive step: a shutdown that has already been acknowledged should not
/// be followed by loading a transducer.
pub fn prepare(
    request: &PrepareRequest,
    backend: &dyn PrepareBackend,
    now_ms: &dyn Fn() -> u64,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(PrepareProgress),
) -> Result<Option<(Spotter, Prepared)>, PrepareError> {
    let timed = |phase: &'static str, since: u64, progress: &mut dyn FnMut(PrepareProgress)| {
        progress(PrepareProgress::Timing {
            phase,
            elapsed_ms: now_ms().saturating_sub(since),
        });
    };

    let since = now_ms();
    let encode = backend
        .load_tokeniser(&request.model_dir)
        .map_err(PrepareError::Startup)?;
    timed("bpe-load", since, progress);

    if cancelled() {
        return Ok(None);
    }

    let since = now_ms();
    let spec = build_keyword_spec(&request.phrases, &*encode, request.threshold)
        .map_err(PrepareError::Startup)?;
    timed("tokenise", since, progress);

    for detail in &spec.details {
        progress(PrepareProgress::Debug(format!(
            "phrase: {} -> tokens: {} -> decoded: {}",
            detail.phrase, detail.tokens, detail.decoded
        )));
    }
    if spec.keyword_lines.is_empty() {
        return Err(PrepareError::NoValidPhrases);
    }

    progress(PrepareProgress::Debug(
        "loading sherpa-onnx KWS model...".to_string(),
    ));
    let since = now_ms();
    let vocabulary = backend
        .load_vocabulary(&request.model_dir)
        .map_err(PrepareError::ModelLoad)?;
    check_pieces(&spec, &vocabulary).map_err(PrepareError::ModelLoad)?;
    let engine = backend
        .create_engine(&request.model_dir, request.threshold, &spec.keywords())
        .map_err(PrepareError::ModelLoad)?;
    timed("model-load", since, progress);

    let prepared = Prepared {
        listening_for: spec
            .phrase_map
            .phrases()
            .into_iter()
            .map(str::to_string)
            .collect(),
    };
    Ok(Some((Spotter::new(engine, spec.phrase_map), prepared)))
}

/// Run [`prepare`] against the real model and put the spotter in its slot.
///
/// Returns what the event loop should be told, or `None` when shutdown had
/// already started and there is nothing left to say.
pub fn prepare_into(
    request: &PrepareRequest,
    slot: &Arc<Mutex<SpotterSlot>>,
    progress: &mut dyn FnMut(PrepareProgress),
) -> Option<Result<Prepared, PrepareError>> {
    let origin = Instant::now();
    let now_ms = || u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX);
    let cancelled = || {
        slot.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_released()
    };

    match prepare(request, &ModelBackend, &now_ms, &cancelled, progress) {
        Ok(Some((spotter, prepared))) => {
            slot.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .install(spotter);
            Some(Ok(prepared))
        }
        Ok(None) => None,
        Err(error) => Some(Err(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// What a scripted engine was asked to do, in order.
    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Accept { rate: i32, first: f32, len: usize },
        Decode,
        Reset,
        ReplaceStream,
    }

    /// A stand-in for the sherpa-onnx spotter. Every accepted chunk makes one
    /// decode step ready, and `script` is the keyword each decode step
    /// completes, in order, with an empty string for none.
    struct ScriptedEngine {
        script: Vec<&'static str>,
        pending: usize,
        calls: Arc<Mutex<Vec<Call>>>,
    }

    impl KeywordEngine for ScriptedEngine {
        fn accept_waveform(&mut self, sample_rate: i32, samples: &[f32]) {
            self.pending += 1;
            self.calls.lock().expect("calls").push(Call::Accept {
                rate: sample_rate,
                first: samples.first().copied().unwrap_or(f32::NAN),
                len: samples.len(),
            });
        }

        fn is_ready(&mut self) -> bool {
            self.pending > 0
        }

        fn decode(&mut self) {
            self.pending -= 1;
            self.calls.lock().expect("calls").push(Call::Decode);
        }

        fn result(&mut self) -> Option<KeywordHit> {
            if self.script.is_empty() {
                return None;
            }
            let keyword = self.script.remove(0);
            (!keyword.is_empty()).then(|| KeywordHit {
                keyword: keyword.to_string(),
                json: format!("{{\"keyword\":\"{keyword}\"}}"),
            })
        }

        fn reset(&mut self) {
            self.calls.lock().expect("calls").push(Call::Reset);
        }

        fn replace_stream(&mut self) {
            self.pending = 0;
            self.calls.lock().expect("calls").push(Call::ReplaceStream);
        }
    }

    struct Rig {
        spotter: Spotter,
        calls: Arc<Mutex<Vec<Call>>>,
        reports: Vec<CaptureReport>,
    }

    impl Rig {
        fn new(script: &[&'static str]) -> Rig {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let engine = ScriptedEngine {
                script: script.to_vec(),
                pending: 0,
                calls: Arc::clone(&calls),
            };
            let encode = |text: &str| -> Result<Vec<String>, String> {
                Ok(text
                    .split(' ')
                    .map(|word| format!("\u{2581}{word}"))
                    .collect())
            };
            let spec = build_keyword_spec(
                &["Hey Claude".to_string(), "open chat".to_string()],
                &encode,
                0.05,
            )
            .expect("spec");
            Rig {
                spotter: Spotter::new(Box::new(engine), spec.phrase_map),
                calls,
                reports: Vec::new(),
            }
        }

        fn accept(&mut self, marker: f32) {
            let reports = &mut self.reports;
            self.spotter
                .accept(&[marker; 1600], &mut |report| reports.push(report));
        }

        fn end_segment(&mut self) {
            let reports = &mut self.reports;
            self.spotter.end_segment(&mut |report| reports.push(report));
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().expect("calls").clone()
        }

        fn detections(&self) -> Vec<String> {
            self.reports
                .iter()
                .filter_map(|report| match report {
                    CaptureReport::Detected(phrase) => Some(phrase.clone()),
                    _ => None,
                })
                .collect()
        }
    }

    fn accept(first: f32) -> Call {
        Call::Accept {
            rate: 16_000,
            first,
            len: 1600,
        }
    }

    #[test]
    fn feeds_chunks_to_the_stream_in_order_at_16_khz_and_decodes_each() {
        let mut rig = Rig::new(&[]);
        rig.accept(0.1);
        rig.accept(0.2);
        rig.accept(0.3);
        assert_eq!(
            rig.calls(),
            [
                accept(0.1),
                Call::Decode,
                accept(0.2),
                Call::Decode,
                accept(0.3),
                Call::Decode
            ]
        );
        assert!(rig.reports.is_empty());
    }

    #[test]
    fn decodes_while_the_stream_is_ready_not_once_per_chunk() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let engine = ScriptedEngine {
            script: Vec::new(),
            pending: 2,
            calls: Arc::clone(&calls),
        };
        let mut spotter = Spotter::new(Box::new(engine), PhraseMap::default());
        spotter.accept(&[0.0; 1600], &mut |_| {});
        let decodes = calls
            .lock()
            .expect("calls")
            .iter()
            .filter(|call| **call == Call::Decode)
            .count();
        assert_eq!(decodes, 3, "two steps were waiting and the chunk added one");
    }

    #[test]
    fn reports_the_configured_phrase_for_a_decoded_keyword_then_resets() {
        let mut rig = Rig::new(&[" HEY CLAUDE "]);
        rig.accept(0.1);
        assert_eq!(rig.detections(), ["hey claude"]);
        assert_eq!(rig.calls(), [accept(0.1), Call::Decode, Call::Reset]);
        assert_eq!(
            rig.reports,
            [
                CaptureReport::Debug("KWS result: {\"keyword\":\" HEY CLAUDE \"}".to_string()),
                CaptureReport::Detected("hey claude".to_string()),
            ]
        );
    }

    #[test]
    fn drops_a_keyword_that_maps_to_no_phrase_and_still_resets() {
        let mut rig = Rig::new(&["HELLO"]);
        rig.accept(0.1);
        assert!(rig.detections().is_empty());
        assert_eq!(rig.calls(), [accept(0.1), Call::Decode, Call::Reset]);
        assert_eq!(
            rig.reports,
            [CaptureReport::Debug(
                "Unmatched KWS result: {\"keyword\":\"HELLO\"}".to_string()
            )]
        );
    }

    #[test]
    fn says_nothing_and_does_not_reset_when_a_step_completes_no_keyword() {
        let mut rig = Rig::new(&[""]);
        rig.accept(0.1);
        assert!(rig.reports.is_empty());
        assert_eq!(rig.calls(), [accept(0.1), Call::Decode]);
    }

    #[test]
    fn reports_each_keyword_of_several_and_resets_after_each() {
        let mut rig = Rig::new(&["HEY CLAUDE", "", "OPEN CHAT"]);
        rig.accept(0.1);
        rig.accept(0.2);
        rig.accept(0.3);
        assert_eq!(rig.detections(), ["hey claude", "open chat"]);
        let resets = rig
            .calls()
            .iter()
            .filter(|call| **call == Call::Reset)
            .count();
        assert_eq!(resets, 2);
    }

    #[test]
    fn resets_the_stream_at_the_end_of_a_speech_segment() {
        let mut rig = Rig::new(&[]);
        rig.accept(0.1);
        rig.end_segment();
        assert_eq!(rig.calls(), [accept(0.1), Call::Decode, Call::Reset]);
    }

    #[test]
    fn replaces_the_stream_on_a_pause_rather_than_resetting_it() {
        let mut rig = Rig::new(&[]);
        rig.accept(0.1);
        rig.spotter.reset();
        rig.accept(0.2);
        assert_eq!(
            rig.calls(),
            [
                accept(0.1),
                Call::Decode,
                Call::ReplaceStream,
                accept(0.2),
                Call::Decode
            ]
        );
    }

    #[test]
    fn an_empty_slot_drops_audio_and_a_filled_one_passes_it_on() {
        let mut slot = SpotterSlot::default();
        let mut reports = Vec::new();
        slot.accept(&[0.0; 1600], &mut |report| reports.push(report));
        slot.end_segment(&mut |report| reports.push(report));
        slot.reset();
        assert!(reports.is_empty());

        let rig = Rig::new(&["HEY CLAUDE"]);
        let calls = Arc::clone(&rig.calls);
        slot.install(rig.spotter);
        slot.accept(&[0.5; 1600], &mut |report| reports.push(report));
        slot.end_segment(&mut |report| reports.push(report));
        slot.reset();
        assert!(reports.contains(&CaptureReport::Detected("hey claude".to_string())));
        assert_eq!(
            *calls.lock().expect("calls"),
            [
                accept(0.5),
                Call::Decode,
                Call::Reset,
                Call::Reset,
                Call::ReplaceStream
            ]
        );
    }

    #[test]
    fn a_released_slot_drops_its_spotter_and_refuses_a_late_one() {
        let mut slot = SpotterSlot::default();
        slot.install(Rig::new(&["HEY CLAUDE"]).spotter);
        slot.release();
        assert!(slot.is_released());

        let mut reports = Vec::new();
        slot.accept(&[0.5; 1600], &mut |report| reports.push(report));
        assert!(reports.is_empty(), "the spotter is gone");

        let late = Rig::new(&["HEY CLAUDE"]);
        let calls = Arc::clone(&late.calls);
        slot.install(late.spotter);
        slot.accept(&[0.5; 1600], &mut |report| reports.push(report));
        assert!(reports.is_empty());
        assert!(calls.lock().expect("calls").is_empty());
    }

    #[test]
    fn the_configuration_matches_the_node_engine_field_for_field() {
        let config = spotter_config("models", 0.05, "\u{2581}HE Y :3.0 #0.05");
        let file = |name: &str| {
            Some(
                Path::new("models")
                    .join(name)
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        assert_eq!(config.feat_config.sample_rate, 16_000);
        assert_eq!(config.feat_config.feature_dim, 80);
        let model = &config.model_config;
        assert_eq!(
            model.transducer.encoder,
            file("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
        );
        assert_eq!(
            model.transducer.decoder,
            file("decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
        );
        assert_eq!(
            model.transducer.joiner,
            file("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
        );
        assert_eq!(model.tokens, file("tokens.txt"));
        assert_eq!(model.provider.as_deref(), Some("cpu"));
        assert_eq!(model.num_threads, 1);
        assert_eq!(model.modeling_unit.as_deref(), Some("bpe"));
        assert_eq!(model.bpe_vocab, file("bpe.model"));
        assert!(!model.debug);
        assert_eq!(config.max_active_paths, 4);
        assert_eq!(config.num_trailing_blanks, 1);
        assert!((config.keywords_score - 1.0).abs() < f32::EPSILON);
        assert!((config.keywords_threshold - 0.05).abs() < f32::EPSILON);
        assert_eq!(config.keywords_file, None, "keyword lines stay in memory");
        assert_eq!(
            config.keywords_buf.as_deref(),
            Some("\u{2581}HE Y :3.0 #0.05")
        );
        // Nothing else is configured: no other model family, no model type,
        // and no token table in memory.
        assert_eq!(model.paraformer.encoder, None);
        assert_eq!(model.zipformer2_ctc.model, None);
        assert_eq!(model.nemo_ctc.model, None);
        assert_eq!(model.t_one_ctc.model, None);
        assert_eq!(model.model_type, None);
        assert_eq!(model.tokens_buf, None);
    }

    #[test]
    fn refuses_a_model_directory_that_lacks_a_file_and_names_it() {
        let error = SherpaEngine::create("no-such-model-dir", 0.05, "A")
            .err()
            .expect("an error");
        assert!(error.contains("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"));
        assert!(error.ends_with("does not exist"), "{error}");
    }

    #[test]
    fn the_token_table_is_not_read_from_a_model_directory_that_is_incomplete() {
        let error = ModelBackend
            .load_vocabulary("no-such-model-dir")
            .expect_err("an error");
        assert!(error.contains("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"));
        assert!(error.ends_with("does not exist"), "{error}");
    }

    #[test]
    fn refuses_a_nul_character_rather_than_passing_it_to_the_library() {
        let path = SherpaEngine::create("models\0", 0.05, "A")
            .err()
            .expect("an error");
        assert!(path.contains("NUL"), "{path}");
        let phrase = SherpaEngine::create("models", 0.05, "\u{2581}HE \0 Y")
            .err()
            .expect("an error");
        assert!(phrase.contains("NUL"), "{phrase}");
    }

    /// A backend whose loads succeed or fail as told, and which counts them.
    struct FakeBackend {
        tokeniser: Result<(), String>,
        engine: Result<(), String>,
        /// The token table; `None` stands for one that has every piece.
        vocabulary: Option<Vec<&'static str>>,
        engines_created: Arc<Mutex<Vec<(String, f64, String)>>>,
        /// Every piece the fake tokeniser has produced.
        pieces_seen: Arc<Mutex<HashSet<String>>>,
    }

    impl FakeBackend {
        fn working() -> FakeBackend {
            FakeBackend {
                tokeniser: Ok(()),
                engine: Ok(()),
                vocabulary: None,
                engines_created: Arc::new(Mutex::new(Vec::new())),
                pieces_seen: Arc::new(Mutex::new(HashSet::new())),
            }
        }
    }

    impl PrepareBackend for FakeBackend {
        fn load_tokeniser(&self, _model_dir: &str) -> Result<Encoder, String> {
            self.tokeniser.clone()?;
            let seen = Arc::clone(&self.pieces_seen);
            Ok(Box::new(move |text: &str| {
                let pieces: Vec<String> = text
                    .split(' ')
                    .filter(|word| !word.is_empty())
                    .map(|word| format!("\u{2581}{word}"))
                    .collect();
                seen.lock().expect("pieces").extend(pieces.iter().cloned());
                Ok(pieces)
            }))
        }

        fn load_vocabulary(&self, _model_dir: &str) -> Result<HashSet<String>, String> {
            Ok(match &self.vocabulary {
                Some(tokens) => tokens.iter().map(|token| token.to_string()).collect(),
                None => self.pieces_seen.lock().expect("pieces").clone(),
            })
        }

        fn create_engine(
            &self,
            model_dir: &str,
            threshold: f64,
            keywords: &str,
        ) -> Result<Box<dyn KeywordEngine>, String> {
            self.engine.clone()?;
            self.engines_created.lock().expect("engines").push((
                model_dir.to_string(),
                threshold,
                keywords.to_string(),
            ));
            Ok(Box::new(ScriptedEngine {
                script: Vec::new(),
                pending: 0,
                calls: Arc::new(Mutex::new(Vec::new())),
            }))
        }
    }

    fn request(phrases: &[&str]) -> PrepareRequest {
        PrepareRequest {
            phrases: phrases.iter().map(|phrase| phrase.to_string()).collect(),
            threshold: 0.3,
            model_dir: "models".to_string(),
        }
    }

    /// Run preparation with a clock that advances 7 ms every time it is read.
    fn run(
        request: &PrepareRequest,
        backend: &FakeBackend,
        cancelled: bool,
    ) -> (Result<Option<Prepared>, PrepareError>, Vec<PrepareProgress>) {
        let clock = std::cell::Cell::new(0u64);
        let now_ms = || {
            clock.set(clock.get() + 7);
            clock.get()
        };
        let mut progress = Vec::new();
        let result = prepare(request, backend, &now_ms, &|| cancelled, &mut |line| {
            progress.push(line)
        })
        .map(|prepared| prepared.map(|(_, prepared)| prepared));
        (result, progress)
    }

    #[test]
    fn prepares_in_the_node_engines_order_and_times_each_phase() {
        let backend = FakeBackend::working();
        let (result, progress) = run(&request(&["hey claude", "open chat"]), &backend, false);
        assert_eq!(
            result.expect("prepared"),
            Some(Prepared {
                listening_for: vec!["hey claude".to_string(), "open chat".to_string()],
            })
        );
        assert_eq!(
            progress,
            [
                PrepareProgress::Timing {
                    phase: "bpe-load",
                    elapsed_ms: 7
                },
                PrepareProgress::Timing {
                    phase: "tokenise",
                    elapsed_ms: 7
                },
                PrepareProgress::Debug(
                    "phrase: hey claude -> tokens: \u{2581}HEY \u{2581}CLAUDE -> decoded: HEY CLAUDE"
                        .to_string()
                ),
                PrepareProgress::Debug(
                    "phrase: open chat -> tokens: \u{2581}OPEN \u{2581}CHAT -> decoded: OPEN CHAT"
                        .to_string()
                ),
                PrepareProgress::Debug("loading sherpa-onnx KWS model...".to_string()),
                PrepareProgress::Timing {
                    phase: "model-load",
                    elapsed_ms: 7
                },
            ]
        );
    }

    #[test]
    fn hands_the_engine_the_model_directory_the_threshold_and_the_keyword_lines() {
        let backend = FakeBackend::working();
        let (result, _) = run(&request(&["hey claude", "open chat"]), &backend, false);
        assert!(result.is_ok());
        let created = backend.engines_created.lock().expect("engines").clone();
        assert_eq!(
            created,
            [(
                "models".to_string(),
                0.3,
                "\u{2581}HEY \u{2581}CLAUDE :3.0 #0.3\n\u{2581}OPEN \u{2581}CHAT :3.0 #0.3"
                    .to_string()
            )]
        );
    }

    #[test]
    fn refuses_no_usable_phrase_only_after_the_tokeniser_has_run() {
        let backend = FakeBackend::working();
        let (result, progress) = run(&request(&["   ", ""]), &backend, false);
        assert_eq!(result, Err(PrepareError::NoValidPhrases));
        assert_eq!(
            progress,
            [
                PrepareProgress::Timing {
                    phase: "bpe-load",
                    elapsed_ms: 7
                },
                PrepareProgress::Timing {
                    phase: "tokenise",
                    elapsed_ms: 7
                },
            ]
        );
        assert!(backend.engines_created.lock().expect("engines").is_empty());
    }

    #[test]
    fn a_tokeniser_that_cannot_load_is_a_startup_error_even_with_no_phrases() {
        let backend = FakeBackend {
            tokeniser: Err("Failed to read models/bpe.model".to_string()),
            ..FakeBackend::working()
        };
        let (result, progress) = run(&request(&[]), &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::Startup(
                "Failed to read models/bpe.model".to_string()
            ))
        );
        assert!(progress.is_empty());
    }

    #[test]
    fn a_model_that_cannot_load_says_so() {
        let backend = FakeBackend {
            engine: Err("models/tokens.txt does not exist".to_string()),
            ..FakeBackend::working()
        };
        let (result, _) = run(&request(&["hey claude"]), &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::ModelLoad(
                "models/tokens.txt does not exist".to_string()
            ))
        );
    }

    #[test]
    fn refuses_a_phrase_with_a_piece_the_model_does_not_have_and_names_both() {
        let backend = FakeBackend {
            vocabulary: Some(vec!["\u{2581}HEY", "\u{2581}CLAUDE", "\u{2581}ROUTE"]),
            ..FakeBackend::working()
        };
        let (result, progress) = run(&request(&["hey claude", "route 66"]), &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::ModelLoad(
                "the phrase \"route 66\" cannot be spotted: \"\u{2581}66\" is not in the model's vocabulary"
                    .to_string()
            ))
        );
        assert_eq!(
            progress.last(),
            Some(&PrepareProgress::Debug(
                "loading sherpa-onnx KWS model...".to_string()
            ))
        );
        assert!(
            backend.engines_created.lock().expect("engines").is_empty(),
            "the library is never handed a line it would end the process over"
        );
    }

    #[test]
    fn accepts_phrases_whose_pieces_are_all_in_the_vocabulary() {
        let backend = FakeBackend {
            vocabulary: Some(vec!["\u{2581}HEY", "\u{2581}CLAUDE"]),
            ..FakeBackend::working()
        };
        let (result, _) = run(&request(&["hey claude", "Claude"]), &backend, false);
        assert!(result.is_ok());
        assert_eq!(backend.engines_created.lock().expect("engines").len(), 1);
    }

    #[test]
    fn reads_the_token_table_one_token_per_line() {
        let vocabulary =
            parse_vocabulary("<blk> 0\n<unk> 2\r\nS 3\n\u{2581}THE 5\n' 13\n\u{2581} 20\n");
        for token in ["<blk>", "<unk>", "S", "\u{2581}THE", "'", "\u{2581}"] {
            assert!(vocabulary.contains(token), "{token}");
        }
        assert_eq!(vocabulary.len(), 6);
        assert!(!vocabulary.contains("3"));
    }

    #[test]
    fn stops_before_the_model_load_once_shutdown_has_started() {
        let backend = FakeBackend::working();
        let (result, progress) = run(&request(&["hey claude"]), &backend, true);
        assert_eq!(result, Ok(None));
        assert_eq!(
            progress,
            [PrepareProgress::Timing {
                phase: "bpe-load",
                elapsed_ms: 7
            }]
        );
        assert!(backend.engines_created.lock().expect("engines").is_empty());
    }

    #[test]
    fn a_spotter_prepared_after_release_is_not_kept() {
        // The slot is released while preparation is between steps; what it
        // builds afterwards must not be installed.
        let slot = Arc::new(Mutex::new(SpotterSlot::default()));
        let released = AtomicBool::new(false);
        let backend = FakeBackend::working();
        let clock = || 0u64;
        let prepared = prepare(
            &request(&["hey claude"]),
            &backend,
            &clock,
            &|| released.load(Ordering::SeqCst),
            &mut |_| {},
        )
        .expect("prepared")
        .expect("not cancelled");
        slot.lock().expect("slot").release();
        slot.lock().expect("slot").install(prepared.0);

        let mut reports = Vec::new();
        slot.lock()
            .expect("slot")
            .accept(&[0.0; 1600], &mut |report| reports.push(report));
        assert!(reports.is_empty());
    }
}
