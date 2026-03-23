# QuietSpot — Crowd-Sourced Noise Map

**Find quiet places near you, or contribute a reading from wherever you are.**

A full-stack web app that lets anyone measure ambient noise levels with their phone microphone, pin the reading to a GPS location, and browse a live crowd-sourced noise map of their surroundings.

**Live demo:** [quietspotweb.vercel.app](https://quietspotweb.vercel.app)

> **Note on first load:** The backend runs on Render's free tier, which spins down after 15 minutes of inactivity. If the map markers don't appear immediately, wait about 30–60 seconds for the backend to wake up, then refresh. This is a hosting limitation, not a bug.

---

## What it does

- **Record noise** — tap Record, allow mic access, and the app measures ambient sound for 5 seconds
- **Pin to map** — your reading is saved to your GPS coordinates and shown as a color-coded marker
- **Browse nearby spots** — green = quiet, yellow = moderate, orange = loud, red = very loud
- **Click any marker** — view all individual readings at that location with timestamps and notes
- **See noise source** — an ML classifier identifies what kind of noise was recorded (traffic, voices, music, construction, nature, HVAC)
- **Correct the classifier** — if the predicted label is wrong, tap "Wrong? Correct it" and pick the right one; the model retrains immediately from your feedback
- **Filter the map** — by noise level category or by time window (last hour, 6h, 24h, all time)
- **Auto-refreshes** every 30 seconds — new readings from other users appear without a page reload
- **Octave-band spectrum** — a real-time frequency bar chart shows where the sound energy is concentrated across 8 standard bands (63 Hz → 8 kHz)

---

## Tech stack

This project deliberately spans four languages to demonstrate real polyglot systems engineering.

| Layer | Technology | Purpose |
|---|---|---|
| Audio DSP | **C / WebAssembly** | FFT, A-weighting, octave bands, spectral analysis |
| ML backend | **Python (FastAPI)** | Noise classification, active learning, analytics |
| Frontend | **JavaScript / React** | UI, maps, Web Audio API, WASM integration |
| Database | **SQLite → PostgreSQL** | Readings and labeled training samples |
| Deployment | **Vercel + Render** | Frontend CDN + Python backend |

### C / WebAssembly audio engine

The most performance-sensitive work runs in a C module compiled to WebAssembly via Emscripten and executed directly in the browser:

- **Cooley-Tukey radix-2 FFT** — iterative implementation with separate real/imaginary arrays (no `complex.h` — avoids Emscripten compatibility issues at `-O3`)
- **Hann windowing** — reduces spectral leakage before the FFT
- **IEC 61672-1 A-weighting** — frequency-domain correction that matches human hearing sensitivity; turns raw dBFS into perceptually accurate dBA
- **Octave-band analysis** — 8 standard bands (63, 125, 250, 500, 1k, 2k, 4k, 8k Hz) for the spectrum visualiser and ML classifier
- **Spectral centroid** — frequency centre of mass; a clean separator between bass-heavy and treble-heavy sources
- **Temporal variance** — variance of RMS dBA across 20 time chunks; distinguishes steady drones (HVAC) from impulsive sources (construction)
- **Zero-crossing rate** — rate at which the waveform crosses zero; separates tonal hums from broadband noise

Browser AGC (Automatic Gain Control), echo cancellation, and noise suppression are all disabled via `getUserMedia` constraints so the microphone captures the full dynamic range of the environment rather than a normalised voice-call signal.

### Python / FastAPI backend

The backend is a Python FastAPI application with SQLAlchemy ORM backed by SQLite (PostgreSQL-ready via `DATABASE_URL`):

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/spots` | All noise spots with average dBA and reading count |
| `GET` | `/spot` | Individual spot detail with all readings |
| `POST` | `/noise` | Save a new reading (runs ML classification) |
| `POST` | `/classify` | Classify without saving (live result panel) |
| `POST` | `/feedback` | Submit a label correction and retrain immediately |
| `POST` | `/retrain` | Manual retrain trigger |
| `GET` | `/feedback/stats` | Accumulated corrections by class |
| `GET` | `/heatmap` | GeoJSON FeatureCollection for map heatmap overlay |
| `GET` | `/stats` | Global dBA statistics (mean, median, percentiles) |
| `GET` | `/trends` | Hourly / daily / 14-day trend for one spot |

### ML noise classifier

The classifier is a **Random Forest** (scikit-learn, 200 trees) trained on 15 acoustic features extracted per recording:

| Feature group | Features | What they capture |
|---|---|---|
| Spectral shape | 8 normalised octave-band levels | Frequency fingerprint of the source |
| Level ratios | low / mid / high power fractions | Spectral tilt — bass vs mid vs treble balance |
| Level | Overall dBA (normalised) | Absolute loudness as a weak secondary cue |
| Centroid | Spectral centre of mass (Hz) | Single-number brightness descriptor |
| Variance | Temporal RMS variance (dB²) | Steady vs intermittent — separates HVAC from construction |
| ZCR | Zero-crossing rate (Hz) | Tonal vs noisy — separates hum from saw blades |

**Six noise classes:** `traffic` · `voices` · `construction` · `nature` · `music` · `hvac`

Predictions below 42% confidence return `ambient` rather than a wrong confident-sounding label.

#### Active learning feedback loop

Every time a user corrects a classification, the corrected label and full acoustic feature set are stored in a `labeled_samples` database table. The model retrains immediately, blending all accumulated real labels (weighted 5×) with the synthetic baseline. On each server restart, the classifier automatically picks up all stored corrections. Over time the model shifts from synthetic training data toward real phone-microphone measurements.

---

## Architecture overview

```
Browser
  └── React app (Vite, Vercel)
        ├── Web Audio API → Float32Array PCM samples
        ├── WASM module (C, compiled by Emscripten)
        │     ├── process_audio()          → A-weighted dBA
        │     ├── get_octave_bands()       → 8-band spectrum
        │     ├── get_spectral_centroid()  → Hz
        │     ├── get_temporal_variance()  → dB²
        │     └── get_zero_crossing_rate() → Hz
        └── Fetch API
              ├── POST /classify  → noise source label
              ├── POST /noise     → save to map
              └── POST /feedback  → label correction + retrain

Python FastAPI (Render)
  ├── SQLite database (labeled_samples + noise_readings)
  ├── Random Forest classifier (scikit-learn)
  └── Active learning retraining pipeline
```

---

## Measurement methodology

The dBA value displayed is an **A-weighted Leq** (equivalent continuous sound level) — the energy-averaged level over the 5-second recording window, corrected for human hearing sensitivity via the IEC 61672-1 A-weighting curve.

The calibration constant maps Web Audio's normalised PCM amplitude (`[-1, 1]`) to a realistic dBA range. The A-weighting correction is computed as a spectral ratio from the FFT rather than by direct FFT power measurement, which avoids Hann window energy loss errors.

---

## Run locally

**Backend (Python 3.13+):**
```bash
cd python-backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend:**
```bash
cd web
npm install
npm run dev
```

Create `web/.env`:
```
VITE_GOOGLE_MAPS_API_KEY=your_key_here
VITE_API_URL=http://localhost:8000
```

**Rebuild the WASM audio engine** (requires [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)):
```bash
cd audio-engine
source ~/emsdk/emsdk_env.sh
./build.sh
```
The compiled `.js` and `.wasm` files are already committed to the repo so this step is only needed if you modify the C source.

---

## Noise level scale

| Range | Category | Color |
|---|---|---|
| < 50 dBA | Very Quiet | Green |
| 50–64 dBA | Moderate | Yellow |
| 65–79 dBA | Loud | Orange |
| ≥ 80 dBA | Very Loud | Red |
