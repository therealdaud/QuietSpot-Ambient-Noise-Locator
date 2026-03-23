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
        "power_fractions": [0.30, 0.26, 0.20, 0.11, 0.06, 0.04, 0.02, 0.01],
        "dba_range": (50, 90),
        "n_samples": 300,
    },
    "voices": {
        "power_fractions": [0.02, 0.04, 0.12, 0.22, 0.30, 0.20, 0.07, 0.03],
        "dba_range": (45, 80),
        "n_samples": 300,
    },
    "construction": {
        "power_fractions": [0.15, 0.17, 0.18, 0.17, 0.14, 0.11, 0.06, 0.02],
        "dba_range": (65, 100),
        "n_samples": 300,
    },
    "nature": {
        "power_fractions": [0.08, 0.16, 0.24, 0.22, 0.15, 0.09, 0.04, 0.02],
        "dba_range": (25, 60),
        "n_samples": 300,
    },
    "music": {
        "power_fractions": [0.08, 0.10, 0.14, 0.18, 0.22, 0.16, 0.08, 0.04],
        "dba_range": (55, 95),
        "n_samples": 300,
    },
    "hvac": {
        "power_fractions": [0.28, 0.32, 0.20, 0.10, 0.06, 0.03, 0.01, 0.00],
        "dba_range": (35, 65),
        "n_samples": 300,
    },
}

OCTAVE_CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
LABELS = list(_CLASSES.keys())


# ── Feature extraction ─────────────────────────────────────────────────────────

def extract_features(bands: list[float], dba: float) -> np.ndarray:
    """
    Convert raw octave-band levels + overall dBA into the 9-dim feature vector.

    bands : list of 8 floats — octave-band dBA levels from the C/WASM engine
    dba   : float            — overall A-weighted level

    Returns a (1, 9) ndarray ready for clf.predict().
    """
    b = np.array(bands, dtype=float)

    # Normalise band shape to [0, 1] — makes level-invariant
    lo, hi = b.min(), b.max()
    bands_norm = (b - lo) / (hi - lo + 1e-6)

    dba_norm = np.clip((dba - 20.0) / 100.0, 0.0, 1.0)

    return np.concatenate([bands_norm, [dba_norm]]).reshape(1, -1)


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
