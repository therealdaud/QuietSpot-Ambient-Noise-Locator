"""
noise_classifier.py — ML noise-source classifier (Phase 3)

Model:   Random Forest (scikit-learn)
Input:   8 octave-band levels (63–8k Hz, in dBA) + overall dBA  → 9 features
Output:  one of six noise-source labels

Labels:
  traffic      — road/engine noise, heavy low-frequency content
  voices       — speech, crowd, human activity (500 Hz–4 kHz peak)
  construction — broadband impulsive noise, flat-ish spectrum
  nature       — wind, rain, birds — smooth mid-low spectrum
  music        — balanced spectrum with mid-to-high energy
  hvac         — mechanical drone, concentrated low-frequency hum

Training data is synthetic but physically grounded: each class is defined
by a realistic octave-band power distribution drawn from IEC / ISO
acoustic measurement references, with per-sample Gaussian noise added to
prevent overfitting and expose the classifier to natural variation.

Feature engineering:
  - bands_norm[i] = (band_dBA[i] - min(band_dBA)) / (max - min + ε)
    → shape-only, strips absolute level so the same spectral profile
      classifies identically at 50 dBA and 80 dBA
  - dba_norm     = (dba - 20) / 100
    → level as a secondary cue (e.g. HVAC is almost always < 65 dBA)

This keeps the feature space compact (9 dims) and interpretable, which
suits a Random Forest well and makes feature importances meaningful.
"""

from __future__ import annotations

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder

# ── Spectral profile definitions ──────────────────────────────────────────────
# Each class is described as a fractional power distribution across the 8
# standard octave bands: [63, 125, 250, 500, 1k, 2k, 4k, 8k] Hz.
# Values sum to 1.0 and represent "what share of total acoustic power sits
# in each band?"  They are converted to dBA offsets during synthesis.

_CLASSES: dict[str, dict] = {
    "traffic": {
        # Engine/tyre rumble: heavily low-frequency even after A-weighting.
        # low_ratio ≈ 0.81 | centroid 200–500 Hz | low variance | moderate ZCR
        "power_fractions": [0.35, 0.28, 0.18, 0.09, 0.05, 0.03, 0.01, 0.01],
        "dba_range":      (55, 90),
        "centroid_range": (200, 500),    # bass-heavy spectrum
        "variance_range": (2, 15),       # fairly continuous, low variation
        "zcr_range":      (1500, 4000),  # broadband but not noisy
        "n_samples": 700,
    },
    "voices": {
        # Speech: narrow peak at 500 Hz–2 kHz. Phone mic sharpens the mid peak.
        # low_ratio ≈ 0.12, mid_ratio ≈ 0.78 | centroid 800–2500 Hz | high variance
        "power_fractions": [0.01, 0.02, 0.09, 0.27, 0.33, 0.18, 0.08, 0.02],
        "dba_range":      (45, 80),
        "centroid_range": (800, 2500),   # mid-range dominant
        "variance_range": (15, 50),      # speech starts/stops naturally
        "zcr_range":      (3000, 7000),  # sibilants and consonants raise ZCR
        "n_samples": 700,
    },
    "construction": {
        # Drills, hammers, saws: flat spectrum + very high temporal variance.
        # low_ratio ≈ 0.42 | impulsive → highest variance of all classes
        "power_fractions": [0.12, 0.14, 0.16, 0.18, 0.17, 0.13, 0.07, 0.03],
        "dba_range":      (70, 105),
        "centroid_range": (500, 1500),   # broadband, centroid in mid range
        "variance_range": (25, 70),      # highly impulsive, biggest variance
        "zcr_range":      (5000, 10000), # saw blades / drills → very high ZCR
        "n_samples": 700,
    },
    "nature": {
        # Outdoors: wind/rain at low freqs + birds/insects at 4–8 kHz.
        # Bimodal + LOW dBA + moderate variance separates from traffic.
        # low_ratio ≈ 0.60, high_ratio ≈ 0.15
        "power_fractions": [0.24, 0.22, 0.14, 0.09, 0.08, 0.08, 0.10, 0.05],
        "dba_range":      (20, 55),
        "centroid_range": (300, 1000),   # bimodal pulls centroid to low-mid
        "variance_range": (5, 30),       # wind gusts + intermittent birds
        "zcr_range":      (2000, 5500),  # moderate — wind is broadband
        "n_samples": 700,
    },
    "music": {
        # Phone speaker playback: weak bass (<250 Hz), broad peak 500 Hz–4 kHz.
        # Key split from voices: more bass (low_ratio 0.32 vs 0.12).
        # Key split from nature: mid-dominant (mid_ratio 0.59 vs 0.25).
        # Key split from construction: low variance (music is continuous).
        "power_fractions": [0.06, 0.10, 0.16, 0.22, 0.23, 0.14, 0.07, 0.02],
        "dba_range":      (55, 92),
        "centroid_range": (600, 2000),   # broad, peaks around 1 kHz
        "variance_range": (5, 20),       # rhythmic but fairly steady
        "zcr_range":      (2500, 6000),  # moderate — melodic content
        "n_samples": 700,
    },
    "hvac": {
        # Mechanical drone: extreme concentration at 63–125 Hz.
        # low_ratio ≈ 0.90 | near-zero variance | very low ZCR (pure hum)
        "power_fractions": [0.44, 0.34, 0.12, 0.05, 0.02, 0.01, 0.01, 0.00],
        "dba_range":      (35, 65),
        "centroid_range": (80, 300),     # pure low-freq drone
        "variance_range": (0.5, 4),      # extremely steady
        "zcr_range":      (300, 1500),   # tonal hum → very low ZCR
        "n_samples": 700,
    },
}

