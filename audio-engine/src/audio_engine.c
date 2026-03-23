#include "audio_engine.h"
#include "fft.h"

#include <math.h>
#include <stdlib.h>

/* ── Constants ────────────────────────────────────────────────────────────── */

#define MAX_FFT_SIZE    8192
#define CALIBRATION_dB  90.0   /* maps Web Audio normalised PCM to realistic dBA */

static const double OCTAVE_CENTERS[8] = {
    63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/* A-weighting amplitude transfer function (IEC 61672-1). */
static double a_weight_amplitude(double f) {
    if (f < 1.0) return 0.0;
    double f2  = f * f;
    double f4  = f2 * f2;
    double num = 12200.0 * 12200.0 * f4;
    double den = (f2 + 20.6  * 20.6)
               * sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
               * (f2 + 12200.0 * 12200.0);
    if (den < 1e-30) return 0.0;
    return num / den;
}

static double hann_window(int i, int N) {
    return 0.5 * (1.0 - cos(2.0 * M_PI * i / (double)(N - 1)));
}

static size_t next_pow2(size_t n) {
    size_t p = 1;
    while (p < n) p <<= 1;
    return p;
}

static float clamp_dba(double v) {
    if (v < 20.0)  return 20.0f;
    if (v > 120.0) return 120.0f;
    return (float)v;
}

/*
 * Compute RMS of all samples → dBA using the simple time-domain calibration.
 * This is our anchor: it matches the frontend's original measurement and Leq.
 */
static double rms_dba(float *samples, int num_samples) {
    double sum_sq = 0.0;
    for (int i = 0; i < num_samples; i++)
        sum_sq += (double)samples[i] * (double)samples[i];
    double rms = sqrt(sum_sq / (double)num_samples);
    if (rms < 1e-9) return 20.0;
    return 20.0 * log10(rms) + CALIBRATION_dB;
}

/*
 * Run a Hann-windowed FFT on the LAST n_use samples.
 * Returns a flat buffer [re[0..N-1] | im[0..N-1]], caller must free().
 * Sets *fft_size_out to the FFT length used.
 */
static double *make_fft(float *samples, int num_samples, size_t *fft_size_out) {
    int    n_use    = (num_samples < MAX_FFT_SIZE) ? num_samples : MAX_FFT_SIZE;
    size_t fft_size = next_pow2((size_t)n_use);

    double *buf = (double *)calloc(fft_size * 2, sizeof(double));
    if (!buf) return NULL;

    double *re  = buf;
    double *im  = buf + fft_size;

    /* Use the last n_use samples — avoids AnalyserNode warmup zeros
       that appear in the first few frames of a recording. */
    float *src = samples + (num_samples - n_use);
    for (int i = 0; i < n_use; i++)
        re[i] = (double)src[i] * hann_window(i, n_use);

    fft(re, im, fft_size);
    *fft_size_out = fft_size;
    return buf;
}

/* Magnitude of FFT bin k (normalised by N). */
static double bin_mag(const double *buf, size_t k, size_t N) {
    double r = buf[k]     / (double)N;
    double i = buf[k + N] / (double)N;
    return sqrt(r * r + i * i);
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/*
 * process_audio — A-weighted dBA
 *
 * Strategy:
 *   1. Compute the simple RMS Leq across all samples (correctly calibrated).
 *   2. Use an FFT to find the A-weighting spectral correction:
 *        correction_dB = 10 * log10(A-weighted power / unweighted power)
 *      This ratio is independent of signal level; it only reflects how
 *      the sound's spectrum interacts with the A-weighting curve.
 *   3. Return  Leq_dBA + correction_dB.
 *
 * This avoids the Hann-window energy loss and FFT normalisation offset
 * that plagued the earlier direct-FFT approach.
 */
float process_audio(float *samples, int num_samples, int sample_rate) {
    if (!samples || num_samples < 2) return 40.0f;

    double base_dba = rms_dba(samples, num_samples);

    size_t  fft_size;
    double *buf = make_fft(samples, num_samples, &fft_size);
    if (!buf) return clamp_dba(base_dba);

    double freq_res       = (double)sample_rate / (double)fft_size;
    double total_power    = 0.0;
    double weighted_power = 0.0;

    for (size_t k = 1; k < fft_size / 2; k++) {
        double f   = (double)k * freq_res;
        double mag = bin_mag(buf, k, fft_size);
        double p   = mag * mag;
        double aw  = a_weight_amplitude(f);
        total_power    += p;
        weighted_power += p * aw * aw;
    }

    free(buf);

    /* A-weighting correction: positive if signal is mid-frequency heavy,
       negative if dominated by low frequencies. Typically ±5 dB for
       common noise sources. */
    double correction = 0.0;
    if (total_power > 1e-30 && weighted_power > 1e-30)
        correction = 10.0 * log10(weighted_power / total_power);

    return clamp_dba(base_dba + correction);
}


/*
 * get_octave_bands — per-band dB levels
 *
 * Each band's level is computed as:
 *   band_dBA = Leq_dBA + 10 * log10(band_fraction_of_total_power)
 *
 * This anchors relative spectral energy to the correctly-calibrated Leq,
 * giving physically meaningful bar heights in the spectrum visualiser.
 */
void get_octave_bands(float *samples, int num_samples,
                      int sample_rate, float *octave_bands) {
    if (!samples || !octave_bands || num_samples < 2) {
        for (int i = 0; i < 8; i++) octave_bands[i] = 0.0f;
        return;
    }

    double base_dba = rms_dba(samples, num_samples);

    size_t  fft_size;
    double *buf = make_fft(samples, num_samples, &fft_size);
    if (!buf) {
        for (int i = 0; i < 8; i++) octave_bands[i] = (float)base_dba;
        return;
    }

    double freq_res   = (double)sample_rate / (double)fft_size;
    double total_power = 0.0;

    /* First pass: total power across all positive bins. */
    for (size_t k = 1; k < fft_size / 2; k++) {
        double mag = bin_mag(buf, k, fft_size);
        total_power += mag * mag;
    }

    /* Second pass: per-band power fraction → absolute dBA. */
    for (int b = 0; b < 8; b++) {
        double f_low  = OCTAVE_CENTERS[b] / 1.41421356237;
        double f_high = OCTAVE_CENTERS[b] * 1.41421356237;
        size_t k_low  = (size_t)(f_low  / freq_res);
        size_t k_high = (size_t)(f_high / freq_res);
        if (k_low  < 1)             k_low  = 1;
        if (k_high >= fft_size / 2) k_high = fft_size / 2 - 1;

        double band_power = 0.0;
        for (size_t k = k_low; k <= k_high; k++) {
            double mag = bin_mag(buf, k, fft_size);
            band_power += mag * mag;
        }

        if (total_power < 1e-30 || band_power < 1e-30)
            octave_bands[b] = 0.0f;
        else
            octave_bands[b] = clamp_dba(base_dba + 10.0 * log10(band_power / total_power));
    }

    free(buf);
}


/* calculate_leq — simple time-domain energy average (Leq). */
float calculate_leq(float *samples, int num_samples, int sample_rate) {
    (void)sample_rate;
    if (!samples || num_samples < 1) return 20.0f;
    return clamp_dba(rms_dba(samples, num_samples));
}


/*
 * get_spectral_centroid — frequency centre of mass of the spectrum (Hz)
 *
 * Uses magnitude (not power) weighting so the result is proportional to
 * the perceptual "brightness" of the sound.  Low value = bass-heavy,
 * high value = treble-heavy.
 */
float get_spectral_centroid(float *samples, int num_samples, int sample_rate) {
    if (!samples || num_samples < 2) return 0.0f;

    size_t  fft_size;
    double *buf = make_fft(samples, num_samples, &fft_size);
    if (!buf) return 0.0f;

    double freq_res      = (double)sample_rate / (double)fft_size;
    double sum_mag       = 0.0;
    double sum_freq_mag  = 0.0;

    for (size_t k = 1; k < fft_size / 2; k++) {
        double f   = (double)k * freq_res;
        double mag = bin_mag(buf, k, fft_size);
        sum_mag      += mag;
        sum_freq_mag += f * mag;
    }

    free(buf);

    if (sum_mag < 1e-30) return 0.0f;

    double centroid = sum_freq_mag / sum_mag;
    if (centroid < 20.0)                    centroid = 20.0;
    if (centroid > (double)sample_rate / 2) centroid = (double)sample_rate / 2;
    return (float)centroid;
}


/*
 * get_temporal_variance — variance of per-chunk RMS dBA levels (dB²)
 *
 * Splits the full buffer into N_CHUNKS equal segments, computes RMS dBA
 * for each, then returns the variance of those values.
 *
 * Near-zero → steady source (HVAC, continuous traffic hum)
 * High      → intermittent / impulsive source (construction, voices)
 */
#define N_TEMPORAL_CHUNKS 20

float get_temporal_variance(float *samples, int num_samples, int sample_rate) {
    (void)sample_rate;
    if (!samples || num_samples < N_TEMPORAL_CHUNKS * 2) return 0.0f;

    int    chunk_size = num_samples / N_TEMPORAL_CHUNKS;
    double chunk_dba[N_TEMPORAL_CHUNKS];
    double mean = 0.0;

    for (int c = 0; c < N_TEMPORAL_CHUNKS; c++) {
        chunk_dba[c] = rms_dba(samples + c * chunk_size, chunk_size);
        mean += chunk_dba[c];
    }
    mean /= N_TEMPORAL_CHUNKS;

    double var = 0.0;
    for (int c = 0; c < N_TEMPORAL_CHUNKS; c++) {
        double d = chunk_dba[c] - mean;
        var += d * d;
    }
    var /= N_TEMPORAL_CHUNKS;

    return (float)var;
}


/*
 * get_zero_crossing_rate — zero crossings per second (Hz)
 *
 * A sign change is counted whenever consecutive samples have opposite sign
 * (zero is treated as positive).  Returned in crossings/second so the value
 * is independent of recording length.
 *
 * Low  → tonal / periodic (HVAC hum, sustained note)
 * High → noisy / broadband (saws, wind, unvoiced fricatives)
 */
float get_zero_crossing_rate(float *samples, int num_samples, int sample_rate) {
    if (!samples || num_samples < 2 || sample_rate < 1) return 0.0f;

    int crossings = 0;
    for (int i = 1; i < num_samples; i++) {
        if ((samples[i] >= 0.0f) != (samples[i - 1] >= 0.0f))
            crossings++;
    }

    double duration = (double)num_samples / (double)sample_rate;
    return (float)(crossings / duration);
}
