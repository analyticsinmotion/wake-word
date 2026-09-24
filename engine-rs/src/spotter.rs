//! The keyword spotter: the decode loop, the sherpa-onnx engine underneath it,
//! and the preparation step that builds both.
//!
//! The model is a streaming transducer. It is loaded once and kept for the life
//! of the process; what changes is its stream, the decoding state for the audio
//! fed so far. The stream is restarted in three places, and each one exists to
//! stop audio from two different moments being read as one phrase:
//!
//! - after a detection, so one utterance is reported once and the next search
//!   starts clean;
//! - at the end of a speech segment, so the two sides of a silence are never
//!   spliced together into a phrase nobody said in one breath. The segment's
//!   last decode step is finished first, by feeding the stream silence and
//!   draining it, so the end of a phrase is not cut off by the reset (see
//!   `SEGMENT_FLUSH_MS`);
//! - on a pause, where the stream is replaced rather than reset. A reset starts
//!   a new search but leaves audio the stream has accepted and not yet decoded
//!   in place, and that audio would be decoded ahead of whatever is heard after
//!   the resume. A new stream holds nothing from before the pause.
//!
//! The phrases arrive as keyword lines the extension has already tokenised,
//! with a phrase map from the decoded text of each line's pieces, which is how
//! the spotter reports a keyword, to the phrase as configured. A hit is mapped
//! back through that map. A keyword with no entry is dropped, and the search
//! still restarts.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use sherpa_onnx::OnlineTransducerModelConfig;
use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig, OnlineStream};

use crate::capture::{SpeechSink, CHUNK_SAMPLES, SAMPLE_RATE};
use crate::config::PhraseMap;
use crate::lifecycle::{CaptureReport, PrepareError, PrepareProgress, PrepareRequest, Prepared};
use crate::protocol::js_trim;

/// The transducer's three networks, int8 quantised, and its token table.
pub const ENCODER_FILE: &str = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const DECODER_FILE: &str = "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const JOINER_FILE: &str = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const TOKENS_FILE: &str = "tokens.txt";
/// The model's SentencePiece file. The configuration names it, as the Node
/// engine's does, but the keyword spotter neither reads it nor checks that it
/// exists, and the keyword lines arrive tokenised, so the engine does not need
/// it either.
pub const TOKENISER_MODEL_FILE: &str = "bpe.model";

/// SentencePiece marks a word boundary with U+2581 LOWER ONE EIGHTH BLOCK.
const WORD_BOUNDARY: char = '\u{2581}';

/// Mel filterbank bins per frame, which is what the model was trained on.
pub const FEATURE_DIM: i32 = 80;
/// Hypotheses kept alive during the search.
pub const MAX_ACTIVE_PATHS: i32 = 4;
/// Blank frames that must follow a keyword's last piece before it is reported.
pub const NUM_TRAILING_BLANKS: i32 = 1;
/// The spotter-wide boost. Every keyword line carries its own, so this is only
/// what a line without one would get.
pub const KEYWORDS_SCORE: f32 = 1.0;

/// Silence fed to the stream at the end of a speech segment, before the reset,
/// in milliseconds.
///
/// The spotter decodes in 320 ms steps counted from the first sample the stream
/// was given, and reports a keyword only once a step has covered the phrase's
/// last piece and the blank after it. Audio the stream has accepted and not yet
/// decoded is lost to the reset, and a phrase the search is still resolving
/// needs audio after it to settle. A phrase said on its own is the case that
/// suffers: its segment ends a few chunks after the phrase does, and there is
/// nothing after it.
///
/// Silence is that audio, and the length was measured over 1,448 phrase
/// opportunities in 92 minutes of synthesised speech, at eight lengths. No
/// flush detected 67.5% of them; 320 ms, 640 ms and 960 ms all detected about
/// 80.3%, which is the first step covering the end of the phrase; 1,600 ms
/// detected 81.6%, the further steps letting a phrase heard in noise settle,
/// and all 18 of those extra opportunities were the phrase with the longest
/// piece sequence. 2,400 ms, 3,200 ms and 4,800 ms detected no more, so the
/// gain stops at 1,600 ms. The one false positive in 14 minutes of speech that contains no
/// phrase is the same clip at every length, including no flush, and the median
/// delay from the end of speech to the detection goes from 352 ms to 380 ms.
/// The flush is five decode steps, which on a desktop processor is about 20 ms
/// of work on the capture thread at each segment end, and a pause waits for it:
/// it closes the microphone, which joins that thread.
const SEGMENT_FLUSH_MS: usize = 1600;

