"""Read-only drill-down over a single account's persisted Immich snapshot."""

from collections import Counter
from datetime import date, datetime
from math import isfinite

from fastapi import HTTPException
from sqlalchemy import select

from .camera import category_for, device_name, manufacturer_for, raw_manufacturer
from .immich import asset_size
from .models import CachedAsset
from .schemas import AssetQueryInput
from .statistics import detected_faces, duration_seconds, exposure_seconds, finite_number, image_dimensions, orientation_of, positive_number, taken_at


METRIC_LABELS = {
    "assets": "Assets", "photos": "Photos", "videos": "Videos",
    "geo": "Assets with location", "people": "Assets with a person", "favorites": "Favorites",
}
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
FIELDS = {
    "iso": "ISO value", "focal": "Focal length",
    "aperture": "Aperture", "exposure": "Exposure time", "video": "Video length", "altitude": "GPS altitude",
}


def validate(query: AssetQueryInput) -> None:
    if query.kind == "asset" and not query.asset_id:
        raise HTTPException(422, "Asset ID is missing.")
    if query.kind in {"device", "manufacturer"} and not query.name:
        raise HTTPException(422, "Device or manufacturer is missing.")
    if query.kind == "distribution" and (not query.field or query.lower is None or query.upper is None):
        raise HTTPException(422, "Distribution range is missing.")
    if query.kind == "distribution" and (
        not isfinite(query.lower) or not isfinite(query.upper) or query.lower > query.upper
    ):
        raise HTTPException(422, "Invalid value range.")
    if query.kind in {"date", "anniversary"} and not query.date:
        raise HTTPException(422, "Capture date is missing.")
    if query.kind == "date":
        try:
            date.fromisoformat(query.date)
        except ValueError:
            raise HTTPException(422, "Invalid capture date.")
    if query.kind == "anniversary":
        try:
            date.fromisoformat(f"2024-{query.date}")
        except ValueError:
            raise HTTPException(422, "Invalid anniversary date.")
    if query.kind == "week":
        try:
            if not query.start or not query.end or date.fromisoformat(query.start) > date.fromisoformat(query.end):
                raise ValueError
        except ValueError:
            raise HTTPException(422, "Invalid calendar week.")
    for kind, required in (("week_hour", ("weekday", "hour")), ("month", ("month",)), ("weekday", ("weekday",)), ("hour", ("hour",)), ("year", ("year",))):
        if query.kind == kind and any(getattr(query, field) is None for field in required):
            raise HTTPException(422, "Time filter is incomplete.")
    if query.category not in (None, "all", "Mobile device", "Camera", "Other"):
        raise HTTPException(422, "Invalid device category.")
    if query.kind == "orientation" and query.orientation is None:
        raise HTTPException(422, "Image orientation is missing.")
    if query.kind == "dimensions" and (query.frame_width is None or query.frame_height is None):
        raise HTTPException(422, "Image dimensions are missing.")
    if query.source is not None and not query.name:
        raise HTTPException(422, "Device or manufacturer is missing.")
    if query.scope_year is not None and (query.scope_start is not None or query.scope_end is not None):
        raise HTTPException(422, "Invalid date-range restriction.")
    if (query.scope_start is None) != (query.scope_end is None) or (query.scope_start and query.scope_end and query.scope_start > query.scope_end):
        raise HTTPException(422, "Invalid date-range restriction.")


def metric_matches(asset: dict, metric: str) -> bool:
    exif = asset.get("exifInfo") or {}
    return (
        metric == "assets"
        or metric == "photos" and asset.get("type") == "IMAGE"
        or metric == "videos" and asset.get("type") == "VIDEO"
        or metric == "geo" and exif.get("latitude") is not None and exif.get("longitude") is not None
        or metric == "people" and detected_faces(asset) > 0
        or metric == "favorites" and bool(asset.get("isFavorite"))
    )


def field_value(asset: dict, field: str) -> float | None:
    exif = asset.get("exifInfo") or {}
    if field == "video":
        return duration_seconds(asset.get("duration")) if asset.get("type") == "VIDEO" and not asset.get("_live_companion") else None
    if asset.get("type") != "IMAGE":
        return None
    if field == "altitude":
        return finite_number(exif.get("altitude") if exif.get("altitude") is not None else exif.get("gpsAltitude"))
    if field == "iso":
        return positive_number(exif.get("iso"))
    if field == "aperture":
        return positive_number(exif.get("fNumber"))
    if field == "focal":
        return positive_number(exif.get("focalLength"))
    if field == "exposure":
        return exposure_seconds(exif.get("exposureTime"))
    return None


