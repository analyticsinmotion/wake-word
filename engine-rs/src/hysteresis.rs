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
//! The policy is decibri's: its bindings apply exactly this state machine
//! (`_processVadValue` in the Node.js package), with a threshold of 0.5 and a
//! holdoff of 300 ms by default. The Rust crate scores audio but leaves the
//! transitions to its caller, so they are implemented here.
//!
//! The holdoff is counted in samples received rather than wall-clock time,
//! the way decibri's file source counts it. The transition then depends only on
//! the audio, never on how promptly a chunk was processed. The quiet span
//! starts at the first sample of the first chunk below the threshold, and
//! silence is declared on the chunk whose last sample completes the holdoff:
//! with 100 ms chunks and a 300 ms holdoff, the third consecutive quiet chunk.

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
    /// Where the current run of below-threshold chunks began, while speaking.
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
        let start = self.position;
        let end = start + samples as u64;
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
        let quiet_since = *self.quiet_since.get_or_insert(start);
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
        // Two quiet chunks is 200 ms, then speech resumes.
        assert_eq!(
            run(&mut machine, &[0.9, 0.2, 0.1, 0.9, 0.9]),
            [(0, Transition::Speech)]
        );
        assert!(machine.speaking());
    }

    #[test]
    fn speech_during_the_holdoff_restarts_it_from_the_next_quiet_chunk() {
        let mut machine = detector();
        // Quiet, quiet, speech, then three more quiet chunks: the holdoff is
        // counted from the first chunk after the speech, not from the first
        // quiet chunk overall.
        assert_eq!(
            run(&mut machine, &[0.9, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1]),
            [(0, Transition::Speech), (6, Transition::Silence)]
        );
    }

    #[test]
    fn a_full_holdoff_below_the_threshold_ends_speech() {
        let mut machine = detector();
        assert_eq!(
            run(&mut machine, &[0.9, 0.1, 0.1, 0.1]),
            [(0, Transition::Speech), (3, Transition::Silence)]
        );
        assert!(!machine.speaking());
    }

    #[test]
    fn silence_is_declared_on_the_exact_sample_that_completes_the_holdoff() {
        let mut machine = detector();
        machine.update(0.9, CHUNK);
        // 4799 quiet samples is one short of 300 ms at 16 kHz.
        assert_eq!(machine.update(0.1, 4799), None);
        assert!(machine.speaking());
        assert_eq!(machine.update(0.1, 1), Some(Transition::Silence));
    }

    #[test]
    fn the_holdoff_boundary_holds_for_uneven_chunk_sizes() {
        let mut machine = detector();
        machine.update(0.9, CHUNK);
        assert_eq!(machine.update(0.1, 1000), None);
        assert_eq!(machine.update(0.1, 3000), None);
        assert_eq!(machine.update(0.1, 799), None);
        assert_eq!(machine.update(0.1, 1), Some(Transition::Silence));
    }

    #[test]
    fn one_long_quiet_chunk_can_complete_the_holdoff_on_its_own() {
        let mut machine = detector();
        machine.update(0.9, CHUNK);
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
            0.9, 0.1, 0.1, 0.1, // speech, then silence on the third quiet chunk
            0.0, 0.0, // silent and staying silent
            0.7, 0.8, 0.2, 0.2, 0.2, // second segment
            0.6, 0.1, 0.1, 0.1, // third segment
        ];
        assert_eq!(
            run(&mut machine, &scores),
            [
                (0, Transition::Speech),
                (3, Transition::Silence),
                (6, Transition::Speech),
                (10, Transition::Silence),
                (11, Transition::Speech),
                (14, Transition::Silence),
            ]
        );
    }

    #[test]
    fn a_nan_probability_counts_as_quiet() {
        let mut machine = detector();
        assert_eq!(machine.update(f32::NAN, CHUNK), None);
        machine.update(0.9, CHUNK);
        assert_eq!(
            run(&mut machine, &[f32::NAN, f32::NAN, f32::NAN]),
            [(2, Transition::Silence)]
        );
    }

    #[test]
    fn the_holdoff_scales_with_the_sample_rate() {
        let mut machine = SpeechHysteresis::new(0.5, 300, 8_000);
        machine.update(0.9, 800);
        assert_eq!(machine.update(0.1, 2399), None);
        assert_eq!(machine.update(0.1, 1), Some(Transition::Silence));
    }
}