/// The flush, as the chunks a microphone would have delivered: a whole number
/// of them, so the stream is fed the way it is fed during speech.
const SEGMENT_FLUSH_CHUNKS: usize = SEGMENT_FLUSH_MS * SAMPLE_RATE as usize / 1000 / CHUNK_SAMPLES;

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

    /// Finish the segment: decode what its tail left behind, report anything
    /// that completes, and start a new search. Only a segment end flushes; a
    /// pause takes the other path, `reset`, because audio heard before the
    /// microphone was handed over must not produce a detection after it.
    fn end_segment(&mut self, report: &mut dyn FnMut(CaptureReport)) {
        for _ in 0..SEGMENT_FLUSH_CHUNKS {
            self.accept(&[0.0; CHUNK_SAMPLES], report);
        }
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
/// A unit test pins every value, because the model, the keyword lines, the
/// boost, and the thresholds only mean what they are documented to mean under
/// this configuration. The keyword lines are handed over in memory; nothing is
/// written to disk.
///
/// `keywords_threshold` is the spotter-wide trigger threshold. Every keyword
/// line carries its own `#` threshold, which replaces it, so the value decides
/// nothing; it is passed because a line without the field would fall back to
/// it. `modeling_unit` and `bpe_vocab` are set for completeness. The keyword
/// spotter expects lines that are already tokenised and uses neither: it
/// creates a spotter with `bpe_vocab` naming an empty file, or no file at
/// all.
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
    [ENCODER_FILE, DECODER_FILE, JOINER_FILE, TOKENS_FILE]
        .iter()
        .map(|name| Path::new(model_dir).join(name))
        .find(|path| !path.is_file())
}

/// The model directory in the form the library is given.
///
/// On Windows the library opens the model files through C runtime calls that
/// refuse a path of 260 characters or more, and it reports such a file as one
/// that does not exist. A path in the verbatim form, which starts `\\?\`, is
/// exempt from that limit, and canonicalising a path produces that form. The
/// verbatim form also skips the normalisation that would turn a forward slash
/// into a separator, which canonicalising has already done. A directory that
/// cannot be canonicalised is passed as it is, so whatever is wrong with it is
/// reported by the load itself.
///
/// Everywhere else the path is passed as it is: there is no such limit, and a
/// canonical path would differ only in resolved links.
fn library_model_dir(model_dir: &str) -> String {
    if cfg!(windows) {
        if let Ok(canonical) = std::fs::canonicalize(model_dir) {
            // A path the bindings cannot take as UTF-8 is left alone too.
            if let Some(canonical) = canonical.to_str() {
                return canonical.to_string();
            }
        }
    }
    model_dir.to_string()
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
        // interior NUL, which a keyword line or a path from the config line
        // can carry. check_keyword_lines() has refused such a line already;
        // this keeps the call itself safe.
        if model_dir.contains('\0') {
            return Err("the model directory path contains a NUL character".to_string());
        }
        if keywords.contains('\0') {
            return Err("a keyword line contains a NUL character".to_string());
        }
        if let Some(path) = missing_model_file(model_dir) {
            return Err(format!("{} does not exist", path.display()));
        }

        let config = spotter_config(&library_model_dir(model_dir), threshold, keywords);
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

/// What preparation loads from the model directory, so a test can stand in
/// for all of it.
pub trait PrepareBackend {
    /// Every token in the model's token table.
    fn load_vocabulary(&self, model_dir: &str) -> Result<HashSet<String>, String>;
    fn create_engine(
        &self,
        model_dir: &str,
        threshold: f64,
        keywords: &str,
    ) -> Result<Box<dyn KeywordEngine>, String>;
}

/// The model directory and sherpa-onnx.
pub struct ModelBackend;

impl PrepareBackend for ModelBackend {
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

/// The words of a keyword line, split where the library splits them: on the
/// characters C's `isspace()` accepts, and nothing else.
fn words(line: &str) -> impl Iterator<Item = &str> {
    line.split([' ', '\t', '\n', '\u{0b}', '\u{0c}', '\r'])
        .filter(|word| !word.is_empty())
}

/// A word that sets the boost (`:`) or the trigger threshold (`#`) of its line
/// rather than naming a piece.
fn is_field(word: &str) -> bool {
    word.starts_with([':', '#'])
}

/// Turn a piece list back into plain text.
///
/// A leading boundary marker becomes a space, the pieces are joined, and the
/// result is trimmed. This is the form the spotter reports a keyword in, and
/// the form of the phrase map's keys.
fn decode_pieces<'a>(pieces: impl IntoIterator<Item = &'a str>) -> String {
    let mut text = String::new();
    for piece in pieces {
        match piece.strip_prefix(WORD_BOUNDARY) {
            Some(rest) => {
                text.push(' ');
                text.push_str(rest);
            }
            None => text.push_str(piece),
        }
    }
    js_trim(&text).to_string()
}

/// What the spotter reports on hearing a keyword line: its pieces, decoded.
fn decoded_line(line: &str) -> String {
    decode_pieces(words(line).filter(|word| !is_field(word)))
}

/// Whether `text` is a boost or threshold value the library can read.
///
/// The library converts the value with `std::stof`, which throws for text that
/// does not start with a number and for a number a float cannot hold, and the
/// exception ends the process. Accepted here: digits with an optional sign,
/// point, and exponent, whose value is zero or a normal float. Nothing else is,
/// not even a number followed by other text, which the library would read
/// while ignoring the rest.
fn is_readable_number(text: &str) -> bool {
    let plain = !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'+' | b'-' | b'e' | b'E'));
    plain
        && text.parse::<f64>().is_ok_and(|value| {
            let magnitude = value.abs();
            magnitude == 0.0
                || (f64::from(f32::MIN_POSITIVE)..=f64::from(f32::MAX)).contains(&magnitude)
        })
}

