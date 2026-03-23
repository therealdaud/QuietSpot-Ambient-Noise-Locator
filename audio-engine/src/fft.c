#include "fft.h"
#include <math.h>

/*
 * Iterative Cooley-Tukey radix-2 FFT.
 *
 * Steps:
 *   1. Bit-reversal permutation — rearranges input so butterflies
 *      can be computed in-place without index collisions.
 *   2. log2(n) stages of butterfly operations.
 *      Each stage doubles the "chunk" size and combines pairs of
 *      sub-DFTs using twiddle factors w = e^(-2πi·k/len).
 *
 * Time complexity : O(n log n)
 * Space complexity: O(1) extra (in-place)
 */

/* ── bit reversal ─────────────────────────────────────────────────────────── */

static size_t bit_reverse(size_t x, int log2n) {
    size_t result = 0;
    for (int i = 0; i < log2n; i++) {
        result = (result << 1) | (x & 1);
        x >>= 1;
    }
    return result;
}

static int ilog2(size_t n) {
    int k = 0;
    while (n > 1) { k++; n >>= 1; }
    return k;
}

/* ── FFT ──────────────────────────────────────────────────────────────────── */

void fft(double complex *x, size_t n) {
    int log2n = ilog2(n);

    /* Bit-reversal permutation */
    for (size_t i = 0; i < n; i++) {
        size_t j = bit_reverse(i, log2n);
        if (j > i) {
            double complex tmp = x[i];
            x[i] = x[j];
            x[j] = tmp;
        }
    }

    /* Butterfly stages — len grows 2, 4, 8 … n */
    for (size_t len = 2; len <= n; len <<= 1) {
        double angle = -2.0 * M_PI / (double)len;
        double complex w_step = cos(angle) + sin(angle) * I;

        for (size_t i = 0; i < n; i += len) {
            double complex w = 1.0 + 0.0 * I;
            size_t half = len >> 1;

            for (size_t j = 0; j < half; j++) {
                double complex u = x[i + j];
                double complex v = x[i + j + half] * w;
                x[i + j]        = u + v;   /* even output */
                x[i + j + half] = u - v;   /* odd  output */
                w *= w_step;
            }
        }
    }
}
