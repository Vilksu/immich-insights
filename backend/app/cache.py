"""Persistent per-account snapshots. Run with one Uvicorn worker (Docker default).

A sync reads remote metadata in a background thread. Publication is transactional:
failed or cancelled syncs never replace the last complete snapshot.
"""
import asyncio
import time
import uuid
from datetime import date, datetime, timedelta, timezone

from cryptography.fernet import Fernet
from fastapi import HTTPException
from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError

from .config import get_settings
from .legacy_labels import category_label, normalize_summary
from .camera import apply_device_rules, device_name
from .database import SessionLocal
from .immich import ImmichClient
from .models import CachedAsset, CachedSummary, DeviceRule, FocalObservation, ReportSize, SyncProgress, SyncState, User
from .schemas import CACHE_VERSION
from .statistics import all_frame_formats, build_statistics, continent_labels, positive_number, taken_at


def focal_observation(user_id, asset):
    if asset.get('type') != 'IMAGE':
        return None
    focal = positive_number((asset.get('exifInfo') or {}).get('focalLength'))
    if focal is None:
        return None
    taken = taken_at(asset)
    return {'user_id': user_id, 'asset_id': asset['id'], 'device': device_name(asset),
            'taken_date': taken.date() if taken else None, 'focal_length_mm': focal}


def replace_focal_observations(db, user_id, assets):
    db.execute(delete(FocalObservation).where(FocalObservation.user_id == user_id))
    rows = [row for asset in assets if (row := focal_observation(user_id, asset)) is not None]
    for offset in range(0, len(rows), 1000):
        db.execute(insert(FocalObservation), rows[offset:offset + 1000])


def update_focal_observations(db, user_id, changes):
    for asset_id, asset in changes.items():
        existing = db.get(FocalObservation, (user_id, asset_id))
        values = focal_observation(user_id, asset) if asset is not None else None
        if values is None:
            if existing is not None:
                db.delete(existing)
        elif existing is None:
            db.add(FocalObservation(**values))
        else:
            existing.device = values['device']
            existing.taken_date = values['taken_date']
            existing.focal_length_mm = values['focal_length_mm']


def ensure_state(db, user_id):
    state = db.get(SyncState, user_id)
    if state is None:
        db.add(SyncState(user_id=user_id, running=False))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
        state = db.get(SyncState, user_id)
    return state


def claim(db, user_id):
    state = ensure_state(db, user_id)
    result = db.execute(update(SyncState).where(SyncState.user_id == user_id, SyncState.running.is_(False)).values(running=True, error=None))
    if result.rowcount:
        progress = db.get(SyncProgress, user_id)
        if progress is None:
            # Before this release every published snapshot came from a full scan.
            progress = SyncProgress(user_id=user_id, last_full_at=state.completed_at if state.revision else None)
            db.add(progress)
        progress.phase, progress.percent, progress.processed, progress.total = 'Preparing', 0, 0, 0
    db.commit()
    return result.rowcount == 1


def set_progress(user_id, phase, percent, processed=0, total=0):
    with SessionLocal() as db:
        progress = db.get(SyncProgress, user_id)
        if progress is None:
            progress = SyncProgress(user_id=user_id)
            db.add(progress)
        progress.phase, progress.percent = phase, max(progress.percent, max(0, min(100, int(percent))))
        progress.processed, progress.total = processed, total
        db.commit()


def device_rules(db, user_id):
    return {(rule.make_key, rule.model_key): {'device_name': rule.device_name, 'manufacturer': rule.manufacturer,
            'category': category_label(rule.category)} for rule in db.scalars(select(DeviceRule).where(DeviceRule.user_id == user_id))}


def summarize_assets(assets, albums):
    summaries = {'all': build_statistics(assets, albums=albums).model_dump(mode='json')}
    grouped = {}
    for asset in assets:
        taken = taken_at(asset)
        if taken:
            grouped.setdefault(taken.year, []).append(asset)
    for year, group in grouped.items():
        summaries[f'year:{year}'] = build_statistics(group, year=year, albums=albums).model_dump(mode='json')
    return summaries


def rebuild_device_classification(user_id):
    """Recalculate profile statistics using only stored assets, without Immich I/O."""
    try:
        set_progress(user_id, "Calculating device assignments", 10)
        with SessionLocal() as db:
            state = db.get(SyncState, user_id)
            assets = [row.payload for row in db.scalars(select(CachedAsset).where(CachedAsset.user_id == user_id))]
            albums = state.albums
            rules = device_rules(db, user_id)
        apply_device_rules(assets, rules)
        set_progress(user_id, "Calculating local statistics", 55)
        summaries = summarize_assets(assets, albums)
        with SessionLocal() as db:
            # Rule writes and remote syncs are blocked while this job owns SyncState.running.
            existing = {row.asset_id: row for row in db.scalars(select(CachedAsset).where(CachedAsset.user_id == user_id))}
            for asset in assets:
                row = existing[asset['id']]
                if row.payload != asset:
                    row.payload = asset
            replace_focal_observations(db, user_id, assets)
            db.execute(delete(CachedSummary).where(CachedSummary.user_id == user_id))
            for scope, payload in summaries.items():
                db.add(CachedSummary(user_id=user_id, scope=scope, payload=payload))
            state = db.get(SyncState, user_id)
            state.revision = uuid.uuid4().hex
            state.running, state.error = False, None
            db.execute(delete(ReportSize).where(ReportSize.user_id == user_id))
            progress = db.get(SyncProgress, user_id)
            progress.phase, progress.percent = 'Device assignments complete', 100
            db.commit()
    except Exception:
        with SessionLocal() as db:
            state = db.get(SyncState, user_id)
            if state:
                state.running = False
                state.error = "Device assignments could not be recalculated. The previous snapshot remains available."
                db.commit()


