"""
schemas.py — Pydantic v2 request / response models.
"""
from typing import Optional

from pydantic import BaseModel, field_validator


class NoiseCreate(BaseModel):
    lat:      float
    lng:      float
    dBA:      float
    note:     Optional[str]         = None
    bands:    Optional[list[float]] = None   # 8 octave-band levels from WASM
    centroid: Optional[float]       = None   # spectral centroid (Hz)
    variance: Optional[float]       = None   # temporal variance (dB²)
    zcr:      Optional[float]       = None   # zero-crossing rate (Hz)

    @field_validator("dBA")
    @classmethod
    def validate_dba(cls, v: float) -> float:
        if not (20 <= v <= 120):
            raise ValueError("dBA must be between 20 and 120")
        return round(v, 2)

    @field_validator("lat")
    @classmethod
    def validate_lat(cls, v: float) -> float:
        if not (-90 <= v <= 90):
            raise ValueError("lat must be between -90 and 90")
        return v

    @field_validator("lng")
    @classmethod
    def validate_lng(cls, v: float) -> float:
        if not (-180 <= v <= 180):
            raise ValueError("lng must be between -180 and 180")
        return v


class SampleOut(BaseModel):
    dBA:         float
    note:        Optional[str]
    source_type: Optional[str]
    at:          str


class SpotSummary(BaseModel):
    key: str
    lat: float
    lng: float
    avg: float
    n:   int


class SpotDetail(SpotSummary):
    samples: list[SampleOut]
