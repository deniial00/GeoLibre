"""Organization-administrator routes for enterprise sign-in settings."""

from __future__ import annotations

import ipaddress
import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from geolibre_server_api.auth import AuthPrincipal, get_clock, get_session, require_scope
from geolibre_server_api.enterprise_models import OrganizationSecurityPolicy
from geolibre_server_api.policy import require_organization_admin
from geolibre_server_api.proxy_identity import client_ip


class SecurityPolicyBody(BaseModel):
    """Full replacement of an organization's security policy; omitted = unset."""

    idle_timeout_seconds: int | None = Field(
        default=None, alias="idleTimeoutSeconds", ge=300, le=2592000
    )
    absolute_session_seconds: int | None = Field(
        default=None, alias="absoluteSessionSeconds", ge=900, le=31536000
    )
    admin_reauth_seconds: int | None = Field(
        default=None, alias="adminReauthSeconds", ge=60, le=86400
    )
    password_min_length: int | None = Field(default=None, alias="passwordMinLength", ge=8, le=128)
    password_min_classes: int | None = Field(default=None, alias="passwordMinClasses", ge=1, le=4)
    password_max_age_days: int | None = Field(
        default=None, alias="passwordMaxAgeDays", ge=1, le=3650
    )
    lockout_threshold: int | None = Field(default=None, alias="lockoutThreshold", ge=3, le=100)
    lockout_seconds: int | None = Field(default=None, alias="lockoutSeconds", ge=60, le=86400)
    admin_ip_allowlist: list[str] = Field(
        default_factory=list, alias="adminIpAllowlist", max_length=50
    )

    model_config = {"extra": "forbid", "populate_by_name": True}


def security_policy_json(row: OrganizationSecurityPolicy | None) -> dict:
    if row is None:
        return {
            "idleTimeoutSeconds": None,
            "absoluteSessionSeconds": None,
            "adminReauthSeconds": None,
            "adminIpAllowlist": [],
            "passwordMinLength": None,
            "passwordMinClasses": None,
            "passwordMaxAgeDays": None,
            "lockoutThreshold": None,
            "lockoutSeconds": None,
        }
    return {
        "idleTimeoutSeconds": row.idle_timeout_seconds,
        "absoluteSessionSeconds": row.absolute_session_seconds,
        "adminReauthSeconds": row.admin_reauth_seconds,
        "adminIpAllowlist": json.loads(row.admin_ip_allowlist_json or "[]"),
        "passwordMinLength": row.password_min_length,
        "passwordMinClasses": row.password_min_classes,
        "passwordMaxAgeDays": row.password_max_age_days,
        "lockoutThreshold": row.lockout_threshold,
        "lockoutSeconds": row.lockout_seconds,
    }


def build_enterprise_admin_router() -> APIRouter:
    """Build the per-organization enterprise sign-in administration routes."""
    router = APIRouter()

    @router.get("/api/organizations/{organization_id}/security-policy")
    def get_security_policy(
        organization_id: str,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=False)
        response.headers["Cache-Control"] = "private, no-store"
        row = session.get(OrganizationSecurityPolicy, organization_id)
        return {"securityPolicy": security_policy_json(row)}

    @router.put("/api/organizations/{organization_id}/security-policy")
    def put_security_policy(
        organization_id: str,
        body: SecurityPolicyBody,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        response.headers["Cache-Control"] = "private, no-store"
        networks = []
        for entry in body.admin_ip_allowlist:
            try:
                networks.append(ipaddress.ip_network(entry.strip(), strict=False))
            except ValueError:
                raise HTTPException(
                    422, "adminIpAllowlist entries must be IP addresses or networks"
                ) from None
        if (body.lockout_threshold is None) != (body.lockout_seconds is None):
            raise HTTPException(422, "lockoutThreshold and lockoutSeconds must be set together")
        if networks:
            address = client_ip(request)
            if address is None or not any(address in network for network in networks):
                raise HTTPException(422, "adminIpAllowlist must include your current address")

        row = session.get(OrganizationSecurityPolicy, organization_id)
        if row is None:
            row = OrganizationSecurityPolicy(organization_id=organization_id)
            session.add(row)
        row.idle_timeout_seconds = body.idle_timeout_seconds
        row.absolute_session_seconds = body.absolute_session_seconds
        row.admin_reauth_seconds = body.admin_reauth_seconds
        row.password_min_length = body.password_min_length
        row.password_min_classes = body.password_min_classes
        row.password_max_age_days = body.password_max_age_days
        row.lockout_threshold = body.lockout_threshold
        row.lockout_seconds = body.lockout_seconds
        row.admin_ip_allowlist_json = json.dumps([str(network) for network in networks])
        row.updated_at = get_clock(request)()
        session.commit()
        return {"securityPolicy": security_policy_json(row)}

    return router
