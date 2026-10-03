import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session


TEMP = tempfile.TemporaryDirectory()
os.environ["DATABASE_URL"] = f"sqlite:///{Path(TEMP.name, 'test.db').as_posix()}"
os.environ["APP_SECRET_FILE"] = str(Path(TEMP.name, "fernet.key"))

from app import main as api  # noqa: E402
from app.statistics import build_statistics, build_timeline, calculate_scores  # noqa: E402
from app.photo_profile import calculate_photo_profile  # noqa: E402
from app.camera import apply_device_rules, category, device_rule_key, manufacturer  # noqa: E402
from app.immich import ImmichClient, asset_size  # noqa: E402
from app.cache import synchronize, claim, read_annual_scores, read_summary, replace_focal_observations, update_focal_observations  # noqa: E402
from app.database import Base, SessionLocal  # noqa: E402
from app.models import CachedAsset, CachedSummary, FocalObservation  # noqa: E402
from app.asset_query import matches, query_assets  # noqa: E402
from app.schemas import AssetQueryInput  # noqa: E402
from app.schemas import CACHE_VERSION  # noqa: E402
from app.report import create_report  # noqa: E402
from app.config import Settings  # noqa: E402


def asset(asset_id, owner, kind, taken, size, **exif):
    return {
        "id": asset_id, "ownerId": owner, "type": kind, "localDateTime": taken,
        "exifInfo": {"fileSizeInByte": size, **exif}, "duration": "01:02:03.5" if kind == "VIDEO" else None,
        "people": [{"id": "person-1"}] if asset_id == "a" else [],
    }


