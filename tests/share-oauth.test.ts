// Security-boundary tests for the share server's web OAuth client
// (share-oauth.ts). Only the pure, security-critical pieces are unit-tested:
// token material shape, the S256 challenge derivation, callback URL derivation
// (root and subpath deployments), and the callback-message validator that
// gates which authorization codes the app will accept. The popup/message/exchange
// flow itself needs a browser and is covered by the live verification in the PR.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveCallbackUrl,
  randomUrlSafeToken,
  s256Challenge,
  validateCallbackPayload,
} from "../apps/geolibre-desktop/src/lib/share-oauth";

describe("randomUrlSafeToken", () => {
  // RFC 7636 requires a 43–128 character verifier. 32 bytes → 43 base64url
  // characters, exactly the server's PKCE_VERIFIER_RE floor.
  it("produces 43-character unpadded baseurl tokens", () => {
    const token = randomUrlSafeToken();
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!token.includes("="));
  });

  it("is random across calls", () => {
    assert.notEqual(randomUrlSafeToken(), randomUrlSafeToken());
  });
});

describe("s256Challenge", () => {
  // RFC 7636 appendix B vector: proves the derivation is base64url(SHA-256),
  // not a near miss (e.g. padded, or hashing the wrong encoding).
  it("matches the RFC 7636 known-answer vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(await s256Challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("differs per verifier", async () => {
    assert.notEqual(await s256Challenge("a".repeat(43)), await s256Challenge("b".repeat(43)));
  });
});

describe("deriveCallbackUrl", () => {
  const APP = "https://app.example";

  it("lands on the app origin's callback at the root base", () => {
    assert.equal(deriveCallbackUrl(APP, "/"), `${APP}/oauth-callback.html`);
  });

  it("honors a subpath deployment base", () => {
    assert.equal(deriveCallbackUrl(APP, "/demo/"), `${APP}/demo/oauth-callback.html`);
  });

  it("repairs a base missing its trailing slash", () => {
    assert.equal(deriveCallbackUrl(APP, "/demo"), `${APP}/demo/oauth-callback.html`);
  });
});

describe("validateCallbackPayload", () => {
  const expected = { state: "st".repeat(16), issuer: "https://share.example" };
  const message = (overrides: Record<string, unknown> = {}) => ({
    type: "geolibre-share-oauth",
    code: "abc123",
    state: expected.state,
    iss: expected.issuer,
    ...overrides,
  });

  it("accepts a well-formed message carrying the code", () => {
    const verdict = validateCallbackPayload(message(), expected);
    assert.deepEqual(verdict, { ok: true, code: "abc123" });
  });

  it("accepts a message without iss (the parameter is optional)", () => {
    const { iss: _iss, ...withoutIssuer } = message();
    const verdict = validateCallbackPayload(withoutIssuer, expected);
    assert.deepEqual(verdict, { ok: true, code: "abc123" });
  });

  it("rejects a foreign message type outright", () => {
    const verdict = validateCallbackPayload(message({ type: "something-else" }), expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "malformed");
  });

  it("rejects a state that does not match exactly", () => {
    for (const state of [`${expected.state}x`, expected.state.slice(1), ""]) {
      const verdict = validateCallbackPayload(message({ state }), expected);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "state-mismatch");
    }
  });

  it("rejects a mismatched issuer (mix-up defense)", () => {
    const verdict = validateCallbackPayload(message({ iss: "https://evil.example" }), expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "issuer-mismatch");
  });

  it("maps an error response to access-denied", () => {
    const verdict = validateCallbackPayload(
      message({ error: "access_denied", code: undefined }),
      expected,
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "access-denied");
  });

  it("rejects a payload without a usable code", () => {
    const verdict = validateCallbackPayload(message({ code: "" }), expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "malformed");
  });

  it("rejects non-object payloads", () => {
    for (const payload of [null, undefined, "geolibre-share-oauth", 42]) {
      const verdict = validateCallbackPayload(payload, expected);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "malformed");
    }
  });
});
