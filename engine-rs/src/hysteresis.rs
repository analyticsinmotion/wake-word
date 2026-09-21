//! Speech and silence transitions from a stream of speech probabilities.
//!
//! The voice activity detector scores each captured chunk with a speech
//! probability. This turns the scores into the two transitions the gate acts
//! on:
//!
//! - speech starts on the first chunk that scores at or above the threshold;
//! - silence is declared once the score has stayed below the threshold for the
//!   holdoff.
//!
//! A chunk at or above the threshold during the holdoff cancels it, so a gap
//! inside a phrase that is shorter than the holdoff does not split the phrase
//! into two segments.
//!
//! The policy is decibri's, with its defaults: a threshold of 0.5 and a
//! holdoff of 300 ms. The crate scores audio but leaves the transitions to its
//! caller, so they are implemented here.
//!
//! The holdoff runs from the moment the first quiet chunk has arrived, which is
//! the end of that chunk, so with 100 ms chunks the 300 ms comes due as the
//! fourth consecutive quiet chunk arrives. Silence is therefore declared on
//! that chunk, and everything up to and including it is part of the speech
//! segment.
//!
//! Where the holdoff starts decides how much audio follows a phrase before the
//! segment ends. The keyword spotter decodes in steps of 320 ms and reports a
//! keyword only once a step has covered the phrase's last piece and the blank
//! after it, so this used to decide whether a phrase said on its own was
//! reported at all: ending every segment one chunk earlier, by counting the
//! holdoff from the start of the first quiet chunk, lost a large share of them.
//! The segment's end now finishes that decoding on silence instead
//! (`crate::spotter::SEGMENT_FLUSH_MS`), and with it one chunk either way costs
//! no detections on the clip set that measured the flush. What the tail decides
//! now is how soon a detection is reported: a segment that ends one chunk
//! sooner reports its phrase about 40 ms sooner. The holdoff stays decibri's
//! default, with decibri's semantics.
//!
//! The holdoff is counted in samples rather than on a wall-clock timer, so the
//! transition depends only on the audio, never on how promptly a chunk was
//! processed.

/// A change of state reported by [`SpeechHysteresis::update`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// The probability reached the threshold while silent.
    Speech,
    /// The probability stayed below the threshold for the whole holdoff.
    Silence,
}

/// The speech and silence state machine. One instance per capture stream: it
/// starts silent at sample zero.
#[derive(Debug, Clone)]
pub struct SpeechHysteresis {
    threshold: f32,
    holdoff_samples: u64,
    /// Samples received so far, which is where the next chunk starts.
    position: u64,
    speaking: bool,
    /// While speaking: the position at which the first chunk of the current
    /// run of below-threshold chunks ended, which is when the holdoff started.
    quiet_since: Option<u64>,
}

impl SpeechHysteresis {
    /// `threshold` is the probability at or above which a chunk is speech;
    /// `holdoff_ms` is how long the probability must stay below it before
    /// silence is declared, converted to samples at `sample_rate`.
    pub fn new(threshold: f32, holdoff_ms: u32, sample_rate: u32) -> SpeechHysteresis {
        SpeechHysteresis {
            threshold,
            holdoff_samples: u64::from(holdoff_ms) * u64::from(sample_rate) / 1000,
            position: 0,
            speaking: false,
            quiet_since: None,
        }
    }

    /// True between a [`Transition::Speech`] and the next
    /// [`Transition::Silence`].
    #[cfg(test)]
    pub fn speaking(&self) -> bool {
        self.speaking
    }