/// Refuse a keyword line the spotter cannot take.
///
/// Each word of a line must be a piece in the model's token table or a `:` or
/// `#` field with a readable number. The library does not report a line that
/// breaks this as an error. A word it cannot find in the token table, such as
/// a digit or an accented letter SentencePiece returned as itself, makes it
/// end the process from inside the call that creates the spotter, so nothing
/// is written for the extension to show, and a field it cannot read as a
/// number ends the process the same way. The bindings pass the lines as a C
/// string, which cannot hold a NUL. A line break would make one entry two
/// keyword lines, and a line with no pieces names no keyword. Checking every
/// line first turns each of these into an ordinary fatal error that names the
/// phrase or the line.
fn check_keyword_lines(
    lines: &[String],
    vocabulary: &HashSet<String>,
    phrase_map: &PhraseMap,
) -> Result<(), String> {
    for line in lines {
        if line.contains('\0') {
            return Err(format!("a keyword line contains a NUL character: {line:?}"));
        }
        if line.contains('\n') {
            return Err(format!("a keyword line contains a line break: {line:?}"));
        }
        let mut pieces = 0;
        for word in words(line) {
            if vocabulary.contains(word) {
                pieces += 1;
            } else if is_field(word) {
                if !is_readable_number(&word[1..]) {
                    return Err(format!(
                        "a keyword line has a boost or threshold that is not a number: {word:?} in {line:?}"
                    ));
                }
            } else {
                let decoded = decoded_line(line);
                let phrase = phrase_map.get(&decoded).unwrap_or(&decoded);
                return Err(format!(
                    "the phrase {phrase:?} cannot be spotted: {word:?} is not in the model's vocabulary"
                ));
            }
        }
        if pieces == 0 {
            return Err(format!("a keyword line has no pieces: {line:?}"));
        }
    }
    Ok(())
}

