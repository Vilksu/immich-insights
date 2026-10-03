from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, Float, Integer, JSON, DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    invitation_hash: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    invitation_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    immich_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    immich_user_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    profile_icon: Mapped[str] = mapped_column(String(30), default="camera", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# Protect the first-admin registration against simultaneous requests.
Index("one_admin_only", User.is_admin, unique=True, postgresql_where=User.is_admin.is_(True), sqlite_where=User.is_admin.is_(True))


class LoginSession(Base):
    __tablename__ = "login_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LegacyProfile(Base):
    """Keep the former table intact. Legacy keys are never exposed to new accounts."""

    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    immich_url: Mapped[str] = mapped_column(String(500))
    encrypted_api_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SyncState(Base):
    __tablename__ = "sync_state"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    revision: Mapped[str | None] = mapped_column(String(40), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    running: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    albums: Mapped[list | None] = mapped_column(JSON, nullable=True)


class SyncProgress(Base):
    """Operational progress, separate from the published snapshot."""

    __tablename__ = "sync_progress"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    phase: Mapped[str] = mapped_column(String(120), default="")
    percent: Mapped[int] = mapped_column(default=0)
    processed: Mapped[int] = mapped_column(default=0)
    total: Mapped[int] = mapped_column(default=0)
    last_full_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CachedAsset(Base):
    __tablename__ = "cached_assets"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    taken_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (Index("cached_asset_user_date", "user_id", "taken_date"),)


class FocalObservation(Base):
    """Queryable original EXIF value; built transactionally from cached assets."""

    __tablename__ = "focal_observations"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    device: Mapped[str] = mapped_column(String(300))
    taken_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    focal_length_mm: Mapped[float] = mapped_column(Float)
    __table_args__ = (Index("focal_user_device_date", "user_id", "device", "taken_date"),)


class DeviceRule(Base):
    """One account's correction for a normalized EXIF make/model pair."""

    __tablename__ = "device_rules"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    make_key: Mapped[str] = mapped_column(String(400), primary_key=True)
    model_key: Mapped[str] = mapped_column(String(400), primary_key=True)
    make: Mapped[str] = mapped_column(String(200))
    model: Mapped[str] = mapped_column(String(200))
    device_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    manufacturer: Mapped[str | None] = mapped_column(String(200), nullable=True)
    category: Mapped[str | None] = mapped_column(String(30), nullable=True)


class CachedSummary(Base):
    __tablename__ = "cached_summaries"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    scope: Mapped[str] = mapped_column(String(100), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)


class ExportSize(Base):
    __tablename__ = "export_sizes"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    revision: Mapped[str] = mapped_column(String(40))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    asset_count: Mapped[int] = mapped_column(Integer)
    summary_count: Mapped[int] = mapped_column(Integer)


class ReportSize(Base):
    __tablename__ = "report_sizes"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    revision: Mapped[str] = mapped_column(String(40), primary_key=True)
    format: Mapped[str] = mapped_column(String(10), primary_key=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
