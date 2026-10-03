import secrets
import os
from collections import Counter
from datetime import date, timedelta

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import BackgroundTasks, Body, Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import (
    COOKIE_NAME, ICONS, AuthContext, admin_auth, csrf_auth, current_auth,
    hash_password, issue_session, token_hash, user_out, utcnow, verify_password,
)
from .config import get_settings
from .database import Base, engine, get_db
from .immich import OPERATIONS, ImmichClient, ImmichPermissionError
from .models import CachedAsset, CachedSummary, DeviceRule, ExportSize, FocalObservation, ReportSize, LoginSession, User, SyncProgress, SyncState
from .legacy_labels import category_label
from .camera import category, device_name, device_rule_key, manufacturer
from .asset_query import query_assets
from .cache import claim, ensure_state, invalidate, read_summary, rebuild_device_classification, synchronize
from .export import create_sqlite_export
from .report import create_report
from .schemas import (
    AcceptInvitationInput, ApiCapabilitiesOut, AssetQueryInput, AuthOut, BootstrapInput,
    ConnectionInput, ConnectionOut, DeviceRuleInput, InvitationInput, InvitationOut, LibraryStatsOut,
    LoginInput, MemberOut, PasswordInput, PermissionOut, ProfileInput, UserOut,
)
from .statistics import build_statistics, focal_distribution


settings = get_settings()
fernet = Fernet(settings.encryption_key())
app = FastAPI(title="Immich Insights API", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"],
    allow_headers=["*"], allow_credentials=True,
)


@app.middleware("http")
async def private_cache(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


@app.on_event("startup")
def create_tables() -> None:
    Base.metadata.create_all(engine)
    from .database import SessionLocal
    with SessionLocal() as db:
        for state in db.scalars(select(SyncState).where(SyncState.running.is_(True))):
            state.running = False
            state.error = "Sync interrupted by a restart. Please refresh again."
        db.commit()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/setup")
def setup_status(db: Session = Depends(get_db)) -> dict[str, bool]:
    return {"needs_setup": db.scalar(select(func.count(User.id))) == 0}


@app.post("/auth/bootstrap", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
def bootstrap(payload: BootstrapInput, response: Response, db: Session = Depends(get_db)):
    if db.scalar(select(func.count(User.id))) != 0:
        raise HTTPException(409, "Setup is already complete.")
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Enter a name.")
    user = User(name=name, email=str(payload.email).lower(), password_hash=hash_password(payload.password), is_admin=True)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Setup has already been completed.")
    db.refresh(user)
    return issue_session(db, user, response)


@app.post("/auth/login", response_model=AuthOut)
def login(payload: LoginInput, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == str(payload.email).lower()))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "Email or password is incorrect.")
    return issue_session(db, user, response)


@app.post("/auth/accept-invite", response_model=AuthOut)
def accept_invite(payload: AcceptInvitationInput, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.invitation_hash == token_hash(payload.token)))
    if not user or user.password_hash or not user.invitation_expires_at or user.invitation_expires_at.replace(tzinfo=None) < utcnow().replace(tzinfo=None):
        raise HTTPException(400, "This invitation link is invalid or expired.")
    user.password_hash = hash_password(payload.password)
    user.invitation_hash = None
    user.invitation_expires_at = None
    db.commit()
    return issue_session(db, user, response)


@app.get("/auth/me", response_model=AuthOut)
def me(context: AuthContext = Depends(current_auth)):
    return AuthOut(user=user_out(context.user), csrf_token=context.session.csrf_token)


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    db.delete(context.session)
    db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    response.status_code = 204
    return response


def member_out(user: User) -> MemberOut:
    return MemberOut(id=user.id, email=user.email, name=user.name, is_admin=user.is_admin, joined=bool(user.password_hash))


