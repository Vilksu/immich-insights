from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from math import pi, isfinite, floor, ceil, sqrt
from fractions import Fraction
from functools import lru_cache
from random import Random
from typing import Any

import country_converter

from .immich import asset_size
from .camera import category_for, device_name, manufacturer_for, raw_manufacturer
from .photo_profile import calculate_photo_profile
from .schemas import CountPoint, DayPoint, DevicePoint, ExposurePoint, FramePoint, FrameSegment, HeatmapSlice, HourWeekPoint, LibraryStatsOut, NumericDistribution, NumericPoint, OrientationCounts, ParameterSlice, ScorePoint, TimelineEvent, WeeklyScorePoint, WeekPoint, YearPoint


@lru_cache(maxsize=1)
def country_lookup():
    return country_converter.CountryConverter()


def continent_labels(countries: set[str]) -> list[str]:
    if not countries:
        return []
    converted = country_lookup().convert(sorted(countries), to='continent_7', not_found='not found')
    values = [converted] if isinstance(converted, str) else converted
    return sorted(set(values) - {'not found'})


def taken_at(asset: dict[str, Any]) -> datetime | None:
    exif = asset.get("exifInfo") or {}
    raw = asset.get("localDateTime") or exif.get("dateTimeOriginal") or asset.get("fileCreatedAt")
    if not raw:
        return None
    try:
        value = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        return value.replace(tzinfo=None)  # Immich localDateTime is deliberately timezone-naive.
    except ValueError:
        return None


