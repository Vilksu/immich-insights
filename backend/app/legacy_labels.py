"""Normalize stored labels from pre-0.1 snapshots without changing raw EXIF.

These strings are upgrade compatibility data, not the application's source language.
"""

LEGACY_CATEGORIES = {"Kamera": "Camera", "Mobilgerät": "Mobile device", "Sonstiges": "Other"}
LEGACY_CONTINENTS = {
    "Afrika": "Africa", "Antarktika": "Antarctica", "Asien": "Asia", "Europa": "Europe",
    "Nordamerika": "North America", "Südamerika": "South America", "Ozeanien": "Oceania",
}


def category_label(value: str | None) -> str | None:
    return LEGACY_CATEGORIES.get(value, value)


def device_aliases(value: str) -> tuple[str, ...]:
    return ("Unknown device", "Unbekanntes Gerät") if value in {"Unknown device", "Unbekanntes Gerät"} else (value,)


def normalize_summary(value):
    """Copy a summary and normalize generated labels, never user metadata."""
    if isinstance(value, list):
        return [normalize_summary(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: normalize_summary(item) for key, item in value.items()}
    if "category" in result:
        result["category"] = category_label(result["category"])
    if "continents" in result:
        result["continents"] = [LEGACY_CONTINENTS.get(item, item) for item in result["continents"]]
    for key in ("name", "manufacturer"):
        if result.get(key) == "Unbekanntes Gerät":
            result[key] = "Unknown device"
        elif result.get(key) == "Unbekannt":
            result[key] = "Unknown manufacturer"
    return result
