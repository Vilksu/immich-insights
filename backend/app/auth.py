import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, Request, Response
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import LoginSession, User
from .schemas import AuthOut, UserOut


COOKIE_NAME = "insights_session"
SESSION_DAYS = 7
ICONS = {"camera", "mountain", "sun", "flower", "star", "heart", "leaf", "film", "immich"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, salt_hex, digest_hex = stored.split("$")
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
        return hmac.compare_digest(candidate, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id, email=user.email, name=user.name, is_admin=user.is_admin,
        profile_icon=user.profile_icon, immich_url=user.immich_url,
        has_api_key=bool(user.encrypted_api_key), has_immich_avatar=bool(user.immich_user_id),
    )


def issue_session(db: Session, user: User, response: Response) -> AuthOut:
    token = secrets.token_urlsafe(40)
    csrf = secrets.token_urlsafe(32)
    db.add(LoginSession(token_hash=token_hash(token), user_id=user.id, csrf_token=csrf, expires_at=utcnow() + timedelta(days=SESSION_DAYS)))
    db.commit()
    response.set_cookie(
        COOKIE_NAME, token, max_age=SESSION_DAYS * 86400, httponly=True,
        secure=get_settings().app_cookie_secure, samesite="lax", path="/",
    )
    return AuthOut(user=user_out(user), csrf_token=csrf)


@dataclass
class AuthContext:
    user: User
    session: LoginSession


def current_auth(request: Request, db: Session = Depends(get_db)) -> AuthContext:
    token = request.cookies.get(COOKIE_NAME)
    session = db.get(LoginSession, token_hash(token)) if token else None
    if not session or aware(session.expires_at) <= utcnow():
        raise HTTPException(401, "Please sign in.")
    user = db.get(User, session.user_id)
    if not user or not user.password_hash:
        raise HTTPException(401, "Please sign in again.")
    return AuthContext(user, session)


def csrf_auth(context: AuthContext = Depends(current_auth), x_csrf_token: str | None = Header(default=None)) -> AuthContext:
    if not x_csrf_token or not hmac.compare_digest(x_csrf_token, context.session.csrf_token):
        raise HTTPException(403, "Invalid form protection. Reload the page.")
    return context


def admin_auth(context: AuthContext = Depends(csrf_auth)) -> AuthContext:
    if not context.user.is_admin:
        raise HTTPException(403, "Only the admin can invite users.")
    return context
