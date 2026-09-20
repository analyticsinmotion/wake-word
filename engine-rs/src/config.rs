//! The config line the extension sends as the first line of stdin.
//!
//! The shape, as `src/sherpaEngine.ts` writes it:
//!
//! ```json
//! { "phrases": [{ "phrase": "hey claude", "label": "Claude" }],
//!   "threshold": 0.05, "modelDir": "<path>",
//!   "debugMode": false, "audioDevice": "",
//!   "keywordLines": ["▁HE Y ▁C LA U DE :3.0 #0.05"],
//!   "phraseMap": { "HEY CLAUDE": "hey claude" } }
//! ```
//!
//! The extension tokenises the phrases. `keywordLines` holds one keyword line
//! per phrase, SentencePiece pieces followed by the boost and the trigger
//! threshold, and `phraseMap` maps the decoded text of each line's pieces,
//! which is what the spotter reports on a hit, to the phrase as configured,
//! lower-cased. The engine needs both and has no tokeniser, so it does not
//! read `phrases`, which is there for engines that tokenise for themselves.
//!
//! Two more optional fields, `vadModelPath` and `ortLibraryPath`, locate the
//! Silero model and the ONNX Runtime library; the extension does not send
//! them, and without them the engine searches the places `crate::assets`
//! describes. The values are read one at a time out of a `serde_json::Value`
//! rather than deserialised into a struct, so that each is coerced rather than
//! rejected: a threshold of zero becomes the default, and a value of the wrong
//! type is ignored. Deserialising into typed fields would turn each of those
//! into a fatal `Invalid config JSON`, which is a different
//! engine.

use serde_json::Value;

/// Lowest usable keyword threshold, matching `clampThreshold()` in
/// `src/wakeWordCore.ts`, which clamps the same setting on the host.
pub const MIN_THRESHOLD: f64 = 0.01;
/// Highest usable keyword threshold.
pub const MAX_THRESHOLD: f64 = 0.9;
/// The `wakeWord.confidenceThreshold` default, repeated in `package.json`.
pub const DEFAULT_THRESHOLD: f64 = 0.05;

/// The `wakeWord.audioDevice` setting resolved into what the capture backend
/// takes: an index, a case-insensitive name substring, or the system default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioDevice {
    /// No device configured: the capture backend opens the system default.
    Default,
    /// A device index. Only a digit-only string counts, because parseInt would
    /// read "2nd mic" as index 2 and open the wrong device.
    Index(u32),
    /// A case-insensitive substring of the device name, as typed.
    Name(String),
}

impl AudioDevice {
    /// How the device reads in a debug line: the JSON form of what decibri
    /// is given, a quoted name or a bare index.
    pub fn describe(&self) -> Option<String> {
        match self {
            AudioDevice::Default => None,
            AudioDevice::Index(index) => Some(index.to_string()),
            AudioDevice::Name(name) => Some(Value::String(name.clone()).to_string()),
        }
    }
}

/// Decoded keyword to configured phrase: what the spotter reports on a hit, and
/// the phrase to write in `DETECTED:` for it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PhraseMap {
    entries: Vec<(String, String)>,
}

impl PhraseMap {
    /// Add an entry, or replace the phrase of an existing one in place.
    pub fn insert(&mut self, decoded: String, phrase: String) {
        match self.entries.iter_mut().find(|(key, _)| *key == decoded) {
            Some(entry) => entry.1 = phrase,
            None => self.entries.push((decoded, phrase)),
        }
    }

