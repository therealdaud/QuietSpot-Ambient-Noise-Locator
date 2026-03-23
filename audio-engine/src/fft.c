#include "fft.h"
#include <math.h>

/*
 * Iterative Cooley-Tukey radix-2 FFT.
 * Uses separate real/imaginary arrays — avoids C99 complex.h entirely,
 * which has known portability issues with Emscripten at -O3.
 */

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

void fft(double *re, double *im, size_t n) {
    int log2n = ilog2(n);

    /* Bit-reversal permutation */
    for (size_t i = 0; i < n; i++) {
        size_t j = bit_reverse(i, log2n);
        if (j > i) {
            double tr = re[i]; re[i] = re[j]; re[j] = tr;
            double ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }

    /* Butterfly stages — len grows 2, 4, 8 … n */
    for (size_t len = 2; len <= n; len <<= 1) {
        double angle    = -2.0 * M_PI / (double)len;
        double wr_step  = cos(angle);
        double wi_step  = sin(angle);
        size_t half     = len >> 1;

        for (size_t i = 0; i < n; i += len) {
            double wr = 1.0, wi = 0.0;

            for (size_t j = 0; j < half; j++) {
                /* u = upper half element */
                double ur = re[i + j];
                double ui = im[i + j];
                /* v = lower half element × twiddle factor w */
                double vr = re[i + j + half] * wr - im[i + j + half] * wi;
                double vi = re[i + j + half] * wi + im[i + j + half] * wr;

                re[i + j]        = ur + vr;
                im[i + j]        = ui + vi;
                re[i + j + half] = ur - vr;
                im[i + j + half] = ui - vi;

                /* rotate twiddle factor */
                double new_wr = wr * wr_step - wi * wi_step;
                wi = wr * wi_step + wi * wr_step;
                wr = new_wr;
            }
        }
    }
}
