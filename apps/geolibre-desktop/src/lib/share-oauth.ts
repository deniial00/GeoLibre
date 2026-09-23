// Web sign-in for the share server: OAuth 2.0 Authorization Code with S256
// PKCE against the reference server's consent endpoint (Stack 3 of the OAuth
// rollout; see docs/server-api.md "OAuth 2.0 sign-in").
//
// Credential model:
// - The refresh token lives in sessionStorage, scoped by issuer. Session
//   storage (not local) so closing the tab drops the grant instead of leaving a
//   month-long credential in a shared browser.
// - The access token lives only in this module's memory; every consumer asks
//   {@link getShareAccessToken} right before an authenticated request.
// - The desktop (Tauri) and Jupyter-embed builds never run this flow: they keep
//   the pasted personal-API-token path (Stack 4 will add the desktop browser
//   flow), and {@link supportsShareOAuth} reports false there.
//
// Security invariants (each enforced where it is cheap to test):
// - The popup is reserved synchronously inside the click handler, before any
//   await, so Safari's popup blocker does not kill the window.
// - The callback message is accepted only from the popup itself, at the app's
//   own origin, with the exact `state` this flow minted and the expected `iss`.
// - Tokens are sent to the issuer and (via shareAuthorizedFetch's own origin
//   gate) to nobody else. A session stored for one issuer is never used for a
//   different one after a redeployment repoints VITE_GEOLIBRE_SHARE_URL.

import { create } from "zustand";
import type { ParseKeys } from "i18next";
import { isTauri } from "./is-tauri";
import { resolveShareBaseUrl } from "./share-geolibre";

/** Public OAuth client registered on the share server for the web build. */
const CLIENT_ID = "geolibre-web";

/** One-time PKCE/state material: 32 random bytes, unpadded base64url (43 chars). */
const TOKEN_BYTES = 32;

/** Give the user five minutes to finish the server's consent form. */
const POPUP_TIMEOUT_MS = 5 * 60_000;

/** How often a closed popup is noticed between message events. */
const POPUP_POLL_MS = 500;

/** Refresh an access token this long before its stated expiry. */
const ACCESS_EXPIRY_BUFFER_MS = 30_000;

/** sessionStorage key prefix; the issuer completes it. */
const SESSION_PREFIX = "geolibre-share-oauth:";

/** postMessage tag carried by the callback page's single message. */
const MESSAGE_TYPE = "geolibre-share-oauth";

export type ShareOAuthErrorCode =
  | "unsupported"
  | "not-configured"
  | "already-pending"
  | "crypto-unavailable"
  | "popup-blocked"
  | "cancelled"
  | "timeout"
  | "access-denied"
  | "state-mismatch"
  | "issuer-mismatch"
  | "malformed"
  | "exchange-failed";

/** Typed failure so the UI renders guidance (t()) instead of a raw message. */
export class ShareOAuthError extends Error {
  readonly code: ShareOAuthErrorCode;

  constructor(code: ShareOAuthErrorCode, message?: string) {
    super(message ?? code);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ShareOAuthError";
    this.code = code;
  }
}

/** i18n catalog key for each failure, so the UI never renders the raw code. */
export function shareOAuthErrorKey(code: ShareOAuthErrorCode): ParseKeys {
  switch (code) {
    case "popup-blocked":
      return "share.oauthPopupBlocked";
    case "cancelled":
    case "access-denied":
      return "share.oauthCancelled";
    case "timeout":
      return "share.oauthTimeout";
    case "already-pending":
      return "share.oauthInProgress";
    case "not-configured":
      return "gallery.errorNotConfigured";
    default:
      return "share.oauthFailed";
  }
}

interface ShareOAuthState {
  /** Issuer of the active session, or null when signed out / unsupported. */
  issuer: string | null;
  /** True while a consent popup is open and unresolved. */
  pending: boolean;
}

/** Reactive session/pending state for the dialogs. */
export const useShareOAuthStore = create<ShareOAuthState>(() => ({
  issuer: loadSignedInIssuer(),
  pending: false,
}));

// ---------------------------------------------------------------------------
// Capability and issuer resolution
// ---------------------------------------------------------------------------