    /// The configured phrase for a keyword the spotter reported.
    pub fn get(&self, decoded: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(key, _)| key == decoded)
            .map(|(_, phrase)| phrase.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The parsed config line.
#[derive(Debug, Clone)]
pub struct Config {
    /// `keywordLines`: one keyword line per phrase, in the order sent, with
    /// entries that are not strings dropped. `None` when the config carries
    /// no such array.
    pub keyword_lines: Option<Vec<String>>,
    /// `phraseMap`, without entries whose phrase is not a string. Empty when
    /// the config carries no such object.
    pub phrase_map: PhraseMap,
    /// The clamped trigger threshold. The extension writes the same value on
    /// every keyword line; here it is the spotter-wide threshold.
    pub threshold: f64,
    /// Where the extension unpacked the keyword spotting model.
    pub model_dir: String,
    /// Whether to emit `DEBUG:` lines.
    pub debug_mode: bool,
    /// The resolved `wakeWord.audioDevice` setting.
    pub audio_device: AudioDevice,
    /// `vadModelPath`: the Silero voice activity model file, when given.
    pub vad_model_path: Option<String>,
    /// `ortLibraryPath`: the ONNX Runtime shared library, when given.
    pub ort_library_path: Option<String>,
}

impl Config {
    /// Read a config out of whatever `JSON.parse()` would have produced.
    ///
    /// Anything that is not a JSON object yields an empty config, which is
    /// what reading every field off a non-object comes to.
    pub fn from_json(value: &Value) -> Config {
        Config {
            keyword_lines: collect_keyword_lines(value.get("keywordLines")),
            phrase_map: collect_phrase_map(value.get("phraseMap")),
            threshold: clamp_keyword_threshold(value.get("threshold")),
            model_dir: value
                .get("modelDir")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            debug_mode: is_truthy(value.get("debugMode")),
            audio_device: resolve_audio_device(value.get("audioDevice")),
            vad_model_path: optional_path(value.get("vadModelPath")),
            ort_library_path: optional_path(value.get("ortLibraryPath")),
        }
    }
}

/// Read `keywordLines`: `None` unless it is an array. An entry that is not a
/// string cannot be a keyword line and is dropped. The strings are kept as
/// sent; whether the spotter can take each one is checked before the model
/// loads.
fn collect_keyword_lines(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(entries)) = value else {
        return None;
    };
    Some(
        entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

/// Read `phraseMap`, dropping entries whose phrase is not a string. Anything
/// but an object is an empty map.
fn collect_phrase_map(value: Option<&Value>) -> PhraseMap {
    let mut map = PhraseMap::default();
    if let Some(Value::Object(entries)) = value {
        for (decoded, phrase) in entries {
            if let Some(phrase) = phrase.as_str() {
                map.insert(decoded.clone(), phrase.to_string());
            }
        }
    }
    map
}

/// Clamp the keyword-spotting threshold into the range
/// `wakeWord.confidenceThreshold` allows, matching `clampKeywordThreshold()`.
///
/// `threshold || 0.05` in JavaScript sends zero, NaN, null, and a missing value
/// to the default; a negative or oversized number is clamped into range.
pub fn clamp_keyword_threshold(value: Option<&Value>) -> f64 {
    clamp_threshold(value.and_then(Value::as_f64).unwrap_or(f64::NAN))
}

/// The same clamp for a number already in hand.
fn clamp_threshold(threshold: f64) -> f64 {
    // Zero and NaN are falsy in JavaScript and take the default with them.
    let raw = if threshold == 0.0 || threshold.is_nan() {
        DEFAULT_THRESHOLD
    } else {
        threshold
    };
    raw.clamp(MIN_THRESHOLD, MAX_THRESHOLD)
}

/// Resolve the `wakeWord.audioDevice` setting, matching `resolveAudioDevice()`.
///
/// The setting is a string, so a value that is nothing but digits is an index
/// and anything else a name substring. Empty, blank, and values of the wrong
/// type mean the system default. A bare number can reach here as well, because
/// settings.json is not validated against the schema.
pub fn resolve_audio_device(value: Option<&Value>) -> AudioDevice {
    match value {
        Some(Value::Number(number)) => match number.as_u64() {
            Some(index) if index <= u64::from(u32::MAX) => AudioDevice::Index(index as u32),
            _ => AudioDevice::Default,
        },
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                AudioDevice::Default
            } else if trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
                // Digits that overflow a u32 are not a device on any machine,
                // so they fall through to a name and fail the lookup by name.
                trimmed.parse::<u32>().map_or_else(
                    |_| AudioDevice::Name(trimmed.to_string()),
                    AudioDevice::Index,
                )
            } else {
                AudioDevice::Name(trimmed.to_string())
            }
        }
        _ => AudioDevice::Default,
    }
}

