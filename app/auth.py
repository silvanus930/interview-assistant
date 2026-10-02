"""Passwords, login sessions and the per-user key the browser extension signs in with."""

import hashlib
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request, Response

from . import db
from .config import SESSION_DAYS

SESSION_COOKIE = "ia_session"
# scrypt cost parameters (interactive-login strength)
_N, _R, _P, _KEY_LEN = 2**14, 8, 1, 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_KEY_LEN)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=_N, r=_R, p=_P, dklen=_KEY_LEN)
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(digest, bytes.fromhex(digest_hex))


_DUMMY_HASH = hash_password(secrets.token_hex(16))


def new_extension_key() -> str:
    return secrets.token_urlsafe(24)


def _token_hash(token: str) -> str:
    # Only the hash is stored, so a copy of the database cannot be used to log in.
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(response: Response, request: Request, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    db.create_session(_token_hash(token), user_id, expires.isoformat(timespec="seconds"))
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax",
        secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https",
    )


def end_session(response: Response, request: Request) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.delete_session(_token_hash(token))
    response.delete_cookie(SESSION_COOKIE)


def session_user(request: Request) -> dict[str, Any] | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    user = db.get_session_user(_token_hash(token))
    return user if user and user["is_active"] else None


# ------------------------------------------------------------ dependencies

def signed_in(request: Request) -> dict[str, Any]:
    """The person who is logged in, whoever they are acting as."""
    user = session_user(request)
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    return user


def current_user(request: Request) -> dict[str, Any]:
    """Whose workspace this request works in.

    Normally the signed-in user. An admin may open another user's workspace by
    sending `X-Act-As: <user id>`; everything they do then applies to that user.
    """
    user = signed_in(request)
    act_as = request.headers.get("x-act-as")
    if act_as and user["role"] == "admin" and act_as.isdigit() and int(act_as) != user["id"]:
        target = db.get_user(int(act_as))
        if target is None:
            raise HTTPException(404, "That user no longer exists.")
        return target
    return user


def admin_user(request: Request) -> dict[str, Any]:
    user = signed_in(request)
    if user["role"] != "admin":
        raise HTTPException(403, "Only an administrator can do this.")
    return user


def extension_user(request: Request) -> dict[str, Any]:
    """The user a browser extension is signed in as, from its connection key."""
    key = request.headers.get("x-extension-key", "")
    user = db.get_user_by_key(key) if key else None
    if user is None or not user["is_active"]:
        raise HTTPException(401, "Not signed in. Open the extension settings and sign in again.")
    return user


# ------------------------------------------------------------ login limiter

class LoginLimiter:
    """Slows password guessing: after too many recent failures for a key, sign-in pauses."""

    def __init__(self, attempts: int, window_seconds: int = 600) -> None:
        self.attempts, self.window = attempts, window_seconds
        self._failures: dict[str, list[float]] = defaultdict(list)

    def _recent(self, key: str) -> list[float]:
        cutoff = time.monotonic() - self.window
        self._failures[key] = [t for t in self._failures[key] if t > cutoff]
        return self._failures[key]

    def check(self, key: str) -> None:
        if len(self._recent(key)) >= self.attempts:
            raise HTTPException(429, "Too many failed sign-in attempts. Wait a few minutes and try again.")

    def failed(self, key: str) -> None:
        self._recent(key).append(time.monotonic())

    def succeeded(self, key: str) -> None:
        self._failures.pop(key, None)


# Tight per account; looser per address, because many people can share one
# address (an office, or a reverse proxy in front of this server).
account_limiter = LoginLimiter(attempts=8)
address_limiter = LoginLimiter(attempts=40)


def authenticate(request: Request, email: str, password: str) -> dict[str, Any]:
    """Check an email and password. Raises the same error for every kind of failure."""
    email = email.strip().lower()
    address = request.client.host if request.client else "unknown"
    account_limiter.check(email)
    address_limiter.check(address)
    user = db.get_user_by_email(email)
    # Verify against a dummy hash when the account does not exist, so timing
    # does not reveal which emails are registered.
    ok = verify_password(password, user["password_hash"] if user else _DUMMY_HASH)
    if not user or not ok or not user["is_active"]:
        account_limiter.failed(email)
        address_limiter.failed(address)
        raise HTTPException(401, "Wrong email or password.")
    account_limiter.succeeded(email)
    db.update_user(user["id"], last_login_at=db.now())
    return user
