"""Create a portable, per-account SQLite snapshot without credentials."""

import json
import os
import sqlite3
import tempfile
from contextlib import closing

from sqlalchemy import select

from .camera import category_for, device_name, manufacturer_for
from .legacy_labels import category_label, normalize_summary
from .immich import asset_size
from .models import CachedAsset, CachedSummary, DeviceRule, SyncState
from .statistics import detected_faces, exposure_seconds, image_dimensions, positive_number, taken_at


def create_sqlite_export(db, user_id: int, state: SyncState) -> tuple[str, int, int]:
    handle = tempfile.NamedTemporaryFile(prefix="immich-insights-", suffix=".sqlite", delete=False)
    path = handle.name
    handle.close()
    asset_count = summary_count = 0
    try:
        with closing(sqlite3.connect(path)) as target:
            with target:
                target.execute("PRAGMA user_version = 4")
                target.execute("PRAGMA foreign_keys = ON")
                target.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                target.execute("""CREATE TABLE assets (
                    asset_id TEXT PRIMARY KEY, taken_date TEXT, taken_at TEXT, media_type TEXT,
                    original_filename TEXT, file_size_bytes INTEGER, is_favorite INTEGER NOT NULL,
                    width INTEGER, height INTEGER, make TEXT, model TEXT, manufacturer TEXT,
                    device_name TEXT, device_category TEXT, iso REAL, focal_length_mm REAL,
                    aperture_f_number REAL, exposure_seconds REAL,
                    latitude REAL, longitude REAL, country TEXT, detected_faces INTEGER,
                    payload_json TEXT NOT NULL)""")
                target.execute("CREATE INDEX assets_taken_date ON assets(taken_date)")
                target.execute("CREATE INDEX assets_media_type ON assets(media_type)")
                target.execute("CREATE INDEX assets_device_name ON assets(device_name)")
                target.execute("CREATE INDEX assets_country ON assets(country)")
                target.execute("CREATE TABLE album_assets (album_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(album_id, asset_id), FOREIGN KEY(asset_id) REFERENCES assets(asset_id))")
                target.execute("CREATE TABLE summaries (scope TEXT PRIMARY KEY, payload_json TEXT NOT NULL)")
                target.execute("CREATE TABLE albums (album_id TEXT PRIMARY KEY, album_name TEXT, asset_count INTEGER)")
                target.execute("CREATE TABLE device_rules (make TEXT NOT NULL, model TEXT NOT NULL, device_name TEXT, manufacturer TEXT, category TEXT, PRIMARY KEY(make, model))")
                target.execute("CREATE VIEW photos AS SELECT * FROM assets WHERE media_type = 'IMAGE'")
                target.execute("CREATE VIEW videos AS SELECT * FROM assets WHERE media_type = 'VIDEO'")
                target.execute("CREATE VIEW yearly_counts AS SELECT substr(taken_date, 1, 4) AS year, COUNT(*) AS assets, SUM(media_type = 'IMAGE') AS photos, SUM(media_type = 'VIDEO') AS videos, SUM(is_favorite) AS favorites FROM assets WHERE taken_date IS NOT NULL GROUP BY substr(taken_date, 1, 4) ORDER BY year")
                target.execute("CREATE VIEW asset_albums AS SELECT aa.asset_id, aa.album_id, a.album_name FROM album_assets aa LEFT JOIN albums a ON a.album_id = aa.album_id")
                target.executemany("INSERT INTO metadata VALUES (?, ?)", [
                    ("format_version", "4"),
                    ("snapshot_revision", state.revision or ""),
                    ("completed_at", state.completed_at.isoformat() + "Z" if state.completed_at else ""),
                    ("scope", "one-account-statistics"),
                    ("schema", "assets=one row per asset; photos/videos=filtered views; yearly_counts=aggregated view; asset_albums=album membership; payload_json=original cached Immich response"),
                ])
                for asset_id, taken_date, payload in db.execute(
                    select(CachedAsset.asset_id, CachedAsset.taken_date, CachedAsset.payload)
                    .where(CachedAsset.user_id == user_id).execution_options(yield_per=500)
                ):
                    exif = payload.get("exifInfo") or {}
                    dimensions = image_dimensions(payload)
                    focal = positive_number(exif.get("focalLength"))
                    shot = taken_at(payload)
                    target.execute("INSERT INTO assets VALUES (" + ",".join("?" for _ in range(23)) + ")", (
                        asset_id, taken_date.isoformat() if taken_date else None,
                        shot.isoformat() if shot else None, payload.get("type"), payload.get("originalFileName"),
                        asset_size(payload), int(bool(payload.get("isFavorite"))),
                        dimensions[0] if dimensions else None, dimensions[1] if dimensions else None,
                        exif.get("make"), exif.get("model"), manufacturer_for(payload), device_name(payload), category_for(payload),
                        positive_number(exif.get("iso")), focal,
                        positive_number(exif.get("fNumber")), exposure_seconds(exif.get("exposureTime")),
                        exif.get("latitude"), exif.get("longitude"), exif.get("country"), detected_faces(payload),
                        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    ))
                    for album_id in payload.get("_album_ids") or []:
                        target.execute("INSERT OR IGNORE INTO album_assets VALUES (?, ?)", (album_id, asset_id))
                    asset_count += 1
                for scope, payload in db.execute(
                    select(CachedSummary.scope, CachedSummary.payload).where(CachedSummary.user_id == user_id)
                ):
                    target.execute("INSERT INTO summaries VALUES (?, ?)", (
                        scope, json.dumps(normalize_summary(payload), ensure_ascii=False, separators=(",", ":")),
                    ))
                    summary_count += 1
                target.executemany("INSERT INTO albums VALUES (?, ?, ?)", [
                    (album["id"], album.get("albumName"), album.get("assetCount")) for album in state.albums or [] if isinstance(album, dict) and album.get("id")
                ])
                target.executemany("INSERT INTO device_rules VALUES (?, ?, ?, ?, ?)", [
                    (rule.make, rule.model, rule.device_name, rule.manufacturer, category_label(rule.category))
                    for rule in db.scalars(select(DeviceRule).where(DeviceRule.user_id == user_id))
                ])
        return path, asset_count, summary_count
    except Exception:
        os.unlink(path)
        raise
