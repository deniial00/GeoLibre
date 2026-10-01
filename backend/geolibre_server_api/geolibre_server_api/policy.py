"""Organization security policy: the effective (strictest) policy and enforcement helpers."""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

from fastapi import HTTPException, Request
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geolibre_server_api.enterprise_models import (
    AccountSecurity,
    OrganizationIdentityProvider,
    OrganizationSecurityPolicy,
)
from geolibre_server_api.org_models import Organization, OrganizationMember
from geolibre_server_api.proxy_identity import client_ip

if TYPE_CHECKING:
    from geolibre_server_api.auth import AuthPrincipal


@dataclass(frozen=True)
class EffectivePolicy:
    idle_timeout: int | None = None
    absolute_lifetime: int | None = None
    password_min_length: int = 8
    password_min_classes: int = 0
    password_max_age_days: int | None = None
    lockout_threshold: int | None = None
    lockout_seconds: int | None = None


def effective_policy(session: Session, account_id: str) -> EffectivePolicy:
    """Combine the policies of every org the account belongs to; the strictest wins."""
    P = OrganizationSecurityPolicy
    row = session.execute(
        select(
            func.min(P.idle_timeout_seconds),
            func.min(P.absolute_session_seconds),
            func.min(P.password_max_age_days),
            func.min(P.lockout_threshold),
            func.max(P.password_min_length),
            func.max(P.password_min_classes),
            func.max(P.lockout_seconds),
        )
        .select_from(OrganizationMember)
        .join(P, P.organization_id == OrganizationMember.organization_id)
        .where(OrganizationMember.account_id == account_id)
    ).one()
    idle, absolute, max_age, threshold, min_length, min_classes, lockout_seconds = row
    return EffectivePolicy(
        idle_timeout=idle,
        absolute_lifetime=absolute,
        password_min_length=max(8, min_length or 8),
        password_min_classes=min_classes or 0,
        password_max_age_days=max_age,
        lockout_threshold=threshold,
        lockout_seconds=lockout_seconds,
    )


def organization_role(session: Session, organization_id: str, account_id: str) -> str | None:
    return session.scalar(
        select(OrganizationMember.role).where(
            OrganizationMember.organization_id == organization_id,
            OrganizationMember.account_id == account_id,
        )
    )


def require_organization_admin(
    session: Session,
    organization_id: str,
    principal: AuthPrincipal,
    request: Request,
    *,
    mutation: bool,
) -> Organization:
    """Require an administrator, honoring this org's IP allowlist and re-auth window."""
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(404, "organization not found")
    if organization_role(session, organization_id, principal.account.id) != "administrator":
        raise HTTPException(403, "organization administrator permission required")
    org_policy = session.get(OrganizationSecurityPolicy, organization_id)
    if org_policy is None:
        return organization
    allowlist = json.loads(org_policy.admin_ip_allowlist_json or "[]")
    if allowlist:
        address = client_ip(request)
        if address is None or not any(
            address in ipaddress.ip_network(entry, strict=False) for entry in allowlist
        ):
            raise HTTPException(403, "administrative access is not allowed from this network")
    max_age = org_policy.admin_reauth_seconds
    if mutation and max_age:
        now_ts = request.app.state.clock()
        if now_ts - principal.authenticated_at > max_age:
            raise HTTPException(
                401,
                "reauthentication_required",
                headers={
                    "WWW-Authenticate": (
                        f'Bearer error="insufficient_user_authentication", max_age="{max_age}"'
                    )
                },
            )
    return organization


def ensure_account_security(session: Session, account_id: str) -> AccountSecurity:
    """Get or lazily create the account's security row without committing."""
    existing = session.get(AccountSecurity, account_id)
    if existing is not None:
        return existing
    row = AccountSecurity(account_id=account_id, status="active", failed_login_count=0)
    try:
        # The savepoint keeps the request transaction usable when a concurrent
        # request wins the primary-key insert.
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = session.get(AccountSecurity, account_id, populate_existing=True)
        if existing is None:
            raise
        return existing
    return row


def password_policy_error(password: str, policy: EffectivePolicy) -> str | None:
    """Return the first complexity rule the password breaks, or None."""
    if len(password) < policy.password_min_length:
        return f"password must be at least {policy.password_min_length} characters"
    classes = 0
    classes += any("a" <= ch <= "z" for ch in password)
    classes += any("A" <= ch <= "Z" for ch in password)
    classes += any("0" <= ch <= "9" for ch in password)
    classes += any(not (ch.isascii() and ch.isalnum()) for ch in password)
    if classes < policy.password_min_classes:
        return (
            f"password must use at least {policy.password_min_classes} of: "
            "lowercase, uppercase, digits, symbols"
        )
    return None


def record_failed_login(
    session: Session, account_id: str, now_ts: int, policy: EffectivePolicy
) -> None:
    """Atomically count a failed password attempt and lock the account at the threshold."""
    ensure_account_security(session, account_id)
    count = session.execute(
        update(AccountSecurity)
        .where(AccountSecurity.account_id == account_id)
        .values(failed_login_count=AccountSecurity.failed_login_count + 1)
        .returning(AccountSecurity.failed_login_count)
    ).scalar_one()
    if policy.lockout_threshold and count >= policy.lockout_threshold:
        session.execute(
            update(AccountSecurity)
            .where(AccountSecurity.account_id == account_id)
            .values(locked_until=now_ts + (policy.lockout_seconds or 0), failed_login_count=0)
        )
    session.commit()


def record_successful_login(session: Session, account_id: str, now_ts: int) -> None:
    """Reset lockout counters; start the rotation clock the first time it is seen."""
    security = ensure_account_security(session, account_id)
    security.failed_login_count = 0
    security.locked_until = None
    if security.password_changed_at is None:
        security.password_changed_at = now_ts
    session.commit()


def credential_expired(
    policy: EffectivePolicy, *, authenticated_at: int, last_activity_at: int, now_ts: int
) -> bool:
    """True when the idle or absolute session limit has passed."""
    if policy.absolute_lifetime and authenticated_at + policy.absolute_lifetime <= now_ts:
        return True
    return bool(policy.idle_timeout and now_ts - last_activity_at > policy.idle_timeout)


def password_login_allowed(session: Session, account_id: str) -> bool:
    """False when an org of the account requires SSO and it is not that org's break-glass admin."""
    provider = OrganizationIdentityProvider
    blocking = session.execute(
        select(provider.break_glass_account_id, OrganizationMember.role)
        .join(OrganizationMember, OrganizationMember.organization_id == provider.organization_id)
        .where(
            OrganizationMember.account_id == account_id,
            provider.enabled.is_(True),
            provider.allow_builtin_accounts.is_(False),
        )
    ).all()
    return all(
        break_glass == account_id and role == "administrator" for break_glass, role in blocking
    )


def require_not_break_glass(session: Session, organization_id: str, account_id: str) -> None:
    """Refuse to demote or remove the org's break-glass account; clear it on the provider first."""
    break_glass = session.scalar(
        select(OrganizationIdentityProvider.id).where(
            OrganizationIdentityProvider.organization_id == organization_id,
            OrganizationIdentityProvider.break_glass_account_id == account_id,
        )
    )
    if break_glass is not None:
        raise HTTPException(422, "account is the organization's break-glass administrator")