class StatisticsTests(unittest.TestCase):
    def test_legacy_snapshot_labels_are_normalized_without_mutation(self):
        from app.legacy_labels import normalize_summary
        stored = {'devices': [{'name': 'Unbekanntes Gerät', 'category': 'Kamera', 'manufacturer': 'Unbekannt'}],
                  'frame_formats': [{'segments': [{'category': 'Mobilgerät'}]}],
                  'continents': ['Europa', 'Nordamerika'], 'top_country': 'Germany'}
        normalized = normalize_summary(stored)
        self.assertEqual(normalized['devices'][0], {'name': 'Unknown device', 'category': 'Camera', 'manufacturer': 'Unknown manufacturer'})
        self.assertEqual(normalized['frame_formats'][0]['segments'][0]['category'], 'Mobile device')
        self.assertEqual(normalized['continents'], ['Europe', 'North America'])
        self.assertEqual(stored['devices'][0]['category'], 'Kamera')
        self.assertEqual(normalized['top_country'], 'Germany')

    def test_legacy_device_rule_category_still_matches(self):
        from app.camera import category_for, device_name
        photo = asset('legacy', 'alice', 'IMAGE', '2024-01-01T12:00:00', 100, make='Canon', model='R6')
        photo['_device_category'] = 'Mobilgerät'
        self.assertEqual(category_for(photo), 'Mobile device')
        self.assertTrue(matches(photo, AssetQueryInput(kind='device', name='Canon R6', category='Mobile device')))
        self.assertEqual(manufacturer('', ''), 'Unknown manufacturer')
        self.assertEqual(device_name({'exifInfo': {}}), 'Unknown device')

    def test_backend_source_messages_are_english(self):
        from app.asset_query import describe
        from app.immich import OPERATIONS, ImmichPermissionError
        from fastapi import HTTPException
        query = AssetQueryInput(kind='week_hour', weekday=0, hour=12, metric='photos')
        self.assertIn('Monday between 12:00 and 12:59', describe(query))
        self.assertEqual(api.immich_error(ImmichPermissionError('Immich denied asset.read (search).')).detail,
                         'Immich denied asset.read (search).')
        self.assertEqual(OPERATIONS['albums'].purpose, 'Count owned albums')
        with self.assertRaises(HTTPException) as error:
            api.current_auth(Mock(cookies={}), Mock())
        self.assertEqual(error.exception.detail, 'Please sign in.')

    def test_postgres_url_preserves_special_characters_in_password(self):
        settings = Settings(
            database_url=None, database_host="db", postgres_db="insights",
            postgres_user="reader", postgres_password="p@ss:word/??",
        )
        url = settings.sqlalchemy_database_url()
        self.assertEqual(url.password, "p@ss:word/??")
        self.assertIn("p%40ss%3Aword%2F%3F%3F", url.render_as_string(hide_password=False))

    def test_postgres_url_requires_password(self):
        settings = Settings(database_url=None, database_host="db", postgres_password=None)
        with self.assertRaisesRegex(ValueError, "POSTGRES_PASSWORD"):
            settings.sqlalchemy_database_url()

    def test_single_country_in_date_range_has_one_continent(self):
        photo = asset('in-range', 'alice', 'IMAGE', '2024-06-01T12:00:00', 100,
                      country='Germany', latitude=50, longitude=8)
        result = build_statistics([photo], start=date(2024, 6, 1), end=date(2024, 6, 30))
        self.assertEqual(result.continent_count, 1)
        self.assertEqual(result.continents, ["Europe"])

    def test_legacy_single_country_summary_is_repaired_without_sync(self):
        stored = Mock(payload={'cache_version': CACHE_VERSION, 'country_count': 1,
                               'top_country': 'Germany', 'continent_count': 6,
                               'continents': list('Europe')})
        db = Mock()
        db.get.return_value = stored
        result = read_summary(db, 1, year=2024)
        self.assertEqual(result['continent_count'], 1)
        self.assertEqual(result['continents'], ["Europe"])

    def test_all_image_formats_survive_limit_and_upgrade_from_local_cache(self):
        photos = [asset(str(index), 'alice', 'IMAGE', '2025-01-01T12:00:00', 1,
                        exifImageWidth=3000 + index, exifImageHeight=2000)
                  for index in range(43)]
        current = build_statistics(photos, year=2025)
        self.assertEqual(len(current.frame_formats), 43)
        self.assertEqual(current.frame_format_covered_count, 43)

        engine = create_engine('sqlite://')
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            db.add(CachedSummary(user_id=17, scope='all', payload={'cache_version': CACHE_VERSION}))
            db.add(CachedSummary(user_id=17, scope='year:2025', payload={
                'cache_version': CACHE_VERSION, 'resolution_count': 43,
                'frame_format_covered_count': 40, 'frame_formats': [],
            }))
            db.add_all(CachedAsset(user_id=17, asset_id=photo['id'], taken_date=date(2025, 1, 1), payload=photo)
                       for photo in photos)
            db.commit()
            result = read_summary(db, 17, year=2025)
            self.assertEqual(len(result['frame_formats']), 43)
            self.assertEqual(result['frame_format_covered_count'], 43)
            self.assertEqual(db.get(CachedSummary, (17, 'year:2025')).payload['frame_format_covered_count'], 43)

    def test_photo_profile_streaks_pauses_and_indices(self):
        days = {
            '2024-01-01': {'photos': 2}, '2024-01-02': {'photos': 4},
            '2024-01-03': {'photos': 6}, '2024-01-06': {'photos': 1},
            '2024-01-10': {'photos': 3}, '2024-01-11': {'photos': 3},
        }
        result = calculate_photo_profile(days, favorite_photo_count=2)
        self.assertEqual(result['photo_days'], 6)
        self.assertEqual(result['photos'], 19)
        self.assertEqual(result['average_streak_days'], 2.5)
        self.assertEqual(result['average_pause_days'], 2.5)
        self.assertEqual(result['average_cycle_days'], 4.5)
        self.assertAlmostEqual(result['photos_per_streak_day'], 18 / 5)
        self.assertEqual(result['maximum_photos_per_streak_day'], 6)
        self.assertEqual(result['long_streak_day_percent'], 50)
        self.assertEqual(result['indices']['stability'], 50)
        self.assertEqual(result['streak_distribution'], [{'label': '2', 'count': 1}, {'label': '3', 'count': 1}])
        self.assertEqual(result['pause_distribution'], [{'label': '2', 'count': 1}, {'label': '3', 'count': 1}])
        self.assertEqual(result['streak_pause_buckets'], [{'label': '2–<5', 'count': 1, 'average_pause_days': 2}])
        self.assertIsNone(result['streak_pause_correlation'])
        self.assertIsNone(calculate_photo_profile({})['indices']['focus'])

    def test_parameter_slices_keep_missing_fields_out_and_filters_exact(self):
        first = asset('one', 'alice', 'IMAGE', '2024-01-01T08:00:00', 1,
                      iso=100, focalLength=50, fNumber=2, make='Canon', model='EOS R6')
        first['isFavorite'] = True
        second = asset('two', 'alice', 'IMAGE', '2024-01-02T08:00:00', 1,
                       iso=400, fNumber=4, latitude=50, longitude=8)
        third = asset('three', 'alice', 'VIDEO', '2024-01-02T08:00:00', 1, iso=6400)
        result = build_statistics([first, second, third])
        rows = {(item.axis, item.bucket, item.segment): item for item in result.parameter_slices}
        hours = rows['hour', 8, 'all']
        self.assertEqual(hours.iso.count, 2)
        self.assertEqual(hours.iso.mean, 250)
        self.assertEqual(hours.iso.std, 150)
        self.assertEqual(hours.focal.count, 1)
        self.assertEqual(hours.aperture.mean, 3)
        self.assertEqual(rows['hour', 8, 'favorites'].iso.count, 1)
        self.assertEqual(rows['hour', 8, 'geo'].iso.count, 1)
        self.assertEqual(rows['year', 2024, 'all'].iso.mean, 250)
        self.assertEqual(result.photo_profile.photos, 2)
        self.assertEqual(result.annual_photo_profiles[0].profile.photo_days, 2)
        self.assertTrue(matches(first, AssetQueryInput(kind='hour', hour=8, metric='photos', field='iso', favorite_only=True)))
        self.assertFalse(matches(second, AssetQueryInput(kind='hour', hour=8, metric='photos', field='iso', favorite_only=True)))
        self.assertTrue(matches(second, AssetQueryInput(kind='month', month=1, metric='photos', field='aperture', geo_only=True)))
        self.assertFalse(matches(third, AssetQueryInput(kind='year', year=2024, metric='photos', field='iso')))

    def test_photo_profile_year_boundary_does_not_join_streaks(self):
        photos = [
            asset('dec', 'alice', 'IMAGE', '2023-12-31T12:00:00', 1),
            asset('jan', 'alice', 'IMAGE', '2024-01-01T12:00:00', 1),
        ]
        whole = build_statistics(photos)
        self.assertEqual(whole.photo_profile.average_streak_days, 2)
        self.assertIsNone(whole.annual_photo_profiles[0].profile.average_streak_days)
        self.assertIsNone(whole.annual_photo_profiles[1].profile.average_streak_days)
    def test_timeline_records_and_drilldown_targets(self):
        first = asset('first', 'alice', 'IMAGE', '2020-01-01T10:00:00', 1,
                      make='Canon', model='EOS R6', latitude=50, longitude=8)
        second = asset('second', 'alice', 'IMAGE', '2020-01-02T10:00:00', 1,
                       make='Canon', model='EOS R6')
        second['exifInfo']['fileSizeInByte'] = 2_000_000
        short = asset('short', 'alice', 'VIDEO', '2020-01-02T11:00:00', 1)
        short['duration'] = 1000
        long = asset('long', 'alice', 'VIDEO', '2020-01-10T11:00:00', 1)
        long['duration'] = 10000
        long['exifInfo']['fileSizeInByte'] = 4_000_000
        companion = asset('companion', 'alice', 'VIDEO', '2020-01-15T11:00:00', 1)
        companion['duration'], companion['_live_companion'] = 999999, True
        companion['exifInfo']['fileSizeInByte'] = 10_000_000
        result = build_statistics([first, second, short, long, companion])
        by_title = {event.title: event for event in result.timeline}
        self.assertEqual(by_title["First geotagged photo"].asset_id, 'first')
        self.assertEqual(by_title['First photo with Canon EOS R6'].asset_id, 'first')
        self.assertEqual(by_title['Last photo with Canon EOS R6'].asset_id, 'second')
        self.assertEqual(by_title["Shortest video"].asset_id, 'short')
        self.assertEqual(by_title["Longest video"].asset_id, 'long')
        self.assertEqual(by_title["Largest photo by file size"].asset_id, 'second')
        self.assertEqual(by_title["Largest video by file size"].asset_id, 'long')
        self.assertNotEqual(by_title["Largest video by file size"].asset_id, 'companion')
        self.assertEqual(by_title["Busiest day"].day, '2020-01-02')
        self.assertEqual(by_title["Busiest day"].metric, 'assets')
        self.assertEqual(by_title["Start of longest break"].day, '2020-01-02')
        self.assertEqual(by_title["End of longest break"].day, '2020-01-10')
        self.assertEqual(build_statistics([first, second], year=2020).timeline, [])
        self.assertTrue(matches(first, AssetQueryInput(kind='asset', asset_id='first')))
        self.assertFalse(matches(second, AssetQueryInput(kind='asset', asset_id='first')))

    def test_timeline_chronological_face_and_location_milestones(self):
        beginning = datetime(2000, 1, 1)
        dated = []
        for index in range(10000):
            photo = asset(str(index), 'alice', 'IMAGE', (beginning + timedelta(minutes=index)).isoformat(), 1,
                          latitude=50, longitude=8)
            photo['people'] = [{'id': 'person-1'}]
            dated.append((beginning + timedelta(minutes=index), photo))
        events = build_timeline(dated, {}, set(), None, (0, None, None))
        milestones = {event.title: event for event in events if event.category == 'milestone'}
        for label in ('10000th asset', '10000th photo', '10000th geotagged photo', '10000th detected face'):
            self.assertEqual(milestones[label].asset_id, '9999')

    def test_timeline_exif_extremes_skip_ties(self):
        photos = [
            asset('one', 'alice', 'IMAGE', '2020-01-01T10:00:00', 1, iso=100, exposureTime='1/1000', fNumber=1.8),
            asset('two', 'alice', 'IMAGE', '2020-01-02T10:00:00', 1, iso=400, exposureTime='1/60', fNumber=8),
            asset('three', 'alice', 'IMAGE', '2020-01-03T10:00:00', 1, iso=400, exposureTime='1/30', fNumber=16),
        ]
        by_title = {event.title: event for event in build_statistics(photos).timeline}
        self.assertEqual(by_title["Lowest ISO"].asset_id, 'one')
        self.assertNotIn("Highest ISO", by_title)
        self.assertEqual(by_title["Shortest shutter time"].asset_id, 'one')
        self.assertEqual(by_title["Longest shutter time"].asset_id, 'three')
        self.assertEqual(by_title["Widest aperture"].asset_id, 'one')
        self.assertEqual(by_title["Smallest aperture opening"].asset_id, 'three')

    def test_annual_scores_project_cached_years_without_loading_assets(self):
        engine = create_engine('sqlite://')
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            db.add_all([
                CachedSummary(user_id=17, scope='all', payload={'cache_version': CACHE_VERSION, 'marker': 'overview'}),
                CachedSummary(user_id=17, scope='year:2024', payload={
                    'scores': [{'key': 'time', 'value': 25}, {'key': 'media', 'value': 0}],
                    'photo_count': 8, 'video_count': 0, 'large_unused_field': ['x'] * 1000,
                }),
                CachedSummary(user_id=17, scope='year:2025', payload={
                    'scores': [{'key': 'time', 'value': 75}, {'key': 'media', 'value': 50}],
                    'photo_count': 3, 'video_count': 3,
                }),
                CachedSummary(user_id=18, scope='year:2025', payload={
                    'scores': [{'key': 'time', 'value': 0}], 'photo_count': 1, 'video_count': 0,
                }),
            ])
            db.commit()
            rows = read_annual_scores(db, 17)
            overview = read_summary(db, 17)
        self.assertEqual([row['year'] for row in rows], [2024, 2025])
        self.assertEqual(rows[1]['scores'], {'time': 75, 'media': 50})
        self.assertEqual((rows[0]['photo_count'], rows[0]['video_count']), (8, 0))
        self.assertEqual(overview['marker'], 'overview')
        self.assertEqual(overview['annual_scores'], rows)

    def test_scores_use_only_evaluable_photos_and_documented_boundaries(self):
        daytime = asset('day', 'alice', 'IMAGE', '2025-01-01T09:00:00', 1,
                        make='Canon', model='EOS R6', iso=100, exifImageWidth=4000, exifImageHeight=3000)
        twilight = asset('dusk', 'alice', 'IMAGE', '2025-01-01T19:00:00', 1,
                         make='Apple', model='iPhone 15', iso=1200, exifImageWidth=3000, exifImageHeight=4000)
        night = asset('night', 'alice', 'IMAGE', '2025-01-01T23:00:00', 1,
                      make='Apple', model='iPhone 15', iso=3200, exifImageWidth=3000, exifImageHeight=3000)
        scores = {score.key: score for score in calculate_scores([daytime, twilight, night])}
        self.assertEqual(scores['time'].value, 50)
        self.assertEqual(scores['iso'].value, 50)
        self.assertAlmostEqual(scores['orientation'].value, 50, places=1)
        self.assertEqual(scores['device'].value, 66.7)
        self.assertEqual(scores['frequency'].value, 0)
        self.assertEqual(scores['frequency'].eligible_count, 2)

    def test_scores_are_calculated_from_selected_year_only(self):
        old = asset('old', 'alice', 'IMAGE', '2024-12-31T23:00:00', 1,
                    make='Apple', model='iPhone 15', iso=3200)
        current = asset('current', 'alice', 'IMAGE', '2025-01-01T09:00:00', 1,
                        make='Canon', model='EOS R6', iso=100)
        overall = {score.key: score for score in build_statistics([old, current]).scores}
        annual = {score.key: score for score in build_statistics([old, current], year=2025).scores}
        self.assertEqual(overall['time'].value, 50)
        self.assertEqual(annual['time'].value, 0)
        self.assertEqual(annual['iso'].value, 0)
        self.assertEqual(annual['device'].value, 0)

    def test_media_score_and_photo_days_use_selected_year(self):
        photo_a = asset('photo-a', 'alice', 'IMAGE', '2024-02-29T09:00:00', 1)
        photo_b = asset('photo-b', 'alice', 'IMAGE', '2024-02-29T10:00:00', 1)
        video = asset('video', 'alice', 'VIDEO', '2024-03-01T10:00:00', 1)
        following = asset('following', 'alice', 'IMAGE', '2025-01-01T10:00:00', 1)
        result = build_statistics([photo_a, photo_b, video, following], year=2024)
        media = next(score for score in result.scores if score.key == 'media')
        self.assertEqual(media.value, 33.3)
        self.assertEqual((media.eligible_count, media.population_count), (3, 3))
        self.assertEqual((result.photo_days_year, result.photo_days_count), (2024, 1))
        self.assertEqual(result.photo_days_total_days, 366)
        self.assertEqual(result.photo_days_percent, 0.3)

    def test_library_photo_days_and_weekly_scores_cover_all_years(self):
        first = asset('first', 'alice', 'IMAGE', '2024-12-30T09:00:00', 1)
        second = asset('second', 'alice', 'IMAGE', '2024-12-31T23:00:00', 1)
        third = asset('third', 'alice', 'IMAGE', '2025-01-06T10:00:00', 1)
        video = asset('video', 'alice', 'VIDEO', '2025-01-06T11:00:00', 1)
        result = build_statistics([first, second, third, video])
        self.assertEqual((result.photo_days_year, result.photo_days_count, result.photo_days_total_days), (None, 3, 8))
        self.assertEqual(result.photo_days_percent, 37.5)
        self.assertEqual([week.week_start for week in result.weekly_scores], ['2024-12-30', '2025-01-06'])
        self.assertEqual(result.weekly_scores[0].scores['time'], 50)
        self.assertEqual(result.weekly_scores[1].scores['media'], 50)
        self.assertEqual((result.weekly_scores[1].photo_count, result.weekly_scores[1].video_count), (1, 1))
        selected = build_statistics([first, second, third, video], start=date(2024, 12, 31), end=date(2025, 1, 6))
        self.assertEqual((selected.photo_days_count, selected.photo_days_total_days), (2, 7))

    def test_camera_weeks_frames_and_exact_distributions_match_drilldown(self):
        first = asset('first', 'alice', 'IMAGE', '2025-01-01T10:00:00', 1,
                      make='Canon', model='EOS R6', exifImageWidth=4000, exifImageHeight=3000,
                      iso=100, exposureTime='1/125')
        second = asset('second', 'alice', 'IMAGE', '2025-01-02T10:00:00', 1,
                       make='Canon', model='EOS R6', exifImageWidth=4000, exifImageHeight=3000,
                       iso=100, exposureTime='1/125')
        third = asset('third', 'alice', 'IMAGE', '2025-01-02T11:00:00', 1,
                      make='Apple', model='iPhone 15', exifImageWidth=3000, exifImageHeight=4000,
                      iso=800, exposureTime='1/60')
        result = build_statistics([first, second, third], year=2025)
        self.assertEqual(result.exposure_distribution.mode, 1 / 125)
        self.assertEqual(result.exposure_distribution.mode_count, 2)
        self.assertEqual(sum(point.count for point in result.exposure_distribution.points), 3)
        self.assertEqual(result.frame_formats[0].count, 2)
        dimensions = AssetQueryInput(kind='dimensions', frame_width=4000, frame_height=3000, metric='photos')
        self.assertEqual(sum(matches(item, dimensions) for item in [first, second, third]), 2)
        self.assertEqual({row.device for row in result.heatmap_slices}, {'Canon EOS R6', 'Apple iPhone 15'})
        camera_filter = AssetQueryInput(kind='week', name='Canon EOS R6', source='device', start='2024-12-30', end='2025-01-05', metric='photos')
        self.assertEqual(sum(matches(item, camera_filter) for item in [first, second, third]), 2)
        self.assertEqual(sum(row.assets for row in result.heatmap_slices), 3)
        self.assertEqual(result.frame_formats[0].segments[0].photos, 2)

    def test_heatmap_source_dominance_and_frame_filters(self):
        camera = asset('camera', 'alice', 'IMAGE', '2025-07-01T12:00:00', 1,
                       make='NIKON CORPORATION', model='D850', exifImageWidth=4000, exifImageHeight=3000)
        camera['isFavorite'] = True
        phone = asset('phone', 'alice', 'IMAGE', '2025-07-01T12:30:00', 1,
                      make='Apple', model='iPhone 15', exifImageWidth=3000, exifImageHeight=4000)
        values = [camera, phone]
        summary = build_statistics(values, year=2025)
        self.assertEqual({row.category for row in summary.heatmap_slices}, {"Camera", "Mobile device"})
        by_maker = AssetQueryInput(kind='date', date='2025-07-01', source='manufacturer', name='Nikon')
        self.assertEqual(sum(matches(item, by_maker) for item in values), 1)
        raw_maker = AssetQueryInput(kind='date', date='2025-07-01', source='manufacturer', raw=True, name='NIKON CORPORATION')
        self.assertEqual(sum(matches(item, raw_maker) for item in values), 1)
        by_phone = AssetQueryInput(kind='week_hour', weekday=1, hour=12, category="Mobile device")
        self.assertEqual(sum(matches(item, by_phone) for item in values), 1)
        by_portrait = AssetQueryInput(kind='date', date='2025-07-01', orientation='portrait')
        self.assertEqual(sum(matches(item, by_portrait) for item in values), 1)
        by_frame = AssetQueryInput(kind='dimensions', frame_width=4000, frame_height=3000,
                                   category="Camera", metric='favorites')
        self.assertEqual(sum(matches(item, by_frame) for item in values), 1)
        self.assertEqual(sum(segment.favorites for segment in summary.frame_formats[0].segments), 1)

    def test_exposure_triangle_uses_only_complete_photo_triplets(self):
        complete = asset('complete', 'alice', 'IMAGE', '2025-06-01T12:00:00', 1,
                         make='Canon', model='EOS R6', iso=400, exposureTime='1/125', fNumber=2.8,
                         latitude=50, longitude=8)
        complete['isFavorite'] = True
        missing_aperture = asset('missing', 'alice', 'IMAGE', '2025-06-01T13:00:00', 1,
                                 iso=400, exposureTime='1/125')
        invalid_aperture = asset('invalid', 'alice', 'IMAGE', '2025-06-01T14:00:00', 1,
                                 iso=400, exposureTime='1/125', fNumber=0)
        video = asset('video-triplet', 'alice', 'VIDEO', '2025-06-01T15:00:00', 1,
                      iso=400, exposureTime='1/125', fNumber=2.8)
        result = build_statistics([complete, missing_aperture, invalid_aperture, video], year=2025)
        self.assertEqual(len(result.exposure_points), 1)
        point = result.exposure_points[0]
        self.assertEqual((point.iso, point.shutter_seconds, point.f_number), (400, 1 / 125, 2.8))
        self.assertEqual((point.year, point.category, point.geo, point.favorite), (2025, "Camera", True, True))

    def test_favorites_and_orientation_filters_match_statistics(self):
        portrait = asset('portrait', 'alice', 'IMAGE', '2025-01-01T10:00:00', 1,
                         exifImageWidth=2000, exifImageHeight=3000)
        portrait['isFavorite'] = True
        landscape = asset('landscape', 'alice', 'IMAGE', '2025-01-01T11:00:00', 1,
                          exifImageWidth=3000, exifImageHeight=2000)
        square = asset('square', 'alice', 'IMAGE', '2025-01-01T12:00:00', 1,
                       exifImageWidth=2000, exifImageHeight=2000)
        result = build_statistics([portrait, landscape, square], year=2025)
        self.assertEqual(result.favorite_count, 1)
        self.assertEqual(result.days[0].favorites, 1)
        self.assertEqual(result.months[0].favorites, 1)
        self.assertEqual(result.scores[3].value, 50)
        self.assertTrue(matches(portrait, AssetQueryInput(kind='orientation', orientation='portrait', metric='photos')))
        self.assertFalse(matches(landscape, AssetQueryInput(kind='orientation', orientation='portrait', metric='photos')))
        self.assertTrue(matches(square, AssetQueryInput(kind='orientation', orientation='unknown', metric='photos')))
        self.assertTrue(matches(portrait, AssetQueryInput(kind='date', date='2025-01-01', metric='favorites')))
        self.assertFalse(matches(landscape, AssetQueryInput(kind='date', date='2025-01-01', metric='favorites')))

    def test_reports_are_private_snapshot_summaries(self):
        summary = {'asset_count': 2, 'photo_count': 1, 'video_count': 1,
                   'api_key': 'SECRET_SHOULD_NOT_APPEAR'}
        self.assertTrue(create_report(summary, 'pdf').startswith(b'%PDF-'))
        self.assertTrue(create_report(summary, 'jpg').startswith(b'\xff\xd8'))
        csv_data = create_report(summary, 'csv')
        self.assertIn('Total assets,2', csv_data.decode('utf-8'))
        self.assertNotIn(b'SECRET_SHOULD_NOT_APPEAR', csv_data)

    def test_duration_milliseconds_live_photos_and_daily_counts(self):
        photo = asset('photo', 'alice', 'IMAGE', '2024-02-29T12:00:00', 10)
        photo.update(livePhotoVideoId='companion', isFavorite=True, _not_in_album=True)
        movie = asset('movie', 'alice', 'VIDEO', '2024-03-01T00:00:00', 20)
        movie['duration'] = 60000
        companion = asset('companion', 'alice', 'VIDEO', '2024-02-29T12:00:00', 5)
        companion['duration'] = 3000
        movie['_not_in_album'] = False
        companion['_not_in_album'] = False
        result = build_statistics([photo, movie, companion], albums=[])
        self.assertEqual(result.video_duration_seconds, 60)
        self.assertEqual(result.live_photo_video_count, 1)
        self.assertEqual(result.favorite_count, 1)
        self.assertEqual(result.unalbumed_photo_count, 1)
        self.assertEqual(result.unalbumed_asset_count, 1)
        self.assertEqual(result.unalbumed_video_count, 0)
        self.assertEqual(result.days[0].date, '2024-02-29')
        self.assertEqual(result.days[0].assets, 2)

    def setUp(self):
        self.assets = [
            asset("a", "alice", "IMAGE", "2020-12-31T11:00:00", 1_000_000_000, make="Canon", model="Canon R6", iso=100, focalLength=50, exifImageWidth=6000, exifImageHeight=4000, latitude=0, longitude=0, country="Germany"),
            asset("b", "alice", "IMAGE", "2021-01-01T12:00:00", 2_000_000_000, make="Canon", model="Canon R6", iso=100, focalLength=50),
            asset("c", "alice", "VIDEO", "2021-02-01T13:00:00", 3_000_000_000, latitude=10, longitude=10, country="France"),
        ]

    def test_totals_and_time_distribution(self):
        result = build_statistics(self.assets)
        self.assertEqual(result.asset_count, 3)
        self.assertEqual(result.photo_bytes, 3_000_000_000)
        self.assertEqual(result.video_bytes, 3_000_000_000)
        self.assertEqual(result.total_bytes, 6_000_000_000)
        self.assertEqual(result.bit_count, 48_000_000_000)
        self.assertGreater(result.sand_cubic_meters, 0)
        self.assertAlmostEqual(result.print_area_square_meters, 0.03)
        self.assertEqual(result.person_count, 1)
        self.assertEqual(result.detected_people_count, 1)
        self.assertEqual(result.geotagged_count, 2)
        self.assertEqual(result.country_count, 2)
        self.assertEqual(result.top_country, 'Germany')
        self.assertEqual(result.continent_count, 1)
        self.assertEqual(result.continents, ["Europe"])
        self.assertEqual(result.most_used_iso, 100)
        self.assertEqual(result.average_megapixels, 24)
        self.assertEqual(result.video_duration_seconds, 3723.5)
        self.assertEqual(result.years[0].cumulative_assets, 1)
        self.assertEqual(result.years[1].cumulative_assets, 3)
        self.assertEqual(result.weeks[0].week_start, result.weeks[1].week_start)
        self.assertNotEqual(result.weeks[0].year, result.weeks[1].year)

    def test_annual_resolution_uses_only_photos_and_known_dimensions(self):
        first = asset('wide', 'alice', 'IMAGE', '2024-02-01T12:00:00', 10)
        first['width'], first['height'] = 4000, 3000
        second = asset('small', 'alice', 'IMAGE', '2024-03-01T12:00:00', 10,
                       exifImageWidth=2000, exifImageHeight=1000)
        video = asset('video', 'alice', 'VIDEO', '2024-03-02T12:00:00', 10)
        video['width'], video['height'] = 8000, 8000
        missing = asset('missing', 'alice', 'IMAGE', '2025-01-01T12:00:00', 10)
        result = build_statistics([first, second, video, missing])
        self.assertEqual(result.resolution_count, 2)
        self.assertEqual(result.years[0].resolution_count, 2)
        self.assertAlmostEqual(result.years[0].average_megapixels, 7)
        self.assertAlmostEqual(result.years[0].minimum_megapixels, 2)
        self.assertAlmostEqual(result.years[0].maximum_megapixels, 12)
        self.assertEqual(result.years[1].resolution_count, 0)
        self.assertIsNone(result.years[1].average_megapixels)

    def test_period_and_missing_size(self):
        result = build_statistics(self.assets, start=date(2021, 1, 1), end=date(2021, 1, 1))
        self.assertEqual((result.asset_count, result.photo_count, result.video_count), (1, 1, 0))
        missing = build_statistics([asset("x", "alice", "IMAGE", "2021-01-01T12:00:00", None)])
        self.assertIsNone(missing.total_bytes)
        self.assertIsNone(missing.average_photo_bytes)
        self.assertEqual(missing.missing_size_count, 1)
        self.assertEqual(asset_size({"fileSizeInByte": 0, "exifInfo": {"fileSizeInByte": 42}}), 42)

    def test_year_uses_only_year_assets_for_prints_albums_and_hours(self):
        first, second = self.assets[:2]
        first['_not_in_album'], second['_not_in_album'] = False, True
        first['_album_ids'], second['_album_ids'] = ['album-1'], []
        albums = [{'id': 'album-1', 'asset_ids': ['a']}, {'id': 'album-2', 'asset_ids': []}]
        all_years = build_statistics([first, second], albums=albums)
        year = build_statistics([first, second], year=2021, albums=albums)
        self.assertEqual(all_years.album_count, 2)
        self.assertEqual(year.album_count, 0)
        self.assertEqual(year.unalbumed_asset_count, 1)
        self.assertEqual(year.print_weight_kg, 0.002)
        self.assertEqual(year.asset_count, 1)
        self.assertEqual(sum(slot.assets for slot in year.hours_of_week), 1)
        self.assertEqual(len(year.hours_of_week), 168)

    def test_year_album_count_and_location_fields(self):
        first = asset('photo-1', 'alice', 'IMAGE', '2025-02-01T10:00:00', 100,
                      altitude=120, gpsImgDirection=90, exifImageWidth=3000, exifImageHeight=4000)
        second = asset('photo-2', 'alice', 'IMAGE', '2025-02-02T10:00:00', 100,
                       altitude=-20, exifImageWidth=4000, exifImageHeight=3000)
        first['_album_ids'], second['_album_ids'] = ['a'], ['a', 'b']
        result = build_statistics([first, second], year=2025,
                                  albums=[{'id': 'a', 'asset_ids': ['photo-1', 'photo-2']},
                                          {'id': 'b', 'asset_ids': ['photo-2']}])
        self.assertEqual(result.album_count, 2)
        self.assertEqual(result.altitude_photo_count, 2)
        self.assertEqual(result.direction_photo_count, 1)
        self.assertEqual(result.portrait.photos, 1)
        self.assertEqual(result.landscape.photos, 1)
        self.assertEqual(result.first_asset_id, 'photo-1')
        self.assertEqual(result.last_asset_id, 'photo-2')
        self.assertEqual(result.busiest_day_asset_id, 'photo-1')
        self.assertEqual(sum(point.count for point in result.altitude_distribution.points), 2)

    def test_device_classification(self):
        self.assertEqual(category('Apple', 'iPhone 15'), "Mobile device")
        self.assertEqual(category('Apple', 'iPod touch'), "Mobile device")
        self.assertEqual(category('Apple', 'Unknown'), "Other")
        self.assertEqual(category('Canon', 'EOS 5D'), "Camera")
        for model in ('SAMSUNG GT-I8190N', 'GT-I9195', 'GT-I8200N'):
            self.assertEqual(category('SAMSUNG', model), "Mobile device")
        self.assertEqual(category('SAMSUNG GT-I9195', ''), "Mobile device")

    def test_manufacturer_normalization_keeps_original_variants(self):
        variants = ['NIKON CORPORATION', 'NIKON', 'Nikon', 'NIKON DIGITAL CAMERA']
        self.assertEqual({manufacturer(make, 'D850') for make in variants}, {'Nikon'})
        self.assertEqual(manufacturer('SONY', 'Alpha'), manufacturer('Sony', 'Alpha'))
        self.assertEqual(manufacturer('DJI', 'Mavic'), 'DJI')
        self.assertEqual(manufacturer('EASTMAN KODAK COMPANY', 'EasyShare'), 'Kodak')
        self.assertEqual(category('EASTMAN KODAK COMPANY', 'EasyShare'), "Camera")
        samples = [asset(str(i), 'alice', 'IMAGE', '2024-01-01T10:00:00', 10, make=make, model='D850') for i, make in enumerate(variants)]
        result = build_statistics(samples)
        self.assertEqual(result.manufacturers[0].count, 4)
        self.assertEqual(result.manufacturers[0].manufacturer_variants, sorted(set(variants)))
        self.assertTrue(all(matches(item, AssetQueryInput(kind='manufacturer', name='Nikon')) for item in samples))
        db = Mock()
        db.scalars.return_value = samples
        drilldown = query_assets(db, 1, AssetQueryInput(kind='manufacturer', name='Nikon'))
        self.assertEqual(drilldown['total'], 4)
        self.assertEqual(drilldown['items'][0]['size_bytes'], 10)
        self.assertEqual({entry['name'] for entry in drilldown['manufacturer_variants']}, set(variants))

    def test_profile_device_rules_affect_statistics_and_drilldown(self):
        photo = asset('kodak', 'alice', 'IMAGE', '2025-01-01T12:00:00', 100,
                      make='EASTMAN KODAK COMPANY', model='EasyShare')
        rules = {(device_rule_key('EASTMAN KODAK COMPANY'), device_rule_key('EasyShare')): {'manufacturer': 'Private Kodak', 'category': "Mobile device", 'device_name': 'My Kodak'}}
        apply_device_rules([photo], rules)
        result = build_statistics([photo])
        self.assertEqual(result.devices[0].manufacturer, 'Private Kodak')
        self.assertEqual(result.devices[0].name, 'My Kodak')
        self.assertEqual(result.devices[0].category, "Mobile device")
        self.assertTrue(matches(photo, AssetQueryInput(kind='manufacturer', name='Private Kodak', category="Mobile device")))
        self.assertFalse(matches(photo, AssetQueryInput(kind='manufacturer', name='Kodak', category="Camera")))
        apply_device_rules([photo], {})
        self.assertEqual(build_statistics([photo]).devices[0].manufacturer, 'Kodak')
        self.assertEqual(build_statistics([photo]).devices[0].category, "Camera")

    def test_extra_metrics_and_streaks(self):
        first = asset('first', 'alice', 'IMAGE', '2024-01-01T12:00:00', 10, exposureTime='1/2', country='Germany', latitude=0, longitude=0)
        first['people'] = [{'id': 'p1'}, {'id': 'p2'}]
        second = asset('second', 'alice', 'IMAGE', '2024-01-02T12:00:00', 10, exposureTime='1/4', country='France', latitude=0, longitude=0)
        third = asset('third', 'alice', 'IMAGE', '2024-01-10T12:00:00', 10, exposureTime='invalid')
        third['unassignedFaces'] = [{'id': 'face-1'}]
        result = build_statistics([first, second, third])
        self.assertEqual(result.busiest_day, '2024-01-01')
        self.assertEqual(result.longest_pause_days, 7)
        self.assertEqual(result.longest_day_streak, 2)
        self.assertEqual(result.longest_week_streak, 2)
        self.assertEqual((result.longest_day_streak_start, result.longest_day_streak_end), ('2024-01-01', '2024-01-02'))
        self.assertEqual((result.longest_week_streak_start, result.longest_week_streak_end), ('2024-01-01', '2024-01-14'))
        self.assertEqual(result.photos_with_people_count, 2)
        self.assertEqual(result.people_per_photo_with_people, 1.5)
        self.assertAlmostEqual(result.people_per_photo, 1)
        self.assertAlmostEqual(result.exposure_seconds, 0.75)
        self.assertEqual(result.exposure_missing_count, 1)
        self.assertEqual(result.continent_count, 1)
        self.assertEqual(result.detected_people_count, 3)
        self.assertEqual(sum(p.count for p in result.exposure_distribution.points), 2)
        self.assertAlmostEqual(result.exposure_distribution.minimum, 0.25)
        self.assertAlmostEqual(result.exposure_distribution.maximum, 0.5)
        self.assertAlmostEqual(result.print_stack_meters, 0.0006)
        self.assertAlmostEqual(result.print_weight_kg, 0.006)

    def test_exact_distribution_extrema_and_average_video(self):
        low = asset('low', 'alice', 'IMAGE', '2024-01-01T12:00:00', 10, iso=64, focalLength=12.3, exposureTime='1/8000')
        high = asset('high', 'alice', 'IMAGE', '2024-01-02T12:00:00', 10, iso=12800, focalLength=401.5, exposureTime='1105')
        short = asset('short', 'alice', 'VIDEO', '2024-01-03T12:00:00', 10)
        long = asset('long', 'alice', 'VIDEO', '2024-01-04T12:00:00', 10)
        short['duration'], long['duration'] = 5000, 60000
        result = build_statistics([low, high, short, long])
        self.assertEqual(result.exposure_distribution.maximum, 1105)
        self.assertAlmostEqual(result.exposure_distribution.minimum, 1 / 8000)
        self.assertEqual(result.focal_distribution.maximum, 401.5)
        self.assertEqual(result.video_duration_distribution.minimum, 5)
        self.assertEqual(result.video_duration_distribution.maximum, 60)
        self.assertEqual(result.average_video_duration_seconds, 32.5)

    def test_original_focal_lengths_are_not_rounded_and_drilldown_agrees(self):
        first = asset('first', 'alice', 'IMAGE', '2024-01-01T12:00:00', 10, focalLength=24.04)
        second = asset('second', 'alice', 'IMAGE', '2024-01-02T12:00:00', 10, focalLength=24.06)
        summary = build_statistics([first, second])
        self.assertEqual([point.value for point in summary.focal_distribution.points], [24.04, 24.06])
        self.assertEqual(summary.focal_distribution.sample_count, 2)
        for selected, other, point in [(first, second, summary.focal_distribution.points[0]), (second, first, summary.focal_distribution.points[1])]:
            query = AssetQueryInput(kind='distribution', field='focal', metric='photos', lower=point.value, upper=point.value, upper_inclusive=True)
            self.assertTrue(matches(selected, query))
            self.assertFalse(matches(other, query))

    def test_focal_index_keeps_exact_values_and_updates_changed_assets(self):
        engine = create_engine('sqlite://')
        Base.metadata.create_all(engine)
        first = asset('first', 'alice', 'IMAGE', '2024-01-01T12:00:00', 10, make='Canon', model='R5', focalLength=24.04)
        second = asset('second', 'alice', 'IMAGE', '2024-01-02T12:00:00', 10, make='Canon', model='R5', focalLength=24.06)
        with Session(engine) as db:
            replace_focal_observations(db, 17, [first, second])
            db.commit()
            rows = list(db.scalars(select(FocalObservation).where(FocalObservation.user_id == 17)))
            self.assertEqual(sorted(row.focal_length_mm for row in rows), [24.04, 24.06])
            second['exifInfo']['focalLength'] = 35.5
            update_focal_observations(db, 17, {'first': None, 'second': second})
            db.commit()
            rows = list(db.scalars(select(FocalObservation).where(FocalObservation.user_id == 17)))
            self.assertEqual([(row.asset_id, row.focal_length_mm) for row in rows], [('second', 35.5)])

    def test_timespan_uses_inclusive_calendar_days_like_photo_day_share(self):
        first = asset('first', 'alice', 'IMAGE', '2024-01-01T12:00:00', 10)
        last = asset('last', 'alice', 'IMAGE', '2024-01-03T12:00:00', 10)
        summary = build_statistics([first, last])
        self.assertEqual(summary.timespan_days, 3)
        self.assertEqual(summary.photo_days_total_days, 3)

    def test_drilldown_matches_chart_buckets(self):
        sample = asset('sample', 'alice', 'IMAGE', '2024-01-01T14:23:00', 10, make='Apple', model='iPhone 15', iso=100, focalLength=50, exposureTime='1/125')
        sample['people'] = [{'id': 'person-1'}]
        summary = build_statistics([sample])
        iso_point = summary.iso_distribution.points[0]
        focal_point = summary.focal_distribution.points[0]
        exposure_point = summary.exposure_distribution.points[0]
        for field, point in [('iso', iso_point), ('focal', focal_point), ('exposure', exposure_point)]:
            self.assertTrue(matches(sample, AssetQueryInput(kind='distribution', field=field, metric='photos', lower=point.lower, upper=point.upper, upper_inclusive=point.upper_inclusive)))
        self.assertTrue(matches(sample, AssetQueryInput(kind='week_hour', weekday=0, hour=14)))
        self.assertFalse(matches(sample, AssetQueryInput(kind='week_hour', weekday=1, hour=14)))
        self.assertTrue(matches(sample, AssetQueryInput(kind='manufacturer', name='Apple', category="Mobile device")))
        self.assertFalse(matches(sample, AssetQueryInput(kind='manufacturer', name='Apple', category="Camera")))