/**
 * Whether this build can run the web popup flow. The desktop shell and the
 * Jupyter embed never do: desktop waits for Stack 4's system-browser flow, and
 * the embed is served from inside a notebook where a popup sign-in to a remote
 * consent page is wrong by construction. `typeof` guards keep the compiled-out
 * define references safe under the tsx test loader.
 */
export function supportsShareOAuth(): boolean {
  if (typeof window === "undefined") return false;
  if (isTauri()) return false;
  if (typeof __GEOLIBRE_EMBED_BUILD__ !== "undefined" && __GEOLIBRE_EMBED_BUILD__) return false;
  return true;
}

/**
 * The OAuth issuer for this deployment: the configured (or hosted default)
 * share base, without a trailing slash. Null when sharing is disabled or the
 * configured host was rejected — exactly the states where no credential may be
 * obtained or sent.
 */
export function resolveShareIssuer(baseUrl?: string): string | null {
  const base = baseUrl ?? resolveShareBaseUrl();
  return base ? base.replace(/\/+$/, "") : null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested security boundaries)
// ---------------------------------------------------------------------------

/** Unpadded base64url of `count` cryptographically random bytes. */
export function randomUrlSafeToken(count = TOKEN_BYTES): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The S256 PKCE challenge for a verifier: base64url(SHA-256(verifier)). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The redirect URI the server must have registered for this deployment: the
 * app's own origin plus the Vite base path and `oauth-callback.html`. Honors
 * subpath deployments (`GEOLIBRE_APP_BASE`) the same way Auth0Gate's redirect
 * does — one stable value an operator can register.
 */
export function deriveCallbackUrl(appOrigin: string, base?: string): string {
  // Vite exposes the configured base with a trailing slash; the tsx test
  // loader has no import.meta.env at all, hence the safe read.
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  const raw = base ?? env?.BASE_URL ?? "/";
  const baseDir = raw.endsWith("/") ? raw : `${raw}/`;
  return new URL(`${baseDir}oauth-callback.html`, appOrigin).toString();
}

export interface CallbackPayload {
  type?: unknown;
  code?: unknown;
  state?: unknown;
  iss?: unknown;
  error?: unknown;
}

export type CallbackVerdict =
  | { ok: true; code: string }
  | { ok: false; code: "access-denied" | "state-mismatch" | "issuer-mismatch" | "malformed" };

/**
 * Validate one callback message against what this flow minted. Everything is
 * compared strictly: the state must match exactly (a mismatch is an attempt to
 * splice a foreign authorization into this flow, never a warning), and a
 * present `iss` must equal the issuer we navigated to (RFC 9207 mix-up
 * defense). A malformed payload is rejected outright.
 */
export function validateCallbackPayload(
  payload: unknown,
  expected: { state: string; issuer: string },
): CallbackVerdict {
  if (!payload || typeof payload !== "object") return { ok: false, code: "malformed" };
  const data = payload as CallbackPayload;
  if (data.type !== MESSAGE_TYPE) return { ok: false, code: "malformed" };
  if (typeof data.error === "string" && data.error) {
    return { ok: false, code: "access-denied" };
  }
  if (typeof data.state !== "string" || data.state !== expected.state) {
    return { ok: false, code: "state-mismatch" };
  }
  if (data.iss !== undefined && data.iss !== null && data.iss !== expected.issuer) {
    return { ok: false, code: "issuer-mismatch" };
  }
  if (typeof data.code !== "string" || !data.code) return { ok: false, code: "malformed" };
  return { ok: true, code: data.code };
}

// ---------------------------------------------------------------------------
// Session persistence (refresh token only; access token stays in memory)
// ---------------------------------------------------------------------------

interface StoredSession {
  refreshToken: string;
}

function readSession(issuer: string): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_PREFIX + issuer);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (typeof parsed?.refreshToken === "string" && parsed.refreshToken) {
      return { refreshToken: parsed.refreshToken };
    }
    window.sessionStorage.removeItem(SESSION_PREFIX + issuer);
    return null;
  } catch {
    // Private-mode storage or tampered value: treat as signed out.
    try {
      window.sessionStorage.removeItem(SESSION_PREFIX + issuer);
    } catch {
      // Nothing further to clean up.
    }
    return null;
  }
}