def duration_seconds(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        if isinstance(raw, (float, int)):
            return max(0.0, float(raw) / 1000) if isfinite(raw) else None
        parts = [float(part) for part in str(raw).split(":")]
        if len(parts) == 3:
            return max(0.0, parts[0] * 3600 + parts[1] * 60 + parts[2])
        if len(parts) == 2:
            return max(0.0, parts[0] * 60 + parts[1])
        if len(parts) == 1:
            return max(0.0, parts[0] / 1000) if isfinite(parts[0]) else None
    except ValueError:
        pass
    return None


def positive_number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if isfinite(number) and number > 0 else None
    except (TypeError, ValueError):
        return None


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if isfinite(number) else None
    except (TypeError, ValueError):
        return None


def image_dimensions(asset: dict[str, Any]) -> tuple[float | None, float | None]:
    exif = asset.get("exifInfo") or {}
    width = positive_number(asset.get('width')) or positive_number(exif.get('exifImageWidth'))
    height = positive_number(asset.get('height')) or positive_number(exif.get('exifImageHeight'))
    if width and height and asset.get('width') is None and str(exif.get('orientation') or '') in {'5', '6', '7', '8'}:
        width, height = height, width
    return width, height


def all_frame_formats(assets: list[dict[str, Any]]) -> tuple[list[FramePoint], int]:
    """Rebuild every image format from locally cached metadata, without Immich I/O."""
    counts: Counter[tuple[int, int]] = Counter()
    segments: dict[tuple[int, int, str], Counter[str]] = defaultdict(Counter)
    for asset in assets:
        if asset.get('type') != 'IMAGE':
            continue
        width, height = image_dimensions(asset)
        if width is None or height is None:
            continue
        size = (round(width), round(height))
        counts[size] += 1
        exif = asset.get('exifInfo') or {}
        segment = segments[(*size, category_for(asset))]
        segment['photos'] += 1
        segment['geo'] += exif.get('latitude') is not None and exif.get('longitude') is not None
        segment['people'] += detected_faces(asset) > 0
        segment['favorites'] += bool(asset.get('isFavorite'))
    frames = [FramePoint(width=width, height=height, count=count,
                         segments=[FrameSegment(category=category, **{key: segments[(width, height, category)][key]
                                                                    for key in ('photos', 'geo', 'people', 'favorites')})
                                   for category in ("Camera", "Mobile device", "Other")
                                   if (width, height, category) in segments])
              for (width, height), count in counts.most_common()]
    return frames, sum(counts.values())


def orientation_of(asset: dict[str, Any]) -> str:
    width, height = image_dimensions(asset)
    return 'portrait' if width and height and height > width else 'landscape' if width and height and width > height else 'unknown'


def iso_score_weight(iso: float) -> float:
    if iso <= 400:
        return 0
    if iso < 800:
        return (iso - 400) / 800
    if iso <= 1600:
        return .5
    if iso < 3200:
        return .5 + (iso - 1600) / 3200
    return 1


def calculate_scores(photos: list[dict[str, Any]], videos: list[dict[str, Any]] | None = None) -> list[ScorePoint]:
    """Percentages among evaluable photos; unknown metadata is reported separately."""
    total = len(photos)
    weights: dict[str, list[float]] = {key: [] for key in ('time', 'iso', 'frequency', 'orientation', 'device')}
    dated: list[datetime] = []
    for photo in photos:
        taken = taken_at(photo)
        if taken:
            hour = taken.hour
            weights['time'].append(0 if 8 <= hour < 18 else .5 if 6 <= hour < 8 or 18 <= hour < 22 else 1)
            dated.append(taken)

        exif = photo.get('exifInfo') or {}
        iso = positive_number(exif.get('iso'))
        if iso is not None:
            weights['iso'].append(iso_score_weight(iso))

        orientation = orientation_of(photo)
        if orientation != 'unknown':
            weights['orientation'].append(1 if orientation == 'portrait' else 0)
        else:
            width, height = image_dimensions(photo)
            if width is not None and height is not None and width == height:
                weights['orientation'].append(.5)

        device = category_for(photo)
        if device in ("Mobile device", "Camera"):
            weights['device'].append(1 if device == "Mobile device" else 0)

    dated.sort()
    for previous, current in zip(dated, dated[1:]):
        gap = (current - previous).total_seconds()
        weights['frequency'].append(1 if gap <= 5 else 0 if gap >= 600 else (600 - gap) / 595)

    videos = videos or []
    weights['media'] = [0] * len(photos) + [1] * len(videos)
    return [ScorePoint(key=key, value=round(sum(values) / len(values) * 100, 1) if values else None,
                       eligible_count=len(values), excluded_count=(total if key != 'media' else total + len(videos)) - len(values),
                       population_count=total if key != 'media' else total + len(videos))
            for key, values in weights.items()]


def exposure_seconds(raw: Any) -> float | None:
    try:
        value = float(Fraction(str(raw)))
        return value if isfinite(value) and value > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def detected_faces(asset: dict[str, Any]) -> int:
    assigned = sum(max(1, len(p.get('faces') or [])) for p in asset.get('people') or [] if isinstance(p, dict) and p.get('id'))
    return assigned + len(asset.get('unassignedFaces') or [])


def longest_streak(values: list[date], step: int) -> tuple[int, date | None, date | None]:
    best = (0, None, None)
    current = 0
    start = previous = None
    for value in sorted(set(values)):
        if previous is not None and (value - previous).days == step:
            current += 1
        else:
            start, current = value, 1
        if current > best[0]:
            best = (current, start, value)
        previous = value
    return best


def average_size(assets: list[dict[str, Any]]) -> float | None:
    sizes = [asset_size(asset) for asset in assets]
    if not sizes or any(size is None for size in sizes):
        return None
    return sum(sizes) / len(sizes)


def total_size(assets: list[dict[str, Any]]) -> int | None:
    sizes = [asset_size(asset) for asset in assets]
    return sum(sizes) if all(size is not None for size in sizes) else None


def numeric_distribution(values, bucket, label, bounds=None) -> NumericDistribution:
    grouped = defaultdict(list)
    for value in values:
        grouped[bucket(value)].append(value)
    ordered = sorted(values)
    middle = len(ordered) // 2
    exact_counts = Counter(values)
    return NumericDistribution(
        points=[NumericPoint(value=sum(grouped[key]) / len(grouped[key]), label=label(key), count=len(grouped[key]),
                             lower=(bounds(key)[0] if bounds else key), upper=(bounds(key)[1] if bounds else key),
                             upper_inclusive=(bounds(key)[2] if bounds else True)) for key in sorted(grouped)],
        minimum=ordered[0] if ordered else None,
        maximum=ordered[-1] if ordered else None,
        median=(ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2) if ordered else None,
        mean=sum(ordered) / len(ordered) if ordered else None,
        mode=exact_counts.most_common(1)[0][0] if ordered else None,
        mode_count=exact_counts.most_common(1)[0][1] if ordered else 0,
        p99=ordered[ceil(len(ordered) * .99) - 1] if ordered else None,
        sample_count=len(ordered),
    )


def focal_distribution(values: list[float]) -> NumericDistribution:
    # Preserve Immich's original EXIF precision. Rounding here made the chart's
    # counts disagree with the asset drill-down and merged distinct lenses.
    return numeric_distribution(values, lambda value: value, lambda key: f"{key:.15g} mm")


def iso_distribution(values: list[float]) -> NumericDistribution:
    return numeric_distribution(values, lambda value: value, lambda key: f"ISO {key:g}")


def build_timeline(dated: list[tuple[datetime, dict[str, Any]]], days: dict[str, Counter[str]],
                   live_ids: set[str | None], longest_pause, day_streak) -> list[TimelineEvent]:
    """Small, deterministic set of dated milestones; never fetches media or metadata."""
    ordered = sorted(dated, key=lambda pair: (pair[0], pair[1]['id']))
    if not ordered:
        return []
    events: list[TimelineEvent] = []

    def add(at: datetime | date, category: str, title: str, detail: str,
            asset: dict | None = None, day: str | None = None, metric: str = 'assets') -> None:
        timestamp = at.isoformat() if isinstance(at, datetime) else f'{at.isoformat()}T12:00:00'
        events.append(TimelineEvent(id=f'{category}:{len(events)}', at=timestamp, category=category,
                                    title=title, detail=detail, asset_id=asset['id'] if asset else None,
                                    day=day, metric=metric))

    first_time, first_asset = ordered[0]
    last_time, last_asset = ordered[-1]
    add(first_time, 'beginning', "First capture", "Earliest dated capture in your library.", first_asset)
    if last_asset['id'] != first_asset['id']:
        add(last_time, 'beginning', "Last capture", "Latest dated capture in your library.", last_asset)

    thresholds = (100, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000)
    counts = Counter()
    first_seen: set[str] = set()
    device_first: dict[str, tuple[datetime, dict]] = {}
    device_last: dict[str, tuple[datetime, dict]] = {}
    day_representatives: dict[tuple[str, str], dict] = {}
    videos: list[tuple[float, datetime, dict]] = []
    exif_records: dict[str, list[tuple[float, datetime, dict]]] = {name: [] for name in ('iso', 'exposure', 'aperture')}
    for taken, asset in ordered:
        exif = asset.get('exifInfo') or {}
        is_photo = asset.get('type') == 'IMAGE'
        is_video = asset.get('type') == 'VIDEO'
        day_representatives.setdefault((taken.date().isoformat(), 'assets'), asset)
        if is_photo or is_video:
            day_representatives.setdefault((taken.date().isoformat(), 'photos' if is_photo else 'videos'), asset)
        faces = detected_faces(asset) if is_photo else 0
        has_geo = is_photo and exif.get('latitude') is not None and exif.get('longitude') is not None
        traits = {
            'photo': is_photo,
            'geo': has_geo,
            'faces': faces > 0,
            'favorite': bool(asset.get('isFavorite')),
            'video': is_video and asset['id'] not in live_ids and not asset.get('_live_companion'),
        }
        for trait, present in traits.items():
            if present and trait not in first_seen:
                first_seen.add(trait)
                titles = {'photo': "First photo", 'geo': "First geotagged photo",
                          'faces': "First photo with a person", 'favorite': "First favorite", 'video': "First video"}
                add(taken, 'beginning', titles[trait], "First dated medium of this type.", asset)
        if is_photo:
            for name, value in (('iso', positive_number(exif.get('iso'))),
                                ('exposure', exposure_seconds(exif.get('exposureTime'))),
                                ('aperture', positive_number(exif.get('fNumber')))):
                if value is not None and value > 0:
                    exif_records[name].append((value, taken, asset))
            device = device_name(asset)
            if device and device != "Unknown device":
                device_first.setdefault(device, (taken, asset))
                device_last[device] = (taken, asset)
        increments = {'assets': 1, 'photos': int(is_photo), 'geo': int(has_geo), 'faces': faces}
        for name, increment in increments.items():
            before = counts[name]
            counts[name] += increment
            for threshold in thresholds:
                if before < threshold <= counts[name]:
                    label = {'assets': "asset", 'photos': "photo", 'geo': "geotagged photo", 'faces': "detected face"}[name]
                    detail = ("Counted chronologically by capture time; undated media are excluded. "
                              + ('Multiple faces in one photo count separately; they are not distinct people.' if name == 'faces' else ''))
                    add(taken, 'milestone', f'{threshold}th {label}', detail, asset)
        if is_video and asset['id'] not in live_ids and not asset.get('_live_companion'):
            duration = duration_seconds(asset.get('duration'))
            if duration is not None and duration > 0:
                videos.append((duration, taken, asset))

    for device, (taken, asset) in device_first.items():
        add(taken, 'device', f'First photo with {device}', "First dated photo with this device.", asset)
        last_taken, last_photo = device_last[device]
        if last_photo['id'] != asset['id']:
            add(last_taken, 'device', f'Last photo with {device}', "Latest dated photo with this device.", last_photo)

    if videos:
        shortest = min(videos, key=lambda row: (row[0], row[1], row[2]['id']))
        longest = min(videos, key=lambda row: (-row[0], row[1], row[2]['id']))
        for title, (seconds, taken, asset) in (("Shortest video", shortest), ("Longest video", longest)):
            add(taken, 'record', title, f'{seconds:g} seconds · standalone video with known duration; Live Photo companion videos excluded.', asset)

    for kind, title in (('IMAGE', "Largest photo by file size"), ('VIDEO', "Largest video by file size")):
        sized = [(size, taken, asset) for taken, asset in ordered
                 if asset.get('type') == kind
                 and (kind != 'VIDEO' or (asset['id'] not in live_ids and not asset.get('_live_companion')))
                 if (size := asset_size(asset)) is not None]
        if sized:
            size, taken, asset = min(sized, key=lambda row: (-row[0], row[1], row[2]['id']))
            add(taken, 'record', title, f'{size / 1_000_000:.2f} MB · largest known original file of this media type.', asset)

    record_names = {
        'iso': ("Lowest ISO", "Highest ISO", 'ISO {}'),
        'exposure': ("Shortest shutter time", "Longest shutter time", '{} s'),
        'aperture': ("Widest aperture", "Smallest aperture opening", 'f/{}'),
    }
    for name, rows in exif_records.items():
        if not rows:
            continue
        low_title, high_title, template = record_names[name]
        for value, title in ((min(row[0] for row in rows), low_title), (max(row[0] for row in rows), high_title)):
            matches = [row for row in rows if row[0] == value]
            if len(matches) == 1:
                _, taken, asset = matches[0]
                add(taken, 'record', title, template.format(f'{value:g}') + ' · only photo with this extreme value.', asset)

    for metric, title in (('assets', 'Assets'), ('photos', "Photos"), ('videos', 'Videos')):
        nonempty = [(day, counts[metric]) for day, counts in days.items() if counts[metric] > 0]
        if nonempty:
            peak_day, amount = max(nonempty, key=lambda row: (row[1], -date.fromisoformat(row[0]).toordinal()))
            event_title = {'assets': 'Busiest day', 'photos': 'Busiest photo day', 'videos': 'Busiest video day'}[metric]
            add(date.fromisoformat(peak_day), 'record', event_title,
                f'{amount} {title} on this capture day.',
                asset=day_representatives.get((peak_day, metric)), day=peak_day, metric=metric)
    if longest_pause and (longest_pause[2] - longest_pause[1]).days > 1:
        gap = (longest_pause[2] - longest_pause[1]).days - 1
        add(longest_pause[1], 'pause', "Start of longest break",
            f'Followed by {gap} calendar days without a dated capture.',
            asset=day_representatives.get((longest_pause[1].isoformat(), 'assets')), day=longest_pause[1].isoformat())
        add(longest_pause[2], 'pause', "End of longest break",
            f'First capture after {gap} calendar days without a dated capture.',
            asset=day_representatives.get((longest_pause[2].isoformat(), 'assets')), day=longest_pause[2].isoformat())
    if day_streak[0] > 1:
        add(day_streak[1], 'record', "Start of longest daily streak",
            f'Captures were made on {day_streak[0]} consecutive days.',
            asset=day_representatives.get((day_streak[1].isoformat(), 'assets')), day=day_streak[1].isoformat())
        add(day_streak[2], 'record', "End of longest daily streak",
            f'Last day of a {day_streak[0]}-day capture streak.',
            asset=day_representatives.get((day_streak[2].isoformat(), 'assets')), day=day_streak[2].isoformat())
    return sorted(events, key=lambda event: (event.at, event.title, event.id))


def build_statistics(assets: list[dict[str, Any]], year: int | None = None, start: date | None = None, end: date | None = None, albums: list[dict] | None = None) -> LibraryStatsOut:
    live_ids = {a.get("livePhotoVideoId") for a in assets if a.get("type") == "IMAGE"}
    if year is not None:
        start, end = date(year, 1, 1), date(year, 12, 31)
    if start or end:
        assets = [asset for asset in assets if (taken := taken_at(asset)) and (not start or taken.date() >= start) and (not end or taken.date() <= end)]

    photos = [asset for asset in assets if asset.get("type") == "IMAGE"]
    videos = [asset for asset in assets if asset.get("type") == "VIDEO"]
    standalone_videos = [a for a in videos if a["id"] not in live_ids and not a.get("_live_companion")]
    total_bytes, photo_bytes, video_bytes = total_size(assets), total_size(photos), total_size(videos)
    dated = [(taken, asset) for asset in assets if (taken := taken_at(asset))]
    dates = [taken for taken, _ in dated]
    month_counts = Counter(taken.month for taken in dates)
    weekday_counts = Counter(taken.weekday() for taken in dates)
    hour_counts = Counter(taken.hour for taken in dates)

    device_counts: Counter[str] = Counter()
    device_metrics: dict[str, Counter[str]] = defaultdict(Counter)
    device_details: dict[str, tuple[str, str]] = {}
    device_variants: dict[str, set[str]] = defaultdict(set)
    maker_counts: Counter[str] = Counter()
    maker_metrics: dict[str, Counter[str]] = defaultdict(Counter)
    maker_categories: dict[str, str] = {}
    maker_variants: dict[str, set[str]] = defaultdict(set)
    raw_maker_metrics: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    raw_maker_groups: dict[tuple[str, str], str] = {}
    megapixels: list[float] = []
    isos: Counter[int] = Counter()
    focal_lengths: Counter[float] = Counter()
    iso_values: list[float] = []
    focal_values: list[float] = []
    durations: list[float] = []
    exposures: list[float] = []
    exposure_points: list[ExposurePoint] = []
    altitudes: list[float] = []
    direction_photo_count = 0
    aspect_counts: dict[str, Counter[str]] = defaultdict(Counter)
    frame_counts: Counter[tuple[int, int]] = Counter()
    frame_segments: dict[tuple[int, int, str], Counter[str]] = defaultdict(Counter)
    heatmap_slices: dict[tuple[str, int, str, str, str, str, str, str], Counter[str]] = defaultdict(Counter)
    people: set[str] = set()
    detected_people = 0
    photos_with_people = 0
    people_on_photos = 0
    countries: set[str] = set()
    country_counts: Counter[str] = Counter()
    geotagged = 0
    weeks: dict[tuple[int, date], Counter[str]] = defaultdict(Counter)
    weekly_assets: dict[date, list[dict[str, Any]]] = defaultdict(list)
    days: dict[str, Counter[str]] = defaultdict(Counter)
    hours_of_week: dict[tuple[int, int], Counter[str]] = defaultdict(Counter)
    by_year: dict[int, list[dict[str, Any]]] = defaultdict(list)
    photo_days: set[date] = set()
    parameter_totals: dict[tuple[str, int, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))

    for asset in assets:
        exif = asset.get("exifInfo") or {}
        faces = detected_faces(asset)
        has_people = faces > 0
        make = str(exif.get("make") or "").strip()
        model = str(exif.get("model") or "").strip()
        device = device_name(asset)
        maker = manufacturer_for(asset)
        raw_maker = raw_manufacturer(make, model)
        device_category = category_for(asset)
        taken = taken_at(asset)
        device_details[device] = maker, device_category
        device_variants[device].add(raw_maker)
        maker_categories[maker] = device_category
        maker_variants[maker].add(raw_maker)
        raw_row = raw_maker_metrics[(raw_maker, device_category)]
        raw_maker_groups[(raw_maker, device_category)] = maker
        raw_row['assets'] += 1
        raw_row['photos'] += asset.get('type') == 'IMAGE'
        raw_row['videos'] += asset.get('type') == 'VIDEO'
        raw_row['geo'] += (exif.get('latitude') is not None and exif.get('longitude') is not None)
        raw_row['people'] += has_people
        raw_row['favorites'] += bool(asset.get('isFavorite'))
        device_counts[device] += 1
        maker_counts[maker] += 1
        device_metrics[device]['assets'] += 1
        device_metrics[device]['photos'] += asset.get('type') == 'IMAGE'
        device_metrics[device]['videos'] += asset.get('type') == 'VIDEO'
        device_metrics[device]['geo'] += (exif.get('latitude') is not None and exif.get('longitude') is not None)
        device_metrics[device]['people'] += has_people
        device_metrics[device]['favorites'] += bool(asset.get('isFavorite'))
        maker_metrics[maker]['photos'] += asset.get('type') == 'IMAGE'
        maker_metrics[maker]['videos'] += asset.get('type') == 'VIDEO'
        maker_metrics[maker]['geo'] += (exif.get('latitude') is not None and exif.get('longitude') is not None)
        maker_metrics[maker]['people'] += has_people
        maker_metrics[maker]['favorites'] += bool(asset.get('isFavorite'))

        kind = 'photos' if asset.get('type') == 'IMAGE' else 'videos' if asset.get('type') == 'VIDEO' else None
        aspect = orientation_of(asset)
        aspect_counts[aspect]['assets'] += 1
        if kind:
            aspect_counts[aspect][kind] += 1
        if kind == 'photos':
            frame_width, frame_height = image_dimensions(asset)
            if frame_width is not None and frame_height is not None:
                dimensions = (round(frame_width), round(frame_height))
                frame_counts[dimensions] += 1
                segment = frame_segments[(*dimensions, device_category)]
                segment['photos'] += 1
                segment['geo'] += exif.get('latitude') is not None and exif.get('longitude') is not None
                segment['people'] += has_people
                segment['favorites'] += bool(asset.get('isFavorite'))

        if asset.get("type") == "IMAGE":
            altitude = finite_number(exif.get('altitude') if exif.get('altitude') is not None else exif.get('gpsAltitude'))
            if altitude is not None:
                altitudes.append(altitude)
            direction = finite_number(exif.get('gpsImgDirection') if exif.get('gpsImgDirection') is not None else exif.get('imageDirection'))
            direction_photo_count += direction is not None and 0 <= direction < 360
            photos_with_people += has_people
            people_on_photos += faces
            exposure = exposure_seconds(exif.get('exposureTime'))
            if exposure is not None:
                exposures.append(exposure)
            width, height = image_dimensions(asset)
            if width and height:
                megapixels.append(width * height / 1_000_000)
            iso = positive_number(exif.get("iso"))
            aperture = positive_number(exif.get("fNumber"))
            if iso is not None and exposure is not None and aperture is not None:
                exposure_points.append(ExposurePoint(
                    asset_id=asset['id'], iso=iso, shutter_seconds=exposure, f_number=aperture,
                    year=taken.year if taken else None, device=device, category=device_category,
                    geo=exif.get('latitude') is not None and exif.get('longitude') is not None,
                    people=has_people, favorite=bool(asset.get('isFavorite')),
                ))
            focal = positive_number(exif.get("focalLength"))
            if iso:
                isos[int(iso)] += 1
                iso_values.append(iso)
            if focal:
                focal_lengths[focal] += 1
                focal_values.append(focal)
        elif asset.get("type") == "VIDEO" and asset["id"] not in live_ids and not asset.get("_live_companion"):
            duration = duration_seconds(asset.get("duration"))
            if duration is not None:
                durations.append(duration)

        for person in asset.get("people") or []:
            if isinstance(person, dict) and person.get("id"):
                people.add(person["id"])
        detected_people += faces

        has_geo = exif.get("latitude") is not None and exif.get("longitude") is not None
        if has_geo:
            geotagged += 1
            if exif.get("country"):
                country = str(exif['country']).strip()
                countries.add(country)
                country_counts[country] += 1

        if taken:
            if asset.get('type') == 'IMAGE':
                segments = ['all']
                if asset.get('isFavorite'):
                    segments.append('favorites')
                if has_geo:
                    segments.append('geo')
                if has_people:
                    segments.append('people')
                if device_category == "Camera":
                    segments.append('camera')
                elif device_category == "Mobile device":
                    segments.append('mobile')
                values = {'iso': iso, 'focal': focal, 'aperture': aperture}
                for axis, bucket in (('hour', taken.hour), ('month', taken.month), ('year', taken.year)):
                    for segment in segments:
                        moments = parameter_totals[(axis, bucket, segment)]
                        for key, value in values.items():
                            if value is not None:
                                cell = moments[key]
                                cell[0] += 1
                                cell[1] += value
                                cell[2] += value * value
            heat_key = (taken.date().isoformat(), taken.hour, device, maker, raw_maker, device_category, aspect, asset.get('type') or 'OTHER')
            heat_row = heatmap_slices[heat_key]
            heat_row['assets'] += 1
            heat_row['photos'] += asset.get('type') == 'IMAGE'
            heat_row['videos'] += asset.get('type') == 'VIDEO'
            heat_row['geo'] += has_geo
            heat_row['people'] += has_people
            heat_row['favorites'] += bool(asset.get('isFavorite'))
            if asset.get('type') == 'IMAGE':
                photo_days.add(taken.date())
            hour = hours_of_week[(taken.weekday(), taken.hour)]
            hour['assets'] += 1
            hour['photos'] += asset.get('type') == 'IMAGE'
            hour['videos'] += asset.get('type') == 'VIDEO'
            hour['geo'] += has_geo
            hour['people'] += has_people
            hour['favorites'] += bool(asset.get('isFavorite'))
            day = days[taken.date().isoformat()]
            day["assets"] += 1
            day["photos"] += asset.get("type") == "IMAGE"
            day["videos"] += asset.get("type") == "VIDEO"
            day["geo"] += has_geo
            day["people"] += has_people
            day["favorites"] += bool(asset.get('isFavorite'))
            by_year[taken.year].append(asset)
            week_start = taken.date() - timedelta(days=taken.weekday())
            if asset.get('type') in ('IMAGE', 'VIDEO'):
                weekly_assets[week_start].append(asset)
            weeks[(taken.year, week_start)]["assets"] += 1
            weeks[(taken.year, week_start)]["people"] += has_people
            weeks[(taken.year, week_start)]["favorites"] += bool(asset.get('isFavorite'))
            if asset.get("type") == "IMAGE":
                weeks[(taken.year, week_start)]["photos"] += 1
            elif asset.get("type") == "VIDEO":
                weeks[(taken.year, week_start)]["videos"] += 1
            if has_geo:
                weeks[(taken.year, week_start)]["geo"] += 1

    years: list[YearPoint] = []
    cumulative_photos = cumulative_videos = cumulative_assets = cumulative_geo = cumulative_people = cumulative_favorites = 0
    if by_year:
        for value in range(min(by_year), max(by_year) + 1):
            group = by_year.get(value, [])
            year_photos = [a for a in group if a.get("type") == "IMAGE"]
            year_videos = [a for a in group if a.get("type") == "VIDEO"]
            year_geo = [a for a in group if (a.get('exifInfo') or {}).get('latitude') is not None and (a.get('exifInfo') or {}).get('longitude') is not None]
            year_people = [a for a in group if detected_faces(a)]
            year_favorites = [a for a in group if a.get('isFavorite')]
            year_resolutions = []
            for photo in year_photos:
                width, height = image_dimensions(photo)
                if width and height:
                    year_resolutions.append(width * height / 1_000_000)
            cumulative_photos += len(year_photos)
            cumulative_videos += len(year_videos)
            cumulative_assets += len(group)
            cumulative_geo += len(year_geo)
            cumulative_people += len(year_people)
            cumulative_favorites += len(year_favorites)
            years.append(YearPoint(
                year=value, photos=len(year_photos), videos=len(year_videos), assets=len(group), geo=len(year_geo), people=len(year_people), favorites=len(year_favorites),
                cumulative_photos=cumulative_photos, cumulative_videos=cumulative_videos,
                cumulative_assets=cumulative_assets, cumulative_geo=cumulative_geo, cumulative_people=cumulative_people, cumulative_favorites=cumulative_favorites,
                average_asset_bytes=average_size(group),
                average_photo_bytes=average_size(year_photos), average_video_bytes=average_size(year_videos),
                average_geo_bytes=average_size(year_geo), average_people_bytes=average_size(year_people), average_favorites_bytes=average_size(year_favorites),
                resolution_count=len(year_resolutions),
                average_megapixels=sum(year_resolutions) / len(year_resolutions) if year_resolutions else None,
                minimum_megapixels=min(year_resolutions) if year_resolutions else None,
                maximum_megapixels=max(year_resolutions) if year_resolutions else None,
            ))

    latest_photo = max(((taken_at(asset), asset) for asset in photos if taken_at(asset)), default=None, key=lambda pair: pair[0])
    first_asset = min(dated, default=None, key=lambda pair: (pair[0], pair[1]['id']))
    last_asset = max(dated, default=None, key=lambda pair: (pair[0], pair[1]['id']))
    months = []
    if year is not None:
        totals = Counter()
        for month in range(1, 13):
            group = [a for taken, a in dated if taken.month == month]
            p = [a for a in group if a.get('type') == 'IMAGE']
            v = [a for a in group if a.get('type') == 'VIDEO']
            g = [a for a in group if (a.get('exifInfo') or {}).get('latitude') is not None and (a.get('exifInfo') or {}).get('longitude') is not None]
            h = [a for a in group if detected_faces(a)]
            f = [a for a in group if a.get('isFavorite')]
            totals.update(assets=len(group), photos=len(p), videos=len(v), geo=len(g), people=len(h), favorites=len(f))
            months.append(YearPoint(year=month, label=f'{year}-{month:02}', assets=len(group), photos=len(p), videos=len(v), geo=len(g), people=len(h), favorites=len(f),
                cumulative_assets=totals['assets'], cumulative_photos=totals['photos'], cumulative_videos=totals['videos'], cumulative_geo=totals['geo'], cumulative_people=totals['people'], cumulative_favorites=totals['favorites'],
                average_asset_bytes=average_size(group), average_photo_bytes=average_size(p), average_video_bytes=average_size(v), average_geo_bytes=average_size(g), average_people_bytes=average_size(h), average_favorites_bytes=average_size(f)))
    first, last = (min(dates), max(dates)) if dates else (None, None)
    active_days = sorted({taken.date() for taken in dates})
    pauses = [(b - a, a, b) for a, b in zip(active_days, active_days[1:])]
    longest_pause = max(pauses, default=None)
    busiest_day = max(days.items(), key=lambda item: (item[1]['assets'], -date.fromisoformat(item[0]).toordinal()), default=None)
    busiest_assets = [asset for taken, asset in dated if busiest_day and taken.date().isoformat() == busiest_day[0]]
    busiest_photos = [asset for asset in busiest_assets if asset.get('type') == 'IMAGE']
    if busiest_photos:
        busiest_assets = busiest_photos
    busiest_asset = Random(busiest_day[0]).choice(sorted(busiest_assets, key=lambda asset: asset['id'])) if busiest_assets else None
    active_weeks = [day - timedelta(days=day.weekday()) for day in active_days]
    day_streak = longest_streak(active_days, 1)
    week_streak = longest_streak(active_weeks, 7)
    continents = continent_labels(countries)
    without_album = [a for a in assets if a.get('_not_in_album')]
    membership_known = all('_not_in_album' in a for a in assets)
    owned_album_ids = {album['id'] for album in albums or [] if album.get('id')}
    photo_days_year = year
    photo_days_count = len(photo_days)
    if year is not None:
        photo_days_total_days = (date(year + 1, 1, 1) - date(year, 1, 1)).days
    elif start is not None and end is not None:
        photo_days_total_days = (end - start).days + 1
    elif dates:
        photo_days_total_days = (max(dates).date() - min(dates).date()).days + 1
    else:
        photo_days_total_days = 0
    weekly_scores = []
    for week_start, group in sorted(weekly_assets.items()):
        week_photos = [asset for asset in group if asset.get('type') == 'IMAGE']
        week_videos = [asset for asset in group if asset.get('type') == 'VIDEO']
        weekly_scores.append(WeeklyScorePoint(
            week_start=week_start.isoformat(), photo_count=len(week_photos), video_count=len(week_videos),
            scores={score.key: score.value for score in calculate_scores(week_photos, week_videos)},
        ))
    annual_album_count = len({album_id for asset in assets for album_id in asset.get('_album_ids', []) if album_id in owned_album_ids})
    def parameter_moment(values):
        count, total, squares = values
        if not count:
            return {'count': 0, 'mean': None, 'std': None}
        average = total / count
        return {'count': int(count), 'mean': average, 'std': sqrt(max(0, squares / count - average * average))}

    parameter_slices = [
        ParameterSlice(axis=axis, bucket=bucket, segment=segment,
                       **{key: parameter_moment(moments[key]) for key in ('iso', 'focal', 'aperture')})
        for (axis, bucket, segment), moments in sorted(parameter_totals.items())
    ]
    favorite_photos = sum(bool(photo.get('isFavorite')) for photo in photos)
    annual_photo_profiles = [
        {'year': year_value, 'profile': calculate_photo_profile(
            {day: counts for day, counts in days.items() if day.startswith(f'{year_value}-')},
            sum(bool(photo.get('isFavorite')) for photo in by_year[year_value] if photo.get('type') == 'IMAGE'),
        )}
        for year_value in sorted(by_year)
    ]
    bits = total_bytes * 8 if total_bytes is not None else None
    # Illustrative estimate: one 0.25 mm diameter grain per bit, at 64% packing density.
    sand = bits * (pi / 6 * 0.00025 ** 3) / 0.64 if bits is not None else None
    area = len(photos) * 0.10 * 0.15
    # Explicit 10x15 cm print assumptions: 0.2 mm paper thickness, 2 g per print.

    return LibraryStatsOut(
        parameter_slices=parameter_slices,
        photo_profile=calculate_photo_profile(days, favorite_photos),
        annual_photo_profiles=annual_photo_profiles,
        timeline=build_timeline(dated, days, live_ids, longest_pause, day_streak) if year is None and start is None and end is None else [],
        favorite_count=sum(bool(a.get("isFavorite")) for a in assets),
        album_count=(len(albums) if year is None and start is None and end is None else annual_album_count)
                    if albums is not None and (not albums or all('_album_ids' in asset for asset in assets) or year is None and start is None and end is None) else None,
        unalbumed_asset_count=len(without_album) if membership_known else None,
        unalbumed_photo_count=sum(a.get('type') == 'IMAGE' for a in without_album) if membership_known else None,
        unalbumed_video_count=sum(a.get('type') == 'VIDEO' for a in without_album) if membership_known else None,
        live_photo_video_count=len(videos) - len(standalone_videos),
        days=[DayPoint(date=d, **{k: c[k] for k in ("photos", "videos", "assets", "geo", "people", "favorites")}) for d, c in sorted(days.items())],
        hours_of_week=[HourWeekPoint(weekday=weekday, hour=hour, **{k: hours_of_week[(weekday, hour)][k] for k in ("photos", "videos", "assets", "geo", "people", "favorites")}) for hour in range(24) for weekday in range(7)],
        asset_count=len(assets), photo_count=len(photos), video_count=len(videos),
        other_count=len(assets) - len(photos) - len(videos),
        total_bytes=total_bytes, photo_bytes=photo_bytes, video_bytes=video_bytes,
        average_asset_bytes=average_size(assets), average_photo_bytes=average_size(photos),
        average_video_bytes=average_size(videos), missing_size_count=sum(asset_size(asset) is None for asset in assets),
        bit_count=bits, sand_cubic_meters=sand, print_area_square_meters=area,
        print_tennis_courts=area / (23.77 * 10.97),
        print_stack_meters=len(photos) * 0.0002, print_weight_kg=len(photos) * 0.002,
        devices=[DevicePoint(name=name, count=count, manufacturer=device_details[name][0], category=device_details[name][1], manufacturer_variants=sorted(device_variants[name]), **{k: device_metrics[name][k] for k in ('photos', 'videos', 'geo', 'people', 'favorites')}) for name, count in device_counts.most_common()],
        manufacturers=[DevicePoint(name=name, count=count, manufacturer=name, category=maker_categories[name], manufacturer_variants=sorted(maker_variants[name]), **{k: maker_metrics[name][k] for k in ('photos', 'videos', 'geo', 'people', 'favorites')}) for name, count in maker_counts.most_common()],
        raw_manufacturers=[DevicePoint(name=name, count=counts['assets'], manufacturer=raw_maker_groups[(name, device_category)], category=device_category, manufacturer_variants=[name], **{k: counts[k] for k in ('photos', 'videos', 'geo', 'people', 'favorites')}) for (name, device_category), counts in sorted(raw_maker_metrics.items(), key=lambda item: -item[1]['assets'])],
        average_megapixels=sum(megapixels) / len(megapixels) if megapixels else None,
        resolution_count=len(megapixels),
        most_used_iso=isos.most_common(1)[0][0] if isos else None,
        most_used_focal_length_mm=focal_lengths.most_common(1)[0][0] if focal_lengths else None,
        video_duration_seconds=sum(durations), average_video_duration_seconds=sum(durations) / len(durations) if durations else None,
        duration_missing_count=len(standalone_videos) - len(durations),
        exposure_seconds=sum(exposures), exposure_missing_count=len(photos) - len(exposures),
        person_count=len(people), detected_people_count=detected_people, geotagged_count=geotagged, country_count=len(countries),
        top_country=country_counts.most_common(1)[0][0] if country_counts else None,
        top_country_asset_count=country_counts.most_common(1)[0][1] if country_counts else 0,
        photos_with_people_count=photos_with_people,
        people_per_photo_with_people=people_on_photos / photos_with_people if photos_with_people else None,
        people_per_photo=people_on_photos / len(photos) if photos else None,
        continent_count=len(continents),
        continents=continents,
        first_date=first, last_date=last, timespan_days=(last.date() - first.date()).days + 1 if dates else None,
        busiest_day=busiest_day[0] if busiest_day else None,
        busiest_day_count=busiest_day[1]['assets'] if busiest_day else 0,
        longest_pause_start=longest_pause[1].isoformat() if longest_pause else None,
        longest_pause_end=longest_pause[2].isoformat() if longest_pause else None,
        longest_pause_days=max(0, longest_pause[0].days - 1) if longest_pause else 0,
        longest_day_streak=day_streak[0],
        longest_day_streak_start=day_streak[1].isoformat() if day_streak[1] else None,
        longest_day_streak_end=day_streak[2].isoformat() if day_streak[2] else None,
        longest_week_streak=week_streak[0],
        longest_week_streak_start=week_streak[1].isoformat() if week_streak[1] else None,
        longest_week_streak_end=(week_streak[2] + timedelta(days=6)).isoformat() if week_streak[2] else None,
        undated_count=len(assets) - len(dated),
        by_month=[CountPoint(label=str(month), count=month_counts[month]) for month in range(1, 13)],
        by_weekday=[CountPoint(label=str(day), count=weekday_counts[day]) for day in range(7)],
        by_hour=[CountPoint(label=str(hour), count=hour_counts[hour]) for hour in range(24)],
        iso_distribution=iso_distribution(iso_values),
        focal_distribution=focal_distribution(focal_values),
        exposure_distribution=numeric_distribution(exposures, lambda value: value, lambda key: f'{key:g} s'),
        video_duration_distribution=numeric_distribution(durations, lambda value: value, lambda key: f'{key:g} s'),
        years=years,
        months=months,
        weeks=[WeekPoint(year=week_year, week_start=week.isoformat(), **{k: counts[k] for k in ("photos", "videos", "geo", "people", "assets", "favorites")}) for (week_year, week), counts in sorted(weeks.items())],
        heatmap_slices=[HeatmapSlice(date=day, hour=hour, device=device, manufacturer=maker, raw_manufacturer=raw_maker, category=device_category, orientation=aspect, media=media, **{k: counts[k] for k in ("photos", "videos", "geo", "people", "assets", "favorites")}) for (day, hour, device, maker, raw_maker, device_category, aspect, media), counts in sorted(heatmap_slices.items())],
        frame_formats=[FramePoint(width=width, height=height, count=count, segments=[FrameSegment(category=category_name, **{k: frame_segments[(width, height, category_name)][k] for k in ('photos', 'geo', 'people', 'favorites')}) for category_name in ("Camera", "Mobile device", "Other") if (width, height, category_name) in frame_segments]) for (width, height), count in frame_counts.most_common()],
        frame_format_covered_count=sum(frame_counts.values()),
        exposure_points=exposure_points,
        photo_days_year=photo_days_year,
        photo_days_count=photo_days_count,
        photo_days_total_days=photo_days_total_days,
        photo_days_percent=round(photo_days_count / photo_days_total_days * 100, 1) if photo_days_total_days else None,
        latest_photo_id=latest_photo[1]["id"] if latest_photo else None,
        first_asset_id=first_asset[1]["id"] if first_asset else None,
        last_asset_id=last_asset[1]["id"] if last_asset else None,
        busiest_day_asset_id=busiest_asset["id"] if busiest_asset else None,
        altitude_photo_count=len(altitudes),
        direction_photo_count=direction_photo_count,
        altitude_distribution=numeric_distribution(altitudes, lambda value: floor(value / 100) * 100,
                                                   lambda key: f'{key:g} bis <{key + 100:g} m',
                                                   lambda key: (key, key + 100, False)),
        portrait=OrientationCounts(**aspect_counts['portrait']),
        landscape=OrientationCounts(**aspect_counts['landscape']),
        orientation_unknown=OrientationCounts(**aspect_counts['unknown']),
        scores=calculate_scores(photos, videos),
        weekly_scores=weekly_scores,
    )
