"""Build and validate the deployment policy the container serves.

``entrypoint.sh`` runs this module on every boot to write
``/usr/share/nginx/html/deployment.json``: the mounted ``GEOLIBRE_DEPLOYMENT_FILE``
(or an empty ``{"version": 1}``) with environment overrides applied per field. The
rules mirror ``schema/deployment.schema.json``, which stays the source of truth;
``docker/tests/test_deployment_policy.py`` fails when the two drift.

The client parser is lenient (it drops what it does not understand); this
validator is strict, so a bad file fails the boot with an ``ERROR:`` naming the
JSON path instead of silently serving a weaker policy.

The env validators (``service_url``, ``read_services_file`` and friends) are shared
with the ``geolibre-runtime-config.js`` generation in ``entrypoint.sh``, so the
env var and the policy field can never disagree about what is valid.

The file is public. Never put secrets in it.
"""

import json
import math
import os
import re
import sys
from collections.abc import Mapping
from urllib.parse import urlsplit

CAPABILITIES = (
    "project:edit",
    "data:add",
    "processing:run",
    "export:data",
    "plugins:install",
    "settings:manage",
)
EXPERIENCE_LEVELS = ("beginner", "intermediate", "advanced")
SERVICE_KINDS = ("wms", "wfs", "wmts", "xyz", "arcgis", "csw")
APP_NAME_MAX = 60
CATALOG_ENTRY_KEYS = ("id", "name", "kind", "category", "fields")
SHARE_LOOPBACK = ("localhost", "127.0.0.1")
LOOPBACK = ("localhost", "127.0.0.1", "::1")
SAFE_INTEGER = 2**53 - 1

# Section -> {field: value kind}, in schema order.
FIELD_KINDS = {
    "interface": {
        "enabled": "bool",
        "level": "level",
        "lock": "bool",
        "hiddenDataSources": "ids",
        "hiddenPlugins": "ids",
        "hiddenMenus": "ids",
        "hiddenMenuItems": "ids",
    },
    "plugins": {
        "registryUrl": "nonblank",
        "allowed": "ids",
        "blocked": "ids",
        "sideload": "bool",
        "defaultActive": "ids",
    },
    "services": {"builtins": "bool", "catalog": "catalog"},
    "sharing": {"shareUrl": "share", "collabUrl": "collab", "embedOrigins": "origins"},
    "geolens": {"url": "geolens"},
    "ai": {"enabled": "bool", "model": "nonblank"},
    "branding": {"appName": "appname", "welcome": "bool"},
}
# Section -> allowed field names; capabilities is a list, not an object.
SECTION_KEYS = {"capabilities": None, **{s: tuple(f) for s, f in FIELD_KINDS.items()}}

OVERRIDE_SUFFIX = " (overrides GEOLIBRE_DEPLOYMENT_FILE)"


# --- Env validators shared with the runtime-config generation -----------------


def service_url(name, value, schemes, loopback_schemes, loopback_hosts):
    """Validate a self-hosted service URL, or exit with an explanation.

    Every caller sends a credential to the value it is given -- the share and
    collab URLs carry a Bearer token, and a news proxy fronting a Tavily key is
    only worth pointing at over TLS whatever it asks for -- so a plaintext scheme
    is only allowed on loopback (development). The app applies the same rule and
    *refuses* a value it rejects rather than falling back to the public hosted
    service, so a value that reaches the app unvalidated becomes a silently
    disabled feature. Failing the boot instead puts the error where an operator
    will actually see it.
    """
    parsed = urlsplit(value)
    # Both checks below run before the loopback shortcut, so their guarantees hold
    # for every accepted value. That ordering is load-bearing: urlsplit() parses
    # ws://localhost:8080"; ... with hostname "localhost", which would match the
    # loopback allowlist while netloc still carried the rest.
    #
    # Service URLs are echoed to stdout further down, so a credentialed
    # URL would also land in the container logs.
    if parsed.username or parsed.password:
        raise SystemExit(f"ERROR: {name} must not embed credentials.")
    # Character set: netloc is substituted unescaped into the double-quoted CSP
    # add_header value in nginx.conf.template, so anything outside a hostname,
    # port, or IPv6 literal could break out of that string and inject nginx
    # directives. urlsplit() puts everything up to the next /, ? or # into netloc,
    # quotes and semicolons included. Same discipline as GEOLIBRE_TRUSTED_PROXIES
    # (parsed through ipaddress) and GEOLIBRE_AI_PROXY_URL (no path/query/fragment).
    if re.search(r"[^A-Za-z0-9.\-:\[\]]", parsed.netloc):
        raise SystemExit(
            f"ERROR: {name} host may contain only letters, digits, dots, hyphens, "
            f"colons, and brackets, not {parsed.netloc!r}."
        )
    if parsed.scheme in loopback_schemes and parsed.hostname in loopback_hosts:
        return value
    if parsed.scheme not in schemes or not parsed.netloc:
        allowed_hosts = "/".join(loopback_hosts)
        raise SystemExit(
            f"ERROR: {name} must be a {schemes[0]}:// URL "
            f"(or {loopback_schemes[0]}:// on {allowed_hosts}), not {value!r}."
        )
    return value


