/**
 * Host side of `app.credentials` (issue #2729): the tokens and API keys a plugin
 * saves for itself. The desktop (Tauri) build keeps each value as its own OS
 * credential-store entry, `plugin.<pluginId>.<name>`; the web build, the Jupyter
 * embed and the mobile apps keep them in localStorage.
 *
 * Plugins read synchronously, so `credential-hydration.ts` loads every indexed
 * value into memory from its single startup keychain read. The credential store
 * cannot be enumerated, so the accounts that have an entry are indexed in
 * localStorage (non-secret). As with project credentials, the index is written
 * before the credential so a crash cannot leave an unindexed entry behind, and
 * a malformed index fails hydration rather than being partially read.
 *
 * The plugin id is injected by `PluginManager`'s scoped app; a plugin passes
 * only `name`. Failures never fall back to plaintext on desktop: the value
 * stays in memory for the session and the credential-storage warning shows.
 */
import type { GeoLibreCredentialLocation } from "@geolibre/plugins";
import {
  credentialStorageLocation,
  isStorableCredentialAccount,
  queueCredentialChanges,
  reportCredentialStorageError,
} from "./credential-store";

/** Desktop: non-secret JSON array of accounts that have a stored value. */
export const PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY = "geolibre.pluginCredentials.accounts";
/** Web/embed/mobile: the localStorage key is `${prefix}${pluginId}.${name}`. */
export const PLUGIN_CREDENTIAL_BROWSER_KEY_PREFIX = "geolibre.pluginCredential.";

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Names cannot contain ".", so the last segment of an account is unambiguous. */
export function pluginCredentialAccount(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

/** Desktop: account → stored value, for this session. */
let values: Record<string, string> = {};
/** Desktop: false until hydration succeeds; edits then stay in memory. */
let writable = false;
/** Web: values whose localStorage write failed, kept for this session. */
const sessionOverrides = new Map<string, string>();

/**
 * Reads the desktop account index. Throws on unreadable storage or a malformed
 * index rather than returning a partial list, which would orphan entries.
 */
export function readPluginCredentialIndex(): string[] {
  const value = window.localStorage.getItem(PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY);
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    new Set(parsed).size !== parsed.length ||
    !parsed.every(
      (account) =>
        typeof account === "string" &&
        account.startsWith("plugin.") &&
        isStorableCredentialAccount(account),
    )
  ) {
    throw new Error("The saved plugin credential index is malformed.");
  }
  return parsed as string[];
}

/**
 * Loads the indexed plugin credentials from the startup keychain read.
 * `index` or `stored` is `null` when reading it failed (the caller reported
 * it): plugin credentials then stay in memory for the session.
 */
export function hydratePluginCredentials(
  index: readonly string[] | null,
  stored: Readonly<Record<string, string>> | null,
): void {
  if (credentialStorageLocation() !== "keychain") return;
  if (index === null || stored === null) {
    writable = false;
    return;
  }
  const present = index.filter((account) => stored[account] !== undefined);
  values = Object.fromEntries(present.map((account) => [account, stored[account]]));
  if (present.length !== index.length) {
    // An indexed write that never landed (crash, failed write): drop it.
    try {
      window.localStorage.setItem(PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY, JSON.stringify(present));
    } catch (error) {
      reportCredentialStorageError(error);
      writable = false;
      return;
    }
  }
  writable = true;
}

function validate(name: string, ownerPluginId: string | undefined): string {
  if (typeof ownerPluginId !== "string" || ownerPluginId === "") {
    throw new Error("app.credentials must be called through the app API a plugin receives.");
  }
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new TypeError("Credential names must be 1-64 letters, digits, underscores or hyphens.");
  }
  return pluginCredentialAccount(ownerPluginId, name);
}

function browserKey(ownerPluginId: string, name: string): string {
  return `${PLUGIN_CREDENTIAL_BROWSER_KEY_PREFIX}${ownerPluginId}.${name}`;
}

function getDesktop(account: string): string {
  return values[account] ?? "";
}

function setDesktop(account: string, value: string): boolean {
  const previous = values[account] ?? "";
  if (value === "") delete values[account];
  else values[account] = value;
  if (!writable || !isStorableCredentialAccount(account)) return false;
  if (previous === value) return true;
  try {
    const index = new Set(readPluginCredentialIndex());
    if (value) index.add(account);
    else index.delete(account);
    window.localStorage.setItem(PLUGIN_CREDENTIAL_ACCOUNTS_STORAGE_KEY, JSON.stringify([...index]));
  } catch (error) {
    reportCredentialStorageError(error);
    return false;
  }
  void queueCredentialChanges({ [account]: previous }, { [account]: value });
  return true;
}

function getBrowser(account: string, key: string): string {
  const override = sessionOverrides.get(account);
  if (override !== undefined) return override;
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function setBrowser(account: string, key: string, value: string): boolean {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    sessionOverrides.set(account, value);
    return false;
  }
  sessionOverrides.delete(account);
  return true;
}

/**
 * The concrete `app.credentials`. `PluginManager` wraps it per plugin and
 * supplies `ownerPluginId`; the parameter is optional only so the object stays
 * assignable to `GeoLibrePluginCredentials`.
 */
export const pluginCredentialHost: {
  get(name: string, ownerPluginId?: string): string;
  set(name: string, value: string, ownerPluginId?: string): boolean;
  location(): GeoLibreCredentialLocation;
} = {
  get: (name, ownerPluginId) => {
    const account = validate(name, ownerPluginId);
    return credentialStorageLocation() === "keychain"
      ? getDesktop(account)
      : getBrowser(account, browserKey(ownerPluginId as string, name));
  },
  set: (name, value, ownerPluginId) => {
    const account = validate(name, ownerPluginId);
    if (typeof value !== "string") throw new TypeError("Credential values must be strings.");
    return credentialStorageLocation() === "keychain"
      ? setDesktop(account, value)
      : setBrowser(account, browserKey(ownerPluginId as string, name), value);
  },
  location: (): GeoLibreCredentialLocation => credentialStorageLocation(),
};
