//! `--list-devices`: the input devices decibri can open, on one line.
//!
//! The extension reads the line for Show Diagnostics, and anything that offers
//! the user a choice of microphone can read the same line. It is one JSON array
//! after the `DEVICES:` prefix, one object per device, in decibri's order:
//!
//! ```text
//! DEVICES:[{"index":0,"name":"Microphone Array","id":"wasapi:{0.0.1.00000000}.{...}","default":true,"channels":2,"sampleRate":48000}]
//! ```
//!
//! - `index`: the device's position in the list, which is what a digit-only
//!   `wakeWord.audioDevice` selects.
//! - `name`: the name the operating system gives the device, which a
//!   non-numeric `wakeWord.audioDevice` is matched against, case-insensitively,
//!   as a substring. Two devices can share a name.
//! - `id`: the platform's stable identifier for the device (`wasapi:`,
//!   `coreaudio:` or `alsa:` then the platform's own id), or an empty string
//!   when the platform gives none.
//! - `default`: the system default input, which an empty
//!   `wakeWord.audioDevice` opens. At most one device has it, and none does
//!   when the platform reports no default.
//! - `channels`, `sampleRate`: the device's native format, or 0 when it could
//!   not be read.
//!
//! No devices is `DEVICES:[]`. Fields are only ever added, never renamed or
//! removed, so a reader should ignore a field it does not know. A failure to
//! list is `ERROR:<message>` and exit code 1.
//!
//! Listing opens no stream: decibri enumerates the devices and reads each
//! one's default format, so no microphone is opened, and neither ONNX Runtime
//! nor any model is loaded.

use serde_json::Value;

/// One input device, as the line describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDevice {
    pub index: usize,
    pub name: String,
    pub id: String,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rate: u32,
}

impl From<decibri::MicrophoneInfo> for InputDevice {
    fn from(info: decibri::MicrophoneInfo) -> InputDevice {
        InputDevice {
            index: info.index,
            name: info.name,
            id: info.id,
            is_default: info.is_default,
            channels: info.max_input_channels,
            sample_rate: info.default_sample_rate,
        }
    }
}

/// The devices as the JSON array the `DEVICES:` line carries.
///
/// Written field by field, so the fields keep the documented order; the names
/// go through serde_json, so a quote, a backslash or a control character in a
/// name cannot break the line or the array.
pub fn devices_json(devices: &[InputDevice]) -> String {
    let entries: Vec<String> = devices
        .iter()
        .map(|device| {
            format!(
                "{{\"index\":{},\"name\":{},\"id\":{},\"default\":{},\"channels\":{},\"sampleRate\":{}}}",
                device.index,
                Value::String(device.name.clone()),
                Value::String(device.id.clone()),
                device.is_default,
                device.channels,
                device.sample_rate
            )
        })
        .collect();
    format!("[{}]", entries.join(","))
}

/// The input devices on this machine, or the message for the `ERROR:` line.
pub fn list() -> Result<Vec<InputDevice>, String> {
    decibri::input_devices()
        .map(|devices| devices.into_iter().map(InputDevice::from).collect())
        .map_err(|error| format!("Could not list the input devices: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(index: usize, name: &str, is_default: bool) -> InputDevice {
        InputDevice {
            index,
            name: name.to_string(),
            id: format!("wasapi:{{0.0.1.0000000{index}}}"),
            is_default,
            channels: 2,
            sample_rate: 48_000,
        }
    }

    #[test]
    fn writes_each_device_with_its_fields_in_order() {
        let json = devices_json(&[
            device(0, "Microphone Array", true),
            device(1, "Headset", false),
        ]);
        assert_eq!(
            json,
            "[{\"index\":0,\"name\":\"Microphone Array\",\"id\":\"wasapi:{0.0.1.00000000}\",\"default\":true,\"channels\":2,\"sampleRate\":48000},\
             {\"index\":1,\"name\":\"Headset\",\"id\":\"wasapi:{0.0.1.00000001}\",\"default\":false,\"channels\":2,\"sampleRate\":48000}]"
        );
    }

    #[test]
    fn writes_no_devices_as_an_empty_array() {
        assert_eq!(devices_json(&[]), "[]");
    }

    #[test]
    fn keeps_a_name_with_quotes_backslashes_or_line_breaks_on_one_line() {
        let awkward = "Mic \"A\" \\ B\nC\u{0}\u{7f} \u{e9}";
        let json = devices_json(&[device(3, awkward, false)]);
        assert!(!json.contains('\n'), "the line must stay one line: {json}");
        let parsed: Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed[0]["name"], Value::String(awkward.to_string()));
        assert_eq!(parsed[0]["index"], 3);
    }

    #[test]
    fn writes_zero_for_a_format_that_could_not_be_read() {
        let mut unknown = device(0, "Microphone", false);
        unknown.channels = 0;
        unknown.sample_rate = 0;
        unknown.id = String::new();
        let parsed: Value = serde_json::from_str(&devices_json(&[unknown])).expect("valid JSON");
        assert_eq!(parsed[0]["channels"], 0);
        assert_eq!(parsed[0]["sampleRate"], 0);
        assert_eq!(parsed[0]["id"], "");
    }
}
