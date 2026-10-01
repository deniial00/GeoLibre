"""Enterprise sign-in ORM models: account security state and org security policy.

Foreign keys are plain strings with no relationships, like ``auth_models``.
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from geolibre_server_api.auth_models import Base


class AccountSecurity(Base):
    """Per-account security state, created lazily (no row = active, no counters)."""

    __tablename__ = "account_security"

    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[str] = mapped_column(String(16), default="active")
    deactivated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_changed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[int | None] = mapped_column(Integer, nullable=True)
    managed_by_organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True
    )


class OrganizationSecurityPolicy(Base):
    """One organization's security policy; unset values impose no constraint."""

    __tablename__ = "organization_security_policies"

    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    idle_timeout_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    absolute_session_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    admin_reauth_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_min_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_min_classes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_max_age_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lockout_threshold: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lockout_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    admin_ip_allowlist_json: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[int] = mapped_column(Integer)