OCTAVE_CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
LABELS = list(_CLASSES.keys())


# ── Feature extraction ─────────────────────────────────────────────────────────

def extract_features(
    bands:    list[float],
    dba:      float,
    centroid: float | None = None,   # spectral centroid (Hz)  — from C engine
    variance: float | None = None,   # temporal variance (dB²) — from C engine
    zcr:      float | None = None,   # zero-crossing rate (Hz) — from C engine
) -> np.ndarray:
    """
    Convert raw octave-band levels + acoustic features into a 15-dim feature vector.

    bands    : list of 8 floats — octave-band dBA levels from the C/WASM engine
    dba      : float            — overall A-weighted level
    centroid : Hz  — frequency centre of mass (low = bass-heavy, high = treble)
    variance : dB² — temporal variance across 20 time chunks (low = steady)
    zcr      : Hz  — zero-crossing rate (low = tonal, high = noisy)

    Feature breakdown (15 total):
      [0-7]  bands_norm      — normalised band shape, level-invariant
      [8]    dba_norm        — absolute level cue (e.g. HVAC < 65 dBA)
      [9]    low_ratio       — linear power fraction at 63–250 Hz
      [10]   mid_ratio       — linear power fraction at 500 Hz–2 kHz
      [11]   high_ratio      — linear power fraction at 4–8 kHz
      [12]   centroid_norm   — spectral centre of mass, normalised [0, 1]
      [13]   variance_norm   — temporal steadiness, normalised [0, 1]
      [14]   zcr_norm        — tonal vs noisy, normalised [0, 1]

    centroid/variance/zcr default to band-derived or neutral values when not
    supplied, so the function works even without the C engine (graceful fallback).
    """
    b = np.array(bands, dtype=float)

    # Normalised band shape [0, 1]
    lo, hi = b.min(), b.max()
    bands_norm = (b - lo) / (hi - lo + 1e-6)

    # Absolute level cue
    dba_norm = np.clip((dba - 20.0) / 100.0, 0.0, 1.0)

    # Convert dB back to linear power for ratio calculation
    linear = 10.0 ** (b / 10.0)
    total  = linear.sum() + 1e-30
    low_ratio  = linear[0:3].sum() / total   # 63, 125, 250 Hz
    mid_ratio  = linear[3:6].sum() / total   # 500, 1k, 2k Hz
    high_ratio = linear[6:8].sum() / total   # 4k, 8k Hz

    # Spectral centroid — derive from band centres if not supplied by C engine
    OCTAVE_CENTERS_HZ = np.array([63, 125, 250, 500, 1000, 2000, 4000, 8000], dtype=float)
    if centroid is None or centroid <= 0:
        centroid = float(np.dot(OCTAVE_CENTERS_HZ, linear) / (linear.sum() + 1e-30))
    centroid_norm = float(np.clip((centroid - 80.0) / (8000.0 - 80.0), 0.0, 1.0))

    # Temporal variance — 0.0 (unknown) maps to a neutral mid-range value
    variance_norm = float(np.clip((variance or 0.0) / 80.0, 0.0, 1.0))

    # Zero-crossing rate — 0.0 (unknown) maps to the low end (conservative)
    zcr_norm = float(np.clip((zcr or 0.0) / 12000.0, 0.0, 1.0))

    return np.concatenate([
        bands_norm,
        [dba_norm, low_ratio, mid_ratio, high_ratio,
         centroid_norm, variance_norm, zcr_norm]
    ]).reshape(1, -1)