@app.get("/admin/users", response_model=list[MemberOut])
def admin_users(context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    if not context.user.is_admin:
        raise HTTPException(403, "Only the admin can list users.")
    return [member_out(user) for user in db.scalars(select(User).order_by(User.name)).all()]


@app.post("/admin/users", response_model=InvitationOut, status_code=status.HTTP_201_CREATED)
def invite_user(payload: InvitationInput, context: AuthContext = Depends(admin_auth), db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Enter a name.")
    token = secrets.token_urlsafe(40)
    user = User(
        name=name, email=str(payload.email).lower(), is_admin=False,
        invitation_hash=token_hash(token), invitation_expires_at=utcnow() + timedelta(days=7),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This email address is already in use.")
    db.refresh(user)
    return InvitationOut(user=member_out(user), token=token)


@app.post("/admin/users/{user_id}/invite", response_model=InvitationOut)
def renew_invitation(user_id: int, context: AuthContext = Depends(admin_auth), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if not user or user.password_hash:
        raise HTTPException(404, "Pending invitation not found.")
    token = secrets.token_urlsafe(40)
    user.invitation_hash = token_hash(token)
    user.invitation_expires_at = utcnow() + timedelta(days=7)
    db.commit()
    return InvitationOut(user=member_out(user), token=token)


@app.delete("/admin/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_member(user_id: int, confirmation: str = Body(embed=True), context: AuthContext = Depends(admin_auth), db: Session = Depends(get_db)):
    """Remove one non-admin account and every account-scoped record atomically."""
    if confirmation != "delete":
        raise HTTPException(422, "Type delete to confirm.")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Member not found.")
    if user.is_admin or user.id == context.user.id:
        raise HTTPException(403, "An admin account cannot be deleted here.")
    state = db.get(SyncState, user_id)
    if state and state.running:
        raise HTTPException(409, "Sync is still running. Please try again afterward.")
    for model in (LoginSession, CachedAsset, CachedSummary, FocalObservation, DeviceRule, ExportSize, ReportSize, SyncProgress, SyncState):
        db.execute(delete(model).where(model.user_id == user_id))
    db.delete(user)
    db.commit()
    return Response(status_code=204)


@app.put("/me/profile", response_model=UserOut)
def update_profile(payload: ProfileInput, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name or payload.profile_icon not in ICONS:
        raise HTTPException(422, "Name or profile icon is invalid.")
    context.user.name = name
    context.user.profile_icon = payload.profile_icon
    db.commit()
    return user_out(context.user)


@app.put("/me/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(payload: PasswordInput, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    if not verify_password(payload.current_password, context.user.password_hash):
        raise HTTPException(403, "Current password is incorrect.")
    context.user.password_hash = hash_password(payload.new_password)
    db.execute(delete(LoginSession).where(LoginSession.user_id == context.user.id, LoginSession.token_hash != context.session.token_hash))
    db.commit()
    return Response(status_code=204)


@app.get("/me/capabilities", response_model=ApiCapabilitiesOut)
def capabilities(_: AuthContext = Depends(current_auth)):
    by_permission: dict[str, PermissionOut] = {}
    for operation in OPERATIONS.values():
        existing = by_permission.get(operation.permission)
        if existing:
            existing.optional = existing.optional and operation.optional
        else:
            by_permission[operation.permission] = PermissionOut(
                permission=operation.permission, purpose=operation.purpose, optional=operation.optional,
            )
    return ApiCapabilitiesOut(permissions=list(by_permission.values()))


@app.put("/me/immich", response_model=UserOut)
def save_immich(payload: ConnectionInput, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    db.scalar(select(User).where(User.id == context.user.id).with_for_update())
    invalidate(db, context.user.id)
    context.user.immich_url = str(payload.immich_url).rstrip("/")
    context.user.encrypted_api_key = fernet.encrypt(payload.api_key.encode()).decode()
    context.user.immich_user_id = None
    db.commit()
    return user_out(context.user)


def immich_for(user: User) -> ImmichClient:
    if not user.immich_url or not user.encrypted_api_key:
        raise HTTPException(422, "First save your Immich URL and API key in your profile.")
    try:
        return ImmichClient(user.immich_url, fernet.decrypt(user.encrypted_api_key.encode()).decode())
    except InvalidToken:
        raise HTTPException(500, "The stored API key cannot be decrypted.")


def immich_error(error: Exception) -> HTTPException:
    if isinstance(error, ImmichPermissionError):
        return HTTPException(422, str(error))
    if isinstance(error, httpx.HTTPStatusError):
        return HTTPException(502, f"Immich returned HTTP {error.response.status_code}. Check the URL, API key, and permissions.")
    if isinstance(error, httpx.ConnectError):
        return HTTPException(502, "Immich is unreachable from the backend. Check the URL and Docker network.")
    return HTTPException(502, "Immich could not be queried. Check the connection and try again.")


@app.post("/me/connection", response_model=ConnectionOut)
async def test_connection(context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    client = immich_for(context.user)
    try:
        immich_user = await client.check_connection()
    except (ImmichPermissionError, httpx.HTTPError, ValueError) as error:
        raise immich_error(error)
    context.user.immich_user_id = immich_user["id"]
    db.commit()
    return ConnectionOut(ok=True, message="Immich is reachable. Only your own assets are counted.")


@app.get("/me/library", response_model=LibraryStatsOut)
def library(year: int | None = None, start: date | None = None, end: date | None = None,
                  context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    if year is not None and (year < 1900 or year > 2200 or start or end):
        raise HTTPException(422, "Invalid year selection.")
    if (start is None) != (end is None) or (start and end and start > end):
        raise HTTPException(422, "Enter a valid date range.")
    state = db.get(SyncState, context.user.id)
    if not state or not state.revision:
        raise HTTPException(409, "No snapshot yet. Please start a refresh.")
    return read_summary(db, context.user.id, year, start, end)


@app.get('/me/sync')
def sync_status(context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    state = ensure_state(db, context.user.id)
    progress = db.get(SyncProgress, context.user.id)
    return {'running': state.running, 'revision': state.revision, 'completed_at': state.completed_at.isoformat() + 'Z' if state.completed_at else None,
            'error': state.error, 'progress': {'phase': progress.phase, 'percent': progress.percent,
            'processed': progress.processed, 'total': progress.total} if progress else None}


@app.get('/me/device-candidates')
def device_candidates(context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    """Distinct original EXIF pairs; rules are isolated to the signed-in account."""
    counts = Counter()
    labels = {}
    for asset in db.scalars(select(CachedAsset.payload).where(CachedAsset.user_id == context.user.id)):
        exif = asset.get('exifInfo') or {}
        make, model = str(exif.get('make') or '').strip(), str(exif.get('model') or '').strip()
        if not make and not model:
            continue
        key = device_rule_key(make), device_rule_key(model)
        if not any(key):
            continue
        counts[key] += 1
        labels.setdefault(key, (make, model))
    rules = {(r.make_key, r.model_key): r for r in db.scalars(select(DeviceRule).where(DeviceRule.user_id == context.user.id))}
    result = []
    for key, count in counts.most_common():
        make, model = labels[key]
        rule = rules.get(key)
        result.append({'make': make, 'model': model, 'count': count,
                       'automatic_name': device_name({'exifInfo': {'make': make, 'model': model}}),
                       'automatic_manufacturer': manufacturer(make, model), 'automatic_category': category(make, model),
                       'device_name': rule.device_name if rule else None,
                       'manufacturer': rule.manufacturer if rule else None,
                       'category': category_label(rule.category) if rule else None})
    return result


@app.get('/me/focal-distribution')
def focal_distribution_for_device(device: str, year: int | None = None, start: date | None = None,
                                  end: date | None = None, context: AuthContext = Depends(current_auth),
                                  db: Session = Depends(get_db)):
    """Exact original EXIF focal lengths from this account's published snapshot.

    The cached asset payload is the source of truth for both this histogram and
    its drill-down. No Immich request or lossy 35-mm conversion is involved.
    """
    if len(device) > 300 or year is not None and (year < 1900 or year > 2200) or bool(start) != bool(end) or start and end and start > end or year is not None and start is not None:
        raise HTTPException(422, "Invalid device or date-range filter.")
    state = db.get(SyncState, context.user.id)
    if not state or not state.revision:
        raise HTTPException(409, "No snapshot yet. Please start a refresh.")
    # Existing snapshots may have indexed the old placeholder. Real EXIF names
    # are left intact; both placeholder spellings refer to the same unknown device.
    from .legacy_labels import device_aliases
    query = select(FocalObservation.focal_length_mm).where(FocalObservation.user_id == context.user.id, FocalObservation.device.in_(device_aliases(device)))
    if year is not None:
        query = query.where(FocalObservation.taken_date >= date(year, 1, 1), FocalObservation.taken_date <= date(year, 12, 31))
    elif start is not None and end is not None:
        query = query.where(FocalObservation.taken_date >= start, FocalObservation.taken_date <= end)
    return focal_distribution(list(db.scalars(query)))


def change_device_rule(db, user_id, background):
    state = db.get(SyncState, user_id)
    if state and state.revision and claim(db, user_id):
        background.add_task(rebuild_device_classification, user_id)
        return {'recalculating': True}
    return {'recalculating': False}


@app.put('/me/device-rules')
def save_device_rule(payload: DeviceRuleInput, background: BackgroundTasks, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    make, model = payload.make.strip(), payload.model.strip()
    if not device_rule_key(make) and not device_rule_key(model):
        raise HTTPException(422, "Choose a specific EXIF device.")
    name = payload.device_name.strip() if payload.device_name else None
    maker = payload.manufacturer.strip() if payload.manufacturer else None
    if name == '' or maker == '':
        raise HTTPException(422, "Device name and manufacturer cannot both be empty.")
    if not any((name, maker, payload.category)):
        raise HTTPException(422, "Enter at least one correction.")
    state = db.get(SyncState, context.user.id)
    if state and state.running:
        raise HTTPException(409, "Please wait until the current sync finishes.")
    key = (context.user.id, device_rule_key(make), device_rule_key(model))
    rule = db.get(DeviceRule, key)
    if rule is None:
        rule = DeviceRule(user_id=key[0], make_key=key[1], model_key=key[2], make=make, model=model)
        db.add(rule)
    rule.device_name, rule.manufacturer, rule.category = name, maker, payload.category
    db.commit()
    return change_device_rule(db, context.user.id, background)


@app.delete('/me/device-rules')
def delete_device_rule(make: str, model: str, background: BackgroundTasks, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    state = db.get(SyncState, context.user.id)
    if state and state.running:
        raise HTTPException(409, "Please wait until the current sync finishes.")
    rule = db.get(DeviceRule, (context.user.id, device_rule_key(make), device_rule_key(model)))
    if rule:
        db.delete(rule)
        db.commit()
        return change_device_rule(db, context.user.id, background)
    return {'recalculating': False}


def export_state(db: Session, user_id: int) -> SyncState:
    state = db.get(SyncState, user_id)
    if not state or not state.revision:
        raise HTTPException(409, "No snapshot yet. Please start a refresh.")
    return state


@app.get('/me/export/sqlite/info')
def sqlite_export_info(context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    state = export_state(db, context.user.id)
    revision = state.revision
    cached = db.get(ExportSize, context.user.id)
    if cached and cached.revision == revision:
        return {'size_bytes': cached.size_bytes, 'asset_count': cached.asset_count, 'summary_count': cached.summary_count, 'revision': revision}
    path, assets, summaries = create_sqlite_export(db, context.user.id, state)
    try:
        size = os.path.getsize(path)
        db.refresh(state)
        if state.revision != revision:
            raise HTTPException(409, "Snapshot changed during export. Please try again.")
        if cached is None:
            db.add(ExportSize(user_id=context.user.id, revision=revision, size_bytes=size, asset_count=assets, summary_count=summaries))
        else:
            cached.revision, cached.size_bytes, cached.asset_count, cached.summary_count = revision, size, assets, summaries
        db.commit()
        return {'size_bytes': size, 'asset_count': assets, 'summary_count': summaries, 'revision': revision}
    finally:
        os.unlink(path)


@app.get('/me/export/sqlite')
def sqlite_export(context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    state = export_state(db, context.user.id)
    path, _, _ = create_sqlite_export(db, context.user.id, state)
    return FileResponse(
        path, media_type='application/vnd.sqlite3', filename='immich-insights.sqlite',
        background=BackgroundTask(os.unlink, path),
    )


@app.get('/me/export/reports/info')
def report_export_info(context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    state = export_state(db, context.user.id)
    summary = db.get(CachedSummary, (context.user.id, 'all'))
    if summary is None:
        raise HTTPException(409, "No statistics available yet.")
    sizes = {}
    for fmt in ('pdf', 'csv', 'jpg'):
        cached = db.get(ReportSize, (context.user.id, state.revision, fmt))
        if cached is None:
            cached = ReportSize(user_id=context.user.id, revision=state.revision, format=fmt,
                                size_bytes=len(create_report(summary.payload, fmt)))
            db.add(cached)
        sizes[fmt] = cached.size_bytes
    db.commit()
    return {'revision': state.revision, 'sizes': sizes}


@app.get('/me/export/report/{format}')
def report_export(format: str, context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    if format not in ('pdf', 'csv', 'jpg'):
        raise HTTPException(404, "Unknown export format.")
    export_state(db, context.user.id)
    summary = db.get(CachedSummary, (context.user.id, 'all'))
    if summary is None:
        raise HTTPException(409, "No statistics available yet.")
    media = {'pdf': 'application/pdf', 'csv': 'text/csv; charset=utf-8', 'jpg': 'image/jpeg'}
    return Response(content=create_report(summary.payload, format), media_type=media[format],
                    headers={'Content-Disposition': f'attachment; filename="immich-insights-report.{format}"'})


@app.post('/me/sync', status_code=202)
def start_sync(background: BackgroundTasks, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    immich_for(context.user)
    if claim(db, context.user.id):
        background.add_task(synchronize, context.user.id)
    return {'accepted': True}


@app.post("/me/assets/query")
def asset_drilldown(query: AssetQueryInput, context: AuthContext = Depends(csrf_auth), db: Session = Depends(get_db)):
    export_state(db, context.user.id)
    return query_assets(db, context.user.id, query)


@app.get("/me/assets/{asset_id}/thumbnail")
async def thumbnail(asset_id: str, context: AuthContext = Depends(current_auth), db: Session = Depends(get_db)):
    if db.get(CachedAsset, (context.user.id, asset_id)) is None:
        raise HTTPException(404, "Image not found.")
    client = immich_for(context.user)
    try:
        image = await client.thumbnail_cached(asset_id)
    except (ImmichPermissionError, httpx.HTTPError) as error:
        raise immich_error(error)
    return Response(content=image.content, media_type=image.headers.get("content-type", "image/jpeg"))


@app.get("/me/avatar")
async def avatar(context: AuthContext = Depends(current_auth)):
    if not context.user.immich_user_id:
        raise HTTPException(404, "No Immich profile image available.")
    try:
        image = await immich_for(context.user).avatar(context.user.immich_user_id)
    except (ImmichPermissionError, httpx.HTTPError):
        raise HTTPException(404, "No Immich profile image available.")
    return Response(content=image.content, media_type=image.headers.get("content-type", "image/jpeg"))
