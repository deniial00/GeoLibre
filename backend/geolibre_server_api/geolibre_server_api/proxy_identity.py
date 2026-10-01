"""Trusted reverse proxies and the client address seen through them."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network

from fastapi import Request


@dataclass(frozen=True)
class TrustedProxyConfig:
    networks: tuple[IPv4Network | IPv6Network, ...]
    user_header: str
    email_header: str


def load_trusted_proxy_config() -> TrustedProxyConfig:
    """Read ``GEOLIBRE_TRUSTED_PROXIES`` and the proxy identity header names."""
    networks: list[IPv4Network | IPv6Network] = []
    for raw in os.getenv("GEOLIBRE_TRUSTED_PROXIES", "").split(","):
        entry = raw.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError as exc:
            raise RuntimeError(
                f"GEOLIBRE_TRUSTED_PROXIES entry {entry!r} is not an IP network"
            ) from exc
    return TrustedProxyConfig(
        networks=tuple(networks),
        user_header=os.getenv("GEOLIBRE_PROXY_USER_HEADER", "Remote-User"),
        email_header=os.getenv("GEOLIBRE_PROXY_EMAIL_HEADER", "Remote-Email"),
    )


def _parse_ip(value: str | None) -> IPv4Address | IPv6Address | None:
    if value is None:
        return None
    try:
        return ipaddress.ip_address(value.strip())
    except ValueError:
        return None


def _trusted(config: TrustedProxyConfig, address: IPv4Address | IPv6Address) -> bool:
    return any(address in network for network in config.networks)


def peer_trusted(request: Request) -> bool:
    """True when the direct peer is one of the configured trusted proxies."""
    if request.client is None:
        return False
    address = _parse_ip(request.client.host)
    if address is None:
        return False
    return _trusted(request.app.state.trusted_proxy, address)


def client_ip(request: Request) -> IPv4Address | IPv6Address | None:
    """Return the originating client address, honoring trusted ``X-Forwarded-For``."""
    if request.client is None:
        return None
    peer = _parse_ip(request.client.host)
    if not peer_trusted(request):
        return peer
    config: TrustedProxyConfig = request.app.state.trusted_proxy
    forwarded = request.headers.get("x-forwarded-for", "")
    for raw in reversed(forwarded.split(",") if forwarded else []):
        address = _parse_ip(raw)
        if address is None:
            return None
        if not _trusted(config, address):
            return address
    return peer
