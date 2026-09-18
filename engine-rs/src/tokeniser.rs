//! The SentencePiece tokeniser that turns a phrase into the model's pieces.
//!
//! The keyword spotter looks each whitespace-separated token of a keyword line
//! up in the model's `tokens.txt` and does no tokenising of its own, so the
//! pieces have to come from the SentencePiece model shipped with the
//! transducer, `bpe.model`. Despite the file name it is a Unigram model
//! (`trainer_spec.model_type` is `UNIGRAM`): pieces are chosen by a Viterbi
//! search over piece scores, not by merge rules. It carries the `nmt_nfkc`
//! normaliser as a precompiled character map, a dummy prefix, and whitespace
//! escaping, so full-width and ligature forms fold to the letters the
//! vocabulary has.
//!
//! The Node engine tokenises with the SentencePiece C++ library. The pieces
//! here have to be the same ones, because a different piece sequence is a
//! different keyword to the spotter.

use std::path::Path;

use sentencepiece_rust::SentencePieceProcessor;

/// The tokeniser model's file name inside the model directory.
pub const TOKENISER_MODEL_FILE: &str = "bpe.model";

/// A loaded tokeniser model.
pub struct Tokeniser {
    processor: SentencePieceProcessor,
}

impl Tokeniser {
    /// Load `bpe.model` from the model directory.
    pub fn load(model_dir: &str) -> Result<Tokeniser, String> {
        let path = Path::new(model_dir).join(TOKENISER_MODEL_FILE);
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        Tokeniser::from_bytes(&bytes)
            .map_err(|error| format!("Failed to load {}: {error}", path.display()))
    }

    /// Load a tokeniser from the bytes of a SentencePiece model file.
    pub fn from_bytes(bytes: &[u8]) -> Result<Tokeniser, String> {
        SentencePieceProcessor::from_bytes(bytes)
            .map(|processor| Tokeniser { processor })
            .map_err(|error| error.to_string())
    }

