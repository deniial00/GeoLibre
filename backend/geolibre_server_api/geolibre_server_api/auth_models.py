"""Authentication ORM models for the projects and identity API.

The project models remain in ``main.py`` and share this module's ``Base``
metadata. Keeping the identity models here lets ``auth.py`` provide reusable
FastAPI dependencies and routes without importing ``main.py``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

if TYPE_CHECKING:
    from geolibre_server_api.main import Project  # noqa: F401


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str | None] = mapped_column(String(39), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32))
    projects: Mapped[list["Project"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Token(Base):
    """A personal API token's identity row.

    Only the SHA-256 digest of the raw token is stored. Scope, expiry, and
    revocation metadata live in ``PersonalTokenPolicy`` so existing databases
    do not need columns added to the legacy ``tokens`` table.
    """

    __tablename__ = "tokens"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[str] = mapped_column(String(32))


class PersonalTokenPolicy(Base):
    """Policy metadata for one personal API token.

    Pre-existing tokens receive a legacy policy with all project scopes and no
    expiry when first used, preserving their existing permissions.
    """

    __tablename__ = "personal_token_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    token_digest: Mapped[str] = mapped_column(
        ForeignKey("tokens.digest", ondelete="CASCADE"), unique=True
    )
    label: Mapped[str] = mapped_column(String(100))
    scope: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    legacy: Mapped[bool] = mapped_column(Boolean, default=False)