async def fetch_snapshot(url, key, previous=None, previous_albums=None, full=True, progress=None):
    client = ImmichClient(url, key)
    owner, assets = await client.list_owned_assets(progress=progress) if full else await client.list_owned_assets(previous, False, progress)
    albums, without_album = (await client.album_metadata(owner['id'], progress=progress) if full else
                             await client.album_metadata(owner['id'], previous_albums, False, progress))
    album_membership = None
    if albums is not None and all(album.get('asset_ids') is not None for album in albums):
        album_membership = {}
        for album in albums:
            for asset_id in album['asset_ids']:
                album_membership.setdefault(asset_id, []).append(album['id'])
    live = {a.get('livePhotoVideoId') for a in assets}
    for asset in assets:
        asset['_live_companion'] = asset['id'] in live
        if without_album is not None:
            asset['_not_in_album'] = asset['id'] in without_album
        if album_membership is not None:
            asset['_album_ids'] = album_membership.get(asset['id'], [])
    return owner, assets, albums, full or client.did_full_scan


def synchronize(user_id):
    try:
        with SessionLocal() as db:
            user = db.get(User, user_id)
            url, encrypted = user.immich_url, user.encrypted_api_key
            state = db.get(SyncState, user_id)
            previous_albums = state.albums if state else None
            previous = {asset.asset_id: asset.payload for asset in db.scalars(select(CachedAsset).where(CachedAsset.user_id == user_id))}
            sync_progress = db.get(SyncProgress, user_id)
            last_full_at = sync_progress.last_full_at if sync_progress else None
            full = not previous or not last_full_at or datetime.now(timezone.utc).replace(tzinfo=None) - last_full_at >= timedelta(days=7)
        key = Fernet(get_settings().encryption_key()).decrypt(encrypted.encode()).decode()
        last_report = {'phase': '', 'at': 0.0}

        def report(phase, count, total):
            if phase == "Loading assets" or phase == "Checking assets":
                percent = 5 + 50 * min(1, count / max(1, total))
            elif phase == "Loading changes":
                percent = 55 + 15 * count / max(1, total)
            elif phase == "Checking assets without albums":
                percent = 70 + 8 * min(1, count / max(1, total))
            else:
                percent = 78 + 7 * count / max(1, total)
            now = time.monotonic()
            if phase == last_report['phase'] and count < total and now - last_report['at'] < 0.4:
                return
            set_progress(user_id, phase, percent, count, total)
            last_report['phase'], last_report['at'] = phase, now

        set_progress(user_id, "Full sync" if full else "Fast incremental sync", 2)
        owner, assets, albums, actual_full = asyncio.run(fetch_snapshot(url, key, previous, previous_albums, full, report))
        with SessionLocal() as db:
            overview = db.get(CachedSummary, (user_id, 'all'))
            current_cache = overview is not None and overview.payload.get('cache_version') == CACHE_VERSION
            rules = device_rules(db, user_id)
        apply_device_rules(assets, rules)
        same = (current_cache and len(assets) == len(previous) and albums == previous_albums and
                all(previous.get(asset['id']) == asset for asset in assets))
        if same:
            with SessionLocal() as db:
                user = db.scalar(select(User).where(User.id == user_id).with_for_update())
                if (user.immich_url, user.encrypted_api_key) == (url, encrypted):
                    state = db.get(SyncState, user_id)
                    state.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    state.running, state.error = False, None
                    progress_row = db.get(SyncProgress, user_id)
                    progress_row.phase, progress_row.percent = "No changes", 100
                    if actual_full:
                        progress_row.last_full_at = state.completed_at
                    db.commit()
                else:
                    db.execute(update(SyncState).where(SyncState.user_id == user_id).values(running=False))
                    db.commit()
            return
        set_progress(user_id, "Calculating statistics", 87)
        summaries = summarize_assets(assets, albums)
        set_progress(user_id, "Updating database", 93)
        with SessionLocal() as db:
            # Lock publication against changing the account's connection mid-sync.
            user = db.scalar(select(User).where(User.id == user_id).with_for_update())
            if (user.immich_url, user.encrypted_api_key) != (url, encrypted):
                db.execute(update(SyncState).where(SyncState.user_id == user_id).values(running=False))
                db.commit()
                return
            existing = {a.asset_id: a for a in db.scalars(select(CachedAsset).where(CachedAsset.user_id == user_id))}
            focal_changes = {}
            for asset in assets:
                old = existing.pop(asset['id'], None)
                taken = taken_at(asset)
                day = taken.date() if taken else None
                if old is None:
                    db.add(CachedAsset(user_id=user_id, asset_id=asset['id'], taken_date=day, payload=asset))
                    focal_changes[asset['id']] = asset
                elif old.payload != asset:
                    old.payload, old.taken_date = asset, day
                    focal_changes[asset['id']] = asset
            for old in existing.values():
                db.delete(old)
                focal_changes[old.asset_id] = None
            if current_cache:
                update_focal_observations(db, user_id, focal_changes)
            else:
                replace_focal_observations(db, user_id, assets)
            db.execute(delete(CachedSummary).where(CachedSummary.user_id == user_id))
            for scope, payload in summaries.items():
                db.add(CachedSummary(user_id=user_id, scope=scope, payload=payload))
            state = db.get(SyncState, user_id)
            state.revision = uuid.uuid4().hex
            db.execute(delete(ReportSize).where(ReportSize.user_id == user_id))
            state.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            state.running, state.error, state.albums = False, None, albums
            progress_row = db.get(SyncProgress, user_id)
            progress_row.phase, progress_row.percent = "Done", 100
            if actual_full:
                progress_row.last_full_at = state.completed_at
            user.immich_user_id = owner['id']
            db.commit()
    except Exception:
        with SessionLocal() as db:
            state = db.get(SyncState, user_id)
            if state:
                state.running = False
                state.error = "Sync failed. Check the connection and API permissions. The last complete snapshot remains available."
                progress_row = db.get(SyncProgress, user_id)
                if progress_row:
                    progress_row.phase = "Failed"
                db.commit()