function writeSession(issuer: string, refreshToken: string): void {
  try {
    window.sessionStorage.setItem(
      SESSION_PREFIX + issuer,
      JSON.stringify({ refreshToken } satisfies StoredSession),
    );
  } catch {
    // Quota/disabled storage: the session simply does not survive a reload.
  }
}

function clearStoredSession(issuer: string): void {
  try {
    window.sessionStorage.removeItem(SESSION_PREFIX + issuer);
  } catch {
    // Nothing further to clean up.
  }
}

function loadSignedInIssuer(): string | null {
  if (typeof window === "undefined") return null;
  const issuer = resolveShareIssuer();
  return issuer && readSession(issuer) ? issuer : null;
}

interface CachedAccessToken {
  issuer: string;
  token: string;
  expiresAt: number;
}

let cachedAccess: CachedAccessToken | null = null;
let sessionGeneration = 0;

function setStoreIssuer(issuer: string | null): void {
  useShareOAuthStore.setState((state) => (state.issuer === issuer ? state : { ...state, issuer }));
}

// ---------------------------------------------------------------------------
// Sign-in: popup consent → callback message → code exchange
// ---------------------------------------------------------------------------

/** A single in-flight consent flow. A second sign-in request is rejected. */
let pendingFlow: symbol | null = null;

