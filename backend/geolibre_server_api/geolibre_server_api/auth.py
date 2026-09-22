"""Authentication and scoped personal tokens for the projects API."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Callable, Iterator, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from geolibre_server_api.auth_models import Account, PersonalTokenPolicy, Token

PROJECT_SCOPES = ("read:projects", "write:projects", "share:public")
SCOPE_ORDER = PROJECT_SCOPES
PAT_DEFAULT_DAYS = 90
PAT_MAX_DAYS = 365

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,37}[a-z0-9]$")


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def iso_ts(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, UTC).isoformat().replace("+00:00", "Z")


def password_hash(password: str, salt: bytes | None = None) -> str:
    if not password:
        raise ValueError("password is required")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def password_matches(password: str, encoded: str) -> bool:
    try:
        _, salt, expected = encoded.split("$")
        return hmac.compare_digest(
            password_hash(password, bytes.fromhex(salt)).split("$")[2], expected
        )
    except (ValueError, TypeError):
        return False


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def account_json(account: Account) -> dict:
    return {"id": account.id, "username": account.username, "createdAt": account.created_at}


@dataclass(frozen=True)
class AuthPrincipal:
    account: Account
    kind: Literal["legacy-pat", "pat"]
    scopes: frozenset[str]
    credential_id: str


class InsufficientScopeError(HTTPException):
    def __init__(self, scope: str):
        super().__init__(
            status_code=403,
            detail="insufficient_scope",
            headers={"WWW-Authenticate": 'Bearer error="insufficient_scope"'},
        )
        self.required_scope = scope


def get_clock(request: Request) -> Callable[[], int]:
    return request.app.state.clock


def get_session(request: Request) -> Iterator[Session]:
    factory: sessionmaker = request.app.state.session_factory
    with factory() as session:
        yield session


def bearer_challenge(error: str | None = None) -> dict[str, str]:
    value = "Bearer" if error is None else f'Bearer error="{error}"'
    return {"WWW-Authenticate": value}


def touch_policy(session: Session, digest: str, now_ts: int) -> None:
    result = session.execute(
        update(PersonalTokenPolicy)
        .where(
            PersonalTokenPolicy.token_digest == digest,
            or_(
                PersonalTokenPolicy.last_used_at.is_(None),
                PersonalTokenPolicy.last_used_at < now_ts - 60,
            ),
        )
        .values(last_used_at=now_ts)
    )
    if result.rowcount:
        session.commit()


def backfill_policy(session: Session, digest: str) -> PersonalTokenPolicy:
    """Create legacy PAT metadata without racing another request."""
    policy = PersonalTokenPolicy(
        id=str(uuid.uuid4()),
        token_digest=digest,
        label="Legacy personal token",
        scope=" ".join(PROJECT_SCOPES),
        legacy=True,
    )
    try:
        with session.begin_nested():
            session.add(policy)
            session.flush()
    except IntegrityError:
        existing = session.scalar(
            select(PersonalTokenPolicy).where(PersonalTokenPolicy.token_digest == digest)
        )
        if existing is None:
            raise
        return existing
    session.commit()
    return policy


def optional_principal(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    session: Session = Depends(get_session),
) -> AuthPrincipal | None:
    """Resolve a Bearer PAT, or return ``None`` when no credential was supplied."""
    if not authorization:
        return None
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "invalid authorization", headers=bearer_challenge("invalid_token"))

    digest = token_digest(authorization[7:])
    token_row = session.get(Token, digest)
    if token_row is None:
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )

    policy = session.scalar(
        select(PersonalTokenPolicy).where(PersonalTokenPolicy.token_digest == digest)
    )
    if policy is None:
        policy = backfill_policy(session, digest)

    now_ts = get_clock(request)()
    if policy.revoked_at is not None or (
        policy.expires_at is not None and policy.expires_at <= now_ts
    ):
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )

    account = session.get(Account, token_row.account_id)
    if account is None:
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )

    touch_policy(session, digest, now_ts)
    return AuthPrincipal(
        account=account,
        kind="legacy-pat" if policy.legacy else "pat",
        scopes=frozenset(policy.scope.split()),
        credential_id=digest,
    )


def required_principal(
    principal: AuthPrincipal | None = Depends(optional_principal),
) -> AuthPrincipal:
    if principal is None:
        raise HTTPException(401, "authentication required", headers=bearer_challenge())
    return principal


def ensure_scope(principal: AuthPrincipal, scope: str) -> None:
    if scope not in principal.scopes:
        raise InsufficientScopeError(scope)


def require_scope(scope: str):
    def dependency(principal: AuthPrincipal = Depends(required_principal)) -> AuthPrincipal:
        ensure_scope(principal, scope)
        return principal

    return dependency


def validate_pat_scopes(scopes: list[str] | None) -> str:
    if scopes is None:
        selected = list(PROJECT_SCOPES)
    else:
        if not scopes or any(not isinstance(scope, str) or not scope for scope in scopes):
            raise HTTPException(400, "invalid_scope")
        if any(scope not in PROJECT_SCOPES for scope in scopes):
            raise HTTPException(400, "invalid_scope")
        selected = list(dict.fromkeys(scopes))
    return " ".join(selected)


def issue_token(
    session: Session,
    account: Account,
    *,
    name: str | None = None,
    scopes: list[str] | None = None,
    expires_in_days: int | None = None,
    clock: Callable[[], int],
    commit: bool = True,
) -> tuple[str, dict]:
    """Mint a PAT and its policy row in one transaction."""
    value = secrets.token_urlsafe(32)
    digest = token_digest(value)
    now_ts = clock()
    days = PAT_DEFAULT_DAYS if expires_in_days is None else expires_in_days
    expires_at = now_ts + days * 86400
    scope_str = validate_pat_scopes(scopes)
    policy = PersonalTokenPolicy(
        id=str(uuid.uuid4()),
        token_digest=digest,
        label=(name or "Personal token")[:100],
        scope=scope_str,
        expires_at=expires_at,
        legacy=False,
    )
    session.add(Token(digest=digest, account_id=account.id, created_at=now()))
    session.flush()
    session.add(policy)
    if commit:
        session.commit()
    return value, {
        "scopes": scope_str.split(),
        "expiresAt": iso_ts(expires_at),
        "tokenId": policy.id,
    }


class TokenIssueRequest(BaseModel):
    username: str = Field(max_length=39)
    password: str = Field(max_length=1024)
    name: str | None = Field(default=None, max_length=100)
    scopes: list[str] | None = None
    expiresInDays: int | None = None


def _validate_pat_lifetime(days: int | None) -> None:
    if days is not None and not (1 <= days <= PAT_MAX_DAYS):
        raise HTTPException(400, "invalid_scope")


def build_identity_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/accounts", status_code=201)
    def create_account(
        body: TokenIssueRequest,
        request: Request,
        session: Session = Depends(get_session),
    ):
        _validate_pat_lifetime(body.expiresInDays)
        validate_pat_scopes(body.scopes)
        username = body.username.strip()
        if not USERNAME_RE.fullmatch(username):
            raise HTTPException(422, "username must be 3-39 lowercase letters, digits, or hyphens")
        if len(body.password) < 8:
            raise HTTPException(422, "password must be at least 8 characters")
        if session.scalar(select(Account.id).where(Account.username == username)):
            raise HTTPException(409, "username already exists")

        account = Account(
            id=str(uuid.uuid4()),
            username=username,
            password_hash=password_hash(body.password),
            created_at=now(),
        )
        session.add(account)
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "username already exists") from None

        token, extra = issue_token(
            session,
            account,
            name=body.name,
            scopes=body.scopes,
            expires_in_days=body.expiresInDays,
            clock=get_clock(request),
            commit=False,
        )
        session.commit()
        return {"account": account_json(account), "token": token, **extra}

    @router.post("/api/auth/token")
    def login(
        body: TokenIssueRequest,
        request: Request,
        session: Session = Depends(get_session),
    ):
        _validate_pat_lifetime(body.expiresInDays)
        account = session.scalar(select(Account).where(Account.username == body.username))
        if account is None:
            password_hash(body.password or "unused")
            raise HTTPException(401, "invalid username or password")
        if not password_matches(body.password, account.password_hash):
            raise HTTPException(401, "invalid username or password")
        token, extra = issue_token(
            session,
            account,
            name=body.name,
            scopes=body.scopes,
            expires_in_days=body.expiresInDays,
            clock=get_clock(request),
        )
        return {"account": account_json(account), "token": token, **extra}

    @router.delete("/api/auth/token", status_code=204)
    def revoke(
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        session.execute(delete(Token).where(Token.digest == principal.credential_id))
        session.commit()

    @router.get("/api/account")
    def get_account(principal: AuthPrincipal = Depends(required_principal)):
        return {"account": account_json(principal.account)}

    @router.get("/api/users/me")
    def get_current_user(principal: AuthPrincipal = Depends(required_principal)):
        return {
            "user": account_json(principal.account),
            "scopes": sorted(principal.scopes, key=SCOPE_ORDER.index),
        }

    return router