def matches(asset: dict, query: AssetQueryInput) -> bool:
    if not metric_matches(asset, query.metric):
        return False
    if query.kind == "asset":
        return asset.get("id") == query.asset_id
    exif = asset.get("exifInfo") or {}
    if query.favorite_only and not asset.get('isFavorite'):
        return False
    if query.geo_only and (exif.get('latitude') is None or exif.get('longitude') is None):
        return False
    if query.people_only and detected_faces(asset) == 0:
        return False
    if query.field and query.kind != "distribution" and field_value(asset, query.field) is None:
        return False
    if query.category not in (None, "all") and category_for(asset) != query.category:
        return False
    if query.kind != "orientation" and query.orientation is not None and orientation_of(asset) != query.orientation:
        return False
    if query.source == "device" and device_name(asset) != query.name:
        return False
    if query.source == "manufacturer":
        maker_name = raw_manufacturer(str(exif.get("make") or ""), str(exif.get("model") or "")) if query.raw else manufacturer_for(asset)
        if maker_name != query.name:
            return False
    if query.kind in {"device", "manufacturer"}:
        if query.kind == "device":
            return device_name(asset) == query.name
        maker = raw_manufacturer(str(exif.get("make") or ""), str(exif.get("model") or "")) if query.raw else manufacturer_for(asset)
        return maker == query.name
    if query.kind == "distribution":
        value = field_value(asset, query.field)
        if value is None:
            return False
        return query.lower <= value <= query.upper if query.upper_inclusive else query.lower <= value < query.upper
    if query.kind == "orientation":
        return orientation_of(asset) == query.orientation
    if query.kind == "dimensions":
        if asset.get("type") != "IMAGE":
            return False
        width, height = image_dimensions(asset)
        return width is not None and height is not None and round(width) == query.frame_width and round(height) == query.frame_height
    if query.kind == "week" and query.name and query.source is None and device_name(asset) != query.name:
        return False
    taken = taken_at(asset)
    if taken is None:
        return False
    if query.kind == "date":
        return taken.date().isoformat() == query.date
    if query.kind == "anniversary":
        return taken.strftime("%m-%d") == query.date
    if query.kind == "week":
        return query.start <= taken.date().isoformat() <= query.end
    if query.kind == "week_hour":
        return taken.weekday() == query.weekday and taken.hour == query.hour
    if query.kind == "month":
        return taken.month == query.month
    if query.kind == "weekday":
        return taken.weekday() == query.weekday
    if query.kind == "hour":
        return taken.hour == query.hour
    if query.kind == "year":
        return taken.year == query.year
    return False


