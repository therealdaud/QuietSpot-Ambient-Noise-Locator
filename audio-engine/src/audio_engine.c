#include "audio_engine.h"
#include "fft.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* ── Constants ────────────────────────────────────────────────────────────── */

#define MAX_FFT_SIZE     8192
#define CALIBRATION_dB   90.0   /* maps Web Audio's normalised [-1,1] range
                                   to a realistic dBA scale (same reference
                                   used by the legacy JS implementation)     */

/* Standard 1/1-octave centre frequencies (Hz) */
static const double OCTAVE_CENTERS[8] = {
    63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/*
 * a_weight_amplitude
 *   A-weighting amplitude transfer function at frequency f (Hz).
 *   Formula from IEC 61672-1:2013.
 *   Returns the linear amplitude ratio (not dB, not power).
 *
 *   A(f) = (12200² · f⁴) /
 *          [(f²+20.6²) · √((f²+107.7²)(f²+737.9²)) · (f²+12200²)]
 */
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

/*
 * hann_window
 *   Hann (raised cosine) window value at sample index i of N total.
 *   Applied before FFT to reduce spectral leakage at bin edges.
 */
static double hann_window(int i, int N) {
    return 0.5 * (1.0 - cos(2.0 * M_PI * i / (double)(N - 1)));
}

/*
 * next_pow2
 *   Returns the smallest power of 2 >= n.
 *   Required because the Cooley-Tukey FFT is radix-2.
 */
static size_t next_pow2(size_t n) {
    size_t p = 1;
    while (p < n) p <<= 1;
    return p;
}

/*
 * clamp_dba
 *   Hard-clamp to a realistic measurement range.
 */
static float clamp_dba(double v) {
    if (v < 20.0)  return 20.0f;
    if (v > 120.0) return 120.0f;
    return (float)v;
}

/* ── Shared FFT computation ───────────────────────────────────────────────── */

/*
 * compute_fft_windowed
 *   Allocates a complex buffer, applies Hann window, runs FFT, and
 *   returns the buffer.  Caller is responsible for free()-ing it.
 *   Returns NULL on allocation failure.
 *
 *   n_use     : number of samples actually loaded (rest is zero-padded)
 *   fft_size  : power-of-2 buffer length (output)
 */
static double complex *compute_fft_windowed(float *samples, int num_samples,
                                            int *n_use_out, size_t *fft_size_out) {
    int n_use = (num_samples < MAX_FFT_SIZE) ? num_samples : MAX_FFT_SIZE;
    size_t fft_size = next_pow2((size_t)n_use);

    double complex *x = (double complex *)calloc(fft_size, sizeof(double complex));
    if (!x) return NULL;

    /* Load samples with Hann window applied */
    for (int i = 0; i < n_use; i++) {
        x[i] = (double)samples[i] * hann_window(i, n_use) + 0.0 * I;
    }

    fft(x, fft_size);

    *n_use_out    = n_use;
    *fft_size_out = fft_size;
    return x;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

float process_audio(float *samples, int num_samples, int sample_rate) {
    if (!samples || num_samples < 2) return 40.0f;

    int    n_use;
    size_t fft_size;
    double complex *x = compute_fft_windowed(samples, num_samples,
                                             &n_use, &fft_size);
    if (!x) return 40.0f;

    /*
     * Accumulate A-weighted power:
     *   For each positive-frequency bin k at f = k * Fs / N,
     *   power(k) = |X[k]|² / N²   (normalised)
     *   A-power(k) = power(k) * A(f)²  (squared because A() is amplitude)
     */
    double weighted_power = 0.0;
    double freq_res = (double)sample_rate / (double)fft_size;

    for (size_t k = 1; k < fft_size / 2; k++) {
        double f   = (double)k * freq_res;
        double mag = cabs(x[k]) / (double)fft_size;
        double aw  = a_weight_amplitude(f);
        weighted_power += (mag * mag) * (aw * aw);
    }

    free(x);

    if (weighted_power < 1e-20) return 20.0f;

    double dba = 10.0 * log10(weighted_power) + CALIBRATION_dB;
    return clamp_dba(dba);
}


void get_octave_bands(float *samples, int num_samples,
                      int sample_rate, float *octave_bands) {
    if (!samples || !octave_bands || num_samples < 2) {
        for (int i = 0; i < 8; i++) octave_bands[i] = 0.0f;
        return;
    }

    int    n_use;
    size_t fft_size;
    double complex *x = compute_fft_windowed(samples, num_samples,
                                             &n_use, &fft_size);
    if (!x) {
        for (int i = 0; i < 8; i++) octave_bands[i] = 0.0f;
        return;
    }

    double freq_res = (double)sample_rate / (double)fft_size;

    /*
     * Each 1/1-octave band spans [fc/√2, fc·√2].
     * Sum power across all FFT bins that fall inside the band.
     */
    for (int b = 0; b < 8; b++) {
        double f_low  = OCTAVE_CENTERS[b] / 1.41421356237;
        double f_high = OCTAVE_CENTERS[b] * 1.41421356237;

        size_t k_low  = (size_t)(f_low  / freq_res);
        size_t k_high = (size_t)(f_high / freq_res);
        if (k_high >= fft_size / 2) k_high = fft_size / 2 - 1;
        if (k_low  < 1)             k_low  = 1;

        double band_power = 0.0;
        for (size_t k = k_low; k <= k_high; k++) {
            double mag = cabs(x[k]) / (double)fft_size;
            band_power += mag * mag;
        }

        octave_bands[b] = (band_power < 1e-20)
            ? 0.0f
            : clamp_dba(10.0 * log10(band_power) + CALIBRATION_dB);
    }

    free(x);
}


float calculate_leq(float *samples, int num_samples, int sample_rate) {
    (void)sample_rate; /* Leq in time domain doesn't need sample rate */

    if (!samples || num_samples < 1) return 20.0f;

    /*
     * Leq = 10 · log10( (1/N) · Σ p²(t) / p_ref² )
     *
     * Since samples are normalised to [-1,1] we use the same +90 dB
     * calibration offset as the frequency-domain functions.
     */
    double sum_sq = 0.0;
    for (int i = 0; i < num_samples; i++) {
        sum_sq += (double)samples[i] * (double)samples[i];
    }
    double rms = sqrt(sum_sq / (double)num_samples);
    if (rms < 1e-9) return 20.0f;

    return clamp_dba(20.0 * log10(rms) + CALIBRATION_dB);
}