    /// Account for one chunk of `samples` samples that scored `probability`.
    ///
    /// Returns the transition this chunk caused, if any. A NaN probability is
    /// below every threshold and counts as quiet.
    pub fn update(&mut self, probability: f32, samples: usize) -> Option<Transition> {
        let end = self.position + samples as u64;
        self.position = end;

        if probability >= self.threshold {
            self.quiet_since = None;
            if !self.speaking {
                self.speaking = true;
                return Some(Transition::Speech);
            }
            return None;
        }

        if !self.speaking {
            return None;
        }
        let quiet_since = *self.quiet_since.get_or_insert(end);
        if end - quiet_since >= self.holdoff_samples {
            self.speaking = false;
            self.quiet_since = None;
            return Some(Transition::Silence);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 100 ms at 16 kHz, the chunk size the engine reads.
    const CHUNK: usize = 1600;

    fn detector() -> SpeechHysteresis {
        SpeechHysteresis::new(0.5, 300, 16_000)
    }

    /// Feed one probability per 100 ms chunk and collect the transitions,
    /// tagged with the index of the chunk that caused each.
    fn run(machine: &mut SpeechHysteresis, scores: &[f32]) -> Vec<(usize, Transition)> {
        scores
            .iter()
            .enumerate()
            .filter_map(|(index, score)| machine.update(*score, CHUNK).map(|t| (index, t)))
            .collect()
    }

    #[test]
    fn starts_silent() {
        let machine = detector();
        assert!(!machine.speaking());
    }

    #[test]
    fn a_probability_below_the_threshold_while_silent_does_nothing() {
        let mut machine = detector();
        assert!(run(&mut machine, &[0.0, 0.1, 0.49, 0.499_999]).is_empty());
        assert!(!machine.speaking());
    }

    #[test]
    fn a_probability_rising_to_the_threshold_starts_speech() {
        let mut machine = detector();
        assert_eq!(
            run(&mut machine, &[0.1, 0.3, 0.8]),
            [(2, Transition::Speech)]
        );
        assert!(machine.speaking());
    }

    #[test]
    fn the_threshold_itself_counts_as_speech() {
        let mut machine = detector();
        assert_eq!(machine.update(0.5, CHUNK), Some(Transition::Speech));
    }

    #[test]
    fn speech_is_reported_once_however_long_it_lasts() {
        let mut machine = detector();
        assert_eq!(
            run(&mut machine, &[0.9, 0.9, 0.7, 0.95, 0.6]),
            [(0, Transition::Speech)]
        );
    }

    #[test]
    fn a_quiet_spell_shorter_than_the_holdoff_does_not_end_speech() {
        let mut machine = detector();
        // Three quiet chunks: the holdoff started when the first had arrived
        // and is 200 ms old when speech resumes.
        assert_eq!(
            run(&mut machine, &[0.9, 0.2, 0.1, 0.1, 0.9, 0.9]),
            [(0, Transition::Speech)]
        );
        assert!(machine.speaking());
    }

    #[test]
    fn speech_during_the_holdoff_restarts_it_from_the_next_quiet_chunk() {
        let mut machine = detector();
        // Quiet, quiet, speech, then four more quiet chunks: the holdoff is
        // counted from the first chunk after the speech, not from the first
        // quiet chunk overall.
        assert_eq!(
            run(&mut machine, &[0.9, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1, 0.1]),
            [(0, Transition::Speech), (7, Transition::Silence)]
        );
    }

    #[test]
    fn silence_is_declared_on_the_fourth_quiet_chunk() {
        // The holdoff starts once the first quiet chunk has arrived, so three
        // more 100 ms chunks complete it. All four are delivered as the tail
        // of the speech segment.
        let mut machine = detector();
        assert_eq!(
            run(&mut machine, &[0.9, 0.1, 0.1, 0.1, 0.1]),
            [(0, Transition::Speech), (4, Transition::Silence)]
        );
        assert!(!machine.speaking());
    }

    #[test]
    fn three_quiet_chunks_are_not_yet_silence() {
        let mut machine = detector();
        assert_eq!(
            run(&mut machine, &[0.9, 0.1, 0.1, 0.1]),
            [(0, Transition::Speech)]
        );
        assert!(machine.speaking());
    }

    #[test]
    fn silence_is_declared_on_the_exact_sample_that_completes_the_holdoff() {
        let mut machine = detector();
        machine.update(0.9, CHUNK);
        // The first quiet chunk only starts the holdoff.
        assert_eq!(machine.update(0.1, CHUNK), None);
        // 4799 more quiet samples is one short of 300 ms at 16 kHz.
        assert_eq!(machine.update(0.1, 4799), None);
        assert!(machine.speaking());
        assert_eq!(machine.update(0.1, 1), Some(Transition::Silence));
    }

    #[test]
    fn the_holdoff_boundary_holds_for_uneven_chunk_sizes() {
        let mut machine = detector();
        machine.update(0.9, CHUNK);
        assert_eq!(machine.update(0.1, 250), None, "starts the holdoff");
        assert_eq!(machine.update(0.1, 1000), None);
        assert_eq!(machine.update(0.1, 3000), None);
        assert_eq!(machine.update(0.1, 799), None);
        assert_eq!(machine.update(0.1, 1), Some(Transition::Silence));
    }

    #[test]
    fn the_first_quiet_chunk_never_ends_speech_however_long_it_is() {
        // The holdoff starts when that chunk has arrived, so it cannot also
        // complete it; the next chunk can.
        let mut machine = detector();
        machine.update(0.9, CHUNK);
        assert_eq!(machine.update(0.1, 48_000), None);
        assert_eq!(machine.update(0.1, 4800), Some(Transition::Silence));
    }

    #[test]
    fn the_quiet_chunks_before_speech_do_not_count_toward_the_holdoff() {
        let mut machine = detector();
        run(&mut machine, &[0.1, 0.1, 0.1, 0.1]);
        assert_eq!(machine.update(0.9, CHUNK), Some(Transition::Speech));
        assert_eq!(machine.update(0.1, CHUNK), None);
    }

    #[test]
    fn repeated_speech_and_silence_cycles_alternate() {
        let mut machine = detector();
        let scores = [
            0.9, 0.1, 0.1, 0.1, 0.1, // speech, then silence on the fourth quiet chunk
            0.0, 0.0, // silent and staying silent
            0.7, 0.8, 0.2, 0.2, 0.2, 0.2, // second segment
            0.6, 0.1, 0.1, 0.1, 0.1, // third segment
        ];
        assert_eq!(
            run(&mut machine, &scores),
            [
                (0, Transition::Speech),
                (4, Transition::Silence),
                (7, Transition::Speech),
                (12, Transition::Silence),
                (13, Transition::Speech),
                (17, Transition::Silence),
            ]
        );
    }

    #[test]
    fn a_nan_probability_counts_as_quiet() {
        let mut machine = detector();
        assert_eq!(machine.update(f32::NAN, CHUNK), None);
        machine.update(0.9, CHUNK);
        assert_eq!(
            run(&mut machine, &[f32::NAN, f32::NAN, f32::NAN, f32::NAN]),
            [(3, Transition::Silence)]
        );
    }

    #[test]
    fn the_holdoff_scales_with_the_sample_rate() {
        let mut machine = SpeechHysteresis::new(0.5, 300, 8_000);
        machine.update(0.9, 800);
        assert_eq!(machine.update(0.1, 800), None, "starts the holdoff");
        assert_eq!(machine.update(0.1, 2399), None);
        assert_eq!(machine.update(0.1, 1), Some(Transition::Silence));
    }
}