def describe(query: AssetQueryInput) -> str:
    metric = METRIC_LABELS[query.metric]
    if query.kind == "asset":
        detail = "the selected asset only"
    elif query.kind == "device":
        detail = f'captured with device “{query.name}”'
    elif query.kind == "manufacturer":
        detail = f'captured with devices of {"EXIF manufacturer" if query.raw else "grouped manufacturer"} “{query.name}”'
    elif query.kind == "distribution":
        interval = f"{query.lower:g}" if query.lower == query.upper else f"{query.lower:g} {'through' if query.upper_inclusive else 'to under'} {query.upper:g}"
        detail = f"with {FIELDS[query.field]} in range {interval} {'seconds' if query.field in ('exposure', 'video') else 'mm' if query.field == 'focal' else 'm' if query.field == 'altitude' else ''}".strip()
    elif query.kind == "orientation":
        detail = {
            "portrait": "in portrait orientation",
            "landscape": "in landscape orientation",
            "unknown": "with square or undetermined orientation",
        }[query.orientation]
    elif query.kind == "dimensions":
        detail = f"with dimensions {query.frame_width} × {query.frame_height} pixels"
    elif query.kind == "date":
        detail = f"captured on {query.date}"
    elif query.kind == "anniversary":
        detail = f"captured on {query.date} (all years)"
    elif query.kind == "week":
        detail = f"captured from {query.start} through {query.end} (inclusive)"
        if query.name and query.source is None:
            detail += f' with camera “{query.name}”'
    elif query.kind == "week_hour":
        detail = f"captured on {WEEKDAYS[query.weekday]} between {query.hour:02}:00 and {query.hour:02}:59"
    elif query.kind == "month":
        detail = f"captured in month {query.month:02d} (all years)"
    elif query.kind == "weekday":
        detail = f"captured on a {WEEKDAYS[query.weekday]} (all years)"
    elif query.kind == "hour":
        detail = f"captured between {query.hour:02}:00 and {query.hour:02}:59 (all days)"
    else:
        detail = f"captured in {query.year}"
    if query.source is not None:
        detail += f', {("device" if query.source == "device" else "EXIF manufacturer" if query.raw else "manufacturer")} “{query.name}”'
    if query.category not in (None, "all"):
        detail += f", category {query.category}"
    if query.favorite_only:
        detail += ", favorites only"
    if query.geo_only:
        detail += ", with location data"
    if query.people_only:
        detail += ", with detected people"
    if query.field and query.kind != "distribution":
        detail += f", with a usable value for {FIELDS[query.field]}"
    if query.orientation is not None and query.kind != "orientation":
        detail += f", {query.orientation == 'portrait' and 'portrait' or query.orientation == 'landscape' and 'landscape' or 'square/unknown'}"
    scope = f" in {query.scope_year}" if query.scope_year is not None else f" from {query.scope_start.isoformat()} through {query.scope_end.isoformat()}" if query.scope_start else ""
    return f"Your {metric}{scope}: {detail}. Capture times follow the local date in Immich."


def query_assets(db, user_id: int, query: AssetQueryInput) -> dict:
    validate(query)
    found: list[tuple[datetime, dict]] = []
    models = Counter()
    variants = Counter()
    statement = select(CachedAsset.payload).where(CachedAsset.user_id == user_id)
    if query.kind == "asset":
        statement = statement.where(CachedAsset.asset_id == query.asset_id)
    if query.scope_year is not None:
        statement = statement.where(CachedAsset.taken_date >= date(query.scope_year, 1, 1),
                                    CachedAsset.taken_date <= date(query.scope_year, 12, 31))
    elif query.scope_start is not None:
        statement = statement.where(CachedAsset.taken_date >= query.scope_start, CachedAsset.taken_date <= query.scope_end)
    if query.kind == "date":
        statement = statement.where(CachedAsset.taken_date == date.fromisoformat(query.date))
    elif query.kind == "week":
        statement = statement.where(CachedAsset.taken_date >= date.fromisoformat(query.start), CachedAsset.taken_date <= date.fromisoformat(query.end))
    elif query.kind == "year":
        statement = statement.where(CachedAsset.taken_date >= date(query.year, 1, 1), CachedAsset.taken_date <= date(query.year, 12, 31))
    for asset in db.scalars(statement.execution_options(yield_per=500)):
        if not matches(asset, query):
            continue
        found.append((taken_at(asset) or datetime.min, asset))
        if query.kind == "manufacturer":
            models[device_name(asset)] += 1
            exif = asset.get("exifInfo") or {}
            variants[raw_manufacturer(str(exif.get("make") or ""), str(exif.get("model") or ""))] += 1
    found.sort(key=lambda item: (item[0], item[1].get("id", "")), reverse=True)
    items = []
    for taken, asset in found[query.offset:query.offset + query.limit]:
        exif = asset.get("exifInfo") or {}
        items.append({
            "id": asset["id"],
            "filename": asset.get("originalFileName") or str(asset.get("originalPath") or "").rsplit("/", 1)[-1] or asset["id"],
            "type": asset.get("type"),
            "taken_at": taken.isoformat() if taken != datetime.min else None,
            "device": device_name(asset),
            "iso": positive_number(exif.get("iso")),
            "focal_mm": positive_number(exif.get("focalLength")),
            "exposure_seconds": exposure_seconds(exif.get("exposureTime")),
            "duration_seconds": duration_seconds(asset.get("duration")) if asset.get("type") == "VIDEO" else None,
            "size_bytes": asset_size(asset),
        })
    return {
        "description": describe(query),
        "total": len(found),
        "items": items,
        "models": [{"name": name, "count": count} for name, count in models.most_common()],
        "manufacturer_variants": [{"name": name, "count": count} for name, count in variants.most_common()],
        "offset": query.offset,
        "limit": query.limit,
    }
