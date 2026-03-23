#ifndef AUDIO_ENGINE_H
#define AUDIO_ENGINE_H

#ifdef __EMSCRIPTEN__
  #include <emscripten.h>
  #define EXPORT EMSCRIPTEN_KEEPALIVE
#else
  #define EXPORT
#endif

/*
 * process_audio
 *   Computes A-weighted dBA from raw PCM samples using FFT.
 *   More accurate than simple RMS because it weights each frequency
 *   bin by the A-weighting curve before summing power.
 *
 *   samples     : float32 PCM, normalised to [-1, 1]
 *   num_samples : total sample count
 *   sample_rate : Hz (e.g. 44100, 48000)
 *   returns     : dBA value clamped to [20, 120]
 */
EXPORT float process_audio(float *samples, int num_samples, int sample_rate);

/*
 * get_octave_bands
 *   Fills octave_bands[8] with dB level for each standard octave band:
 *   63, 125, 250, 500, 1000, 2000, 4000, 8000 Hz
 *   Each value is a dB level using the same calibration as process_audio.
 */
EXPORT void get_octave_bands(float *samples, int num_samples,
                             int sample_rate, float *octave_bands);

/*
 * calculate_leq
 *   Equivalent continuous sound level (Leq) — energy-averaged dBA
 *   over the entire buffer. Used for time-averaged exposure assessment.
 */
EXPORT float calculate_leq(float *samples, int num_samples, int sample_rate);

/*
 * get_spectral_centroid
 *   Frequency-weighted centre of mass of the spectrum (Hz).
 *   centroid = Σ(freq[k] * mag[k]) / Σ(mag[k])
 *
 *   Low value  → bass-heavy source (traffic, HVAC)
 *   High value → treble-heavy source (birds, sibilant speech)
 *   Mid value  → speech, music
 */
EXPORT float get_spectral_centroid(float *samples, int num_samples, int sample_rate);

/*
 * get_temporal_variance
 *   Variance of per-chunk RMS dBA levels across 20 equal time segments (dB²).
 *
 *   Near-zero → steady drone (HVAC, continuous traffic)
 *   High      → intermittent or impulsive source (construction, voices)
 */
EXPORT float get_temporal_variance(float *samples, int num_samples, int sample_rate);

/*
 * get_zero_crossing_rate
 *   Rate at which the waveform crosses zero (crossings per second).
 *
 *   Low  → tonal/periodic signal (HVAC hum, pure tone)
 *   High → noisy/broadband signal (saws, sibilants, wind)
 */
EXPORT float get_zero_crossing_rate(float *samples, int num_samples, int sample_rate);

#endif
