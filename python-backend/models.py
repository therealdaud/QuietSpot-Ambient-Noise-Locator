"""
models.py — SQLAlchemy ORM model for noise readings.
"""
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Float, Integer, String, Text

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


class LabeledSample(Base):
    """
    User-corrected noise labels — ground-truth training data for the ML model.
    Each row is one recording where the user confirmed or corrected the
    predicted label.  The classifier retrains on startup using these rows
    blended with the synthetic baseline dataset.
    """
    __tablename__ = "labeled_samples"

    id         = Column(Integer,  primary_key=True, index=True)
    label      = Column(String,   nullable=False)   # user-confirmed correct label
    dba        = Column(Float,    nullable=False)
    bands      = Column(Text,     nullable=True)    # JSON list of 8 floats
    centroid   = Column(Float,    nullable=True)    # Hz
    variance   = Column(Float,    nullable=True)    # dB²
    zcr        = Column(Float,    nullable=True)    # Hz
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
