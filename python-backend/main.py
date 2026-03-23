"""
main.py — QuietSpot FastAPI backend (Phase 2)

Existing endpoints (drop-in replacement for server.js):
  GET  /health
  GET  /spots?since=1h
  GET  /spot?key=X,Y  |  ?lat=X&lng=Y
  POST /noise

Python-native analytics endpoints (new):
  GET  /heatmap?since=    — GeoJSON FeatureCollection for HeatmapLayer
  GET  /stats?since=      — global dBA statistics (mean, median, stddev, percentiles)
  GET  /trends?key=X,Y    — hourly / daily / 14-day trend for one spot
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from database import Base, engine, get_db
from models import NoiseReading
from noise_classifier import classify_with_confidence
from schemas import NoiseCreate

# ── Bootstrap ─────────────────────────────────────────────────────────────────
Base.metadata.create_all(bind=engine)

app = FastAPI(title="QuietSpot API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Shared helpers ─────────────────────────────────────────────────────────────

def cell_key(lat: float, lng: float) -> str:
    """Round to 4 decimal places (~11 m grid) and return 'lat,lng' string."""
    return f"{round(lat, 4)},{round(lng, 4)}"


def parse_since(since: Optional[str]) -> Optional[datetime]:
    """'1h' | '6h' | '24h' | '7d' → UTC datetime cutoff, or None for all-time."""
    if not since or since == "all":
        return None
    units = {"h": 3600, "d": 86400}
    try:
        n, unit = int(since[:-1]), since[-1]
        return datetime.now(timezone.utc) - timedelta(seconds=n * units[unit])
    except (ValueError, KeyError):
        return None


def filtered_query(db: Session, since: Optional[str]):
    q = db.query(NoiseReading)
    cutoff = parse_since(since)
    if cutoff:
        # recorded_at stored as naive UTC
        q = q.filter(NoiseReading.recorded_at >= cutoff.replace(tzinfo=None))
    return q


def percentile(sorted_data: list[float], p: float) -> float:
    """Linear-interpolation percentile on a pre-sorted list."""
    if not sorted_data:
        return 0.0
    idx = (p / 100) * (len(sorted_data) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(sorted_data) - 1)
    return round(sorted_data[lo] + (sorted_data[hi] - sorted_data[lo]) * (idx - lo), 1)


# ── Core routes (same contract as server.js) ──────────────────────────────────

@app.get("/health")
def health(db: Session = Depends(get_db)):
    count = db.query(NoiseReading).count()
    return {"ok": True, "service": "QuietSpot API", "storage": "sqlite", "items": count}


@app.get("/spots")
def get_spots(since: Optional[str] = None, db: Session = Depends(get_db)):
    readings = filtered_query(db, since).all()

    cells: dict[str, list[NoiseReading]] = defaultdict(list)
    for r in readings:
        cells[r.cell_key].append(r)

    spots = []
    for key, group in cells.items():
        avg_lat = sum(r.lat for r in group) / len(group)
        avg_lng = sum(r.lng for r in group) / len(group)
        avg_dba = sum(r.dba for r in group) / len(group)
        spots.append({
            "key": key,
            "lat": round(avg_lat, 6),
            "lng": round(avg_lng, 6),
            "avg": round(avg_dba, 1),
            "n":   len(group),
        })

    spots.sort(key=lambda x: x["n"], reverse=True)
    return {"ok": True, "spots": spots}


@app.get("/spot")
def get_spot(
    key: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    db: Session = Depends(get_db),
):
    if key:
        ck = key
    elif lat is not None and lng is not None:
        ck = cell_key(lat, lng)
    else:
        raise HTTPException(status_code=400, detail="Provide ?key= or ?lat=&lng=")

    readings = (
        db.query(NoiseReading)
        .filter(NoiseReading.cell_key == ck)
        .order_by(NoiseReading.recorded_at.desc())
        .all()
    )

    if not readings:
        raise HTTPException(status_code=404, detail="No readings at this location")

    klat, klng = map(float, ck.split(","))
    avg = sum(r.dba for r in readings) / len(readings)

    return {
        "ok": True,
        "spot": {
            "key":     ck,
            "lat":     klat,
            "lng":     klng,
            "avg":     round(avg, 1),
            "n":       len(readings),
            "samples": [
                {
                    "dBA":         r.dba,
                    "note":        r.note,
                    "source_type": r.source_type,
                    "at":          r.recorded_at.isoformat() + "Z",
                }
                for r in readings
            ],
        },
    }


@app.post("/classify")
def classify_noise(payload: NoiseCreate):
    """
    Classify a noise recording without saving it.
    Used by the frontend to show the predicted source type in the result panel
    before the user decides to save or discard.
    """
    if not payload.bands or len(payload.bands) != 8:
        return {"ok": True, "label": None, "confidence": 0.0, "probabilities": {}}
    result = classify_with_confidence(payload.bands, payload.dBA)
    return {"ok": True, **result}


@app.post("/noise", status_code=201)
def post_noise(payload: NoiseCreate, db: Session = Depends(get_db)):
    ck   = cell_key(payload.lat, payload.lng)
    note = payload.note.strip() if payload.note and payload.note.strip() else None

    # ML classification — requires octave bands from the WASM engine
    classification = (
        classify_with_confidence(payload.bands, payload.dBA)
        if payload.bands and len(payload.bands) == 8
        else {"label": None, "confidence": 0.0, "probabilities": {}}
    )

    reading = NoiseReading(
        lat=payload.lat,
        lng=payload.lng,
        dba=payload.dBA,
        note=note,
        source_type=classification["label"],
        cell_key=ck,
        recorded_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(reading)
    db.commit()
    db.refresh(reading)

    return {
        "ok": True,
        "saved": {
            "lat":         reading.lat,
            "lng":         reading.lng,
            "dBA":         reading.dba,
            "note":        reading.note,
            "source_type": reading.source_type,
            "confidence":  classification["confidence"],
        },
    }


# ── Python-native analytics ───────────────────────────────────────────────────

@app.get("/heatmap")
def get_heatmap(since: Optional[str] = None, db: Session = Depends(get_db)):
    """
    GeoJSON FeatureCollection for Google Maps HeatmapLayer.

    Each feature carries:
      - dBA  : raw decibel value
      - weight: 0.0–1.0 linear normalisation of dBA over the 20–120 range
                (louder = heavier = redder on the heatmap)
    """
    readings = filtered_query(db, since).all()

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type":        "Point",
                "coordinates": [r.lng, r.lat],   # GeoJSON is [lng, lat]
            },
            "properties": {
                "dBA":    r.dba,
                "weight": round((r.dba - 20) / 100, 3),
            },
        }
        for r in readings
    ]

    return {
        "ok":      True,
        "type":    "FeatureCollection",
        "count":   len(features),
        "features": features,
    }


@app.get("/stats")
def get_stats(since: Optional[str] = None, db: Session = Depends(get_db)):
    """
    Global noise statistics over all (or time-filtered) readings.

    Returns:
      - descriptive stats : mean, median, std_dev, min, max
      - percentiles       : p10, p25, p50, p75, p90
      - distribution      : count + % for each noise category
    """
    readings = filtered_query(db, since).all()

    if not readings:
        return {"ok": True, "count": 0, "message": "No readings in range"}

    values = [r.dba for r in readings]
    sorted_values = sorted(values)
    n = len(values)

    categories = {"very_quiet": 0, "moderate": 0, "loud": 0, "very_loud": 0}
    for v in values:
        if v < 50:
            categories["very_quiet"] += 1
        elif v < 65:
            categories["moderate"] += 1
        elif v < 80:
            categories["loud"] += 1
        else:
            categories["very_loud"] += 1

    return {
        "ok":     True,
        "count":  n,
        "mean":   round(statistics.mean(values), 1),
        "median": round(statistics.median(values), 1),
        "std_dev": round(statistics.stdev(values), 2) if n > 1 else 0.0,
        "min":    round(min(values), 1),
        "max":    round(max(values), 1),
        "percentiles": {
            "p10": percentile(sorted_values, 10),
            "p25": percentile(sorted_values, 25),
            "p50": percentile(sorted_values, 50),
            "p75": percentile(sorted_values, 75),
            "p90": percentile(sorted_values, 90),
        },
        "distribution": {
            label: {"count": count, "pct": round(count / n * 100, 1)}
            for label, count in categories.items()
        },
    }


@app.get("/trends")
def get_trends(
    key: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    db: Session = Depends(get_db),
):
    """
    Time-series trend analysis for a single spot.

    Returns three views — each is independently useful for ML feature engineering:

    by_hour  — average dBA per hour of day (0–23)
               reveals rush-hour spikes, nighttime quiet, etc.

    by_day   — average dBA per day of week (Mon–Sun)
               reveals weekday vs weekend patterns.

    recent   — daily averages for the last 14 days (ISO date → avg dBA)
               ready to feed into a regression or LSTM model.
    """
    if key:
        ck = key
    elif lat is not None and lng is not None:
        ck = cell_key(lat, lng)
    else:
        raise HTTPException(status_code=400, detail="Provide ?key= or ?lat=&lng=")

    readings = db.query(NoiseReading).filter(NoiseReading.cell_key == ck).all()

    if not readings:
        raise HTTPException(status_code=404, detail="No readings at this location")

    hour_buckets: dict[int, list[float]]  = defaultdict(list)
    day_buckets:  dict[int, list[float]]  = defaultdict(list)
    date_buckets: dict[str, list[float]]  = defaultdict(list)

    cutoff_14d = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=14)
    DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    for r in readings:
        hour_buckets[r.recorded_at.hour].append(r.dba)
        day_buckets[r.recorded_at.weekday()].append(r.dba)
        if r.recorded_at >= cutoff_14d:
            date_buckets[r.recorded_at.date().isoformat()].append(r.dba)

    return {
        "ok":  True,
        "key": ck,
        "by_hour": [
            {
                "hour":  h,
                "avg":   round(statistics.mean(hour_buckets[h]), 1),
                "count": len(hour_buckets[h]),
            }
            for h in range(24) if h in hour_buckets
        ],
        "by_day": [
            {
                "day":   DAY_NAMES[d],
                "avg":   round(statistics.mean(day_buckets[d]), 1),
                "count": len(day_buckets[d]),
            }
            for d in range(7) if d in day_buckets
        ],
        "recent": sorted(
            [
                {
                    "date":  date,
                    "avg":   round(statistics.mean(vals), 1),
                    "count": len(vals),
                }
                for date, vals in date_buckets.items()
            ],
            key=lambda x: x["date"],
        ),
    }
