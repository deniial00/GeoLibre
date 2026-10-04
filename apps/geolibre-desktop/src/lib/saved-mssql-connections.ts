import type { MssqlAuthMethod } from "@geolibre/processing";
import { credentialStorageLocation, queueCredentialChanges } from "./credential-store";

export const MSSQL_CONNECTIONS_STORAGE_KEY = "geolibre.mssql.connections";
export const MAX_SAVED_MSSQL_CONNECTIONS = 10;
export const MSSQL_CONNECTIONS_CHANGED_EVENT = "geolibre:mssql-connections-changed";
export type { MssqlAuthMethod } from "@geolibre/processing";
export const MSSQL_AUTH_METHODS: readonly MssqlAuthMethod[] = [
  "sql",
  "windows",
  "entra_password",
  "entra_sp",
  "entra_interactive",
  "msi",
  "token",
];
export interface MssqlConnectionProfile {
  id: string;
  server: string;
  port: number;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  authMethod: MssqlAuthMethod;
  username?: string;
  tenantId?: string;
  clientId?: string;
}
export interface MssqlStoredSecret {
  password?: string;
  clientSecret?: string;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let secrets: Record<string, MssqlStoredSecret> = {};
let writable = true;
export function mssqlConnectionAccount(id: string): string {
  return `mssql.connection.${id}`;
}
export function isMssqlConnectionProfile(value: unknown): value is MssqlConnectionProfile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    ID.test(v.id) &&
    typeof v.server === "string" &&
    !!v.server.trim() &&
    typeof v.database === "string" &&
    !!v.database.trim() &&
    typeof v.port === "number" &&
    Number.isInteger(v.port) &&
    v.port >= 1 &&
    v.port <= 65535 &&
    typeof v.encrypt === "boolean" &&
    typeof v.trustServerCertificate === "boolean" &&
    MSSQL_AUTH_METHODS.includes(v.authMethod as MssqlAuthMethod) &&
    (v.username === undefined || typeof v.username === "string") &&
    (v.tenantId === undefined || typeof v.tenantId === "string") &&
    (v.clientId === undefined || typeof v.clientId === "string")
  );
}
function persistedProfile(profile: MssqlConnectionProfile): MssqlConnectionProfile {
  return {
    id: profile.id,
    server: profile.server,
    port: profile.port,
    database: profile.database,
    encrypt: profile.encrypt,
    trustServerCertificate: profile.trustServerCertificate,
    authMethod: profile.authMethod,
    ...(profile.username === undefined ? {} : { username: profile.username }),
    ...(profile.tenantId === undefined ? {} : { tenantId: profile.tenantId }),
    ...(profile.clientId === undefined ? {} : { clientId: profile.clientId }),
  };
}
export function readSavedMssqlConnections(): MssqlConnectionProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MSSQL_CONNECTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .filter(isMssqlConnectionProfile)
          .map(persistedProfile)
          .slice(0, MAX_SAVED_MSSQL_CONNECTIONS)
      : [];
  } catch {
    return [];
  }
}
/** Return an id only when connection settings, including both TLS flags, match. */
export function findMssqlConnectionId(
  profile: Omit<MssqlConnectionProfile, "id">,
): string | undefined {
  return readSavedMssqlConnections().find(
    (p) =>
      p.server.toLowerCase() === profile.server.toLowerCase() &&
      p.port === profile.port &&
      p.database === profile.database &&
      p.encrypt === profile.encrypt &&
      p.trustServerCertificate === profile.trustServerCertificate &&
      p.authMethod === profile.authMethod &&
      p.username === profile.username &&
      p.tenantId === profile.tenantId &&
      p.clientId === profile.clientId,
  )?.id;
}
export function setKeychainMssqlSecrets(value: Record<string, MssqlStoredSecret>): void {
  secrets = { ...value };
}
export function setMssqlKeychainWritable(value: boolean): void {
  writable = value;
}
export function savedMssqlSecret(id: string): MssqlStoredSecret | undefined {
  return secrets[id] ? { ...secrets[id] } : undefined;
}
export function rememberMssqlConnection(
  profile: MssqlConnectionProfile,
  secret: MssqlStoredSecret | null,
): MssqlConnectionProfile[] {
  if (typeof window === "undefined") return [];
  const previousProfiles = readSavedMssqlConnections();
  const profiles = [
    persistedProfile(profile),
    ...previousProfiles.filter((p) => p.id !== profile.id),
  ].slice(0, MAX_SAVED_MSSQL_CONNECTIONS);
  try {
    window.localStorage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    /* best effort */
  }
  if (credentialStorageLocation() === "keychain" && writable) {
    const previous = Object.fromEntries(
      Object.entries(secrets).map(([id, value]) => [
        mssqlConnectionAccount(id),
        JSON.stringify(value),
      ]),
    );
    const nextSecrets: Record<string, MssqlStoredSecret> = {};
    for (const p of profiles) {
      const selected = p.id === profile.id && secret ? secret : secrets[p.id];
      if (selected) nextSecrets[p.id] = selected;
    }
    const next = Object.fromEntries(
      Object.entries(nextSecrets).map(([id, value]) => [
        mssqlConnectionAccount(id),
        JSON.stringify(value),
      ]),
    );
    secrets = nextSecrets;
    void queueCredentialChanges(previous, next);
  }
  window.dispatchEvent(new Event(MSSQL_CONNECTIONS_CHANGED_EVENT));
  return profiles;
}
export function mssqlConnectionLabel(
  profile: Pick<MssqlConnectionProfile, "server" | "port" | "database" | "username">,
): string {
  return `${profile.username ? `${profile.username}@` : ""}${profile.server}${profile.port === 1433 ? "" : `:${profile.port}`}/${profile.database}`;
}
