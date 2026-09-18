//! The config line the extension sends as the first line of stdin.
//!
//! Port of the config half of `engine/lib/control.js` (`clampKeywordThreshold`,
//! `resolveAudioDevice`) and of the phrase filtering `buildKeywordSpec()` does
//! in `engine/lib/keywords.js`.
//!
//! The shape, as `src/sherpaEngine.ts` writes it:
//!
//! ```json
//! { "phrases": [{ "phrase": "hey claude", "label": "Claude" }],
//!   "threshold": 0.05, "modelDir": "<path>",
//!   "debugMode": false, "audioDevice": "" }
//! ```
//!
//! `phrase` is a string or an array of strings, `label` is never read by the
//! engine, and every field is optional. Two more optional fields,
//! `vadModelPath` and `ortLibraryPath`, locate the Silero model and the ONNX
//! Runtime library; the extension does not send them, and without them the
//! engine searches the places `crate::assets` describes. The values are read one at a time out
//! of a `serde_json::Value` rather than deserialised into a struct, because the
//! Node engine coerces rather than rejects: a phrase that is not a string is
//! skipped, a threshold of zero becomes the default, and a missing field is
//! simply absent. Deserialising into typed fields would turn each of those into
//! a fatal `Invalid config JSON`, which is a different engine.

use serde_json::Value;

/// Lowest usable keyword threshold, matching `clampThreshold()` in
/// `src/wakeWordCore.ts` and `clampKeywordThreshold()` in
/// `engine/lib/control.js`.
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
    /// How the device reads in a debug line, matching the Node engine's
    /// `JSON.stringify(micOptions.device)`.
    pub fn describe(&self) -> Option<String> {
        match self {
            AudioDevice::Default => None,
            AudioDevice::Index(index) => Some(index.to_string()),
            AudioDevice::Name(name) => Some(Value::String(name.clone()).to_string()),
        }
    }
}

/// The parsed config line.
#[derive(Debug, Clone)]
pub struct Config {
    /// Every phrase from every route, flattened in the order they were sent,
    /// with non-string and blank entries dropped. The engine has no use for the
    /// route grouping or the label: `buildKeywordSpec()` builds one keyword
    /// line per phrase and one flat lookup map.
    pub phrases: Vec<String>,
    /// The clamped trigger threshold, the value every keyword line carries.
    /// No keyword spotter reads it in this build.
    #[allow(dead_code)]
    pub threshold: f64,
    /// Where the extension unpacked the keyword spotting model. Reported in a
    /// debug line; no keyword spotter reads it in this build.
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
    /// Anything that is not a JSON object yields an empty config, the same
    /// outcome the Node engine reaches by destructuring a non-object and
    /// finding every field undefined.
    pub fn from_json(value: &Value) -> Config {
        Config {
            phrases: collect_phrases(value.get("phrases")),
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

/// Flatten `phrases` into the phrase strings the spotter can actually use.
///
/// Mirrors the skipping in `buildKeywordSpec()`: a falsy route entry, a
/// `phrase` that is not a string, and a phrase that is blank once trimmed are
/// all dropped rather than thrown on. `wakeWord.routes` is user-edited JSON and
/// one bad entry must not take the engine down before the microphone opens.
fn collect_phrases(value: Option<&Value>) -> Vec<String> {
    let mut phrases = Vec::new();
    let Some(Value::Array(routes)) = value else {
        return phrases;
    };
    for route in routes {
        let Some(phrase) = route.get("phrase") else {
            continue;
        };
        let candidates: Vec<&Value> = match phrase {
            Value::Array(aliases) => aliases.iter().collect(),
            other => vec![other],
        };
        for candidate in candidates {
            let Some(text) = candidate.as_str() else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            phrases.push(text.to_string());
        }
    }
    phrases
}

/// Clamp the keyword-spotting threshold into the range
/// `wakeWord.confidenceThreshold` allows, matching `clampKeywordThreshold()`.
///
/// `threshold || 0.05` in JavaScript sends zero, NaN, null, and a missing value
/// to the default; a negative or oversized number is clamped into range.
pub fn clamp_keyword_threshold(value: Option<&Value>) -> f64 {
    let raw = match value.and_then(Value::as_f64) {
        // Zero and NaN are falsy in JavaScript and take the default with them.
        Some(number) if number != 0.0 && !number.is_nan() => number,
        _ => DEFAULT_THRESHOLD,
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
                "modelDir":"C:\\Users\\me\\models","debugMode":true,"audioDevice":""}"#,
        );
        assert_eq!(parsed.phrases, vec!["hey claude"]);
        assert!(close(parsed.threshold, 0.3));
        assert_eq!(parsed.model_dir, "C:\\Users\\me\\models");
        assert!(parsed.debug_mode);
        assert_eq!(parsed.audio_device, AudioDevice::Default);
    }

    #[test]
    fn accepts_a_phrase_as_a_string_and_as_an_array_of_aliases() {
        let parsed = config(
            r#"{"phrases":[{"phrase":["hey claude","open claude"],"label":"Claude"},
                {"phrase":"hey chat","label":"Chat"}]}"#,
        );
        assert_eq!(
            parsed.phrases,
            vec!["hey claude", "open claude", "hey chat"]
        );
    }

    #[test]
    fn defaults_every_field_that_is_missing() {
        let parsed = config("{}");
        assert!(parsed.phrases.is_empty());
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
            assert!(parsed.phrases.is_empty(), "{json} should carry no phrases");
            assert!(close(parsed.threshold, DEFAULT_THRESHOLD), "{json}");
        }
    }

    #[test]
    fn skips_phrases_that_are_not_strings_rather_than_failing() {
        let parsed = config(
            r#"{"phrases":[{"phrase":42},{"phrase":null},{"phrase":["hey claude",7,true]},
                {"label":"no phrase"},null,"hey",{"phrase":{}}]}"#,
        );
        assert_eq!(parsed.phrases, vec!["hey claude"]);
    }

    #[test]
    fn skips_blank_phrases() {
        let parsed = config(r#"{"phrases":[{"phrase":"   "},{"phrase":""},{"phrase":"\t\r\n"}]}"#);
        assert!(parsed.phrases.is_empty());
    }

    #[test]
    fn keeps_a_phrase_exactly_as_sent() {
        // Case folding and trimming belong to the keyword builder, which
        // needs both the upper case form and the lower case one.
        let parsed = config(r#"{"phrases":[{"phrase":"  Hey Claude  "}]}"#);
        assert_eq!(parsed.phrases, vec!["  Hey Claude  "]);
    }

    #[test]
    fn ignores_a_phrases_field_that_is_not_an_array() {
        for json in [
            r#"{"phrases":5}"#,
            r#"{"phrases":"hey"}"#,
            r#"{"phrases":{}}"#,
        ] {
            assert!(config(json).phrases.is_empty(), "{json}");
        }
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
