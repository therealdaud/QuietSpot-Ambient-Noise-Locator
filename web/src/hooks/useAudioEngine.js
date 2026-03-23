/**
 * useAudioEngine.js
 *
 * Loads the C/WASM audio engine at mount time.
 * All three exported functions fall back to a pure-JS implementation
 * if the WASM module hasn't loaded yet (or if build.sh hasn't been run).
 * The app is fully functional either way — WASM just makes it more accurate.
 */
import { useEffect, useRef } from 'react';

// ── JS fallback (simple RMS, same formula as the original NoiseMeter) ─────────
function jsDBA(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms < 1e-9) return 20;
  return Math.max(20, Math.min(120, 20 * Math.log10(rms) + 90));
}

// ── WASM memory helpers ────────────────────────────────────────────────────────
function writeF32(mod, samples) {
  const ptr = mod._malloc(samples.length * 4);
  mod.HEAPF32.set(samples, ptr >> 2);
  return ptr;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useAudioEngine() {
  const modRef = useRef(null);

  useEffect(() => {
    // Dynamically inject the Emscripten glue script.
    // If the file doesn't exist yet (WASM not compiled) the onerror handler
    // fires silently and the JS fallbacks remain active.
    const script = document.createElement('script');
    script.src = '/audio-engine/audio_engine.js';

    script.onload = () => {
      window.AudioEngine().then(mod => {
        modRef.current = mod;
        console.log('[QuietSpot] WASM audio engine loaded — using C/FFT processing');
      }).catch(() => {
        console.warn('[QuietSpot] WASM init failed — using JS fallback');
      });
    };

    script.onerror = () => {
      console.info('[QuietSpot] WASM not found — using JS fallback (run audio-engine/build.sh to enable)');
    };

    document.body.appendChild(script);
    return () => { if (document.body.contains(script)) document.body.removeChild(script); };
  }, []);

  // ── processAudio ────────────────────────────────────────────────────────────
  // Returns A-weighted dBA for a raw PCM Float32Array.
  function processAudio(samples, sampleRate) {
    const mod = modRef.current;
    if (!mod) return jsDBA(samples);

    const ptr = writeF32(mod, samples);
    const dba = mod._process_audio(ptr, samples.length, sampleRate);
    mod._free(ptr);
    return dba;
  }

  // ── getOctaveBands ──────────────────────────────────────────────────────────
  // Returns Float32Array[8] with dB levels for bands:
  //   63, 125, 250, 500, 1000, 2000, 4000, 8000 Hz
  // Returns null if WASM isn't loaded.
  function getOctaveBands(samples, sampleRate) {
    const mod = modRef.current;
    if (!mod) return null;

    const samplesPtr = writeF32(mod, samples);
    const bandsPtr   = mod._malloc(8 * 4);

    mod._get_octave_bands(samplesPtr, samples.length, sampleRate, bandsPtr);

    const bands = new Float32Array(8);
    for (let i = 0; i < 8; i++) bands[i] = mod.HEAPF32[(bandsPtr >> 2) + i];

    mod._free(samplesPtr);
    mod._free(bandsPtr);
    return bands;
  }

  // ── calculateLeq ────────────────────────────────────────────────────────────
  // Energy-averaged dBA over the full buffer (Leq).
  function calculateLeq(samples, sampleRate) {
    const mod = modRef.current;
    if (!mod) return jsDBA(samples);

    const ptr = writeF32(mod, samples);
    const leq = mod._calculate_leq(ptr, samples.length, sampleRate);
    mod._free(ptr);
    return leq;
  }

  // ── getSpectralCentroid ──────────────────────────────────────────────────────
  // Frequency centre of mass (Hz). Low = bass-heavy, high = treble-heavy.
  // Returns null if WASM isn't loaded.
  function getSpectralCentroid(samples, sampleRate) {
    const mod = modRef.current;
    if (!mod) return null;

    const ptr      = writeF32(mod, samples);
    const centroid = mod._get_spectral_centroid(ptr, samples.length, sampleRate);
    mod._free(ptr);
    return centroid;
  }

  // ── getTemporalVariance ──────────────────────────────────────────────────────
  // Variance of per-chunk RMS dBA across 20 time segments (dB²).
  // Near-zero = steady; high = intermittent / impulsive.
  // Returns null if WASM isn't loaded.
  function getTemporalVariance(samples, sampleRate) {
    const mod = modRef.current;
    if (!mod) return null;

    const ptr      = writeF32(mod, samples);
    const variance = mod._get_temporal_variance(ptr, samples.length, sampleRate);
    mod._free(ptr);
    return variance;
  }

  // ── getZeroCrossingRate ──────────────────────────────────────────────────────
  // Zero crossings per second (Hz). Low = tonal, high = noisy/broadband.
  // Returns null if WASM isn't loaded.
  function getZeroCrossingRate(samples, sampleRate) {
    const mod = modRef.current;
    if (!mod) return null;

    const ptr = writeF32(mod, samples);
    const zcr = mod._get_zero_crossing_rate(ptr, samples.length, sampleRate);
    mod._free(ptr);
    return zcr;
  }

  return { processAudio, getOctaveBands, calculateLeq,
           getSpectralCentroid, getTemporalVariance, getZeroCrossingRate };
}