# ── Synthetic training data ────────────────────────────────────────────────────

def _synthesise_dataset(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate (X, y) training data from the spectral profile definitions.

    For each sample:
      band_dBA[i] = overall_dBA + 10 * log10(fraction[i]) + Gaussian noise(σ=2 dB)
      centroid    ~ Uniform(centroid_range) with ±10% Gaussian jitter
      variance    ~ Uniform(variance_range) with ±15% Gaussian jitter
      zcr         ~ Uniform(zcr_range)      with ±10% Gaussian jitter
    """
    X_parts, y_parts = [], []

    for label, cfg in _CLASSES.items():
        fracs = np.array(cfg["power_fractions"], dtype=float)
        fracs /= fracs.sum()
        band_offsets = 10.0 * np.log10(fracs + 1e-30)

        lo_dba, hi_dba = cfg["dba_range"]
        lo_c,   hi_c   = cfg["centroid_range"]
        lo_v,   hi_v   = cfg["variance_range"]
        lo_z,   hi_z   = cfg["zcr_range"]
        n = cfg["n_samples"]

        dba_vals      = rng.uniform(lo_dba, hi_dba, size=n)
        centroid_vals = rng.uniform(lo_c,   hi_c,   size=n)
        variance_vals = rng.uniform(lo_v,   hi_v,   size=n)
        zcr_vals      = rng.uniform(lo_z,   hi_z,   size=n)

        # Add realistic jitter to acoustic features
        centroid_vals *= 1.0 + rng.normal(0.0, 0.10, size=n)
        variance_vals *= 1.0 + rng.normal(0.0, 0.15, size=n)
        zcr_vals      *= 1.0 + rng.normal(0.0, 0.10, size=n)

        for i, dba in enumerate(dba_vals):
            noise = rng.normal(0.0, 2.0, size=8)
            bands = dba + band_offsets + noise

            feats = extract_features(
                bands.tolist(), float(dba),
                centroid=float(np.clip(centroid_vals[i], 20, 20000)),
                variance=float(np.clip(variance_vals[i], 0, 200)),
                zcr=float(np.clip(zcr_vals[i], 0, 24000)),
            )
            X_parts.append(feats[0])
            y_parts.append(label)

    X = np.array(X_parts)
    y = np.array(y_parts)

    idx = rng.permutation(len(y))
    return X[idx], y[idx]


# ── Model training ─────────────────────────────────────────────────────────────

def _build_model(X: np.ndarray, y_enc: np.ndarray) -> RandomForestClassifier:
    clf = RandomForestClassifier(
        n_estimators=200,
        max_depth=None,
        min_samples_leaf=2,
        random_state=42,
        n_jobs=-1,
    )
    clf.fit(X, y_enc)
    return clf


def _train() -> tuple[RandomForestClassifier, LabelEncoder]:
    rng = np.random.default_rng(42)
    X, y = _synthesise_dataset(rng)

    le = LabelEncoder()
    y_enc = le.fit_transform(y)
    return _build_model(X, y_enc), le


# Train once at import time — takes < 1 s, result is cached for the process lifetime
_clf, _le = _train()


def retrain_with_real_data(real_samples: list[dict]) -> int:
    """
    Retrain the classifier blending the synthetic baseline with real labeled samples.

    real_samples : list of dicts, each with keys:
        label    (str)         — user-confirmed noise source
        dba      (float)       — overall A-weighted level
        bands    (list|None)   — 8 octave-band dBA values
        centroid (float|None)  — spectral centroid (Hz)
        variance (float|None)  — temporal variance (dB²)
        zcr      (float|None)  — zero-crossing rate (Hz)

    Real samples are replicated 5× so ground-truth data outweighs the
    synthetic baseline when the real dataset is small.

    Returns the total number of training samples used.
    """
    global _clf, _le

    rng = np.random.default_rng(42)
    X_syn, y_syn = _synthesise_dataset(rng)

    X_real_parts: list[np.ndarray] = []
    y_real_parts: list[str]        = []

    for s in real_samples:
        if not s.get("bands") or len(s["bands"]) != 8:
            continue
        if s.get("label") not in LABELS:
            continue
        feats = extract_features(
            s["bands"], float(s["dba"]),
            centroid=s.get("centroid"),
            variance=s.get("variance"),
            zcr=s.get("zcr"),
        )
        X_real_parts.append(feats[0])
        y_real_parts.append(s["label"])

    if X_real_parts:
        # 5× duplication gives real data ~5× more influence than synthetic
        X_real = np.tile(np.array(X_real_parts), (5, 1))
        y_real = np.tile(np.array(y_real_parts), 5)
        X_all  = np.vstack([X_syn, X_real])
        y_all  = np.concatenate([y_syn, y_real])
    else:
        X_all, y_all = X_syn, y_syn

    le    = LabelEncoder()
    y_enc = le.fit_transform(y_all)
    _clf  = _build_model(X_all, y_enc)
    _le   = le

    return len(X_all)


# ── Public API ─────────────────────────────────────────────────────────────────

def classify(
    bands:    list[float],
    dba:      float,
    centroid: float | None = None,
    variance: float | None = None,
    zcr:      float | None = None,
) -> str:
    """
    Predict the dominant noise source.

    bands    : 8-element list from WASM get_octave_bands()
    dba      : overall A-weighted level from process_audio()
    centroid : spectral centroid (Hz) from get_spectral_centroid()
    variance : temporal variance (dB²) from get_temporal_variance()
    zcr      : zero-crossing rate (Hz) from get_zero_crossing_rate()

    Returns one of: 'traffic', 'voices', 'construction', 'nature', 'music', 'hvac', 'ambient'
    """
    if not bands or len(bands) != 8:
        return "unknown"

    feats = extract_features(bands, dba, centroid, variance, zcr)
    pred  = _clf.predict(feats)[0]
    return str(_le.inverse_transform([pred])[0])


def classify_with_confidence(
    bands:    list[float],
    dba:      float,
    centroid: float | None = None,
    variance: float | None = None,
    zcr:      float | None = None,
) -> dict:
    """
    Like classify(), but also returns per-class probabilities.
    Useful for the API response / debugging.
    """
    if not bands or len(bands) != 8:
        return {"label": "unknown", "confidence": 0.0, "probabilities": {}}

    feats  = extract_features(bands, dba, centroid, variance, zcr)
    probs  = _clf.predict_proba(feats)[0]
    labels = list(_le.classes_)

    best_idx   = int(np.argmax(probs))
    best_label = str(_le.inverse_transform([best_idx])[0])
    best_prob  = float(probs[best_idx])

    # Below this threshold the model is uncertain — return 'ambient' rather than
    # a confident-sounding wrong answer.
    CONFIDENCE_THRESHOLD = 0.42
    display_label = best_label if best_prob >= CONFIDENCE_THRESHOLD else "ambient"

    return {
        "label":         display_label,
        "confidence":    round(best_prob, 3),
        "probabilities": {
            str(_le.inverse_transform([i])[0]): round(float(p), 3)
            for i, p in enumerate(probs)
        },
    }