def is_valid_field_value(value):
    """True for a catalog field value: string, boolean, or finite number.

    Integers must also be within the JavaScript safe-integer range, because the
    browser would silently round anything larger.
    """
    if not isinstance(value, (str, int, float, bool)):
        return False
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > SAFE_INTEGER:
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    return True


def _invalid_json_constant(value):
    raise ValueError("non-finite JSON number")


def read_services_file(path):
    """Read and validate a GEOLIBRE_SERVICES_FILE catalog; return its services."""
    try:
        with open(path, encoding="utf-8") as source:
            catalog = json.load(source, parse_constant=_invalid_json_constant)
    except OSError as error:
        raise SystemExit(
            "ERROR: GEOLIBRE_SERVICES_FILE cannot be read. "
            "Check the mounted file path and read permissions."
        ) from error
    except (ValueError, UnicodeError) as error:
        raise SystemExit(
            "ERROR: GEOLIBRE_SERVICES_FILE must contain valid UTF-8 JSON with a services array."
        ) from error
    if not isinstance(catalog, dict) or not isinstance(catalog.get("services"), list):
        raise SystemExit(
            "ERROR: GEOLIBRE_SERVICES_FILE must contain an object with a services array."
        )
    services = []
    service_ids = set()
    for index, entry in enumerate(catalog["services"], start=1):
        prefix = f"ERROR: GEOLIBRE_SERVICES_FILE services entry {index}"
        if not isinstance(entry, dict):
            raise SystemExit(prefix + " must be an object.")
        for key in ("id", "name"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                raise SystemExit(prefix + f" must have a nonblank string {key}.")
        service_id = entry["id"].strip()
        if service_id in service_ids:
            raise SystemExit(
                prefix + " has a duplicate trimmed id; give every service a unique stable id."
            )
        if entry.get("kind") not in SERVICE_KINDS:
            raise SystemExit(prefix + " kind must be one of: " + ", ".join(SERVICE_KINDS) + ".")
        if "category" in entry and not isinstance(entry["category"], str):
            raise SystemExit(prefix + " category must be a string when present.")
        fields = entry.get("fields")
        if (
            not isinstance(fields, dict)
            or not fields
            or not all(is_valid_field_value(value) for value in fields.values())
        ):
            raise SystemExit(
                prefix
                + " fields must be a nonempty object of strings, booleans, or finite numbers "
                "with integers within the safe-integer range."
            )
        service_ids.add(service_id)
        service = {
            "id": service_id,
            "name": entry["name"].strip(),
            "kind": entry["kind"],
            "fields": fields,
        }
        if "category" in entry:
            service["category"] = entry["category"]
        services.append(service)
    return services


def builtin_services_hidden(raw):
    """True when GEOLIBRE_BUILTIN_SERVICES is "off"; any other nonempty value exits."""
    value = raw.strip().lower()
    if value and value != "off":
        raise SystemExit(
            'ERROR: GEOLIBRE_BUILTIN_SERVICES must be "off" to hide the built-in '
            "starter services, or unset to keep them."
        )
    return value == "off"


def parse_embed_origins(raw):
    """Parse GEOLIBRE_EMBED_ORIGINS into origins (scheme://netloc, or "*").

    postMessage can only be scoped to an origin, so a path/query/fragment on an
    otherwise valid URL is dropped rather than rejected (matching how the app
    parses the same value). Credentials and other schemes are a mistake worth
    failing the boot for, since they can never match a real host.
    """
    origins = []
    for entry in raw.replace(",", " ").split():
        if entry == "*":
            origins.append(entry)
            continue
        parsed = urlsplit(entry)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.netloc
            or parsed.username
            or parsed.password
        ):
            raise SystemExit(
                f"ERROR: GEOLIBRE_EMBED_ORIGINS entry {entry!r} must be an http(s) "
                "origin such as https://portal.example.com."
            )
        origins.append(f"{parsed.scheme}://{parsed.netloc}")
    return origins