    /// The pieces for `text`, as SentencePiece's `EncodeAsPieces` returns them:
    /// text the vocabulary does not cover comes back as itself, with a run of
    /// such characters merged into one piece, rather than as `<unk>`.
    pub fn encode_pieces(&self, text: &str) -> Result<Vec<String>, String> {
        self.processor
            .encode_pieces(text)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keywords::{build_keyword_spec, decode_pieces};

    /// A protobuf varint.
    fn varint(mut value: u64, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn length_delimited(field: u64, bytes: &[u8], out: &mut Vec<u8>) {
        varint(field << 3 | 2, out);
        varint(bytes.len() as u64, out);
        out.extend_from_slice(bytes);
    }

    fn int_field(field: u64, value: i32, out: &mut Vec<u8>) {
        varint(field << 3, out);
        // Negative int32 values are written sign-extended to 64 bits.
        varint(i64::from(value) as u64, out);
    }

    /// One `ModelProto.SentencePiece`: piece, score, and type.
    fn piece(text: &str, score: f32, kind: i32) -> Vec<u8> {
        let mut out = Vec::new();
        length_delimited(1, text.as_bytes(), &mut out);
        varint(2 << 3 | 5, &mut out);
        out.extend_from_slice(&score.to_le_bytes());
        int_field(3, kind, &mut out);
        out
    }

    /// A miniature Unigram model with the shape of the shipped one: `<unk>` at
    /// id 2 behind two user-defined symbols, no byte fallback, a dummy prefix,
    /// and whitespace escaping. It has no character map, so normalisation is
    /// the identity apart from whitespace.
    fn miniature_model() -> Vec<u8> {
        const NORMAL: i32 = 1;
        const UNKNOWN: i32 = 2;
        const USER_DEFINED: i32 = 4;
        let pieces: [(&str, f32, i32); 16] = [
            ("<blk>", 0.0, USER_DEFINED),
            ("<sos/eos>", 0.0, USER_DEFINED),
            ("<unk>", 0.0, UNKNOWN),
            ("\u{2581}", -2.0, NORMAL),
            ("\u{2581}HE", -3.0, NORMAL),
            ("Y", -3.5, NORMAL),
            ("\u{2581}C", -4.0, NORMAL),
            ("LA", -4.5, NORMAL),
            ("U", -4.6, NORMAL),
            ("DE", -4.7, NORMAL),
            ("H", -6.0, NORMAL),
            ("E", -6.1, NORMAL),
            ("C", -6.2, NORMAL),
            ("L", -6.3, NORMAL),
            ("A", -6.4, NORMAL),
            ("D", -6.5, NORMAL),
        ];

        let mut model = Vec::new();
        for (text, score, kind) in pieces {
            length_delimited(1, &piece(text, score, kind), &mut model);
        }

        let mut trainer = Vec::new();
        int_field(3, 1, &mut trainer); // model_type: UNIGRAM
        int_field(40, 2, &mut trainer); // unk_id
        int_field(41, -1, &mut trainer); // bos_id
        int_field(42, -1, &mut trainer); // eos_id
        length_delimited(2, &trainer, &mut model);

        let mut normaliser = Vec::new();
        int_field(3, 1, &mut normaliser); // add_dummy_prefix
        int_field(4, 1, &mut normaliser); // remove_extra_whitespaces
        int_field(5, 1, &mut normaliser); // escape_whitespaces
        length_delimited(3, &normaliser, &mut model);
        model
    }

    fn miniature() -> Tokeniser {
        Tokeniser::from_bytes(&miniature_model()).expect("the miniature model loads")
    }

    #[test]
    fn encodes_a_phrase_into_the_best_scoring_pieces() {
        let tokeniser = miniature();
        assert_eq!(
            tokeniser.encode_pieces("HEY CLAUDE").expect("encode"),
            ["\u{2581}HE", "Y", "\u{2581}C", "LA", "U", "DE"]
        );
    }

    #[test]
    fn collapses_whitespace_and_adds_the_dummy_prefix() {
        let tokeniser = miniature();
        assert_eq!(
            tokeniser.encode_pieces("  HEY   CLAUDE  ").expect("encode"),
            tokeniser.encode_pieces("HEY CLAUDE").expect("encode")
        );
    }

    #[test]
    fn returns_text_outside_the_vocabulary_as_itself_in_one_piece() {
        let tokeniser = miniature();
        assert_eq!(
            tokeniser.encode_pieces("HEY 42").expect("encode"),
            ["\u{2581}HE", "Y", "\u{2581}", "42"]
        );
    }

    #[test]
    fn upper_casing_happens_before_encoding() {
        // The vocabulary is upper case. Lower-case text is outside it, so the
        // keyword builder upper-cases first.
        let tokeniser = miniature();
        assert_eq!(
            tokeniser.encode_pieces("hey").expect("encode"),
            ["\u{2581}", "hey"]
        );
        let encode = |text: &str| tokeniser.encode_pieces(text);
        let spec = build_keyword_spec(&["hey claude".to_string()], &encode, 0.05).expect("spec");
        assert_eq!(
            spec.keyword_lines,
            ["\u{2581}HE Y \u{2581}C LA U DE :3.0 #0.05"]
        );
        assert_eq!(spec.phrase_map.get("HEY CLAUDE"), Some("hey claude"));
    }

    #[test]
    fn decoding_reverses_the_encoding() {
        let tokeniser = miniature();
        for text in ["HEY CLAUDE", "CLAUDE", "HEY", "HEY 42 CLAUDE"] {
            let pieces = tokeniser.encode_pieces(text).expect("encode");
            assert_eq!(decode_pieces(&pieces), text);
        }
    }

    #[test]
    fn refuses_bytes_that_are_not_a_model() {
        assert!(Tokeniser::from_bytes(b"not a sentencepiece model").is_err());
        assert!(Tokeniser::from_bytes(&[]).is_err());
    }

    #[test]
    fn names_the_file_it_could_not_read() {
        let error = Tokeniser::load("no-such-model-dir")
            .err()
            .expect("an error");
        assert!(error.contains("bpe.model"), "{error}");
    }

    /// The pieces `sentencepiece-js` 1.1.0 produces from the shipped
    /// `bpe.model` for each upper-cased phrase. The Node engine builds its
    /// keyword lines from exactly these.
    const REFERENCE_PIECES: &[(&str, &[&str])] = &[
        ("HEY CLAUDE", &["▁HE", "Y", "▁C", "LA", "U", "DE"]),
        ("HEY CHAT", &["▁HE", "Y", "▁CHA", "T"]),
        ("OPEN CHAT", &["▁O", "P", "EN", "▁CHA", "T"]),
        ("HEY COMPUTER", &["▁HE", "Y", "▁COMP", "U", "TER"]),
        (
            "OPEN TERMINAL",
            &["▁O", "P", "EN", "▁", "TER", "M", "IN", "AL"],
        ),
        ("OPEN CLAUDE", &["▁O", "P", "EN", "▁C", "LA", "U", "DE"]),
        ("HELLO WORLD", &["▁HE", "LL", "O", "▁WORLD"]),
        ("HAPPY NEW YEAR", &["▁HA", "PP", "Y", "▁NEW", "▁YEAR"]),
        (
            "MERRY CHRISTMAS",
            &["▁ME", "R", "RY", "▁", "CH", "R", "IST", "MA", "S"],
        ),
        ("LIGHT UP", &["▁", "L", "IGHT", "▁UP"]),
        ("LOVELY CHILD", &["▁LOVE", "LY", "▁CHI", "L", "D"]),
        ("DON'T STOP", &["▁DON", "'", "T", "▁ST", "O", "P"]),
        // Normalisation: full-width letters fold to the vocabulary's letters,
        // a ligature unfolds to lower-case letters the vocabulary lacks, and a
        // combining accent composes.
        ("ＨＥＹ　ＣＬＡＵＤＥ", &["▁HE", "Y", "▁C", "LA", "U", "DE"]),
        ("ﬁNE", &["▁", "fi", "NE"]),
        ("CAFE\u{301}", &["▁CA", "F", "É"]),
        // Outside the vocabulary: returned as itself, runs merged.
        ("ROUTE 66", &["▁RO", "U", "TE", "▁", "66"]),
        ("ПРИВЕТ", &["▁", "ПРИВЕТ"]),
    ];

    fn shipped_model() -> Tokeniser {
        let dir = std::env::var("WAKE_WORD_MODEL_DIR")
            .expect("set WAKE_WORD_MODEL_DIR to the extracted keyword spotting model");
        Tokeniser::load(&dir).expect("bpe.model loads")
    }

    #[test]
    #[ignore = "needs the keyword spotting model: set WAKE_WORD_MODEL_DIR"]
    fn the_shipped_model_gives_the_pieces_the_node_engine_gets() {
        let tokeniser = shipped_model();
        for (text, expected) in REFERENCE_PIECES {
            assert_eq!(
                tokeniser.encode_pieces(text).expect("encode"),
                *expected,
                "{text}"
            );
        }
    }

    #[test]
    #[ignore = "needs the keyword spotting model: set WAKE_WORD_MODEL_DIR"]
    fn the_shipped_model_decodes_back_to_the_normalised_phrase() {
        let tokeniser = shipped_model();
        for (text, decoded) in [
            ("HEY CLAUDE", "HEY CLAUDE"),
            ("  OPEN   TERMINAL ", "OPEN TERMINAL"),
            ("ＨＥＹ　ＣＬＡＵＤＥ", "HEY CLAUDE"),
            ("ROUTE 66", "ROUTE 66"),
        ] {
            let pieces = tokeniser.encode_pieces(text).expect("encode");
            assert_eq!(decode_pieces(&pieces), decoded, "{text}");
        }
    }

    #[test]
    #[ignore = "needs the keyword spotting model: set WAKE_WORD_MODEL_DIR"]
    fn the_shipped_model_builds_the_default_keyword_lines() {
        let tokeniser = shipped_model();
        let encode = |text: &str| tokeniser.encode_pieces(text);
        let phrases: Vec<String> = [
            "hey claude",
            "hey chat",
            "open chat",
            "hey computer",
            "open terminal",
        ]
        .iter()
        .map(|phrase| phrase.to_string())
        .collect();
        let spec = build_keyword_spec(&phrases, &encode, 0.05).expect("spec");
        assert_eq!(
            spec.keywords(),
            "▁HE Y ▁C LA U DE :3.0 #0.05\n\
             ▁HE Y ▁CHA T :3.0 #0.05\n\
             ▁O P EN ▁CHA T :3.0 #0.05\n\
             ▁HE Y ▁COMP U TER :3.0 #0.05\n\
             ▁O P EN ▁ TER M IN AL :3.0 #0.05"
        );
    }
}
