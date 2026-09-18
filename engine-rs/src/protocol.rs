//! The wire protocol: chunk-safe stdin line splitting, control-line parsing,
//! and the stdout line vocabulary.
//!
//! Port of `drainLines()` and `parseControlLine()` in `engine/lib/control.js`
//! and of the `out()` / `debug()` / `fatal()` helpers in
//! `engine/audio-engine.js`. The extension parses the stdout side in
//! `parseEngineLine()` / `createLineReader()` in `src/wakeWordCore.ts`, so the
//! vocabulary here is fixed by what that reader accepts.
//!
//! | stdout line | when |
//! |---|---|
//! | `READY` | capture open and listening; answers both the start and a resume |
//! | `DETECTED:<phrase>` | a wake phrase was heard (Relay 3) |
//! | `PAUSED` | capture closed, everything else still loaded |
//! | `RELEASED` | capture closed for good, process exiting |
//! | `ERROR:<msg>` | fatal, the process exits 1 |
//! | `DEBUG:<msg>` | diagnostics, debug mode only |
//! | `SELF-TEST:<line>` | `--self-test` only |

use std::io::{self, Write};
use std::process;

use serde_json::Value;

use crate::config::Config;

/// Splits a byte stream into complete lines, carrying a trailing partial line
/// into the next chunk. Mirrors `drainLines()`.
///
/// stdin arrives in chunks, not lines: one chunk can hold several commands,
/// none at all, or half of one. Handling only the first line of a chunk loses
/// the rest, and a lost `stop` leaves the engine running with the microphone
/// open. Splitting on bytes rather than on decoded text is what makes a
/// multi-byte character split across two chunks harmless: `\n` cannot appear
/// inside a UTF-8 sequence, so every line is decoded whole.
#[derive(Default)]
pub struct LineSplitter {
    rest: Vec<u8>,
}

impl LineSplitter {
    pub fn new() -> LineSplitter {
        LineSplitter::default()
    }

    /// Add a chunk and return every complete line it finished.
    ///
    /// A `\r` is left on the line: `parse_control_line()` trims it, the same
    /// way the Node engine does, so a parent writing CRLF is handled without
    /// the splitter having to know about it.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.rest.extend_from_slice(chunk);

        let mut lines = Vec::new();
        let mut start = 0;
        for (index, byte) in self.rest.iter().enumerate() {
            if *byte == b'\n' {
                lines.push(String::from_utf8_lossy(&self.rest[start..index]).into_owned());
                start = index + 1;
            }
        }
        self.rest.drain(..start);
        lines
    }
}

/// One line read from stdin.
pub enum ControlLine {
    /// The JSON config line, which is the first thing the extension sends.
    Config(Config),
    /// Close the capture device and keep everything else loaded.
    Pause,
    /// Reopen the capture device.
    Resume,
    /// Close everything and exit.
    Stop,
    /// A blank line, which is ignored.
    Empty,
    /// Neither a command nor parsable JSON. Fatal.
    Invalid(String),
}

/// Parse one stdin line, matching `parseControlLine()`.
///
/// Commands match exactly once surrounding whitespace is trimmed: not by
/// prefix and not case-insensitively, so `PAUSE` and `resume now` are invalid
/// rather than silently accepted.
pub fn parse_control_line(line: &str) -> ControlLine {
    let trimmed = js_trim(line);

    match trimmed {
        "stop" => ControlLine::Stop,
        "pause" => ControlLine::Pause,
        "resume" => ControlLine::Resume,
        "" => ControlLine::Empty,
        _ => match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => ControlLine::Config(Config::from_json(&value)),
            Err(err) => ControlLine::Invalid(format!("Invalid config JSON: {err}")),
        },
    }
}