/// The configured phrases in the order their keyword lines first name them,
/// once each: the order of the phrase map's values, as the extension builds
/// the map from these lines. A line the map has no phrase for names none.
fn listening_for(lines: &[String], phrase_map: &PhraseMap) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut phrases = Vec::new();
    for line in lines {
        let decoded = decoded_line(line);
        if seen.contains(&decoded) {
            continue;
        }
        if let Some(phrase) = phrase_map.get(&decoded) {
            phrases.push(phrase.to_string());
        }
        seen.push(decoded);
    }
    phrases
}

/// Check the keyword lines and load the model.
///
/// The lines arrive tokenised: every line is checked against the model's token
/// table, then the transducer loads. A line the spotter cannot take, a token table that cannot
/// be read, and a model that cannot load are all model load failures.
/// `progress` carries the debug line and the phase timing as they happen.
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
    if cancelled() {
        return Ok(None);
    }

    progress(PrepareProgress::Debug(
        "loading sherpa-onnx KWS model...".to_string(),
    ));
    let since = now_ms();
    let vocabulary = backend
        .load_vocabulary(&request.model_dir)
        .map_err(PrepareError::ModelLoad)?;
    check_keyword_lines(&request.keyword_lines, &vocabulary, &request.phrase_map)
        .map_err(PrepareError::ModelLoad)?;
    let engine = backend
        .create_engine(
            &request.model_dir,
            request.threshold,
            &request.keyword_lines.join("\n"),
        )
        .map_err(PrepareError::ModelLoad)?;
    progress(PrepareProgress::Timing {
        phase: "model-load",
        elapsed_ms: now_ms().saturating_sub(since),
    });

    let prepared = Prepared {
        listening_for: listening_for(&request.keyword_lines, &request.phrase_map),
    };
    Ok(Some((
        Spotter::new(engine, request.phrase_map.clone()),
        prepared,
    )))
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
    use crate::config::Config;
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

        /// A new stream has accepted nothing, so nothing that was in flight
        /// completes on it: the script is dropped along with the audio.
        fn replace_stream(&mut self) {
            self.pending = 0;
            self.script.clear();
            self.calls.lock().expect("calls").push(Call::ReplaceStream);
        }
    }

    fn phrase_map(entries: &[(&str, &str)]) -> PhraseMap {
        let mut map = PhraseMap::default();
        for (decoded, phrase) in entries {
            map.insert(decoded.to_string(), phrase.to_string());
        }
        map
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
            let map = phrase_map(&[("HEY CLAUDE", "hey claude"), ("OPEN CHAT", "open chat")]);
            Rig {
                spotter: Spotter::new(Box::new(engine), map),
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

    /// One chunk of the silence a segment end feeds the stream, and the decode
    /// step it makes ready, repeated for the whole flush.
    fn flush() -> Vec<Call> {
        std::iter::repeat_with(|| {
            [
                Call::Accept {
                    rate: 16_000,
                    first: 0.0,
                    len: CHUNK_SAMPLES,
                },
                Call::Decode,
            ]
        })
        .take(SEGMENT_FLUSH_CHUNKS)
        .flatten()
        .collect()
    }

    /// Several parts of a call list, concatenated, so an expectation can have
    /// the flush spliced into it.
    fn calls(parts: &[&[Call]]) -> Vec<Call> {
        parts.iter().flat_map(|part| part.to_vec()).collect()
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
    fn looks_a_hit_up_in_the_phrase_map_the_config_line_carried() {
        let json = r#"{"keywordLines":["▁HE Y ▁C LA U DE :3.0 #0.05"],
                       "phraseMap":{"HEY CLAUDE":"hey claude","OPEN MAPS":"open the map"}}"#;
        let config = Config::from_json(&serde_json::from_str(json).expect("json"));
        let engine = ScriptedEngine {
            script: vec!["HEY CLAUDE", "OPEN MAPS"],
            pending: 0,
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let mut spotter = Spotter::new(Box::new(engine), config.phrase_map);
        let mut reports = Vec::new();
        spotter.accept(&[0.0; 1600], &mut |report| reports.push(report));
        spotter.accept(&[0.0; 1600], &mut |report| reports.push(report));
        let detected: Vec<CaptureReport> = reports
            .into_iter()
            .filter(|report| matches!(report, CaptureReport::Detected(_)))
            .collect();
        assert_eq!(
            detected,
            [
                CaptureReport::Detected("hey claude".to_string()),
                CaptureReport::Detected("open the map".to_string()),
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
    fn a_segment_in_which_no_keyword_completes_writes_nothing_at_all() {
        // The spotter only ever completes one of the configured keywords, and
        // says nothing otherwise, debug lines included: what was heard is never
        // written out, only which configured phrase was matched.
        let mut rig = Rig::new(&[""; 40]);
        for step in 0..20 {
            rig.accept(step as f32 / 100.0);
        }
        rig.end_segment();
        assert!(rig.reports.is_empty(), "{:?}", rig.reports);
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
    fn feeds_silence_and_drains_the_stream_before_resetting_at_a_segment_end() {
        let mut rig = Rig::new(&[]);
        rig.accept(0.1);
        rig.end_segment();
        assert_eq!(
            rig.calls(),
            calls(&[&[accept(0.1), Call::Decode], &flush(), &[Call::Reset]])
        );
    }

    #[test]
    fn reports_the_phrase_of_a_keyword_the_segment_end_flush_completes() {
        // The chunk's own step completes nothing; a step of the flush completes
        // the phrase, as it does when a phrase is said on its own.
        let mut rig = Rig::new(&["", "HEY CLAUDE"]);
        rig.accept(0.1);
        assert!(rig.detections().is_empty());
        rig.end_segment();
        assert_eq!(rig.detections(), ["hey claude"]);
        // The detection resets the search inside the flush, and the segment
        // end resets it again at the end.
        let resets = rig
            .calls()
            .iter()
            .filter(|call| **call == Call::Reset)
            .count();
        assert_eq!(resets, 2);
    }

    #[test]
    fn the_flush_is_five_decode_steps_of_silence_in_chunks() {
        assert_eq!(SEGMENT_FLUSH_MS, 1600);
        assert_eq!(SEGMENT_FLUSH_CHUNKS, 16);
        assert_eq!(SEGMENT_FLUSH_CHUNKS * CHUNK_SAMPLES, 25_600);
    }

    #[test]
    fn replaces_the_stream_on_a_pause_rather_than_resetting_it() {
        let mut rig = Rig::new(&[]);
        rig.accept(0.1);
        rig.spotter.reset();
        rig.accept(0.2);
        // No silence is fed: a pause hands the microphone over, and audio from
        // before it must not complete a phrase after it.
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
    fn a_segment_end_that_lands_after_a_pause_reports_nothing() {
        // The capture thread can reach a segment end just after the event loop
        // has paused. The stream it flushes is the new one, which has heard
        // nothing, so the phrase that was in flight is not reported.
        let mut rig = Rig::new(&["", "HEY CLAUDE"]);
        rig.accept(0.1);
        rig.spotter.reset();
        rig.end_segment();
        assert!(rig.detections().is_empty());
        assert_eq!(
            rig.calls(),
            calls(&[
                &[accept(0.1), Call::Decode, Call::ReplaceStream],
                &flush(),
                &[Call::Reset]
            ])
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
        let engine_calls = Arc::clone(&rig.calls);
        slot.install(rig.spotter);
        slot.accept(&[0.5; 1600], &mut |report| reports.push(report));
        slot.end_segment(&mut |report| reports.push(report));
        slot.reset();
        assert!(reports.contains(&CaptureReport::Detected("hey claude".to_string())));
        assert_eq!(
            *engine_calls.lock().expect("calls"),
            calls(&[
                &[accept(0.5), Call::Decode, Call::Reset],
                &flush(),
                &[Call::Reset, Call::ReplaceStream]
            ])
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
    fn the_configuration_is_pinned_field_for_field() {
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
    fn a_model_directory_that_cannot_be_canonicalised_is_passed_as_it_is() {
        assert_eq!(library_model_dir("no-such-model-dir"), "no-such-model-dir");
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_library_is_given_a_path_exempt_from_the_length_limit() {
        // A directory whose files have paths well over 260 characters.
        let root = std::env::temp_dir().join(format!("wake-word-long-{}", std::process::id()));
        let mut dir = root.clone();
        while dir.as_os_str().len() < 300 {
            dir.push("d".repeat(40));
        }
        std::fs::create_dir_all(&dir).expect("create the directory");
        let given = dir.to_str().expect("UTF-8").replace('\\', "/");

        let verbatim = library_model_dir(&given);
        let removed = std::fs::remove_dir_all(&root);

        let prefix: String = ['\\', '\\', '?', '\\'].iter().collect();
        assert!(verbatim.starts_with(&prefix), "{verbatim}");
        assert!(!verbatim.contains('/'), "{verbatim}");
        assert!(verbatim.ends_with(&"d".repeat(40)), "{verbatim}");
        assert!(verbatim.len() >= 300, "{verbatim}");
        removed.expect("remove the directory");
    }

    #[cfg(not(windows))]
    #[test]
    fn elsewhere_the_library_is_given_the_path_as_it_is() {
        let dir = std::env::temp_dir();
        let given = format!("{}/.", dir.to_str().expect("UTF-8"));
        assert_eq!(library_model_dir(&given), given);
    }

    #[test]
    fn refuses_a_nul_character_rather_than_passing_it_to_the_library() {
        let path = SherpaEngine::create("models\0", 0.05, "A")
            .err()
            .expect("an error");
        assert!(path.contains("NUL"), "{path}");
        let line = SherpaEngine::create("models", 0.05, "\u{2581}HE \0 Y")
            .err()
            .expect("an error");
        assert!(line.contains("NUL"), "{line}");
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
    fn decoding_turns_the_boundary_marker_back_into_a_space() {
        assert_eq!(
            decode_pieces(["\u{2581}HEY", "\u{2581}CLAUDE"]),
            "HEY CLAUDE"
        );
    }

    #[test]
    fn decoding_joins_sub_word_pieces_without_a_space() {
        assert_eq!(decode_pieces(["\u{2581}CL", "AU", "DE"]), "CLAUDE");
        assert_eq!(decode_pieces(["HE", "Y"]), "HEY");
    }

    #[test]
    fn decoding_trims_the_first_boundary_and_handles_no_pieces() {
        assert_eq!(decode_pieces(["\u{2581}COMPUTER"]), "COMPUTER");
        assert_eq!(decode_pieces([]), "");
    }

    #[test]
    fn decoding_replaces_only_a_leading_boundary_marker() {
        assert_eq!(decode_pieces(["\u{2581}A\u{2581}B"]), "A\u{2581}B");
    }

    #[test]
    fn decoding_trims_the_way_javascript_does() {
        // The phrase map's keys were decoded by the extension in JavaScript.
        // U+0085 is white space to Rust and not to JavaScript; U+FEFF is the
        // other way round.
        assert_eq!(decode_pieces(["\u{feff}HEY\u{feff}"]), "HEY");
        assert_eq!(decode_pieces(["\u{85}"]), "\u{85}");
    }

    #[test]
    fn decodes_a_keyword_line_without_its_fields() {
        assert_eq!(
            decoded_line("\u{2581}O P EN \u{2581} TER M IN AL :3.0 #0.05"),
            "OPEN TERMINAL"
        );
    }

    const HEY_CLAUDE: &str = "\u{2581}HEY \u{2581}CLAUDE :3.0 #0.3";
    const OPEN_CHAT: &str = "\u{2581}OPEN \u{2581}CHAT :3.0 #0.3";

    /// A backend whose loads succeed or fail as told, and which records the
    /// engines it was asked for.
    struct FakeBackend {
        vocabulary: Result<Vec<&'static str>, String>,
        engine: Result<(), String>,
        engines_created: Arc<Mutex<Vec<(String, f64, String)>>>,
    }

    impl FakeBackend {
        fn working() -> FakeBackend {
            FakeBackend {
                vocabulary: Ok(vec![
                    "\u{2581}HEY",
                    "\u{2581}CLAUDE",
                    "\u{2581}OPEN",
                    "\u{2581}CHAT",
                    "\u{2581}ROUTE",
                ]),
                engine: Ok(()),
                engines_created: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn engines(&self) -> Vec<(String, f64, String)> {
            self.engines_created.lock().expect("engines").clone()
        }
    }

    impl PrepareBackend for FakeBackend {
        fn load_vocabulary(&self, _model_dir: &str) -> Result<HashSet<String>, String> {
            self.vocabulary
                .clone()
                .map(|tokens| tokens.into_iter().map(str::to_string).collect())
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

    /// A request for these lines, with a phrase map entry for each: its
    /// decoded pieces, lower-cased.
    fn request(lines: &[&str]) -> PrepareRequest {
        let mut map = PhraseMap::default();
        for line in lines {
            let decoded = decoded_line(line);
            map.insert(decoded.clone(), decoded.to_lowercase());
        }
        PrepareRequest {
            keyword_lines: lines.iter().map(|line| line.to_string()).collect(),
            phrase_map: map,
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

    /// The error preparation gives for these lines, and whether the library
    /// was reached.
    fn refusal(lines: &[&str]) -> String {
        let backend = FakeBackend::working();
        let (result, _) = run(&request(lines), &backend, false);
        assert!(
            backend.engines().is_empty(),
            "the library is never handed a line it cannot take"
        );
        match result {
            Err(PrepareError::ModelLoad(detail)) => detail,
            other => panic!("expected a model load failure, got {other:?}"),
        }
    }

    #[test]
    fn loads_the_model_and_times_it() {
        let backend = FakeBackend::working();
        let (result, progress) = run(&request(&[HEY_CLAUDE, OPEN_CHAT]), &backend, false);
        assert_eq!(
            result.expect("prepared"),
            Some(Prepared {
                listening_for: vec!["hey claude".to_string(), "open chat".to_string()],
            })
        );
        assert_eq!(
            progress,
            [
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
        let (result, _) = run(&request(&[HEY_CLAUDE, OPEN_CHAT]), &backend, false);
        assert!(result.is_ok());
        assert_eq!(
            backend.engines(),
            [(
                "models".to_string(),
                0.3,
                format!("{HEY_CLAUDE}\n{OPEN_CHAT}")
            )]
        );
    }

    #[test]
    fn a_model_that_cannot_load_says_so() {
        let backend = FakeBackend {
            engine: Err("models/encoder.onnx does not exist".to_string()),
            ..FakeBackend::working()
        };
        let (result, _) = run(&request(&[HEY_CLAUDE]), &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::ModelLoad(
                "models/encoder.onnx does not exist".to_string()
            ))
        );
    }

    #[test]
    fn a_token_table_that_cannot_be_read_is_a_model_load_failure() {
        let backend = FakeBackend {
            vocabulary: Err("models/tokens.txt does not exist".to_string()),
            ..FakeBackend::working()
        };
        let (result, _) = run(&request(&[HEY_CLAUDE]), &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::ModelLoad(
                "models/tokens.txt does not exist".to_string()
            ))
        );
        assert!(backend.engines().is_empty());
    }

    #[test]
    fn refuses_a_phrase_with_a_piece_the_model_does_not_have_and_names_both() {
        let route_66 = "\u{2581}ROUTE \u{2581}66 :3.0 #0.3";
        let backend = FakeBackend::working();
        let (result, progress) = run(&request(&[HEY_CLAUDE, route_66]), &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::ModelLoad(
                "the phrase \"route 66\" cannot be spotted: \"\u{2581}66\" is not in the model's vocabulary"
                    .to_string()
            ))
        );
        assert_eq!(
            progress,
            [PrepareProgress::Debug(
                "loading sherpa-onnx KWS model...".to_string()
            )]
        );
        assert!(backend.engines().is_empty());
    }

    #[test]
    fn names_the_decoded_text_when_the_phrase_map_has_no_phrase_for_the_line() {
        let backend = FakeBackend::working();
        let mut unmapped = request(&[HEY_CLAUDE]);
        unmapped
            .keyword_lines
            .push("\u{2581}CAF\u{c9} :3.0 #0.3".to_string());
        let (result, _) = run(&unmapped, &backend, false);
        assert_eq!(
            result,
            Err(PrepareError::ModelLoad(
                "the phrase \"CAF\u{c9}\" cannot be spotted: \"\u{2581}CAF\u{c9}\" is not in the model's vocabulary"
                    .to_string()
            ))
        );
    }

    #[test]
    fn refuses_a_keyword_line_with_a_nul_character() {
        let detail = refusal(&[HEY_CLAUDE, "\u{2581}HEY\0 \u{2581}CLAUDE :3.0 #0.3"]);
        assert_eq!(
            detail,
            "a keyword line contains a NUL character: \"\u{2581}HEY\\0 \u{2581}CLAUDE :3.0 #0.3\""
        );
    }

    #[test]
    fn refuses_a_keyword_line_with_a_line_break() {
        let detail = refusal(&["\u{2581}HEY \u{2581}CLAUDE\n:3.0 #0.3"]);
        assert!(
            detail.starts_with("a keyword line contains a line break: "),
            "{detail}"
        );
    }

    #[test]
    fn refuses_a_boost_or_threshold_the_library_cannot_read() {
        for field in [
            ":", "#", ":x", "#abc", ":3.0x", ":0x10", ":inf", "#nan", ":1e999", "#1e-50", ":1e-39",
            "#--1", "#1..2",
        ] {
            let line = format!("\u{2581}HEY \u{2581}CLAUDE {field}");
            let detail = refusal(&[line.as_str()]);
            assert_eq!(
                detail,
                format!(
                    "a keyword line has a boost or threshold that is not a number: {field:?} in {line:?}"
                ),
                "{field}"
            );
        }
    }

    #[test]
    fn accepts_a_boost_or_threshold_the_library_can_read() {
        for fields in [
            ":3.0 #0.05",
            ":3 #0.9",
            "#0.123456789",
            ":1e3 #.5",
            ":+2.5 #0",
            ":-1 #0.0",
            "",
        ] {
            let line = format!("\u{2581}HEY \u{2581}CLAUDE {fields}");
            let backend = FakeBackend::working();
            let (result, _) = run(&request(&[line.as_str()]), &backend, false);
            assert!(result.is_ok(), "{fields}: {result:?}");
        }
    }

    #[test]
    fn refuses_a_keyword_line_with_no_pieces() {
        for line in ["", "   ", ":3.0 #0.3", "\t#0.3"] {
            let detail = refusal(&[HEY_CLAUDE, line]);
            assert_eq!(
                detail,
                format!("a keyword line has no pieces: {line:?}"),
                "{line:?}"
            );
        }
    }

    #[test]
    fn splits_a_line_into_words_only_where_the_library_does() {
        // Tab, vertical tab, form feed, and carriage return separate words as
        // spaces do. A no-break space does not: it is part of the word.
        let separated = "\u{2581}HEY\t\u{2581}CLAUDE\u{0b}:3.0\u{0c}#0.3\r";
        let backend = FakeBackend::working();
        let (result, _) = run(&request(&[separated]), &backend, false);
        assert!(result.is_ok(), "{result:?}");

        // The message escapes the no-break space, which would otherwise be
        // invisible.
        let joined = "\u{2581}HEY\u{a0}\u{2581}CLAUDE :3.0 #0.3";
        let detail = refusal(&[joined]);
        assert!(
            detail
                .ends_with("\"\u{2581}HEY\\u{a0}\u{2581}CLAUDE\" is not in the model's vocabulary"),
            "{detail}"
        );
    }

    #[test]
    fn lists_the_phrases_in_the_order_their_lines_first_name_them() {
        let mut map = phrase_map(&[("OPEN CHAT", "open chat"), ("HEY CLAUDE", "hey  claude")]);
        map.insert("NEVER SAID".to_string(), "never said".to_string());
        let lines: Vec<String> = [HEY_CLAUDE, OPEN_CHAT, HEY_CLAUDE, "\u{2581}HEY :3.0 #0.3"]
            .iter()
            .map(|line| line.to_string())
            .collect();
        assert_eq!(listening_for(&lines, &map), ["hey  claude", "open chat"]);
    }

    #[test]
    fn stops_before_the_model_load_once_shutdown_has_started() {
        let backend = FakeBackend::working();
        let (result, progress) = run(&request(&[HEY_CLAUDE]), &backend, true);
        assert_eq!(result, Ok(None));
        assert!(progress.is_empty());
        assert!(backend.engines().is_empty());
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
            &request(&[HEY_CLAUDE]),
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
