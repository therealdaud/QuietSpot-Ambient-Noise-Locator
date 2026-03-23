#!/usr/bin/env python3
"""
migrate.py — One-time import of existing JSON readings into SQLite.

Handles both JSON formats produced by the old Node.js server:
  • readings.json  → flat list   [ {lat, lng, dBA, at, note?}, ... ]
  • noise.json     → wrapped     { "samples": [ {lat, lng, dBA, at, note?}, ... ] }

Usage:
    # from inside python-backend/
    python migrate.py                          # auto-discovers ../data/readings.json
    python migrate.py ../data/readings.json    # explicit path
    python migrate.py ../data/noise.json       # alternative file
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from database import Base, SessionLocal, engine
from models import NoiseReading


# ── helpers ───────────────────────────────────────────────────────────────────

def cell_key(lat: float, lng: float) -> str:
    return f"{round(lat, 4)},{round(lng, 4)}"


def parse_dt(iso: str) -> datetime:
    """Parse ISO-8601 string (with or without trailing Z) to naive UTC datetime."""
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).replace(tzinfo=None)


def load_samples(path: Path) -> list[dict]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict) and "samples" in raw:
        return raw["samples"]
    raise ValueError(f"Unrecognised JSON format in {path}")


def discover_data_file() -> Path:
    candidates = [
        Path("../data/readings.json"),
        Path("../data/noise.json"),
        Path("data/readings.json"),
        Path("data/noise.json"),
    ]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        f"Could not find a data file. Tried: {[str(c) for c in candidates]}"
    )


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    data_file = Path(sys.argv[1]) if len(sys.argv) > 1 else discover_data_file()

    print(f"Reading from: {data_file.resolve()}")
    samples = load_samples(data_file)
    print(f"Found {len(samples)} record(s)")

    # Create tables if they don't exist yet
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    added, skipped = 0, 0

    for s in samples:
        try:
            reading = NoiseReading(
                lat=float(s["lat"]),
                lng=float(s["lng"]),
                dba=float(s["dBA"]),
                note=(s.get("note") or "").strip() or None,
                cell_key=cell_key(float(s["lat"]), float(s["lng"])),
                recorded_at=parse_dt(s["at"]),
            )
            db.add(reading)
            added += 1
        except (KeyError, ValueError, TypeError) as exc:
            print(f"  Skipped malformed record — {exc}: {s}")
            skipped += 1

    db.commit()
    db.close()

    print(f"\nMigration complete.")
    print(f"  Added:   {added}")
    print(f"  Skipped: {skipped}")
    print(f"  Database: quietspot.db")


if __name__ == "__main__":
    main()
