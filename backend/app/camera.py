"""Conservative camera and manufacturer classification from original EXIF fields."""

import re

from .legacy_labels import category_label


PHONE_MAKES = {"huawei", "xiaomi", "oneplus", "oppo", "vivo", "motorola", "realme", "honor"}
PHONE_MODEL_WORDS = ("iphone", "ipad", "ipod", "pixel", "galaxy", "oneplus", "redmi", "poco")
CAMERA_MAKES = {"canon", "nikon", "olympus", "sony", "fujifilm", "panasonic", "leica", "pentax", "ricoh", "kodak", "hasselblad", "phase one", "sigma", "casio"}
GENERIC_MAKE_SUFFIXES = {
    "corporation", "corp", "inc", "incorporated", "ltd", "limited",
    "company", "co", "digital", "camera", "imaging", "optical",
}


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def device_rule_key(value: str) -> str:
    """Unicode-safe identity for a raw EXIF field, ignoring only case and spacing."""
    return " ".join(value.casefold().split())


def raw_manufacturer(make: str, model: str) -> str:
    return make.strip() or (model.strip().split(" ", 1)[0] if model.strip() else "Unknown manufacturer")


def manufacturer(make: str, model: str) -> str:
    """Group case, generic legal/EXIF suffixes and well-known company names."""
    if not make.strip() and not model.strip():
        return "Unknown manufacturer"
    words = normalized(raw_manufacturer(make, model)).split()
    while len(words) > 1 and words[-1] in GENERIC_MAKE_SUFFIXES:
        words.pop()
    # EXIF commonly reports the company name instead of the camera brand.
    if words[:2] == ["eastman", "kodak"]:
        words = ["kodak"]
    if not words:
        return "Unknown manufacturer"
    return " ".join(word.upper() if len(word) <= 3 else word.capitalize() for word in words)


def device_name(asset: dict) -> str:
    if asset.get("_device_name"):
        return asset["_device_name"]
    exif = asset.get("exifInfo") or {}
    make = str(exif.get("make") or "").strip()
    model = str(exif.get("model") or "").strip()
    name = model if make and model and model.lower().startswith(make.lower()) else " ".join(part for part in (make, model) if part)
    return name or "Unknown device"


def category(make: str, model: str) -> str:
    maker, camera = normalized(manufacturer(make, model)), normalized(model)
    combined = normalized(f"{make} {model}")
    if camera.startswith(maker + " "):
        camera = camera[len(maker) + 1:]
    if maker in PHONE_MAKES or any(word in combined for word in PHONE_MODEL_WORDS) or (
        re.search(r"\bsamsung\s+(?:sm\s+\w|gt\s+[isp]\d)", combined)
    ):
        return "Mobile device"
    if maker == "samsung" and re.match(r"^(nx|wb|ex|pl)\s*\d", camera):
        return "Camera"
    if maker in CAMERA_MAKES and (camera or maker == "kodak"):
        return "Camera"
    return "Other"


def manufacturer_for(asset: dict) -> str:
    exif = asset.get("exifInfo") or {}
    return asset.get("_manufacturer") or manufacturer(str(exif.get("make") or ""), str(exif.get("model") or ""))


def category_for(asset: dict) -> str:
    exif = asset.get("exifInfo") or {}
    return category_label(asset.get("_device_category")) or category(str(exif.get("make") or ""), str(exif.get("model") or ""))


def apply_device_rules(assets: list[dict], rules: dict[tuple[str, str], dict]) -> None:
    """Reapply profile-specific display overrides without altering original EXIF."""
    for asset in assets:
        for field in ("_device_name", "_manufacturer", "_device_category"):
            asset.pop(field, None)
        exif = asset.get("exifInfo") or {}
        key = (device_rule_key(str(exif.get("make") or "")), device_rule_key(str(exif.get("model") or "")))
        rule = rules.get(key)
        if rule:
            for field, source in (("_device_name", "device_name"), ("_manufacturer", "manufacturer"), ("_device_category", "category")):
                if rule.get(source):
                    asset[field] = category_label(rule[source]) if source == "category" else rule[source]
