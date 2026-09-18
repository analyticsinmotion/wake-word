//! Keyword lines for the spotter, and the way back from what it reports to the
//! phrase the user configured.
//!
//! Port of `engine/lib/keywords.js`. The spotter does not take plain text: each
//! phrase reaches it as the tokeniser's pieces for the upper-cased phrase,
//! followed by two fields the spotter parses off the end of the line:
//!
//! ```text
//! ▁HE Y ▁C LA U DE :3.0 #0.05
//! ```
//!
//! - `:3.0` is the boost score. It biases decoding toward this phrase's piece
//!   sequence over other readings of the same audio, and is 1.0 when absent.
//!   Higher values help words the model saw little of in training, such as
//!   proper nouns, at the cost of more false triggers.
//! - `#<threshold>` is the phrase's own trigger threshold: the acoustic
//!   probability, from 0 to 1, the decoded sequence must reach before the
//!   spotter reports it. A per-phrase threshold replaces the spotter's global
//!   one for that phrase, and every line carries one, so this is where the
//!   `wakeWord.confidenceThreshold` setting takes effect.
//!
//! The spotter reports a hit as the decoded text of the pieces (`HEY CLAUDE`),
//! not as the phrase that was configured, so the lookup key for each phrase is
//! built the same way: encode it, then decode the pieces.

use crate::config::clamp_threshold;
use crate::protocol::js_trim;

/// SentencePiece marks a word boundary with U+2581 LOWER ONE EIGHTH BLOCK.
pub const WORD_BOUNDARY: char = '\u{2581}';

/// The boost score written on every keyword line.
pub const BOOST_SCORE: &str = "3.0";

/// Turn a piece list back into plain text.
///
/// A leading boundary marker becomes a space, the pieces are joined, and the
/// result is trimmed. This is the form the spotter reports a keyword in.
pub fn decode_pieces(pieces: &[String]) -> String {
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

/// How one phrase was tokenised, for the debug log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhraseDetail {
    /// The phrase as configured.
    pub phrase: String,
    /// Its pieces, space separated, without the boost and threshold fields.
    pub tokens: String,
    /// What the spotter reports when it hears the phrase.
    pub decoded: String,
}

/// Decoded keyword to configured phrase, in the order the keys first appeared.
///
/// Two phrases that decode to the same text share one entry. The later phrase
/// replaces the value and the entry keeps its place, which is what assigning
/// to an existing key of a JavaScript object does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PhraseMap {
    entries: Vec<(String, String)>,
}

