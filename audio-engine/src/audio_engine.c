#include "audio_engine.h"
#include "fft.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* ── Constants ────────────────────────────────────────────────────────────── */

#define MAX_FFT_SIZE     8192
#define CALIBRATION_dB   90.0

static const double OCTAVE_CENTERS[8] = {
    63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/*
 * A-weighting amplitude transfer function (IEC 61672-1).
 * Returns linear amplitude ratio (not dB, not power).
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

/* Hann window — reduces spectral leakage */
static double hann_window(int i, int N) {
    return 0.5 * (1.0 - cos(2.0 * M_PI * i / (double)(N - 1)));
}

/* Smallest power of 2 >= n */
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
 * Allocate and fill re[]/im[] arrays with windowed samples, run FFT.
 * Returns a flat buffer: [ re[0..N-1] | im[0..N-1] ]
 * Caller must free() the returned pointer.
 * Returns NULL on allocation failure.
 */
static double *make_fft(float *samples, int num_samples,
                        int *n_use_out, size_t *fft_size_out) {
    int    n_use    = (num_samples < MAX_FFT_SIZE) ? num_samples : MAX_FFT_SIZE;
    size_t fft_size = next_pow2((size_t)n_use);

    /* Flat buffer: first half = re, second half = im (zeroed via calloc) */
    double *buf = (double *)calloc(fft_size * 2, sizeof(double));
    if (!buf) return NULL;

    double *re = buf;
    double *im = buf + fft_size;

    for (int i = 0; i < n_use; i++) {
        re[i] = (double)samples[i] * hann_window(i, n_use);
        /* im[i] already 0 from calloc */
    }

    fft(re, im, fft_size);

    *n_use_out    = n_use;
    *fft_size_out = fft_size;
    return buf;
}

/* Magnitude of bin k from the flat buffer */
static double bin_mag(const double *buf, size_t k, size_t fft_size) {
    const double *re = buf;
    const double *im = buf + fft_size;
    double r = re[k] / (double)fft_size;
    double i = im[k] / (double)fft_size;
    return sqrt(r * r + i * i);
}

/* ── Public API ───────────────────────────────────────────────────────────── */

float process_audio(float *samples, int num_samples, int sample_rate) {
    if (!samples || num_samples < 2) return 40.0f;

    int    n_use;
    size_t fft_size;
    double *buf = make_fft(samples, num_samples, &n_use, &fft_size);
    if (!buf) return 40.0f;

    double weighted_power = 0.0;
    double freq_res = (double)sample_rate / (double)fft_size;

    for (size_t k = 1; k < fft_size / 2; k++) {
        double f   = (double)k * freq_res;
        double mag = bin_mag(buf, k, fft_size);
        double aw  = a_weight_amplitude(f);
        weighted_power += (mag * mag) * (aw * aw);
    }

    free(buf);

    if (weighted_power < 1e-20) return 20.0f;
    return clamp_dba(10.0 * log10(weighted_power) + CALIBRATION_dB);
}


void get_octave_bands(float *samples, int num_samples,
                      int sample_rate, float *octave_bands) {
    if (!samples || !octave_bands || num_samples < 2) {
        for (int i = 0; i < 8; i++) octave_bands[i] = 0.0f;
        return;
    }

    int    n_use;
    size_t fft_size;
    double *buf = make_fft(samples, num_samples, &n_use, &fft_size);
    if (!buf) {
        for (int i = 0; i < 8; i++) octave_bands[i] = 0.0f;
        return;
    }

    double freq_res = (double)sample_rate / (double)fft_size;

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

        octave_bands[b] = (band_power < 1e-20)
            ? 0.0f
            : clamp_dba(10.0 * log10(band_power) + CALIBRATION_dB);
    }

    free(buf);
}


float calculate_leq(float *samples, int num_samples, int sample_rate) {
    (void)sample_rate;
    if (!samples || num_samples < 1) return 20.0f;

    double sum_sq = 0.0;
    for (int i = 0; i < num_samples; i++)
        sum_sq += (double)samples[i] * (double)samples[i];

    double rms = sqrt(sum_sq / (double)num_samples);
    if (rms < 1e-9) return 20.0f;
    return clamp_dba(20.0 * log10(rms) + CALIBRATION_dB);
}