class ImmichClientTests(unittest.TestCase):
    def test_fast_scan_reuses_unchanged_assets_and_reconciles_deletions(self):
        old = asset('old', 'alice', 'IMAGE', '2024-01-01T10:00:00', 100, iso=100)
        old['updatedAt'], old['checksum'] = '2024-01-02T00:00:00Z', 'old-hash'
        changed = asset('changed', 'alice', 'IMAGE', '2024-01-01T11:00:00', 200, iso=200)
        changed['updatedAt'], changed['checksum'] = '2024-01-03T00:00:00Z', 'new-hash'
        requests = []

        def light(item):
            # Older/search-light DTOs may omit fields that the detailed cache has.
            return {key: value for key, value in item.items() if key not in ('exifInfo', 'people', 'checksum', 'width', 'height')}

        def handler(request):
            requests.append(request)
            if request.url.path == '/api/users/me':
                return httpx.Response(200, json={'id': 'alice'})
            if request.url.path == '/api/search/metadata':
                body = json.loads(request.content)
                self.assertFalse(body['withExif'])
                self.assertFalse(body['withPeople'])
                rows = [light(old), light(changed)] if body['visibility'] == 'timeline' else []
                return httpx.Response(200, json={'assets': {'items': rows, 'nextPage': None}})
            if request.url.path == '/api/assets/changed':
                return httpx.Response(200, json=changed)
            raise AssertionError(f'Unexpected request: {request.url}')

        real_client = httpx.AsyncClient
        previous = {'old': old, 'changed': {**changed, 'updatedAt': '2024-01-02T00:00:00Z'},
                    'deleted': asset('deleted', 'alice', 'IMAGE', '2024-01-01T12:00:00', 300)}
        with patch('app.immich.httpx.AsyncClient', side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs)):
            user, rows = asyncio.run(ImmichClient('https://photos.example', 'key').list_owned_assets(previous, False))
        self.assertEqual(user['id'], 'alice')
        self.assertEqual({item['id'] for item in rows}, {'old', 'changed'})
        self.assertEqual(next(item for item in rows if item['id'] == 'old')['exifInfo']['iso'], 100)
        self.assertEqual(next(item for item in rows if item['id'] == 'changed')['exifInfo']['iso'], 200)
        self.assertEqual([request.url.path for request in requests].count('/api/assets/changed'), 1)

    def test_fast_scan_reuses_unchanged_album_memberships(self):
        searches = []

        def handler(request):
            if request.url.path == '/api/albums':
                return httpx.Response(200, json=[{'id': 'own', 'updatedAt': '2024-01-01T00:00:00Z', 'assetCount': 1}])
            if request.url.path == '/api/search/metadata':
                body = json.loads(request.content)
                searches.append(body)
                self.assertTrue(body.get('isNotInAlbum'))
                return httpx.Response(200, json={'assets': {'items': [], 'nextPage': None}})
            raise AssertionError(request.url)

        real_client = httpx.AsyncClient
        previous = [{'id': 'own', 'updatedAt': '2024-01-01T00:00:00Z', 'assetCount': 1, 'asset_ids': ['photo']}]
        with patch('app.immich.httpx.AsyncClient', side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs)):
            albums, without_album = asyncio.run(ImmichClient('https://photos.example', 'key').album_metadata('alice', previous, False))
        self.assertEqual(albums[0]['asset_ids'], ['photo'])
        self.assertEqual(without_album, set())
        self.assertEqual(len(searches), 2)

    def test_album_search_is_authoritative(self):
        def handler(request):
            if request.url.path == '/api/albums':
                self.assertEqual(request.url.params['isOwned'], 'true')
                return httpx.Response(200, json=[{'id': 'own'}])
            if request.url.path == '/api/search/metadata':
                body = json.loads(request.content)
                if body.get('albumIds'):
                    self.assertEqual(body['albumIds'], ['own'])
                    return httpx.Response(200, json={'assets': {'items': [asset('in-album', 'alice', 'IMAGE', '2024-01-01T00:00:00', 1)], 'nextPage': None}})
                self.assertTrue(body['isNotInAlbum'])
                return httpx.Response(200, json={'assets': {'items': [asset('free', 'alice', 'IMAGE', '2024-01-01T00:00:00', 1), asset('shared', 'bob', 'IMAGE', '2024-01-01T00:00:00', 1)], 'nextPage': None}})
            raise AssertionError(request.url)

        real_client = httpx.AsyncClient
        with patch('app.immich.httpx.AsyncClient', side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs)):
            albums, without_album = asyncio.run(ImmichClient('https://photos.example', 'key').album_metadata('alice'))
        self.assertEqual(len(albums), 1)
        self.assertEqual(without_album, {'free'})
        self.assertEqual(albums[0]['asset_ids'], ['in-album'])

    def test_invalid_response_is_not_empty_library(self):
        with self.assertRaises(ValueError):
            ImmichClient._page({'message': 'invalid'})

    def test_owner_filter_pagination_and_size_enrichment(self):
        searches = []

        def handler(request):
            if request.url.path == "/api/users/me":
                return httpx.Response(200, json={"id": "alice"})
            if request.url.path == "/api/search/metadata":
                body = json.loads(request.content)
                searches.append(body)
                if body["visibility"] == "timeline" and body["page"] == 1:
                    return httpx.Response(200, json={"assets": {"items": [
                        asset("a", "alice", "IMAGE", "2020-01-01T10:00:00", None),
                        asset("shared", "bob", "IMAGE", "2020-01-01T10:00:00", 999),
                    ], "nextPage": "2"}})
                if body["visibility"] == "archive":
                    return httpx.Response(200, json={"assets": {"items": [asset("b", "alice", "VIDEO", "2020-01-02T10:00:00", 100)]}})
                return httpx.Response(200, json={"assets": {"items": []}})
            if request.url.path == "/api/assets/a":
                return httpx.Response(200, json=asset("a", "alice", "IMAGE", "2020-01-01T10:00:00", 500))
            raise AssertionError(f"Unexpected request: {request.url}")

        real_client = httpx.AsyncClient
        with patch("app.immich.httpx.AsyncClient", side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs)):
            user, assets = asyncio.run(ImmichClient("https://photos.example", "key").list_owned_assets())
        self.assertEqual(user["id"], "alice")
        self.assertEqual({item["id"] for item in assets}, {"a", "b"})
        self.assertEqual(sum(asset_size(item) for item in assets), 600)
        self.assertEqual(len(searches), 3)
        self.assertTrue(all(item["withExif"] and item["withPeople"] for item in searches))


