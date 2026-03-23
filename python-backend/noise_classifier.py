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
        # 63–250 Hz carries ~75% of energy.
        "power_fractions": [0.32, 0.28, 0.18, 0.10, 0.06, 0.04, 0.01, 0.01],
        "dba_range": (50, 90),
        "n_samples": 500,
    },
    "voices": {
        # Speech: strong vowel/consonant energy at 250–1 kHz; harmonics through 3 kHz.
        # After A-weighting the peak lands at 500 Hz not 1 kHz — corrected from v1.
        "power_fractions": [0.02, 0.05, 0.16, 0.28, 0.26, 0.14, 0.07, 0.02],
        "dba_range": (45, 80),
        "n_samples": 500,
    },
    "construction": {
        # Drills, hammers, saws: broadband and relatively flat across all bands.
        "power_fractions": [0.12, 0.14, 0.17, 0.18, 0.16, 0.13, 0.07, 0.03],
        "dba_range": (65, 100),
        "n_samples": 500,
    },
    "nature": {
        # Outdoors mix: wind/rain peaks at 63–250 Hz; birds/insects peak at 4–8 kHz.
        # Bimodal shape — clearly different from the single mid-peak of voices.
        "power_fractions": [0.20, 0.22, 0.16, 0.12, 0.08, 0.07, 0.10, 0.05],
        "dba_range": (20, 60),
        "n_samples": 500,
    },
    "music": {
        # Full-range playback with bass boost: nearly flat 63 Hz – 4 kHz.
        # More low-end AND more high-end than voices — distinguishable by ratios.
        "power_fractions": [0.20, 0.18, 0.16, 0.14, 0.13, 0.10, 0.06, 0.03],
        "dba_range": (55, 95),
        "n_samples": 500,
    },
    "hvac": {
        # Mechanical drone: extreme concentration at 63–125 Hz.
        "power_fractions": [0.44, 0.33, 0.13, 0.06, 0.02, 0.01, 0.01, 0.00],
        "dba_range": (35, 65),
        "n_samples": 500,
    },
}

OCTAVE_CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
LABELS = list(_CLASSES.keys())


# ── Feature extraction ─────────────────────────────────────────────────────────

def extract_features(bands: list[float], dba: float) -> np.ndarray:
    """
    Convert raw octave-band levels + overall dBA into the 12-dim feature vector.

    bands : list of 8 floats — octave-band dBA levels from the C/WASM engine
    dba   : float            — overall A-weighted level

    Feature breakdown (12 total):
      [0-7]  bands_norm  — normalised band shape, level-invariant
      [8]    dba_norm    — absolute level cue (e.g. HVAC < 65 dBA)
      [9]    low_ratio   — fraction of linear power in 63–250 Hz (bands 0-2)
      [10]   mid_ratio   — fraction of linear power in 500 Hz–2 kHz (bands 3-5)
      [11]   high_ratio  — fraction of linear power in 4–8 kHz (bands 6-7)

    The ratio features give the classifier a direct measure of spectral tilt that
    the normalised shape alone cannot represent unambiguously. They are the key
    separator between e.g. traffic (high low_ratio), voices (high mid_ratio),
    and nature (bimodal: elevated low_ratio AND high_ratio).

    Returns a (1, 12) ndarray ready for clf.predict().
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

    return np.concatenate([
        bands_norm, [dba_norm, low_ratio, mid_ratio, high_ratio]
    ]).reshape(1, -1)


# ── Synthetic training data ────────────────────────────────────────────────────

def _synthesise_dataset(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate (X, y) training data from the spectral profile definitions.

    band_dBA[i] = overall_dBA + 10 * log10(fraction[i])
    then Gaussian noise (σ = 1.5 dB) is added per band to model real variation.
    """
    X_parts, y_parts = [], []

    for label, cfg in _CLASSES.items():
        fracs = np.array(cfg["power_fractions"], dtype=float)
        fracs /= fracs.sum()                          # ensure sums to 1
        band_offsets = 10.0 * np.log10(fracs + 1e-30) # dB below overall Leq

        lo, hi = cfg["dba_range"]
        n = cfg["n_samples"]

        dba_vals = rng.uniform(lo, hi, size=n)

        for dba in dba_vals:
            # Band levels + realistic measurement noise
            noise = rng.normal(0.0, 1.5, size=8)
            bands = dba + band_offsets + noise

            feats = extract_features(bands.tolist(), float(dba))
            X_parts.append(feats[0])
            y_parts.append(label)

    X = np.array(X_parts)
    y = np.array(y_parts)

    # Shuffle
    idx = rng.permutation(len(y))
    return X[idx], y[idx]


# ── Model training ─────────────────────────────────────────────────────────────

def _train() -> tuple[RandomForestClassifier, LabelEncoder]:
    rng = np.random.default_rng(42)
    X, y = _synthesise_dataset(rng)

    le = LabelEncoder()
    y_enc = le.fit_transform(y)

    clf = RandomForestClassifier(
        n_estimators=200,
        max_depth=None,
        min_samples_leaf=2,
        random_state=42,
        n_jobs=-1,
    )
    clf.fit(X, y_enc)
    return clf, le


# Train once at import time — takes < 1 s, result is cached for the process lifetime
_clf, _le = _train()


# ── Public API ─────────────────────────────────────────────────────────────────

def classify(bands: list[float], dba: float) -> str:
    """
    Predict the dominant noise source from octave-band levels + overall dBA.

    bands : 8-element list from the WASM get_octave_bands() call
    dba   : overall A-weighted level from process_audio()

    Returns one of: 'traffic', 'voices', 'construction', 'nature', 'music', 'hvac'
    """
    if not bands or len(bands) != 8:
        return "unknown"

    feats = extract_features(bands, dba)
    pred  = _clf.predict(feats)[0]
    return str(_le.inverse_transform([pred])[0])


def classify_with_confidence(bands: list[float], dba: float) -> dict:
    """
    Like classify(), but also returns per-class probabilities.
    Useful for the API response / debugging.
    """
    if not bands or len(bands) != 8:
        return {"label": "unknown", "confidence": 0.0, "probabilities": {}}

    feats  = extract_features(bands, dba)
    probs  = _clf.predict_proba(feats)[0]
    labels = list(_le.classes_)

    best_idx   = int(np.argmax(probs))
    best_label = str(_le.inverse_transform([best_idx])[0])
    best_prob  = float(probs[best_idx])

    return {
        "label":         best_label,
        "confidence":    round(best_prob, 3),
        "probabilities": {
            str(_le.inverse_transform([i])[0]): round(float(p), 3)
            for i, p in enumerate(probs)
        },
    }