def normalize_share_url(raw):
    """Validate a stripped, nonblank GEOLIBRE_SHARE_URL ("off" or an https URL)."""
    if raw.lower() == "off":
        return "off"
    return service_url("GEOLIBRE_SHARE_URL", raw, ("https",), ("http",), SHARE_LOOPBACK)


def normalize_collab_url(raw):
    """Validate a stripped, nonblank GEOLIBRE_COLLAB_URL (a wss URL)."""
    return service_url("GEOLIBRE_COLLAB_URL", raw, ("wss",), ("ws",), LOOPBACK)


def normalize_geolens_url(raw):
    """Validate a stripped, nonblank GEOLIBRE_GEOLENS_URL."""
    setting = raw.lower()
    if setting in ("off", "same-origin"):
        return setting
    if re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?(?:/.*)?", raw):
        raw = f"https://{raw}"
    parsed = urlsplit(raw)
    if parsed.query or parsed.fragment:
        raise SystemExit(
            "ERROR: GEOLIBRE_GEOLENS_URL must not include query parameters or a fragment."
        )
    return service_url("GEOLIBRE_GEOLENS_URL", raw, ("https",), ("http",), LOOPBACK)


# --- New env parsers -----------------------------------------------------------


def parse_capabilities_env(raw):
    """Parse GEOLIBRE_CAPABILITIES: comma-separated names, or "none" for no grants."""
    if raw.strip().lower() == "none":
        return []
    capabilities = []
    for token in (part.strip() for part in raw.split(",")):
        if not token:
            continue
        if token not in CAPABILITIES:
            raise SystemExit(
                f"ERROR: GEOLIBRE_CAPABILITIES entry {token!r} is not a capability. "
                "Accepted values: " + ", ".join(CAPABILITIES) + ", or none."
            )
        if token not in capabilities:
            capabilities.append(token)
    if not capabilities:
        raise SystemExit(
            "ERROR: GEOLIBRE_CAPABILITIES must list capabilities (comma-separated) or be none."
        )
    return capabilities


def normalize_app_name(raw):
    """Collapse whitespace and cut to APP_NAME_MAX code points; return (name, truncated)."""
    name = re.sub(r"\s+", " ", raw).strip()
    if len(name) > APP_NAME_MAX:
        return name[:APP_NAME_MAX].rstrip(), True
    return name, False


# --- Strict policy validation --------------------------------------------------


def fail(label, path, problem):
    where = f"{path} " if path else ""
    raise SystemExit(f"ERROR: {label} {where}{problem}.")


def _validate_ids(label, path, value):
    if not isinstance(value, list):
        fail(label, path, "must be a list of strings")
    seen = set()
    out = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            fail(label, f"{path}[{index}]", "must be a nonblank string")
        item = item.strip()
        if item in seen:
            fail(label, f"{path}[{index}]", "is a duplicate after trimming")
        seen.add(item)
        out.append(item)
    return out


def _no_whitespace(label, path, value):
    if re.search(r"\s", value):
        fail(label, path, "must not contain whitespace")


