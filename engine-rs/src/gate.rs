//! Pre-roll ring buffer and VAD gate.
//!
//! Port of `VadGate` in `engine/lib/vad-gate.js`. While the detector reports
//! silence, each chunk is held in a short ring instead of reaching the keyword
//! spotter. When speech starts the ring is flushed oldest first, and chunks
//! then pass straight through until silence, which discards whatever the ring
//! gathered in between.
//!
//! The capture loop scores each chunk before offering it to the gate, so the
//! chunk that trips the detector is delivered with the speech it belongs to
//! and is never stranded behind a closed gate. The pre-roll is there for the
//! audio before that chunk. A speech probability rises some way into a
//! phrase, not on its first sample: a soft onset such as the breathy "h" of
//! "hey" commonly scores below the threshold, and Silero scores in 32 ms
//! windows, so the chunk that crosses the threshold usually starts after the
//! phrase has. The spotter needs the start of the phrase to match it, so the
//! ring carries the 500 ms of audio that precedes the transition.
//!
//! The gate holds no audio knowledge: a chunk is whatever the caller pushes.

use std::collections::VecDeque;

pub struct VadGate<T> {
    capacity: usize,
    preroll: VecDeque<T>,
    speaking: bool,
}

impl<T> VadGate<T> {
    /// A gate that retains up to `capacity` chunks of lead-in. A capacity of
    /// zero retains nothing.
    pub fn new(capacity: usize) -> VadGate<T> {
        VadGate {
            capacity,
            preroll: VecDeque::with_capacity(capacity),
            speaking: false,
        }
    }

    /// True between [`speech_started`](Self::speech_started) and
    /// [`speech_ended`](Self::speech_ended).
    #[cfg(test)]
    pub fn speaking(&self) -> bool {
        self.speaking
    }

    /// How many chunks are held as lead-in.
    pub fn preroll_len(&self) -> usize {
        self.preroll.len()
    }

    /// Offer one captured chunk.
    ///
    /// While speaking the chunk is handed straight back for delivery. While
    /// silent it is retained as pre-roll, evicting the oldest chunk once the
    /// ring is full, and nothing is returned.
    pub fn push(&mut self, chunk: T) -> Option<T> {
        if self.speaking {
            return Some(chunk);
        }
        if self.capacity > 0 {
            if self.preroll.len() == self.capacity {
                self.preroll.pop_front();
            }
            self.preroll.push_back(chunk);
        }
        None
    }

    /// The detector reported speech. Returns the retained pre-roll, oldest
    /// first, and empties the ring, so a second call before the next silence
    /// returns nothing.
    pub fn speech_started(&mut self) -> Vec<T> {
        self.speaking = true;
        self.preroll.drain(..).collect()
    }

    /// The detector reported silence. The gate closes and starts gathering
    /// lead-in afresh.
    pub fn speech_ended(&mut self) {
        self.speaking = false;
        self.preroll.clear();
    }

    /// Return to the initial state: closed, with an empty ring.
    #[cfg(test)]
    pub fn reset(&mut self) {
        self.speaking = false;
        self.preroll.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Push each chunk and collect whatever comes straight back.
    fn push_all(gate: &mut VadGate<u32>, chunks: impl IntoIterator<Item = u32>) -> Vec<u32> {
        chunks
            .into_iter()
            .filter_map(|chunk| gate.push(chunk))
            .collect()
    }

    #[test]
    fn holds_chunks_while_silent_and_delivers_nothing() {
        let mut gate = VadGate::new(5);
        assert!(push_all(&mut gate, 1..=3).is_empty());
        assert_eq!(gate.preroll_len(), 3);
        assert!(!gate.speaking());
    }

    #[test]
    fn holds_at_most_its_capacity() {
        let mut gate = VadGate::new(5);
        push_all(&mut gate, 1..=12);
        assert_eq!(gate.preroll_len(), 5);
    }

    #[test]
    fn evicts_the_oldest_chunk_when_full() {
        let mut gate = VadGate::new(3);
        push_all(&mut gate, 1..=5);
        assert_eq!(gate.speech_started(), [3, 4, 5]);
    }

    #[test]
    fn flushes_the_pre_roll_in_arrival_order() {
        let mut gate = VadGate::new(5);
        push_all(&mut gate, [10, 20, 30]);
        assert_eq!(gate.speech_started(), [10, 20, 30]);
    }

    #[test]
    fn flushing_empties_the_ring() {
        let mut gate = VadGate::new(5);
        push_all(&mut gate, 1..=4);
        gate.speech_started();
        assert_eq!(gate.preroll_len(), 0);
        assert!(
            gate.speech_started().is_empty(),
            "a second speech before any silence has nothing to flush"
        );
    }

    #[test]
    fn passes_chunks_straight_through_while_speaking() {
        let mut gate = VadGate::new(5);
        push_all(&mut gate, [1, 2]);
        gate.speech_started();
        assert_eq!(push_all(&mut gate, [3, 4, 5]), [3, 4, 5]);
        assert_eq!(gate.preroll_len(), 0, "nothing is retained while speaking");
        assert!(gate.speaking());
    }

    #[test]
    fn clears_the_ring_on_silence() {
        let mut gate = VadGate::new(5);
        gate.speech_started();
        gate.speech_ended();
        push_all(&mut gate, [7, 8]);
        gate.speech_ended();
        assert_eq!(gate.preroll_len(), 0);
        assert!(!gate.speaking());
        assert!(gate.speech_started().is_empty());
    }

    #[test]
    fn closes_again_on_silence() {
        let mut gate = VadGate::new(5);
        gate.speech_started();
        gate.speech_ended();
        assert!(push_all(&mut gate, [1, 2]).is_empty());
        assert_eq!(gate.preroll_len(), 2);
    }

    #[test]
    fn a_zero_capacity_gate_retains_nothing() {
        let mut gate = VadGate::new(0);
        assert!(push_all(&mut gate, 1..=3).is_empty());
        assert!(gate.speech_started().is_empty());
        assert_eq!(push_all(&mut gate, [4]), [4]);
    }

    #[test]
    fn reset_returns_to_the_initial_state() {
        let mut gate = VadGate::new(5);
        push_all(&mut gate, 1..=3);
        gate.speech_started();
        gate.reset();
        assert!(!gate.speaking());
        assert_eq!(gate.preroll_len(), 0);
        assert!(push_all(&mut gate, [9]).is_empty());
    }

    #[test]
    fn delivers_every_chunk_at_most_once_across_several_cycles() {
        let mut gate = VadGate::new(3);
        let mut delivered = Vec::new();

        // Silent 1..=5 (ring keeps 3..=5), speech, 6..=8 pass through, silence.
        push_all(&mut gate, 1..=5);
        delivered.extend(gate.speech_started());
        delivered.extend(push_all(&mut gate, 6..=8));
        gate.speech_ended();

        // Silent 9..=10, speech, 11 passes through, silence.
        push_all(&mut gate, 9..=10);
        delivered.extend(gate.speech_started());
        delivered.extend(push_all(&mut gate, [11]));
        gate.speech_ended();

        // Silent 12..=16 (ring keeps 14..=16), speech with nothing after it.
        push_all(&mut gate, 12..=16);
        delivered.extend(gate.speech_started());

        assert_eq!(delivered, [3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16]);
        assert!(
            delivered.windows(2).all(|pair| pair[0] < pair[1]),
            "every chunk is delivered once, in arrival order"
        );
    }
}