def invalidate(db, user_id):
    for model in (CachedAsset, CachedSummary, FocalObservation, ReportSize, SyncProgress):
        db.execute(delete(model).where(model.user_id == user_id))
    state = db.get(SyncState, user_id)
    if state:
        state.revision = state.completed_at = state.albums = state.error = None


def read_annual_scores(db, user_id):
    """Project only small score fields from cached year summaries; no Immich request."""
    rows = db.execute(
        select(
            CachedSummary.scope,
            CachedSummary.payload['scores'],
            CachedSummary.payload['photo_count'].as_integer(),
            CachedSummary.payload['video_count'].as_integer(),
        ).where(CachedSummary.user_id == user_id, CachedSummary.scope.like('year:%'))
    )
    return [
        {
            'year': int(scope[5:]), 'photo_count': photo_count or 0,
            'video_count': video_count or 0,
            'scores': {score['key']: score.get('value') for score in scores or []},
        }
        for scope, scores, photo_count, video_count in sorted(rows, key=lambda row: int(row.scope[5:]))
    ]


def read_summary(db, user_id, year=None, start=None, end=None):
    overview = db.get(CachedSummary, (user_id, 'all'))
    if overview and overview.payload.get('cache_version') != CACHE_VERSION:
        raise HTTPException(409, "Snapshot from an older version. Please select “Refresh now”.")
    scope = f'year:{year}' if year else f'range:{start}:{end}' if start else 'all'
    saved = db.get(CachedSummary, (user_id, scope))
    if saved:
        payload = normalize_summary(saved.payload)
        # Old snapshots stored only the 40 most common formats. Complete them
        # once from local cached assets, without starting an Immich scan.
        if payload.get('frame_format_covered_count', 0) < payload.get('resolution_count', 0):
            query = select(CachedAsset.payload).where(CachedAsset.user_id == user_id)
            if year:
                query = query.where(CachedAsset.taken_date >= date(year, 1, 1), CachedAsset.taken_date <= date(year, 12, 31))
            if start:
                query = query.where(CachedAsset.taken_date >= start, CachedAsset.taken_date <= end)
            frames, covered = all_frame_formats(list(db.scalars(query)))
            payload = {**payload, 'frame_formats': [frame.model_dump(mode='json') for frame in frames],
                       'frame_format_covered_count': covered}
            saved.payload = payload
            db.commit()
        # Repair legacy snapshots without forcing another expensive Immich scan.
        if payload.get('country_count') == 1 and payload.get('continent_count', 0) > 1:
            continents = continent_labels({payload['top_country']}) if payload.get('top_country') else []
            payload = {**payload, 'continent_count': len(continents), 'continents': continents}
        return {**payload, 'annual_scores': read_annual_scores(db, user_id)} if scope == 'all' else payload
    query = select(CachedAsset.payload).where(CachedAsset.user_id == user_id)
    if year:
        start, end = date(year, 1, 1), date(year, 12, 31)
    if start:
        query = query.where(CachedAsset.taken_date >= start, CachedAsset.taken_date <= end)
    state = db.get(SyncState, user_id)
    return build_statistics(list(db.scalars(query)), year=year, start=start, end=end, albums=state.albums if state else None)
