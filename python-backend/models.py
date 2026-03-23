"""
models.py — SQLAlchemy ORM model for noise readings.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Float, Integer, String

from database import Base


class NoiseReading(Base):
    __tablename__ = "noise_readings"

    id          = Column(Integer, primary_key=True, index=True)
    lat         = Column(Float,   nullable=False)
    lng         = Column(Float,   nullable=False)
    dba         = Column(Float,   nullable=False)
    note        = Column(String,  nullable=True)
    source_type = Column(String,  nullable=True)   # ML-classified noise source
    recorded_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    cell_key    = Column(String,  index=True)   # precomputed ~11m grid cell