/// An optional path field: a string that is not blank once trimmed. Anything
/// else means the field was not given.
fn optional_path(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// JavaScript truthiness, which is what `if (debugMode)` applies.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number
            .as_f64()
            .is_some_and(|float| float != 0.0 && !float.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        // An array or an object is truthy however empty it is.
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(json: &str) -> Config {
        Config::from_json(&serde_json::from_str(json).expect("test config parses"))
    }

    fn close(left: f64, right: f64) -> bool {
        (left - right).abs() < f64::EPSILON
    }

    #[test]
    fn parses_the_config_the_extension_sends_on_start() {
        let parsed = config(
            r#"{"phrases":[{"phrase":"hey claude","label":"Claude"}],"threshold":0.3,
                "modelDir":"C:\\Users\\me\\models","debugMode":true,"audioDevice":"",
                "keywordLines":["▁HE Y ▁C LA U DE :3.0 #0.3"],
                "phraseMap":{"HEY CLAUDE":"hey claude"}}"#,
        );
        assert_eq!(
            parsed.keyword_lines,
            Some(vec!["\u{2581}HE Y \u{2581}C LA U DE :3.0 #0.3".to_string()])
        );
        assert_eq!(parsed.phrase_map.get("HEY CLAUDE"), Some("hey claude"));
        assert!(close(parsed.threshold, 0.3));
        assert_eq!(parsed.model_dir, "C:\\Users\\me\\models");
        assert!(parsed.debug_mode);
        assert_eq!(parsed.audio_device, AudioDevice::Default);
    }

    #[test]
    fn defaults_every_field_that_is_missing() {
        let parsed = config("{}");
        assert_eq!(parsed.keyword_lines, None);
        assert!(parsed.phrase_map.is_empty());
        assert!(close(parsed.threshold, DEFAULT_THRESHOLD));
        assert_eq!(parsed.model_dir, "");
        assert!(!parsed.debug_mode);
        assert_eq!(parsed.audio_device, AudioDevice::Default);
        assert_eq!(parsed.vad_model_path, None);
        assert_eq!(parsed.ort_library_path, None);
    }

    #[test]
    fn treats_json_that_is_not_an_object_as_an_empty_config() {
        for json in ["123", "null", "\"hey\"", "[]"] {
            let parsed = config(json);
            assert_eq!(parsed.keyword_lines, None, "{json}");
            assert!(parsed.phrase_map.is_empty(), "{json}");
            assert!(close(parsed.threshold, DEFAULT_THRESHOLD), "{json}");
        }
    }

    #[test]
    fn reads_the_keyword_lines_exactly_as_sent_and_in_order() {
        let parsed =
            config(r#"{"keywordLines":["▁HE Y ▁CHA T :3.0 #0.05"," ▁O P EN ▁CHA T  :3.0 #0.05"]}"#);
        assert_eq!(
            parsed.keyword_lines,
            Some(vec![
                "\u{2581}HE Y \u{2581}CHA T :3.0 #0.05".to_string(),
                " \u{2581}O P EN \u{2581}CHA T  :3.0 #0.05".to_string(),
            ])
        );
    }

    #[test]
    fn has_no_keyword_lines_when_the_field_is_missing_or_not_an_array() {
        for json in [
            "{}",
            r#"{"keywordLines":null}"#,
            r#"{"keywordLines":"▁HE Y :3.0 #0.05"}"#,
            r#"{"keywordLines":{}}"#,
            r#"{"keywordLines":5}"#,
        ] {
            assert_eq!(config(json).keyword_lines, None, "{json}");
        }
    }

    #[test]
    fn reads_an_empty_array_as_no_lines_rather_than_no_field() {
        assert_eq!(
            config(r#"{"keywordLines":[]}"#).keyword_lines,
            Some(Vec::new())
        );
    }

    #[test]
    fn drops_keyword_lines_that_are_not_strings() {
        // A blank line is kept: it is refused, with the other lines the
        // spotter cannot take, before the model loads.
        let parsed = config(r#"{"keywordLines":[42,null,["▁A"],"▁HE Y :3.0 #0.05",{},""]}"#);
        assert_eq!(
            parsed.keyword_lines,
            Some(vec!["\u{2581}HE Y :3.0 #0.05".to_string(), String::new()])
        );
    }

    #[test]
    fn reads_the_phrase_map() {
        let parsed = config(r#"{"phraseMap":{"HEY CLAUDE":"hey claude","OPEN CHAT":"open chat"}}"#);
        assert_eq!(parsed.phrase_map.get("HEY CLAUDE"), Some("hey claude"));
        assert_eq!(parsed.phrase_map.get("OPEN CHAT"), Some("open chat"));
        assert_eq!(parsed.phrase_map.get("hey claude"), None);
    }

    #[test]
    fn drops_phrase_map_entries_whose_phrase_is_not_a_string() {
        let parsed =
            config(r#"{"phraseMap":{"HEY CLAUDE":"hey claude","A":1,"B":null,"C":["c"]}}"#);
        assert_eq!(parsed.phrase_map.get("HEY CLAUDE"), Some("hey claude"));
        for key in ["A", "B", "C"] {
            assert_eq!(parsed.phrase_map.get(key), None, "{key}");
        }
    }

    #[test]
    fn has_an_empty_phrase_map_when_the_field_is_missing_or_not_an_object() {
        for json in [
            "{}",
            r#"{"phraseMap":null}"#,
            r#"{"phraseMap":[["HEY CLAUDE","hey claude"]]}"#,
            r#"{"phraseMap":"HEY CLAUDE"}"#,
        ] {
            assert!(config(json).phrase_map.is_empty(), "{json}");
        }
    }

    #[test]
    fn replaces_the_phrase_of_an_entry_already_in_the_map_and_keeps_its_place() {
        let mut map = PhraseMap::default();
        map.insert("HEY CLAUDE".into(), "hey claude".into());
        map.insert("OPEN CHAT".into(), "open chat".into());
        map.insert("HEY CLAUDE".into(), "hey  claude".into());
        assert_eq!(map.get("HEY CLAUDE"), Some("hey  claude"));
        assert_eq!(
            map.entries,
            [
                ("HEY CLAUDE".to_string(), "hey  claude".to_string()),
                ("OPEN CHAT".to_string(), "open chat".to_string())
            ]
        );
    }

    #[test]
    fn clamps_a_number_the_same_way_as_a_json_value() {
        assert!(close(clamp_threshold(0.5), 0.5));
        assert!(close(clamp_threshold(7.0), MAX_THRESHOLD));
        assert!(close(clamp_threshold(-7.0), MIN_THRESHOLD));
        assert!(close(clamp_threshold(0.0), DEFAULT_THRESHOLD));
        assert!(close(clamp_threshold(f64::NAN), DEFAULT_THRESHOLD));
        assert!(close(clamp_threshold(f64::INFINITY), MAX_THRESHOLD));
    }

    #[test]
    fn clamps_the_threshold_into_the_settings_range() {
        let clamped = |json: &str| config(json).threshold;
        assert!(close(clamped(r#"{"threshold":0.5}"#), 0.5));
        assert!(close(clamped(r#"{"threshold":0.9}"#), MAX_THRESHOLD));
        assert!(close(clamped(r#"{"threshold":5}"#), MAX_THRESHOLD));
        assert!(close(clamped(r#"{"threshold":0.001}"#), MIN_THRESHOLD));
        assert!(close(clamped(r#"{"threshold":-1}"#), MIN_THRESHOLD));
    }

    #[test]
    fn sends_a_falsy_or_unusable_threshold_to_the_default() {
        let clamped = |json: &str| config(json).threshold;
        assert!(close(clamped(r#"{"threshold":0}"#), DEFAULT_THRESHOLD));
        assert!(close(clamped(r#"{"threshold":null}"#), DEFAULT_THRESHOLD));
        assert!(close(clamped(r#"{"threshold":"0.3"}"#), DEFAULT_THRESHOLD));
        assert!(close(clamped("{}"), DEFAULT_THRESHOLD));
    }

    #[test]
    fn reads_debug_mode_the_way_javascript_reads_it() {
        assert!(config(r#"{"debugMode":true}"#).debug_mode);
        assert!(config(r#"{"debugMode":1}"#).debug_mode);
        assert!(config(r#"{"debugMode":"yes"}"#).debug_mode);
        assert!(!config(r#"{"debugMode":false}"#).debug_mode);
        assert!(!config(r#"{"debugMode":0}"#).debug_mode);
        assert!(!config(r#"{"debugMode":""}"#).debug_mode);
        assert!(!config(r#"{"debugMode":null}"#).debug_mode);
        assert!(!config("{}").debug_mode);
    }

    #[test]
    fn means_the_system_default_when_no_device_is_configured() {
        for json in [
            r#"{"audioDevice":""}"#,
            r#"{"audioDevice":"   "}"#,
            r#"{"audioDevice":null}"#,
            r#"{"audioDevice":false}"#,
            r#"{"audioDevice":[]}"#,
            "{}",
        ] {
            assert_eq!(config(json).audio_device, AudioDevice::Default, "{json}");
        }
    }

    #[test]
    fn reads_a_digit_only_device_as_an_index() {
        let device = |json: &str| config(json).audio_device;
        assert_eq!(device(r#"{"audioDevice":"0"}"#), AudioDevice::Index(0));
        assert_eq!(device(r#"{"audioDevice":" 12 "}"#), AudioDevice::Index(12));
        assert_eq!(device(r#"{"audioDevice":2}"#), AudioDevice::Index(2));
    }

    #[test]
    fn reads_anything_else_as_a_device_name() {
        // parseInt would turn "2nd mic" into index 2 and open the wrong device.
        let device = |json: &str| config(json).audio_device;
        assert_eq!(
            device(r#"{"audioDevice":"2nd mic"}"#),
            AudioDevice::Name("2nd mic".into())
        );
        assert_eq!(
            device(r#"{"audioDevice":"1 USB"}"#),
            AudioDevice::Name("1 USB".into())
        );
        assert_eq!(
            device(r#"{"audioDevice":"  USB  "}"#),
            AudioDevice::Name("USB".into())
        );
        assert_eq!(
            device(r#"{"audioDevice":"usb"}"#),
            AudioDevice::Name("usb".into())
        );
    }

    #[test]
    fn ignores_a_negative_or_fractional_device_number() {
        assert_eq!(
            config(r#"{"audioDevice":-1}"#).audio_device,
            AudioDevice::Default
        );
        assert_eq!(
            config(r#"{"audioDevice":1.5}"#).audio_device,
            AudioDevice::Default
        );
    }

    #[test]
    fn describes_a_device_the_way_the_debug_line_prints_it() {
        assert_eq!(AudioDevice::Default.describe(), None);
        assert_eq!(AudioDevice::Index(1).describe().as_deref(), Some("1"));
        assert_eq!(
            AudioDevice::Name("Desk Mic 2".into()).describe().as_deref(),
            Some("\"Desk Mic 2\"")
        );
    }

    #[test]
    fn reads_the_vad_model_and_onnx_runtime_paths_when_given() {
        let parsed = config(
            r#"{"vadModelPath":" /opt/models/silero_vad.onnx ","ortLibraryPath":"/opt/ort/libonnxruntime.so"}"#,
        );
        assert_eq!(
            parsed.vad_model_path.as_deref(),
            Some("/opt/models/silero_vad.onnx")
        );
        assert_eq!(
            parsed.ort_library_path.as_deref(),
            Some("/opt/ort/libonnxruntime.so")
        );
    }

    #[test]
    fn treats_a_blank_or_non_string_path_as_not_given() {
        for json in [
            r#"{"vadModelPath":"","ortLibraryPath":"   "}"#,
            r#"{"vadModelPath":5,"ortLibraryPath":null}"#,
            r#"{"vadModelPath":["a"],"ortLibraryPath":{}}"#,
        ] {
            let parsed = config(json);
            assert_eq!(parsed.vad_model_path, None, "{json}");
            assert_eq!(parsed.ort_library_path, None, "{json}");
        }
    }
}
