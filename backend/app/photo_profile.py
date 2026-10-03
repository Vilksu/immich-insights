"""Reproducible photo-day, streak and pause statistics from cached daily counts.

Only days with at least one photo are input. Calendar-year views intentionally cut
streaks and pauses at the year boundary; the library view spans all years.
"""
from collections import Counter
from datetime import date
from math import ceil, sqrt


def mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def coefficient_of_variation(values: list[float]) -> float | None:
    average = mean(values)
    if average is None or average == 0:
        return None
    return sqrt(sum((value - average) ** 2 for value in values) / len(values)) / average


def pearson(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 3:
        return None
    xs, ys = [pair[0] for pair in pairs], [pair[1] for pair in pairs]
    mx, my = mean(xs), mean(ys)
    numerator = sum((x - mx) * (y - my) for x, y in pairs)
    denominator = sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return numerator / denominator if denominator else None


def calculate_photo_profile(days: dict[str, Counter], favorite_photo_count: int = 0) -> dict:
    active = sorted((date.fromisoformat(day), counts['photos']) for day, counts in days.items() if counts['photos'] > 0)
    photo_count = sum(count for _, count in active)
    if not active:
        return {
            'photo_days': 0, 'photos': 0, 'favorite_photos': favorite_photo_count,
            'photos_per_photo_day': None, 'average_streak_days': None, 'average_pause_days': None,
            'average_cycle_days': None, 'photos_per_streak_day': None, 'maximum_photos_per_streak_day': None,
            'streak_vs_normal_ratio': None, 'streak_pause_correlation': None, 'long_streak_day_percent': None,
            'streak_distribution': [], 'pause_distribution': [], 'streak_pause_buckets': [],
            'indices': {key: None for key in ('focus', 'volatility', 'habit', 'regularity', 'momentum', 'burnout', 'stability')},
        }
    runs: list[list[tuple[date, int]]] = []
    for item in active:
        if not runs or (item[0] - runs[-1][-1][0]).days != 1:
            runs.append([])
        runs[-1].append(item)
    streaks = [run for run in runs if len(run) >= 2]
    streak_days = [count for run in streaks for _, count in run]
    long_streak_days = sum(len(run) for run in runs if len(run) >= 3)
    pauses = [(runs[index + 1][0][0] - run[-1][0]).days - 1 for index, run in enumerate(runs[:-1])]
    gaps = [(active[index + 1][0] - item[0]).days for index, item in enumerate(active[:-1])]
    cycles = [len(run) + pauses[index] for index, run in enumerate(runs[:-1])]
    completed = [(sum(count for _, count in run) / len(run), pauses[index]) for index, run in enumerate(runs[:-1]) if len(run) >= 2]
    first = [run[0][1] for run in streaks]
    rest = [count for run in streaks for _, count in run[1:]]
    first_mean, rest_mean = mean(first), mean(rest)
    long_pauses = [pauses[index] for index, run in enumerate(runs[:-1]) if len(run) >= 3]
    pause_mean = mean(pauses)
    streak_mean = mean([len(run) for run in streaks])
    ordered = sorted((count for _, count in active), reverse=True)
    focus = sum(ordered[:ceil(len(ordered) * .1)]) / photo_count * 100
    count_cv = coefficient_of_variation([count for _, count in active])
    gap_cv = coefficient_of_variation(gaps) if len(gaps) >= 2 else None
    long_pause_mean = mean(long_pauses)
    indices = {
        'focus': focus,
        'volatility': 100 * count_cv / (1 + count_cv) if count_cv is not None else None,
        'habit': long_streak_days / len(active) * 100,
        'regularity': 100 / (1 + gap_cv) if gap_cv is not None else None,
        'momentum': 100 * first_mean / (first_mean + rest_mean) if first_mean is not None and rest_mean is not None else None,
        'burnout': 100 * long_pause_mean / (long_pause_mean + pause_mean) if long_pause_mean is not None and pause_mean is not None and long_pause_mean + pause_mean else None,
        'stability': 100 * streak_mean / (streak_mean + pause_mean) if streak_mean is not None and pause_mean is not None else None,
    }
    streak_histogram = Counter(len(run) for run in streaks)
    pause_histogram = Counter(pauses)
    intensity_bands = ((0, 2, '<2'), (2, 5, '2–<5'), (5, 10, '5–<10'),
                       (10, 25, '10–<25'), (25, 50, '25–<50'), (50, float('inf'), '50+'))
    streak_pause_buckets = []
    for lower, upper, label in intensity_bands:
        band_pauses = [pause for intensity, pause in completed if lower <= intensity < upper]
        if band_pauses:
            streak_pause_buckets.append({
                'label': label, 'count': len(band_pauses),
                'average_pause_days': mean(band_pauses),
            })
    normal = photo_count / len(active)
    streak_rate = mean(streak_days)
    return {
        'photo_days': len(active), 'photos': photo_count, 'favorite_photos': favorite_photo_count,
        'photos_per_photo_day': normal, 'average_streak_days': streak_mean, 'average_pause_days': pause_mean,
        'average_cycle_days': mean(cycles), 'photos_per_streak_day': streak_rate,
        'maximum_photos_per_streak_day': max(streak_days) if streak_days else None,
        'streak_vs_normal_ratio': streak_rate / normal if streak_rate is not None else None,
        'streak_pause_correlation': pearson(completed), 'long_streak_day_percent': indices['habit'],
        'streak_distribution': [{'label': str(length), 'count': count} for length, count in sorted(streak_histogram.items())],
        'pause_distribution': [{'label': str(length), 'count': count} for length, count in sorted(pause_histogram.items())],
        'streak_pause_buckets': streak_pause_buckets,
        'indices': indices,
    }
