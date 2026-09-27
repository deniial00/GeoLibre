/**
 * Persistence for the PostgreSQL connection strings the user has entered:
 * a small MRU list, plus the password-masked label used to show (and later
 * match) a connection without exposing its credentials.
 *
 * The web build and the mobile apps keep the list in localStorage. The desktop
 * build (issue #1667) keeps each DSN as its own OS credential-store entry
 * (`postgres.connection.<uuid>`) and only the non-secret MRU order of those
 * ids in localStorage. `credential-hydration.ts` loads that list into memory
 * before the app renders, so readers stay synchronous.
 *
 * Pure data utilities, deliberately UI-free: consumed both by the Add Data
 * dialog and by the PostGIS layer connection registry in
 * `postgis-connections.ts`.
 */
import {
  credentialStorageLocation,
  queueCredentialChanges,
  reportCredentialStorageError,
} from "./credential-store";

/** Web/mobile list; on desktop, only legacy plaintext awaiting migration. */
export const POSTGRES_CONNECTIONS_STORAGE_KEY = "geolibre.postgres.connectionStrings";
/** Desktop: non-secret JSON array of connection ids in MRU order. */
export const POSTGRES_CONNECTION_IDS_STORAGE_KEY = "geolibre.postgres.connectionIds";
export const MAX_SAVED_POSTGRES_CONNECTIONS = 10;

/**
 * Fired on `window` after the saved-connections list changes, so same-tab
 * views (e.g. the Browser panel's Databases section) can re-read it — the
 * native `storage` event only fires cross-tab.
 */
export const POSTGRES_CONNECTIONS_CHANGED_EVENT = "geolibre:postgres-connections-changed";

const CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface KeychainPostgresConnection {
  id: string;
  connection: string;
}

/** Desktop cache of the credential-store list; null until hydrated. */
let keychainConnections: KeychainPostgresConnection[] | null = null;
/** False after a failed startup migration: edits then stay in memory. */
let postgresKeychainWritable = true;

export function uniquePostgresConnections(connections: string[]): string[] {
  return Array.from(new Set(connections));
}

export function postgresConnectionAccount(id: string): string {
  return `postgres.connection.${id}`;
}

/**
 * Reads the desktop id index. Throws on unreadable storage or a malformed
 * index rather than returning a partial list, which would orphan entries.
 */
export function readKeychainPostgresIds(): string[] {
  const value = window.localStorage.getItem(POSTGRES_CONNECTION_IDS_STORAGE_KEY);
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_SAVED_POSTGRES_CONNECTIONS ||
    new Set(parsed).size !== parsed.length ||
    !parsed.every((id) => typeof id === "string" && CONNECTION_ID_PATTERN.test(id))
  ) {
    throw new Error("The saved PostGIS connection index is malformed.");
  }
  return parsed as string[];
}

export function postgresConnectionSecrets(
  entries: readonly KeychainPostgresConnection[],
): Record<string, string> {
  return Object.fromEntries(
    entries.map(({ id, connection }) => [postgresConnectionAccount(id), connection]),
  );
}

export function setKeychainPostgresConnections(entries: KeychainPostgresConnection[]): void {
  keychainConnections = entries.map((entry) => ({ ...entry }));
  window.dispatchEvent(new Event(POSTGRES_CONNECTIONS_CHANGED_EVENT));
}

export function setPostgresKeychainWritable(writable: boolean): void {
  postgresKeychainWritable = writable;
}

/** The localStorage list: the web/mobile store, legacy plaintext on desktop. */
export function readBrowserPostgresConnections(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(POSTGRES_CONNECTIONS_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniquePostgresConnections(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return [];
  }
}

export function readSavedPostgresConnections(): string[] {
  if (credentialStorageLocation() === "browser") return readBrowserPostgresConnections();
  return keychainConnections?.map(({ connection }) => connection) ?? [];
}

export function rememberPostgresConnection(connectionString: string): string[] {
  const trimmed = connectionString.trim();
  if (!trimmed || typeof window === "undefined") return [];

  const connections = uniquePostgresConnections([
    trimmed,
    ...readSavedPostgresConnections().filter((value) => value !== trimmed),
  ]).slice(0, MAX_SAVED_POSTGRES_CONNECTIONS);

  if (credentialStorageLocation() === "keychain") {
    rememberKeychainPostgresConnections(connections);
    return connections;
  }

  try {
    window.localStorage.setItem(POSTGRES_CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    // Notify same-tab listeners (the Browser panel) so a newly-saved connection
    // appears without closing and reopening the panel.
    window.dispatchEvent(new Event(POSTGRES_CONNECTIONS_CHANGED_EVENT));
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not abort the
    // connect flow (mirrors readBrowserPostgresConnections' guard).
  }
  return connections;
}

/**
 * Desktop write path. Ids are stable per DSN, so reordering the MRU list only
 * rewrites the non-secret index; the credential store sees just the new DSN
 * and any evicted one. The index is written first so a crash cannot leave an
 * unindexed credential behind.
 */
function rememberKeychainPostgresConnections(connections: string[]): void {
  const previous = keychainConnections ?? [];
  const idByConnection = new Map(previous.map(({ id, connection }) => [connection, id]));
  const next = connections.map((connection) => ({
    id: idByConnection.get(connection) ?? crypto.randomUUID(),
    connection,
  }));
  setKeychainPostgresConnections(next);
  if (!postgresKeychainWritable) return;

  try {
    window.localStorage.setItem(
      POSTGRES_CONNECTION_IDS_STORAGE_KEY,
      JSON.stringify(next.map(({ id }) => id)),
    );
  } catch (error) {
    reportCredentialStorageError(error);
    postgresKeychainWritable = false;
    return;
  }
  void queueCredentialChanges(postgresConnectionSecrets(previous), postgresConnectionSecrets(next));
}

export function savedPostgresConnectionLabel(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return connectionString
      .replace(/(:\/\/[^:\s/@]+:)[^@\s]+@/, "$1****@")
      .replace(/(password\s*=\s*)('[^']*'|[^\s]+)/gi, "$1****");
  }
}