impl PhraseMap {
    fn insert(&mut self, decoded: String, phrase: String) {
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

    /// Every decoded key, in insertion order.
    #[cfg(test)]
    pub fn keys(&self) -> Vec<&str> {
        self.entries.iter().map(|(key, _)| key.as_str()).collect()
    }

    /// Every configured phrase, in insertion order.
    pub fn phrases(&self) -> Vec<&str> {
        self.entries
            .iter()
            .map(|(_, phrase)| phrase.as_str())
            .collect()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Everything the spotter needs to listen for the configured phrases.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeywordSpec {
    pub phrase_map: PhraseMap,
    pub keyword_lines: Vec<String>,
    pub details: Vec<PhraseDetail>,
}

impl KeywordSpec {
    /// The keyword list as the spotter takes it: one line per phrase.
    pub fn keywords(&self) -> String {
        self.keyword_lines.join("\n")
    }
}

/// Build the keyword list and the decoded-to-spoken lookup map.
///
/// `phrases` are the configured phrases as sent; `encode` is the tokeniser;
/// `threshold` is the `wakeWord.confidenceThreshold` setting, written as every
/// line's trigger threshold. It is clamped here as well as where the config is
/// parsed, so an unusable value writes the default rather than a line the
/// spotter cannot parse.
///
/// A phrase that is blank once trimmed, or whose pieces decode to nothing, is
/// skipped rather than refused: the routes are user-edited JSON, and one bad
/// entry must not take the engine down before the microphone opens. An empty
/// result is for the caller to refuse.
pub fn build_keyword_spec(
    phrases: &[String],
    encode: &dyn Fn(&str) -> Result<Vec<String>, String>,
    threshold: f64,
) -> Result<KeywordSpec, String> {
    let trigger = clamp_threshold(threshold);
    let mut spec = KeywordSpec::default();

    for phrase in phrases {
        let upper_cased = phrase.to_uppercase();
        let upper = js_trim(&upper_cased);
        if upper.is_empty() {
            continue;
        }
        let pieces = encode(upper)?;
        let tokens = pieces.join(" ");
        let decoded = decode_pieces(&pieces);
        if decoded.is_empty() {
            continue;
        }
        let lower_cased = phrase.to_lowercase();
        spec.phrase_map
            .insert(decoded.clone(), js_trim(&lower_cased).to_string());
        spec.keyword_lines
            .push(format!("{tokens} :{BOOST_SCORE} #{trigger}"));
        spec.details.push(PhraseDetail {
            phrase: phrase.clone(),
            tokens,
            decoded,
        });
    }

    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: char = WORD_BOUNDARY;
    /// The boost score and default trigger threshold a keyword line ends with.
    const SUFFIX: &str = " :3.0 #0.05";

    /// A stand-in tokeniser that splits on whitespace, marks each word
    /// boundary, and breaks longer words into two pieces.
    ///
    ///   "HEY CLAUDE" -> ["<B>HE", "Y", "<B>CL", "AUDE"]
    fn fake_encode(text: &str) -> Result<Vec<String>, String> {
        let mut pieces = Vec::new();
        for word in text.split_whitespace() {
            let split = word
                .char_indices()
                .nth(2)
                .map_or(word.len(), |(index, _)| index);
            pieces.push(format!("{B}{}", &word[..split]));
            if split < word.len() {
                pieces.push(word[split..].to_string());
            }
        }
        Ok(pieces)
    }

    fn phrases(list: &[&str]) -> Vec<String> {
        list.iter().map(|phrase| phrase.to_string()).collect()
    }

    fn spec(list: &[&str], threshold: f64) -> KeywordSpec {
        build_keyword_spec(&phrases(list), &fake_encode, threshold).expect("spec")
    }

    fn pieces(list: &[&str]) -> Vec<String> {
        list.iter().map(|piece| piece.to_string()).collect()
    }

    /// Drop the boost and threshold fields, as the spotter does when it parses
    /// a line, leaving the pieces.
    fn line_pieces(line: &str) -> Vec<String> {
        line.split(' ')
            .filter(|token| !token.starts_with(':') && !token.starts_with('#'))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn decoding_turns_the_boundary_marker_back_into_a_space() {
        assert_eq!(
            decode_pieces(&pieces(&["\u{2581}HEY", "\u{2581}CLAUDE"])),
            "HEY CLAUDE"
        );
    }

    #[test]
    fn decoding_joins_sub_word_pieces_without_a_space() {
        assert_eq!(
            decode_pieces(&pieces(&["\u{2581}CL", "AU", "DE"])),
            "CLAUDE"
        );
        assert_eq!(decode_pieces(&pieces(&["HE", "Y"])), "HEY");
    }

    #[test]
    fn decoding_trims_the_first_boundary_and_handles_no_pieces() {
        assert_eq!(decode_pieces(&pieces(&["\u{2581}COMPUTER"])), "COMPUTER");
        assert_eq!(decode_pieces(&[]), "");
    }

    #[test]
    fn decoding_replaces_only_a_leading_boundary_marker() {
        assert_eq!(
            decode_pieces(&pieces(&["\u{2581}A\u{2581}B"])),
            "A\u{2581}B"
        );
    }

    #[test]
    fn decoding_reverses_the_encoding_of_a_multi_word_phrase() {
        for text in ["HEY CLAUDE", "COMPUTER", "  OPEN   TERMINAL  "] {
            let encoded = fake_encode(text).expect("encode");
            let expected = text.split_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(decode_pieces(&encoded), expected);
        }
    }

    #[test]
    fn a_single_phrase_produces_one_line_with_the_boost_and_the_threshold() {
        let spec = spec(&["hey"], 0.05);
        assert_eq!(spec.keyword_lines, ["\u{2581}HE Y :3.0 #0.05"]);
        assert_eq!(spec.keywords(), "\u{2581}HE Y :3.0 #0.05");
    }

    #[test]
    fn an_alias_list_produces_one_line_per_alias() {
        let spec = spec(&["hey claude", "open claude"], 0.05);
        assert_eq!(spec.keyword_lines.len(), 2);
        assert_eq!(spec.phrase_map.get("HEY CLAUDE"), Some("hey claude"));
        assert_eq!(spec.phrase_map.get("OPEN CLAUDE"), Some("open claude"));
    }

    #[test]
    fn separates_keyword_lines_with_a_newline() {
        let spec = spec(&["hey", "yo"], 0.05);
        assert_eq!(spec.keywords(), format!("{B}HE Y{SUFFIX}\n{B}YO{SUFFIX}"));
    }

    #[test]
    fn skips_blank_phrases() {
        let spec = spec(&["hey claude", "", "   ", "\t\r\n", "\u{feff}"], 0.05);
        assert_eq!(spec.keyword_lines.len(), 1);
        assert_eq!(spec.phrase_map.keys(), ["HEY CLAUDE"]);
    }

    #[test]
    fn skips_a_phrase_whose_pieces_decode_to_nothing() {
        let nothing = |_: &str| -> Result<Vec<String>, String> { Ok(Vec::new()) };
        let spec = build_keyword_spec(&phrases(&["hey claude"]), &nothing, 0.05).expect("spec");
        assert!(spec.keyword_lines.is_empty());
        assert!(spec.phrase_map.is_empty());
    }

    #[test]
    fn no_usable_phrase_leaves_an_empty_spec_for_the_caller_to_refuse() {
        for list in [&[][..], &["", "  "][..]] {
            let spec = spec(list, 0.05);
            assert!(spec.keyword_lines.is_empty());
            assert_eq!(spec.keywords(), "");
            assert!(spec.phrase_map.is_empty());
            assert!(spec.details.is_empty());
        }
    }

    #[test]
    fn tokenises_the_upper_cased_phrase_and_maps_back_to_lower_case() {
        let seen = std::cell::RefCell::new(Vec::new());
        let recording = |text: &str| {
            seen.borrow_mut().push(text.to_string());
            fake_encode(text)
        };
        let spec =
            build_keyword_spec(&phrases(&["  Hey CLAUDE  "]), &recording, 0.05).expect("spec");
        assert_eq!(*seen.borrow(), ["HEY CLAUDE"], "upper-cased and trimmed");
        assert_eq!(spec.phrase_map.keys(), ["HEY CLAUDE"]);
        assert_eq!(spec.phrase_map.get("HEY CLAUDE"), Some("hey claude"));
    }

    #[test]
    fn the_map_round_trips_every_line_back_to_its_phrase() {
        let configured = [
            "hey claude",
            "hey chat",
            "open chat",
            "hey computer",
            "open terminal",
        ];
        let spec = spec(&configured, 0.05);
        assert_eq!(spec.keyword_lines.len(), configured.len());
        for (line, phrase) in spec.keyword_lines.iter().zip(configured) {
            let decoded = decode_pieces(&line_pieces(line));
            assert_eq!(spec.phrase_map.get(&decoded), Some(phrase));
        }
    }

    #[test]
    fn writes_the_threshold_as_configured() {
        for (threshold, text) in [
            (0.01, "0.01"),
            (0.05, "0.05"),
            (0.2, "0.2"),
            (0.3, "0.3"),
            (0.35, "0.35"),
            (0.9, "0.9"),
            (0.123_456_789, "0.123456789"),
        ] {
            let spec = spec(&["hey"], threshold);
            assert_eq!(spec.keyword_lines, [format!("{B}HE Y :3.0 #{text}")]);
        }
    }

    #[test]
    fn writes_every_two_decimal_threshold_the_way_javascript_prints_it() {
        // The settings editor steps in hundredths. Each one must reach the
        // keyword line as the same text the Node engine writes, which is the
        // shortest decimal that reads back as the same number.
        for hundredths in 1..=90 {
            let text = format!("0.{hundredths:02}");
            let expected = text.trim_end_matches('0');
            let json = format!("{{\"threshold\":{text}}}");
            let value: serde_json::Value = serde_json::from_str(&json).expect("json");
            let parsed = crate::config::Config::from_json(&value).threshold;
            let spec = spec(&["hey"], parsed);
            assert_eq!(
                spec.keyword_lines,
                [format!("{B}HE Y :3.0 #{expected}")],
                "threshold {text}"
            );
        }
    }

    #[test]
    fn clamps_the_threshold_before_writing_it() {
        let line = |threshold: f64| spec(&["hey"], threshold).keyword_lines.remove(0);
        assert_eq!(line(0.001), format!("{B}HE Y :3.0 #0.01"));
        assert_eq!(line(-1.0), format!("{B}HE Y :3.0 #0.01"));
        assert_eq!(line(5.0), format!("{B}HE Y :3.0 #0.9"));
        assert_eq!(line(f64::INFINITY), format!("{B}HE Y :3.0 #0.9"));
    }

    #[test]
    fn writes_the_default_threshold_for_an_unusable_one() {
        for threshold in [0.0, -0.0, f64::NAN] {
            assert_eq!(
                spec(&["hey"], threshold).keyword_lines,
                [format!("{B}HE Y{SUFFIX}")]
            );
        }
    }

    #[test]
    fn ends_every_line_with_the_two_fields_and_keeps_them_out_of_the_pieces() {
        let spec = spec(
            &[
                "hey claude",
                "hey chat",
                "open chat",
                "hey computer",
                "open terminal",
            ],
            0.05,
        );
        assert_eq!(spec.keyword_lines.len(), 5);
        for line in &spec.keyword_lines {
            let pieces = line
                .strip_suffix(SUFFIX)
                .expect("line ends with the fields");
            assert!(!pieces.contains(':') && !pieces.contains('#'), "{line}");
        }
    }

    #[test]
    fn reports_how_each_phrase_was_tokenised() {
        let spec = spec(&["hey chat"], 0.05);
        assert_eq!(
            spec.details,
            [PhraseDetail {
                phrase: "hey chat".to_string(),
                tokens: format!("{B}HE Y {B}CH AT"),
                decoded: "HEY CHAT".to_string(),
            }]
        );
    }

    #[test]
    fn phrases_that_decode_alike_share_one_map_entry_and_keep_both_lines() {
        // The spotter accepts a repeated line. The later phrase takes the
        // entry, which keeps the place the first one gave it.
        let spec = spec(&["hey claude", "open chat", "HEY  CLAUDE"], 0.05);
        assert_eq!(spec.keyword_lines.len(), 3);
        assert_eq!(spec.phrase_map.keys(), ["HEY CLAUDE", "OPEN CHAT"]);
        assert_eq!(spec.phrase_map.get("HEY CLAUDE"), Some("hey  claude"));
        assert_eq!(spec.phrase_map.phrases(), ["hey  claude", "open chat"]);
    }

    #[test]
    fn a_tokeniser_failure_is_passed_on() {
        let failing = |_: &str| -> Result<Vec<String>, String> { Err("no model".to_string()) };
        let error = build_keyword_spec(&phrases(&["hey"]), &failing, 0.05).unwrap_err();
        assert_eq!(error, "no model");
    }

    #[test]
    fn trims_the_way_javascript_does() {
        // U+0085 is white space to Rust and not to JavaScript; U+FEFF is the
        // other way round. The lookup key has to match what the Node engine
        // builds for the same phrase.
        let whole = |text: &str| -> Result<Vec<String>, String> { Ok(vec![format!("{B}{text}")]) };
        let spec = build_keyword_spec(&phrases(&["\u{feff}hey\u{feff}", "\u{85}"]), &whole, 0.05)
            .expect("spec");
        assert_eq!(spec.phrase_map.get("HEY"), Some("hey"));
        assert_eq!(spec.phrase_map.get("\u{85}"), Some("\u{85}"));
    }
}