/// JavaScript's `String.prototype.trim()`, which also strips a byte order mark.
fn js_trim(line: &str) -> &str {
    line.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

/// Where protocol lines go. The engine writes through this so the state
/// machine can be driven in a test without a pipe.
pub trait Sink: Send {
    fn write_line(&mut self, line: &str);
}

/// The real sink: one line per write, flushed immediately.
///
/// Every line here is something the extension is waiting for, so none of them
/// may sit in a buffer. A write that fails is dropped rather than reported:
/// the only way it fails is the parent closing the pipe, and that arrives as
/// stdin EOF a moment later and shuts the engine down through the normal path.
pub struct StdoutSink;

impl Sink for StdoutSink {
    fn write_line(&mut self, line: &str) {
        let mut out = io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

/// The stdout half of the protocol.
pub struct Reporter {
    sink: Box<dyn Sink>,
    debug_enabled: bool,
}

impl Reporter {
    pub fn new(sink: Box<dyn Sink>) -> Reporter {
        Reporter {
            sink,
            debug_enabled: false,
        }
    }

    /// Turn `DEBUG:` lines on, once the config line has said whether to.
    pub fn set_debug(&mut self, enabled: bool) {
        self.debug_enabled = enabled;
    }

    pub fn line(&mut self, line: &str) {
        self.sink.write_line(line);
    }

    /// Capture is open and listening. Answers the start and every resume.
    pub fn ready(&mut self) {
        self.line("READY");
    }

    /// Capture is closed and everything else is still loaded.
    pub fn paused(&mut self) {
        self.line("PAUSED");
    }

    /// Capture is closed for good and the process is on its way out.
    pub fn released(&mut self) {
        self.line("RELEASED");
    }

    /// A wake phrase was heard.
    ///
    /// The keyword spotter applies its own threshold and returns no usable
    /// score, so the line carries no confidence suffix even though the
    /// extension's parser accepts one. Relay 3 is what calls this; the format
    /// is pinned here so the vocabulary is complete in one place.
    #[allow(dead_code)]
    pub fn detected(&mut self, phrase: &str) {
        self.line(&format!("DETECTED:{phrase}"));
    }

    /// A fatal error. The caller exits 1 straight after.
    pub fn error(&mut self, message: &str) {
        self.line(&format!("ERROR:{message}"));
    }

    /// Diagnostics, written only in debug mode.
    pub fn debug(&mut self, message: &str) {
        if self.debug_enabled {
            self.line(&format!("DEBUG:{message}"));
        }
    }

    /// One phase of the startup or of a microphone reopen.
    pub fn timing(&mut self, phase: &str, elapsed_ms: u64) {
        self.debug(&format!("Timing: {phase} {elapsed_ms}ms"));
    }

    /// A `--self-test` line. Self-test output is not conditional on debug mode:
    /// CI is the reader.
    pub fn self_test(&mut self, message: &str) {
        self.line(&format!("SELF-TEST:{message}"));
    }
}

/// Flush stdout and exit.
///
/// The Node engine needs `exitWhenFlushed()` because `process.stdout` is an
/// asynchronous pipe on POSIX and exiting straight after a write truncates it.
/// A Rust `write_all` to a pipe is a blocking syscall, so the bytes are in the
/// pipe once it returns; what remains is making sure nothing is still sitting
/// in the line buffer, which is what this flush is for. `RELEASED`, `ERROR:`
/// and the self-test lines are all read by something on the other end of that
/// pipe, so none of them may be lost.
pub fn flush_and_exit(code: i32) -> ! {
    let _ = io::stdout().flush();
    process::exit(code)
}

/// A sink that keeps every line, for tests.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct RecordingSink {
    lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

#[cfg(test)]
impl RecordingSink {
    pub fn new() -> RecordingSink {
        RecordingSink::default()
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines.lock().expect("sink lock").clone()
    }
}

#[cfg(test)]
impl Sink for RecordingSink {
    fn write_line(&mut self, line: &str) {
        self.lines.lock().expect("sink lock").push(line.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(line: &str) -> &'static str {
        match parse_control_line(line) {
            ControlLine::Config(_) => "config",
            ControlLine::Pause => "pause",
            ControlLine::Resume => "resume",
            ControlLine::Stop => "stop",
            ControlLine::Empty => "empty",
            ControlLine::Invalid(_) => "invalid",
        }
    }

    fn push(splitter: &mut LineSplitter, chunk: &str) -> Vec<String> {
        splitter.push(chunk.as_bytes())
    }

    #[test]
    fn returns_a_single_complete_line() {
        let mut splitter = LineSplitter::new();
        assert_eq!(push(&mut splitter, "stop\n"), vec!["stop"]);
    }

    #[test]
    fn returns_every_complete_line_in_one_chunk() {
        let mut splitter = LineSplitter::new();
        assert_eq!(
            push(&mut splitter, "{\"a\":1}\npause\nresume\nstop\n"),
            vec!["{\"a\":1}", "pause", "resume", "stop"]
        );
    }

    #[test]
    fn reassembles_a_line_split_across_two_chunks() {
        let mut splitter = LineSplitter::new();
        assert!(push(&mut splitter, "{\"threshold\":0").is_empty());
        assert_eq!(push(&mut splitter, ".3}\n"), vec!["{\"threshold\":0.3}"]);
    }

    #[test]
    fn reassembles_a_line_split_across_three_chunks() {
        let mut splitter = LineSplitter::new();
        assert!(push(&mut splitter, "{\"phrases\":[{\"phrase\":").is_empty());
        assert!(push(&mut splitter, "\"hey claude\"}],\"threshold\"").is_empty());
        let lines = push(&mut splitter, ":0.05}\nstop\n");
        assert_eq!(
            lines,
            vec![
                "{\"phrases\":[{\"phrase\":\"hey claude\"}],\"threshold\":0.05}",
                "stop"
            ]
        );
    }

    #[test]
    fn splits_a_line_one_byte_at_a_time() {
        let mut splitter = LineSplitter::new();
        let mut lines = Vec::new();
        for byte in b"pause\nstop\n" {
            lines.extend(splitter.push(&[*byte]));
        }
        assert_eq!(lines, vec!["pause", "stop"]);
    }

    #[test]
    fn holds_a_trailing_partial_line_until_it_is_completed() {
        let mut splitter = LineSplitter::new();
        assert_eq!(
            push(&mut splitter, "pause\nresume\nsto"),
            vec!["pause", "resume"]
        );
        assert!(push(&mut splitter, "").is_empty());
        assert_eq!(push(&mut splitter, "p\n"), vec!["stop"]);
    }

    #[test]
    fn returns_blank_lines_for_the_parser_to_ignore() {
        let mut splitter = LineSplitter::new();
        assert_eq!(push(&mut splitter, "\n\nstop\n"), vec!["", "", "stop"]);
        assert_eq!(kind(""), "empty");
        assert_eq!(kind("   "), "empty");
        assert_eq!(kind("\r"), "empty");
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut splitter = LineSplitter::new();
        let lines = push(&mut splitter, "pause\r\nresume\r\nstop\r\n");
        assert_eq!(lines, vec!["pause\r", "resume\r", "stop\r"]);
        assert_eq!(
            lines.iter().map(|line| kind(line)).collect::<Vec<_>>(),
            ["pause", "resume", "stop"]
        );
    }

    #[test]
    fn handles_an_empty_chunk() {
        let mut splitter = LineSplitter::new();
        assert!(push(&mut splitter, "").is_empty());
    }

    #[test]
    fn decodes_a_multi_byte_character_split_across_chunks() {
        // The word boundary marker SentencePiece uses is three bytes, and a
        // phrase can carry any character the user typed.
        let mut splitter = LineSplitter::new();
        let bytes = "{\"phrases\":[{\"phrase\":\"héllo\"}]}\n".as_bytes();
        let mut lines = Vec::new();
        lines.extend(splitter.push(&bytes[..24]));
        lines.extend(splitter.push(&bytes[24..]));
        assert_eq!(lines.len(), 1);
        match parse_control_line(&lines[0]) {
            ControlLine::Config(config) => assert_eq!(config.phrases, vec!["héllo"]),
            _ => panic!("expected a config line"),
        }
    }

    #[test]
    fn recognises_every_command() {
        assert_eq!(kind("pause"), "pause");
        assert_eq!(kind("resume"), "resume");
        assert_eq!(kind("stop"), "stop");
    }

    #[test]
    fn tolerates_whitespace_around_a_command() {
        assert_eq!(kind("  stop\r"), "stop");
        assert_eq!(kind("pause\r"), "pause");
        assert_eq!(kind(" resume \r"), "resume");
        assert_eq!(kind("\tstop  "), "stop");
    }

    #[test]
    fn matches_commands_exactly_not_by_prefix_or_case() {
        for line in [
            "PAUSE",
            "Resume",
            "paused",
            "resume now",
            "stopped",
            "st op",
        ] {
            assert_eq!(kind(line), "invalid", "{line} should be fatal");
        }
    }

    #[test]
    fn reports_malformed_json_in_the_format_the_extension_logs() {
        match parse_control_line("{ not json") {
            ControlLine::Invalid(message) => {
                assert!(
                    message.starts_with("Invalid config JSON: "),
                    "unexpected message: {message}"
                );
            }
            _ => panic!("expected an invalid line"),
        }
    }

    #[test]
    fn reports_a_truncated_config_line() {
        assert_eq!(kind("{\"phrases\":[{\"phrase\":\"hey"), "invalid");
    }

    #[test]
    fn parses_a_config_that_arrived_in_one_chunk_with_its_commands() {
        let mut splitter = LineSplitter::new();
        let lines = push(
            &mut splitter,
            "{\"phrases\":[{\"phrase\":\"hey claude\"}]}\npause\nstop\n",
        );
        assert_eq!(
            lines.iter().map(|line| kind(line)).collect::<Vec<_>>(),
            ["config", "pause", "stop"]
        );
    }

    #[test]
    fn writes_the_stdout_vocabulary() {
        let sink = RecordingSink::new();
        let mut reporter = Reporter::new(Box::new(sink.clone()));
        reporter.ready();
        reporter.paused();
        reporter.released();
        reporter.detected("hey claude");
        reporter.error("Failed to open microphone: no device");
        reporter.self_test("OK");
        assert_eq!(
            sink.lines(),
            [
                "READY",
                "PAUSED",
                "RELEASED",
                "DETECTED:hey claude",
                "ERROR:Failed to open microphone: no device",
                "SELF-TEST:OK",
            ]
        );
    }

    #[test]
    fn writes_debug_lines_only_in_debug_mode() {
        let sink = RecordingSink::new();
        let mut reporter = Reporter::new(Box::new(sink.clone()));
        reporter.debug("quiet");
        reporter.timing("mic-open", 87);
        assert!(sink.lines().is_empty());

        reporter.set_debug(true);
        reporter.debug("loud");
        reporter.timing("mic-open", 87);
        assert_eq!(sink.lines(), ["DEBUG:loud", "DEBUG:Timing: mic-open 87ms"]);
    }
}
