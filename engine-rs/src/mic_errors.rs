//! decibri's typed errors, turned into messages a user can act on.
//!
//! Every decibri error carries a stable code, `DecibriError::code()`, and the
//! mapping switches on that rather than on the message text, which is not
//! stable. Anything unrecognised falls back to the raw message under the
//! caller's prefix.

use crate::config::AudioDevice;

/// The setting a user edits to choose a microphone, named in every message
/// about a device they chose.
pub const SETTING: &str = "wakeWord.audioDevice";

/// A failure from the capture side: opening the microphone, loading the voice
/// activity detector, or a stream that failed while running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureError {
    /// decibri's stable code, when the failure came from decibri.
    pub code: Option<&'static str>,
    /// The error's own message.
    pub message: String,
}

impl CaptureError {
    /// A failure with no decibri code, reported under the caller's prefix.
    #[cfg(test)]
    pub fn uncoded(message: impl Into<String>) -> CaptureError {
        CaptureError {
            code: None,
            message: message.into(),
        }
    }
}

impl From<decibri::DecibriError> for CaptureError {
    fn from(error: decibri::DecibriError) -> CaptureError {
        CaptureError {
            code: Some(error.code()),
            message: error.to_string(),
        }
    }
}

/// The message to report for a capture failure.
///
/// `device` is the resolved `wakeWord.audioDevice` setting. When the user chose
/// a device, a lookup failure names the setting and the value: "no microphone
/// found" is the wrong diagnosis on a machine with three microphones where the
/// name simply matched none of them.
pub fn mic_error_message(
    error: &CaptureError,
    fallback_prefix: &str,
    device: &AudioDevice,
) -> String {
    let chosen = match device {
        AudioDevice::Default => None,
        AudioDevice::Index(index) => Some(index.to_string()),
        AudioDevice::Name(name) => Some(name.clone()),
    };
    let message = &error.message;

    match error.code {
        // An index past the end of the device list.
        Some("DEVICE_INDEX_OUT_OF_RANGE") if chosen.is_some() => format!(
            "Microphone index {} is out of range. Check {SETTING} against the input devices on this machine.",
            chosen.unwrap_or_default()
        ),
        Some("MICROPHONE_NOT_FOUND") => match chosen {
            Some(chosen) => format!(
                "No microphone matching \"{chosen}\" was found. Check {SETTING} against the input devices on this machine."
            ),
            None => "No microphone found. Check your audio device settings.".to_string(),
        },
        Some("NO_MICROPHONE_FOUND") => {
            "No microphone found. Check your audio device settings.".to_string()
        }
        Some("MULTIPLE_DEVICES_MATCH") => format!(
            "More than one microphone matches \"{}\". Use a longer name or the device index in {SETTING}.",
            chosen.as_deref().unwrap_or("the requested name")
        ),
        Some("NOT_AN_INPUT_DEVICE") => match chosen {
            Some(chosen) => {
                format!("The audio device \"{chosen}\" is not a microphone. Check {SETTING}.")
            }
            None => "The selected audio device is not a microphone. Check your audio device settings."
                .to_string(),
        },
        Some("PERMISSION_DENIED") => "Microphone access denied. Enable microphone access for VS Code in your system privacy settings.".to_string(),
        Some("DEVICE_FAILED") => format!("The microphone stopped responding: {message}"),
        // Every ONNX Runtime and Silero failure is the detector failing to
        // start or to run. The threads and tensor codes are raised by the same
        // load and inference paths as the others.
        Some(
            "ORT_INIT_FAILED"
            | "ORT_LOAD_FAILED"
            | "ORT_SESSION_BUILD_FAILED"
            | "ORT_THREADS_CONFIG_FAILED"
            | "ORT_INFERENCE_FAILED"
            | "ORT_TENSOR_CREATE_FAILED"
            | "ORT_TENSOR_EXTRACT_FAILED"
            | "VAD_MODEL_LOAD_FAILED",
        ) => format!("Failed to start voice activity detection: {message}"),
        _ => format!("{fallback_prefix}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &str = "Failed to open microphone";

    fn coded(code: &'static str, message: &str) -> CaptureError {
        CaptureError {
            code: Some(code),
            message: message.to_string(),
        }
    }

    fn name(value: &str) -> AudioDevice {
        AudioDevice::Name(value.to_string())
    }

    fn message(code: &'static str, device: &AudioDevice) -> String {
        mic_error_message(&coded(code, "raw message"), PREFIX, device)
    }

    #[test]
    fn names_the_setting_and_value_for_a_name_that_matches_nothing() {
        assert_eq!(
            message("MICROPHONE_NOT_FOUND", &name("Desk Mic 2")),
            "No microphone matching \"Desk Mic 2\" was found. Check wakeWord.audioDevice against the input devices on this machine."
        );
    }

    #[test]
    fn gives_the_generic_message_for_a_missing_microphone_when_none_was_chosen() {
        assert_eq!(
            message("MICROPHONE_NOT_FOUND", &AudioDevice::Default),
            "No microphone found. Check your audio device settings."
        );
    }

    #[test]
    fn gives_the_generic_message_when_the_machine_has_no_microphone() {
        for device in [AudioDevice::Default, name("Desk Mic 2")] {
            assert_eq!(
                message("NO_MICROPHONE_FOUND", &device),
                "No microphone found. Check your audio device settings."
            );
        }
    }

    #[test]
    fn asks_for_a_longer_name_when_several_devices_match() {
        assert_eq!(
            message("MULTIPLE_DEVICES_MATCH", &name("USB")),
            "More than one microphone matches \"USB\". Use a longer name or the device index in wakeWord.audioDevice."
        );
        assert_eq!(
            message("MULTIPLE_DEVICES_MATCH", &AudioDevice::Default),
            "More than one microphone matches \"the requested name\". Use a longer name or the device index in wakeWord.audioDevice."
        );
    }

    #[test]
    fn says_a_chosen_output_device_is_not_a_microphone() {
        assert_eq!(
            message("NOT_AN_INPUT_DEVICE", &name("Speakers")),
            "The audio device \"Speakers\" is not a microphone. Check wakeWord.audioDevice."
        );
        assert_eq!(
            message("NOT_AN_INPUT_DEVICE", &AudioDevice::Default),
            "The selected audio device is not a microphone. Check your audio device settings."
        );
    }

    #[test]
    fn names_the_index_when_it_is_out_of_range() {
        assert_eq!(
            message("DEVICE_INDEX_OUT_OF_RANGE", &AudioDevice::Index(7)),
            "Microphone index 7 is out of range. Check wakeWord.audioDevice against the input devices on this machine."
        );
    }

    #[test]
    fn falls_back_for_an_index_out_of_range_when_no_device_was_chosen() {
        assert_eq!(
            message("DEVICE_INDEX_OUT_OF_RANGE", &AudioDevice::Default),
            "Failed to open microphone: raw message"
        );
    }

    #[test]
    fn points_at_the_privacy_settings_when_access_is_denied() {
        for device in [AudioDevice::Default, name("Desk Mic 2")] {
            assert_eq!(
                message("PERMISSION_DENIED", &device),
                "Microphone access denied. Enable microphone access for VS Code in your system privacy settings."
            );
        }
    }

    #[test]
    fn carries_the_driver_message_for_a_device_that_failed() {
        assert_eq!(
            message("DEVICE_FAILED", &AudioDevice::Default),
            "The microphone stopped responding: raw message"
        );
    }

    #[test]
    fn reports_every_onnx_runtime_and_model_failure_as_the_detector_failing() {
        for code in [
            "ORT_INIT_FAILED",
            "ORT_LOAD_FAILED",
            "ORT_SESSION_BUILD_FAILED",
            "ORT_THREADS_CONFIG_FAILED",
            "ORT_INFERENCE_FAILED",
            "ORT_TENSOR_CREATE_FAILED",
            "ORT_TENSOR_EXTRACT_FAILED",
            "VAD_MODEL_LOAD_FAILED",
        ] {
            assert_eq!(
                message(code, &name("Desk Mic 2")),
                "Failed to start voice activity detection: raw message",
                "{code}"
            );
        }
    }

    #[test]
    fn falls_back_to_the_prefix_and_message_for_an_unknown_code() {
        assert_eq!(
            message("STREAM_OPEN_FAILED", &AudioDevice::Default),
            "Failed to open microphone: raw message"
        );
        assert_eq!(
            mic_error_message(
                &coded("SOMETHING_NEW", "odd"),
                "Microphone error",
                &name("x")
            ),
            "Microphone error: odd"
        );
    }

    #[test]
    fn falls_back_to_the_prefix_and_message_when_there_is_no_code() {
        assert_eq!(
            mic_error_message(
                &CaptureError::uncoded("no device"),
                PREFIX,
                &AudioDevice::Default
            ),
            "Failed to open microphone: no device"
        );
    }

    #[test]
    fn every_code_that_is_mapped_produces_its_own_message() {
        // The eleven codes with a message of their own, plus the index case.
        // None of them may fall through to the generic fallback.
        let device = name("Desk Mic 2");
        for code in [
            "MICROPHONE_NOT_FOUND",
            "NO_MICROPHONE_FOUND",
            "MULTIPLE_DEVICES_MATCH",
            "NOT_AN_INPUT_DEVICE",
            "PERMISSION_DENIED",
            "DEVICE_FAILED",
            "ORT_INIT_FAILED",
            "ORT_LOAD_FAILED",
            "ORT_SESSION_BUILD_FAILED",
            "ORT_INFERENCE_FAILED",
            "VAD_MODEL_LOAD_FAILED",
            "DEVICE_INDEX_OUT_OF_RANGE",
        ] {
            let text = message(code, &device);
            assert!(!text.starts_with(PREFIX), "{code} fell back: {text}");
        }
    }

    #[test]
    fn the_codes_match_the_ones_decibri_assigns() {
        // The mapping switches on literal strings, so check each one against
        // the variant decibri actually reports it for. A code renamed upstream
        // would otherwise fall silently through to the fallback.
        use decibri::DecibriError;
        let source = || -> Box<dyn std::error::Error + Send + Sync> { "cause".into() };
        let cases: Vec<(DecibriError, &str)> = vec![
            (
                DecibriError::MicrophoneNotFound("x".into()),
                "MICROPHONE_NOT_FOUND",
            ),
            (DecibriError::NoMicrophoneFound, "NO_MICROPHONE_FOUND"),
            (
                DecibriError::MultipleDevicesMatch {
                    name: "x".into(),
                    matches: "y".into(),
                },
                "MULTIPLE_DEVICES_MATCH",
            ),
            (DecibriError::NotAnInputDevice, "NOT_AN_INPUT_DEVICE"),
            (
                DecibriError::DeviceIndexOutOfRange,
                "DEVICE_INDEX_OUT_OF_RANGE",
            ),
            (DecibriError::PermissionDenied, "PERMISSION_DENIED"),
            (
                DecibriError::DeviceFailed { source: source() },
                "DEVICE_FAILED",
            ),
            (
                DecibriError::OrtInitFailed { source: source() },
                "ORT_INIT_FAILED",
            ),
            (
                DecibriError::OrtLoadFailed {
                    path: "x".into(),
                    source: source(),
                },
                "ORT_LOAD_FAILED",
            ),
            (
                DecibriError::OrtPathInvalid {
                    path: "x".into(),
                    reason: "missing",
                },
                "ORT_LOAD_FAILED",
            ),
            (
                DecibriError::OrtSessionBuildFailed(source()),
                "ORT_SESSION_BUILD_FAILED",
            ),
            (
                DecibriError::OrtThreadsConfigFailed(source()),
                "ORT_THREADS_CONFIG_FAILED",
            ),
            (
                DecibriError::OrtInferenceFailed(source()),
                "ORT_INFERENCE_FAILED",
            ),
            (
                DecibriError::OrtTensorCreateFailed {
                    kind: "input",
                    source: source(),
                },
                "ORT_TENSOR_CREATE_FAILED",
            ),
            (
                DecibriError::OrtTensorExtractFailed {
                    kind: "output",
                    source: source(),
                },
                "ORT_TENSOR_EXTRACT_FAILED",
            ),
            (
                DecibriError::VadModelLoadFailed {
                    path: "x".into(),
                    source: source(),
                },
                "VAD_MODEL_LOAD_FAILED",
            ),
        ];
        for (error, code) in cases {
            let converted = CaptureError::from(error);
            assert_eq!(converted.code, Some(code));
            assert!(!converted.message.is_empty());
        }
    }

    #[test]
    fn a_converted_decibri_error_keeps_its_display_message() {
        let converted =
            CaptureError::from(decibri::DecibriError::MicrophoneNotFound("Desk Mic".into()));
        assert_eq!(
            converted.message,
            "No microphone found matching \"Desk Mic\""
        );
        assert_eq!(
            mic_error_message(&converted, PREFIX, &name("Desk Mic")),
            "No microphone matching \"Desk Mic\" was found. Check wakeWord.audioDevice against the input devices on this machine."
        );
    }
}