export async function signInToShare(baseUrl?: string): Promise<void> {
  if (!supportsShareOAuth()) {
    throw new ShareOAuthError("unsupported", "Web OAuth sign-in is not available in this build.");
  }
  const issuer = resolveShareIssuer(baseUrl);
  if (!issuer) throw new ShareOAuthError("not-configured");
  if (pendingFlow) throw new ShareOAuthError("already-pending");
  if (!window.crypto?.subtle) throw new ShareOAuthError("crypto-unavailable");

  const flow = Symbol("share-oauth-flow");
  const state = randomUrlSafeToken();
  const verifier = randomUrlSafeToken();
  // Reserve the popup before the first await: browsers only allow window.open
  // in the synchronous call stack of a user gesture.
  const popup = window.open("about:blank", "geolibre-share-oauth", "popup,width=480,height=680");
  if (!popup) throw new ShareOAuthError("popup-blocked");

  pendingFlow = flow;
  useShareOAuthStore.setState((state) => (state.pending ? state : { ...state, pending: true }));
  try {
    const challenge = await s256Challenge(verifier);
    const redirectUri = deriveCallbackUrl(window.location.origin);
    const authorizeUrl = new URL("/oauth/authorize", issuer);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "read:projects write:projects share:public",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    popup.location.href = authorizeUrl.toString();

    const code = await waitForCallbackCode(popup, { state, issuer, flow });
    const tokens = await exchangeCode(issuer, code, verifier, redirectUri);
    sessionGeneration += 1;
    writeSession(issuer, tokens.refresh_token);
    cachedAccess = {
      issuer,
      token: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    setStoreIssuer(issuer);
  } finally {
    if (pendingFlow === flow) {
      pendingFlow = null;
      useShareOAuthStore.setState((state) =>
        state.pending ? { ...state, pending: false } : state,
      );
    }
    popup.close();
  }
}

/** Resolve with the authorization code from the popup, or reject. */
function waitForCallbackCode(
  popup: Window,
  expected: { state: string; issuer: string; flow: symbol },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const appOrigin = window.location.origin;
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      run();
    };

    const onMessage = (event: MessageEvent) => {
      // The app origin, and the very popup we opened — never a stranger tab.
      if (event.origin !== appOrigin || event.source !== popup) return;
      const verdict = validateCallbackPayload(event.data, {
        state: expected.state,
        issuer: expected.issuer,
      });
      if (!verdict.ok) {
        finish(() => reject(new ShareOAuthError(verdict.code)));
        return;
      }
      finish(() => resolve(verdict.code));
    };

    const pollTimer = window.setInterval(() => {
      if (popup.closed) finish(() => reject(new ShareOAuthError("cancelled")));
    }, POPUP_POLL_MS);

    const timeoutTimer = window.setTimeout(() => {
      finish(() => reject(new ShareOAuthError("timeout")));
    }, POPUP_TIMEOUT_MS);

    window.addEventListener("message", onMessage);
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** POST /oauth/token; validates the payload shape before anything is stored. */
async function exchangeCode(
  issuer: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(new URL("/oauth/token", issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
  } catch {
    throw new ShareOAuthError("exchange-failed", "Could not reach the share server.");
  }
  const payload = (await response.json().catch(() => null)) as Partial<TokenResponse> | null;
  if (
    !response.ok ||
    typeof payload?.access_token !== "string" ||
    !payload.access_token ||
    typeof payload?.refresh_token !== "string" ||
    !payload.refresh_token
  ) {
    throw new ShareOAuthError("exchange-failed", "The share server rejected the sign-in.");
  }
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : 600;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: expiresIn,
  };
}

// ---------------------------------------------------------------------------
// Access-token resolution: cache → single-flight refresh
// ---------------------------------------------------------------------------

const refreshInFlight = new Map<string, Promise<string | null>>();

/**
 * A fresh access token for the share issuer, or null when there is no web
 * session (the caller then falls back to the pasted personal token). Refresh
 * failure (revoked/expired family) clears the session so the UI offers sign-in
 * rather than retrying a dead grant forever.
 */
export async function getShareAccessToken(baseUrl?: string): Promise<string | null> {
  if (!supportsShareOAuth()) return null;
  const issuer = resolveShareIssuer(baseUrl);
  if (!issuer) return null;

  if (
    cachedAccess &&
    cachedAccess.issuer === issuer &&
    cachedAccess.expiresAt - ACCESS_EXPIRY_BUFFER_MS > Date.now()
  ) {
    return cachedAccess.token;
  }
  const session = readSession(issuer);
  if (!session) return null;

  const generation = sessionGeneration;
  const existing = refreshInFlight.get(issuer);
  if (existing) return existing;
  const refreshPromise = refreshAccessToken(issuer, session.refreshToken, generation).finally(() => {
    if (refreshInFlight.get(issuer) === refreshPromise) refreshInFlight.delete(issuer);
  });
  refreshInFlight.set(issuer, refreshPromise);
  return refreshPromise;
}

async function refreshAccessToken(
  issuer: string,
  refreshToken: string,
  generation: number,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(new URL("/oauth/token", issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    // Network trouble is not an authorization failure: keep the session.
    return null;
  }
  if (generation !== sessionGeneration) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (generation !== sessionGeneration) return null;
    const grantDead =
      (response.status === 400 || response.status === 401) &&
      (body?.error === "invalid_grant" || body?.error === "invalid_client");
    if (grantDead) {
      // Dead family (reused/rotated elsewhere, revoked, expired): drop it.
      clearStoredSession(issuer);
      if (cachedAccess?.issuer === issuer) cachedAccess = null;
      if (loadSignedInIssuer() === null) setStoreIssuer(null);
    }
    return null;
  }
  const payload = (await response.json().catch(() => null)) as Partial<TokenResponse> | null;
  if (generation !== sessionGeneration) return null;
  if (
    typeof payload?.access_token !== "string" ||
    !payload.access_token ||
    typeof payload?.refresh_token !== "string" ||
    !payload.refresh_token
  ) {
    return null;
  }
  // Rotation: the presented refresh token is consumed; store the successor.
  writeSession(issuer, payload.refresh_token);
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : 600;
  cachedAccess = { issuer, token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

// ---------------------------------------------------------------------------
// Sign-out: revoke the family, then clear local state either way
// ---------------------------------------------------------------------------

export async function signOutOfShare(baseUrl?: string): Promise<void> {
  if (!supportsShareOAuth()) return;
  sessionGeneration += 1;
  const issuer = resolveShareIssuer(baseUrl);
  if (!issuer) return;
  const session = readSession(issuer);
  // Local state is cleared first and unconditionally: a failed revoke must not
  // leave the UI signed in, and the refresh token is single-use enough that the
  // server-side family expires on its own schedule regardless.
  clearStoredSession(issuer);
  if (cachedAccess?.issuer === issuer) cachedAccess = null;
  if (loadSignedInIssuer() === null) setStoreIssuer(null);
  if (!session) return;
  try {
    await fetch(new URL("/oauth/revoke", issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        token: session.refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
  } catch {
    // Best effort: local state is already gone.
  }
}