def _validate_catalog(label, path, value):
    if not isinstance(value, list):
        fail(label, path, "must be a list")
    seen = set()
    out = []
    for index, entry in enumerate(value):
        here = f"{path}[{index}]"
        if not isinstance(entry, dict):
            fail(label, here, "must be an object")
        for key in entry:
            if key not in CATALOG_ENTRY_KEYS:
                fail(label, f"{here}.{key}", "is not a known key")
        for key in ("id", "name"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                fail(label, f"{here}.{key}", "must be a nonblank string")
        if entry.get("kind") not in SERVICE_KINDS:
            fail(label, f"{here}.kind", "must be one of: " + ", ".join(SERVICE_KINDS))
        if "category" in entry and not isinstance(entry["category"], str):
            fail(label, f"{here}.category", "must be a string")
        fields = entry.get("fields")
        if (
            not isinstance(fields, dict)
            or not fields
            or not all(is_valid_field_value(v) for v in fields.values())
        ):
            fail(
                label,
                f"{here}.fields",
                "must be a nonempty object of strings, booleans, or finite numbers "
                "with integers within the safe-integer range",
            )
        service_id = entry["id"].strip()
        if service_id in seen:
            fail(label, f"{here}.id", "is a duplicate after trimming")
        seen.add(service_id)
        service = {**entry, "id": service_id, "name": entry["name"].strip()}
        out.append(service)
    return out


def _validate_origins(label, path, value):
    if not isinstance(value, list):
        fail(label, path, "must be a list")
    out = []
    for index, item in enumerate(value):
        ok = isinstance(item, str) and (
            item == "*"
            or (
                re.fullmatch(r"https?://[^/\s]+", item)
                and not urlsplit(item).username
                and not urlsplit(item).password
            )
        )
        if not ok:
            fail(
                label,
                f"{path}[{index}]",
                'must be "*" or an http(s) origin such as https://portal.example.com',
            )
        if item in out:
            fail(label, f"{path}[{index}]", "is a duplicate")
        out.append(item)
    return out


def _validate_field(label, path, kind, value):
    if kind == "bool":
        if type(value) is not bool:
            fail(label, path, "must be a boolean")
        return value
    if kind == "nonblank":
        if not isinstance(value, str) or not value.strip():
            fail(label, path, "must be a nonblank string")
        return value
    if kind == "level":
        if value not in EXPERIENCE_LEVELS:
            fail(label, path, "must be one of: " + ", ".join(EXPERIENCE_LEVELS))
        return value
    if kind == "ids":
        return _validate_ids(label, path, value)
    if kind == "catalog":
        return _validate_catalog(label, path, value)
    if kind == "origins":
        return _validate_origins(label, path, value)
    if kind == "appname":
        if not isinstance(value, str) or not value.strip():
            fail(label, path, "must be a nonblank string")
        if len(value) > APP_NAME_MAX:
            fail(label, path, f"must be at most {APP_NAME_MAX} characters")
        return value
    # The remaining kinds are URLs.
    if not isinstance(value, str):
        fail(label, path, "must be a string")
    if kind == "share":
        if value != "off":
            service_url(f"{label} {path}", value, ("https",), ("http",), SHARE_LOOPBACK)
            _no_whitespace(label, path, value)
    elif kind == "collab":
        service_url(f"{label} {path}", value, ("wss",), ("ws",), LOOPBACK)
        _no_whitespace(label, path, value)
    elif kind == "geolens":
        if value not in ("off", "same-origin"):
            if not value.startswith(("http://", "https://")):
                fail(label, path, 'must be "off", "same-origin", or an http(s):// URL')
            parsed = urlsplit(value)
            if parsed.query or parsed.fragment:
                fail(label, path, "must not include query parameters or a fragment")
            service_url(f"{label} {path}", value, ("https",), ("http",), LOOPBACK)
            _no_whitespace(label, path, value)
    return value


def validate_policy(doc, label):
    """Validate a policy document strictly; return it normalized (without $schema)."""
    if not isinstance(doc, dict):
        fail(label, "", "must contain a JSON object")
    version = doc.get("version")
    if type(version) is not int or version != 1:
        fail(label, "", "version must be the integer 1")
    for key in doc:
        if key not in ("$schema", "version", *SECTION_KEYS):
            fail(label, key, "is not a known key")
    if "$schema" in doc and not isinstance(doc["$schema"], str):
        fail(label, "$schema", "must be a string")

    out = {"version": 1}
    if "capabilities" in doc:
        value = doc["capabilities"]
        if not isinstance(value, list):
            fail(label, "capabilities", "must be a list")
        capabilities = []
        for index, item in enumerate(value):
            if item not in CAPABILITIES:
                fail(label, f"capabilities[{index}]", "must be one of: " + ", ".join(CAPABILITIES))
            if item in capabilities:
                fail(label, f"capabilities[{index}]", "is a duplicate")
            capabilities.append(item)
        out["capabilities"] = capabilities
    for section, kinds in FIELD_KINDS.items():
        if section not in doc:
            continue
        body = doc[section]
        if not isinstance(body, dict):
            fail(label, section, "must be an object")
        for key in body:
            if key not in kinds:
                fail(label, f"{section}.{key}", "is not a known key")
        out[section] = {
            key: _validate_field(label, f"{section}.{key}", kind, body[key])
            for key, kind in kinds.items()
            if key in body
        }
    return out


# --- Building and writing ------------------------------------------------------


def load_policy_file(path):
    try:
        with open(path, encoding="utf-8-sig") as source:
            return json.load(source, parse_constant=_invalid_json_constant)
    except OSError as error:
        raise SystemExit(
            "ERROR: GEOLIBRE_DEPLOYMENT_FILE cannot be read. "
            "Check the mounted file path and read permissions."
        ) from error
    except (ValueError, UnicodeError) as error:
        raise SystemExit(
            "ERROR: GEOLIBRE_DEPLOYMENT_FILE must contain valid UTF-8 JSON."
        ) from error


def build_policy(env: Mapping[str, str]):
    """Return (policy, log lines): the mounted file with env overrides applied."""
    logs = []
    file_path = env.get("GEOLIBRE_DEPLOYMENT_FILE", "").strip()
    if file_path:
        policy = validate_policy(load_policy_file(file_path), "GEOLIBRE_DEPLOYMENT_FILE")
        logs.append(f"Deployment policy: loaded GEOLIBRE_DEPLOYMENT_FILE {file_path}")
    else:
        policy = {"version": 1}

    def override(path, var, value, shown):
        section, _, field = path.partition(".")
        if field:
            existed = field in policy.get(section, {})
            policy.setdefault(section, {})[field] = value
        else:
            existed = section in policy
            policy[section] = value
        logs.append(
            f"Deployment policy: {path} from {var} = {shown}" + (OVERRIDE_SUFFIX if existed else "")
        )

    def get(var):
        return env.get(var, "").strip()

    if get("GEOLIBRE_CAPABILITIES"):
        capabilities = parse_capabilities_env(get("GEOLIBRE_CAPABILITIES"))
        override(
            "capabilities", "GEOLIBRE_CAPABILITIES", capabilities, ",".join(capabilities) or "none"
        )
    if get("GEOLIBRE_SERVICES_FILE"):
        catalog = read_services_file(env["GEOLIBRE_SERVICES_FILE"])
        override("services.catalog", "GEOLIBRE_SERVICES_FILE", catalog, f"{len(catalog)} entries")
    if builtin_services_hidden(get("GEOLIBRE_BUILTIN_SERVICES")):
        override("services.builtins", "GEOLIBRE_BUILTIN_SERVICES", False, "false")
    if get("GEOLIBRE_SHARE_URL"):
        value = normalize_share_url(get("GEOLIBRE_SHARE_URL"))
        override("sharing.shareUrl", "GEOLIBRE_SHARE_URL", value, value)
    if get("GEOLIBRE_COLLAB_URL"):
        value = normalize_collab_url(get("GEOLIBRE_COLLAB_URL"))
        override("sharing.collabUrl", "GEOLIBRE_COLLAB_URL", value, value)
    origins = list(dict.fromkeys(parse_embed_origins(get("GEOLIBRE_EMBED_ORIGINS"))))
    if origins:
        override("sharing.embedOrigins", "GEOLIBRE_EMBED_ORIGINS", origins, ",".join(origins))
    if get("GEOLIBRE_GEOLENS_URL"):
        value = normalize_geolens_url(get("GEOLIBRE_GEOLENS_URL"))
        override("geolens.url", "GEOLIBRE_GEOLENS_URL", value, value)
    if get("GEOLIBRE_APP_NAME"):
        name, truncated = normalize_app_name(get("GEOLIBRE_APP_NAME"))
        shown = name + (f" (truncated to {APP_NAME_MAX} characters)" if truncated else "")
        override("branding.appName", "GEOLIBRE_APP_NAME", name, shown)
    if get("GEOLIBRE_AI_URL"):
        override("ai.enabled", "GEOLIBRE_AI_URL", True, "true")
        if get("GEOLIBRE_AI_MODEL"):
            override(
                "ai.model", "GEOLIBRE_AI_MODEL", get("GEOLIBRE_AI_MODEL"), get("GEOLIBRE_AI_MODEL")
            )

    if policy.get("ai", {}).get("enabled") is True and not get("GEOLIBRE_AI_URL"):
        raise SystemExit(
            "ERROR: GEOLIBRE_DEPLOYMENT_FILE ai.enabled is true, but the AI proxy is not "
            "configured. Set GEOLIBRE_AI_URL=/ai, GEOLIBRE_AI_PROXY_URL and "
            "GEOLIBRE_AI_PROXY_TOKEN, or set ai.enabled to false."
        )
    # Safety net: anything env-derived that the schema would reject fails the boot.
    return validate_policy(policy, "generated deployment.json"), logs


def write_policy(policy, path):
    """Write the policy atomically with mode 0644."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as output:
        output.write(json.dumps(policy, indent=2) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main(argv):
    if len(argv) != 2:
        print("usage: deployment_policy.py <output-path>", file=sys.stderr)
        return 2
    policy, logs = build_policy(os.environ)
    write_policy(policy, argv[1])
    for line in logs:
        print(line)
    sections = [key for key in policy if key != "version"]
    print(f"Deployment policy: wrote {argv[1]} ({', '.join(sections) or 'no sections'})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
