#ifndef FFT_H
#define FFT_H

#include <stddef.h>

/*
 * In-place Cooley-Tukey radix-2 FFT — no C99 complex.h dependency.
 * n must be a power of 2.
 * re[] and im[] are overwritten with the frequency-domain result.
 */
void fft(double *re, double *im, size_t n);

#endif
