"""
database.py — SQLAlchemy engine + session factory.

Supports SQLite (local / Render free tier) and PostgreSQL (production).
Set DATABASE_URL in your environment to switch:
  sqlite:///./quietspot.db          (default)
  postgresql://user:pass@host/db    (Render PostgreSQL addon)
"""
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DB_URL = os.getenv("DATABASE_URL", "sqlite:///./quietspot.db")

# Render gives a postgres:// URL; SQLAlchemy needs postgresql://
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DB_URL.startswith("sqlite") else {}

engine = create_engine(DB_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
