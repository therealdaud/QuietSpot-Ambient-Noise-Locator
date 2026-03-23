#ifndef FFT_H
#define FFT_H

#include <complex.h>
#include <stddef.h>

/*
 * In-place Cooley-Tukey radix-2 FFT.
 * n must be a power of 2.
 * x is overwritten with the frequency-domain result.
 */
void fft(double complex *x, size_t n);

#endif
