#!/usr/bin/env bash
# End-to-end check of docker/entrypoint.sh and the deployment.json it writes
# (issue #2783). Builds a small image holding the REAL entrypoint.sh, nginx.conf
# and deployment_policy.py with a stub index.html and the Python sidecar disabled,
# so it needs no app build. The COPY/printf lines below mirror the runtime stage
# of the Dockerfile (COPY docker/..., default auth and AI snippets) and must be
# kept in sync with it.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

IMAGE=geolibre-entrypoint:test
FIXTURES=tests/fixtures/deployment-policy
TMP="$(mktemp -d)"
CONTAINERS=()

cleanup() {
  for name in "${CONTAINERS[@]:-}"; do
    [ -n "$name" ] && docker rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL - $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

docker build -q -t "$IMAGE" -f - . <<'DOCKERFILE' >/dev/null
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends nginx openssl curl \
  && rm -rf /var/lib/apt/lists/* && rm -f /etc/nginx/sites-enabled/default
COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/deployment_policy.py /usr/local/lib/geolibre/deployment_policy.py
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && printf '# Basic Auth disabled.\n' > /etc/nginx/geolibre-auth.conf \
  && printf '# AI proxy disabled.\n' > /etc/nginx/geolibre-ai-proxy.conf \
  && mkdir -p /usr/share/nginx/html \
  && printf '<!doctype html><title>stub</title>\n' > /usr/share/nginx/html/index.html
ENV GEOLIBRE_DISABLE_SIDECAR=1
CMD ["/usr/local/bin/entrypoint.sh"]
DOCKERFILE

# start NAME DOCKER_ARGS... : run detached and wait for /healthz.
start() {
  local name="$1"; shift
  CONTAINERS+=("$name")
  docker run -d --name "$name" "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$name" curl -fsS http://127.0.0.1/healthz >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  docker logs "$name" >&2 || true
  fail "$name did not become healthy"
}

# expect_fail SUBSTRING DOCKER_ARGS... : boot must exit non-zero with ERROR: + SUBSTRING.
expect_fail() {
  local substring="$1"; shift
  local out status=0
  out="$(docker run --rm "$@" "$IMAGE" 2>&1)" || status=$?
  [ "$status" -ne 0 ] || fail "boot succeeded, expected: $substring"
  grep -q "ERROR:" <<<"$out" || fail "no ERROR: line for: $substring (got: $out)"
  grep -qF -- "$substring" <<<"$out" || fail "missing '$substring' in: $out"
}

mount_policy() { echo "-v $1:/etc/geolibre/deployment.json:ro -e GEOLIBRE_DEPLOYMENT_FILE=/etc/geolibre/deployment.json"; }
fetch() { docker exec "$1" curl -fsS "http://127.0.0.1$2"; }
json_eq() { python3 -c 'import json,sys; a=json.loads(sys.argv[1]); b=json.load(open(sys.argv[2])); b.pop("$schema",None); sys.exit(0 if a==b else 1)' "$1" "$2"; }

# 1. defaults ------------------------------------------------------------------
start defaults
headers="$(docker exec defaults curl -si http://127.0.0.1/deployment.json)"
grep -q '^HTTP/1.1 200' <<<"$headers" || fail "defaults: status"
grep -qi '^content-type: application/json' <<<"$headers" || fail "defaults: content-type"
grep -qi '^cache-control: no-store' <<<"$headers" || fail "defaults: cache-control"
grep -qi '^x-content-type-options: nosniff' <<<"$headers" || fail "defaults: nosniff"
[ "$(fetch defaults /deployment.json | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)))')" = '{"version": 1}' ] \
  || fail "defaults: body"
[ "$(docker exec defaults cat /usr/share/nginx/html/geolibre-runtime-config.js)" = 'window.__GEOLIBRE_DEPLOYMENT_ENV__ = {};' ] \
  || fail "defaults: runtime config changed"
! docker logs defaults 2>&1 | grep -q ' from GEOLIBRE_' || fail "defaults: unexpected override log"
ok "defaults: empty policy, headers, runtime config unchanged"

# 2. capabilities env ----------------------------------------------------------
start caps -e GEOLIBRE_CAPABILITIES=data:add,export:data
json_eq "$(fetch caps /deployment.json)" <(echo '{"version":1,"capabilities":["data:add","export:data"]}') \
  || fail "caps: body"
docker exec caps cat /usr/share/nginx/html/geolibre-runtime-config.js \
  | grep -qF '"VITE_GEOLIBRE_CAPABILITIES":"data:add,export:data"' || fail "caps: runtime config"
ok "GEOLIBRE_CAPABILITIES serves exactly those capabilities"

# 3. file + one env override ---------------------------------------------------
echo '{"version":1,"capabilities":["data:add"],"branding":{"appName":"From File"}}' >"$TMP/mixed.json"
# shellcheck disable=SC2046
start mixed $(mount_policy "$TMP/mixed.json") -e "GEOLIBRE_APP_NAME=From Env"
body="$(fetch mixed /deployment.json)"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["branding"]["appName"]=="From Env" and d["capabilities"]==["data:add"], d' "$body" \
  || fail "mixed: body"
lines="$(docker logs mixed 2>&1 | grep -c '^Deployment policy: .* from GEOLIBRE_' || true)"
[ "$lines" = 1 ] || fail "mixed: expected exactly one override log line, got $lines"
docker logs mixed 2>&1 | grep '^Deployment policy: .* from GEOLIBRE_' | grep -q '(overrides GEOLIBRE_DEPLOYMENT_FILE)$' \
  || fail "mixed: override log suffix"
ok "env overrides one file field with one log line"

# 4. good fixtures round-trip ---------------------------------------------------
# shellcheck disable=SC2046
start minimal $(mount_policy "$PWD/$FIXTURES/good/minimal.json")
json_eq "$(fetch minimal /deployment.json)" "$FIXTURES/good/minimal.json" || fail "minimal: round trip"
# shellcheck disable=SC2046
start full $(mount_policy "$PWD/$FIXTURES/good/full.json") \
  -e GEOLIBRE_AI_URL=/ai -e GEOLIBRE_AI_PROXY_URL=https://127.0.0.1:9 -e GEOLIBRE_AI_PROXY_TOKEN=test-token
json_eq "$(fetch full /deployment.json)" "$FIXTURES/good/full.json" || fail "full: round trip"
docker exec full curl -sI http://127.0.0.1/ | grep -i '^content-security-policy' | grep -qF ' wss://relay.example.com' \
  || fail "full: CSP lacks the collab origin from the file"
ok "good fixtures round-trip"

# 5. bad fixtures --------------------------------------------------------------
python3 - "$FIXTURES/bad-cases.json" "$TMP" >"$TMP/cases.tsv" <<'PY'
import json, sys
cases = json.load(open(sys.argv[1]))
for name, case in cases.items():
    text = json.dumps(case["input"]).replace('"__UNSAFE__"', "9007199254740993")
    open(f"{sys.argv[2]}/bad-{name}.json", "w").write(text)
    print(f"{name}\t{case['container']}")
PY
count=0
while IFS=$'\t' read -r name substring; do
  # shellcheck disable=SC2046
  expect_fail "$substring" $(mount_policy "$TMP/bad-$name.json")
  count=$((count + 1))
done <"$TMP/cases.tsv"
ok "$count bad fixtures fail the boot with their ERROR"

# 6. bad env -------------------------------------------------------------------
expect_fail "Accepted values: project:edit" -e GEOLIBRE_CAPABILITIES=bogus
echo '{"version":1,"ai":{"enabled":true}}' >"$TMP/ai.json"
# shellcheck disable=SC2046
expect_fail "ai.enabled is true, but the AI proxy is not configured" $(mount_policy "$TMP/ai.json")
ok "bad env fails the boot"
