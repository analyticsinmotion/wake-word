//! Sample conditioning between capture and the keyword spotter.
//!
//! Port of `toSpotterSamples()` in `engine/lib/samples.js`, less the part that
//! reinterprets a byte buffer as floats: decibri's Rust API hands over
//! `Vec<f32>` directly.

/// Clamp every sample to [-1, 1] in place, and turn NaN into silence.
///
/// Automatic gain control can lift a loud passage above full scale. An int16
/// stream saturates such a sample on conversion; a float32 stream carries the
/// overshoot through unchanged, and decibri documents that a float32 consumer
/// running without its limiter must clamp its own input. An infinity is an
/// overshoot like any other and clamps to full scale. decibri's conditioning
/// chain already replaces non-finite input, so NaN is a guard rather than an
/// expected value.
pub fn clamp_in_place(samples: &mut [f32]) {
    for sample in samples.iter_mut() {
        // f32::clamp passes NaN through, so NaN is handled first.
        *sample = if sample.is_nan() {
            0.0
        } else {
            sample.clamp(-1.0, 1.0)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clamped(input: &[f32]) -> Vec<f32> {
        let mut samples = input.to_vec();
        clamp_in_place(&mut samples);
        samples
    }

    #[test]
    fn leaves_values_in_range_unchanged() {
        let input = [0.0, 0.25, -0.25, 0.999_999, -0.999_999, 1.0, -1.0];
        assert_eq!(clamped(&input), input);
    }

    #[test]
    fn keeps_the_sign_of_zero() {
        let out = clamped(&[-0.0]);
        assert!(out[0] == 0.0 && out[0].is_sign_negative());
    }

    #[test]
    fn clamps_values_above_full_scale() {
        assert_eq!(clamped(&[1.000_001, 1.5, 37.0, f32::MAX]), [1.0; 4]);
    }

    #[test]
    fn clamps_values_below_negative_full_scale() {
        assert_eq!(clamped(&[-1.000_001, -1.5, -37.0, f32::MIN]), [-1.0; 4]);
    }

    #[test]
    fn turns_nan_into_silence() {
        assert_eq!(clamped(&[f32::NAN, 0.5, -f32::NAN]), [0.0, 0.5, 0.0]);
    }

    #[test]
    fn clamps_infinities_to_full_scale() {
        assert_eq!(clamped(&[f32::INFINITY, f32::NEG_INFINITY]), [1.0, -1.0]);
    }

    #[test]
    fn handles_an_empty_chunk() {
        assert!(clamped(&[]).is_empty());
    }

    #[test]
    fn clamps_a_mixed_chunk_sample_by_sample() {
        assert_eq!(
            clamped(&[0.5, 2.0, f32::NAN, -3.0, -0.5]),
            [0.5, 1.0, 0.0, -1.0, -0.5]
        );
    }
}