class AuthTests(unittest.TestCase):
    def test_accounts_are_isolated(self):
        with TestClient(api.app) as admin, TestClient(api.app) as member:
            created = admin.post("/auth/bootstrap", json={"name": "Administrator", "email": "admin@example.com", "password": "long secure password"})
            self.assertEqual(created.status_code, 201, created.text)
            admin_csrf = created.json()["csrf_token"]
            self.assertEqual(admin.post("/auth/bootstrap", json={"name": "Other", "email": "other@example.com", "password": "long secure password"}).status_code, 409)
            invited = admin.post("/admin/users", json={"name": "Member", "email": "member@example.com"}, headers={"X-CSRF-Token": admin_csrf})
            self.assertEqual(invited.status_code, 201, invited.text)
            old_token = invited.json()["token"]
            renewed = admin.post(f"/admin/users/{invited.json()['user']['id']}/invite", headers={"X-CSRF-Token": admin_csrf})
            self.assertEqual(renewed.status_code, 200, renewed.text)
            token = renewed.json()["token"]
            self.assertEqual(member.post("/auth/accept-invite", json={"token": old_token, "password": "different secret password"}).status_code, 400)
            accepted = member.post("/auth/accept-invite", json={"token": token, "password": "different secret password"})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            member_csrf = accepted.json()["csrf_token"]
            self.assertEqual(member.post("/auth/accept-invite", json={"token": token, "password": "different secret password"}).status_code, 400)
            self.assertEqual(member.get("/admin/users").status_code, 403)
            self.assertEqual(admin.put("/me/immich", json={"immich_url": "https://example.com", "api_key": "admin-key"}).status_code, 403)
            self.assertEqual(admin.put("/me/immich", json={"immich_url": "https://example.com", "api_key": "admin-key"}, headers={"X-CSRF-Token": admin_csrf}).status_code, 200)
            self.assertEqual(member.put("/me/immich", json={"immich_url": "https://example.com", "api_key": "member-key"}, headers={"X-CSRF-Token": member_csrf}).status_code, 200)

            async def own_assets(client, *args, **kwargs):
                key = client.headers["x-api-key"]
                return {"id": key}, [asset(key, key, "IMAGE", "2021-01-01T12:00:00", 123 if key == "admin-key" else 456,
                                           make='EASTMAN KODAK COMPANY', model='EasyShare')]

            async def albums(client, owner_id, *args, **kwargs):
                return [], set()

            with patch.object(api.ImmichClient, "list_owned_assets", own_assets), patch.object(api.ImmichClient, 'album_metadata', albums):
                self.assertEqual(admin.get('/me/library').status_code, 409)
                self.assertEqual(admin.get('/me/export/sqlite').status_code, 409)
                self.assertEqual(admin.post('/me/sync').status_code, 403)
                self.assertEqual(admin.post('/me/sync', headers={'X-CSRF-Token': admin_csrf}).status_code, 202)
                self.assertEqual(member.post('/me/sync', headers={'X-CSRF-Token': member_csrf}).status_code, 202)
            with patch.object(api.ImmichClient, 'list_owned_assets', side_effect=AssertionError('GET must use cache')):
                admin_result = admin.get("/me/library")
                member_result = member.get("/me/library")
                self.assertEqual(admin.get('/me/library?year=2021').json()['total_bytes'], 123)
                self.assertEqual(member.get('/me/library?start=2021-01-01&end=2021-01-01').json()['total_bytes'], 456)
            self.assertEqual(admin_result.json()["total_bytes"], 123)
            self.assertEqual(member_result.json()["total_bytes"], 456)
            self.assertEqual(admin.post('/me/assets/query', json={'kind': 'year', 'year': 2021}).status_code, 403)
            admin_assets = admin.post('/me/assets/query', json={'kind': 'year', 'year': 2021}, headers={'X-CSRF-Token': admin_csrf})
            member_assets = member.post('/me/assets/query', json={'kind': 'year', 'year': 2021}, headers={'X-CSRF-Token': member_csrf})
            self.assertEqual(admin_assets.json()['total'], 1)
            self.assertEqual(admin_assets.json()['items'][0]['id'], 'admin-key')
            self.assertEqual(member_assets.json()['items'][0]['id'], 'member-key')
            self.assertEqual(admin.post('/me/assets/query', json={'kind': 'asset', 'asset_id': 'member-key'},
                                        headers={'X-CSRF-Token': admin_csrf}).json()['total'], 0)
            self.assertEqual(member.post('/me/assets/query', json={'kind': 'asset', 'asset_id': 'member-key'},
                                         headers={'X-CSRF-Token': member_csrf}).json()['total'], 1)
            candidates = admin.get('/me/device-candidates').json()
            self.assertEqual(candidates[0]['automatic_manufacturer'], 'Kodak')
            self.assertEqual(candidates[0]['automatic_category'], "Camera")
            correction = {'make': 'EASTMAN KODAK COMPANY', 'model': 'EasyShare',
                          'manufacturer': 'Private Kodak', 'device_name': 'My Kodak', 'category': "Camera"}
            self.assertEqual(admin.put('/me/device-rules', json=correction).status_code, 403)
            saved = admin.put('/me/device-rules', json=correction, headers={'X-CSRF-Token': admin_csrf})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertTrue(saved.json()['recalculating'])
            self.assertEqual(admin.get('/me/library').json()['devices'][0]['manufacturer'], 'Private Kodak')
            self.assertEqual(member.get('/me/library').json()['devices'][0]['manufacturer'], 'Kodak')
            self.assertEqual(admin.post('/me/assets/query', json={'kind': 'manufacturer', 'name': 'Private Kodak'},
                                        headers={'X-CSRF-Token': admin_csrf}).json()['total'], 1)
            self.assertEqual(member.post('/me/assets/query', json={'kind': 'manufacturer', 'name': 'Private Kodak'},
                                         headers={'X-CSRF-Token': member_csrf}).json()['total'], 0)
            self.assertEqual(member.get('/me/assets/admin-key/thumbnail').status_code, 404)
            self.assertEqual(TestClient(api.app).get('/me/export/sqlite/info').status_code, 401)
            export_info = admin.get('/me/export/sqlite/info')
            with patch.object(api, 'create_sqlite_export', side_effect=AssertionError('cached size should be reused')):
                self.assertEqual(admin.get('/me/export/sqlite/info').json(), export_info.json())
            exported = admin.get('/me/export/sqlite')
            self.assertEqual(export_info.status_code, 200, export_info.text)
            self.assertEqual(exported.status_code, 200, exported.text)
            self.assertTrue(exported.content.startswith(b'SQLite format 3'))
            self.assertEqual(export_info.json()['size_bytes'], len(exported.content))
            with sqlite3.connect(':memory:') as snapshot:
                snapshot.deserialize(exported.content)
                self.assertEqual(snapshot.execute('SELECT COUNT(*) FROM assets').fetchone()[0], 1)
                self.assertEqual(snapshot.execute('SELECT asset_id FROM assets').fetchone()[0], 'admin-key')
                self.assertEqual(snapshot.execute('SELECT manufacturer FROM device_rules').fetchone()[0], 'Private Kodak')
                tables = {row[0] for row in snapshot.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertEqual(tables, {'metadata', 'assets', 'summaries', 'albums', 'album_assets', 'device_rules'})
                columns = {row[1] for row in snapshot.execute('PRAGMA table_info(assets)')}
                self.assertTrue({'media_type', 'file_size_bytes', 'iso', 'focal_length_mm', 'is_favorite', 'payload_json'} <= columns)
            member_export = member.get('/me/export/sqlite')
            with sqlite3.connect(':memory:') as snapshot:
                snapshot.deserialize(member_export.content)
                self.assertEqual(snapshot.execute('SELECT asset_id FROM assets').fetchone()[0], 'member-key')
                self.assertEqual(snapshot.execute('SELECT COUNT(*) FROM device_rules').fetchone()[0], 0)
            rule_path = '/me/device-rules?make=EASTMAN%20KODAK%20COMPANY&model=EasyShare'
            self.assertEqual(admin.delete(rule_path).status_code, 403)
            self.assertEqual(admin.delete(rule_path, headers={'X-CSRF-Token': admin_csrf}).status_code, 200)
            self.assertEqual(admin.get('/me/library').json()['devices'][0]['manufacturer'], 'Kodak')
            unchanged_revision = admin.get('/me/sync').json()['revision']
            with patch.object(api.ImmichClient, 'list_owned_assets', own_assets), patch.object(api.ImmichClient, 'album_metadata', albums), patch('app.cache.build_statistics', side_effect=AssertionError('unchanged assets must not be recalculated')):
                self.assertEqual(admin.post('/me/sync', headers={'X-CSRF-Token': admin_csrf}).status_code, 202)
            self.assertEqual(admin.get('/me/sync').json()['revision'], unchanged_revision)
            self.assertEqual(admin.get('/me/sync').json()['progress']['percent'], 100)
            async def changed_assets(client, *args, **kwargs):
                return {'id': 'admin-key'}, [asset('new', 'admin-key', 'VIDEO', '2022-01-01T12:00:00', 789)]
            with patch.object(api.ImmichClient, 'list_owned_assets', changed_assets), patch.object(api.ImmichClient, 'album_metadata', albums):
                admin.post('/me/sync', headers={'X-CSRF-Token': admin_csrf})
            self.assertNotEqual(admin.get('/me/export/sqlite/info').json()['revision'], export_info.json()['revision'])
            self.assertEqual(admin.get('/me/library').json()['total_bytes'], 789)
            self.assertEqual(admin.get('/me/library?year=2021').json()['asset_count'], 0)
            self.assertEqual(admin.get('/me/library?year=2022').json()['video_count'], 1)
            with patch.object(api.ImmichClient, 'list_owned_assets', side_effect=RuntimeError('offline')):
                admin.post('/me/sync', headers={'X-CSRF-Token': admin_csrf})
            self.assertEqual(admin.get('/me/library').json()['total_bytes'], 789)
            self.assertIsNotNone(admin.get('/me/sync').json()['error'])
            self.assertEqual(member.get('/me/library').json()['total_bytes'], 456)
            admin.put('/me/immich', json={'immich_url': 'https://other.example', 'api_key': 'changed'}, headers={'X-CSRF-Token': admin_csrf})
            self.assertEqual(admin.get('/me/library').status_code, 409)
            self.assertEqual(member.get('/me/library').status_code, 200)
            self.assertNotIn("immich_url", admin.get("/admin/users").json()[1])
            self.assertEqual(admin.get("/profiles").status_code, 404)
            self.assertEqual(member.get("/me/capabilities").json()["permissions"][0]["permission"], "asset.read")
            self.assertEqual(member.post("/auth/logout", headers={"X-CSRF-Token": member_csrf}).status_code, 204)
            self.assertEqual(member.get("/me/library").status_code, 401)
            member_id = invited.json()['user']['id']
            active_member = TestClient(api.app)
            self.assertEqual(active_member.post('/auth/login', json={'email': 'member@example.com', 'password': 'different secret password'}).status_code, 200)
            self.assertEqual(active_member.get('/me/library').status_code, 200)
            self.assertEqual(admin.request('DELETE', f'/admin/users/{member_id}', json={'confirmation': 'delete'}).status_code, 403)
            self.assertEqual(admin.request('DELETE', f'/admin/users/{member_id}', json={'confirmation': 'wrong'}, headers={'X-CSRF-Token': admin_csrf}).status_code, 422)
            self.assertEqual(admin.request('DELETE', f'/admin/users/{created.json()["user"]["id"]}', json={'confirmation': 'delete'}, headers={'X-CSRF-Token': admin_csrf}).status_code, 403)
            self.assertEqual(admin.request('DELETE', f'/admin/users/{member_id}', json={'confirmation': 'delete'}, headers={'X-CSRF-Token': admin_csrf}).status_code, 204)
            self.assertEqual(member.get('/me/library').status_code, 401)
            self.assertEqual(active_member.get('/me/library').status_code, 401)
            active_member.close()
            self.assertNotIn(member_id, [user['id'] for user in admin.get('/admin/users').json()])
            from sqlalchemy import select
            from app.database import SessionLocal
            from app.models import CachedAsset, CachedSummary, DeviceRule, SyncState, User
            with SessionLocal() as db:
                self.assertIsNone(db.get(User, member_id))
                self.assertIsNone(db.get(SyncState, member_id))
                self.assertFalse(db.scalars(select(CachedAsset).where(CachedAsset.user_id == member_id)).first())
                self.assertFalse(db.scalars(select(CachedSummary).where(CachedSummary.user_id == member_id)).first())
                self.assertFalse(db.scalars(select(DeviceRule).where(DeviceRule.user_id == member_id)).first())


def tearDownModule():
    api.engine.dispose()
    TEMP.cleanup()


if __name__ == "__main__":
    unittest.main()
