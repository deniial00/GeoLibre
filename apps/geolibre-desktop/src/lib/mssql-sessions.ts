import type { GeoLibreLayer } from "@geolibre/core";
import { connectMssql, disconnectMssql, MssqlSessionExpiredError, type ConnectMssqlRequest, type MssqlAuthMethod } from "@geolibre/processing";
import { startGeoLibreSidecar } from "./sidecar";
import { readSavedMssqlConnections, savedMssqlSecret, type MssqlConnectionProfile, type MssqlStoredSecret } from "./saved-mssql-connections";

export type MssqlSessionSecret = MssqlStoredSecret & { accessToken?: string };
export class MssqlReconnectRequiredError extends Error {
  override readonly name = "MssqlReconnectRequiredError";
}
export interface MssqlSessionClient {
  connect: typeof connectMssql;
  disconnect: typeof disconnectMssql;
  startSidecar: () => Promise<unknown>;
}
export const defaultMssqlSessionClient: MssqlSessionClient = { connect: connectMssql, disconnect: disconnectMssql, startSidecar: startGeoLibreSidecar };
const sessionByProfileId = new Map<string, string>();
const memorySecrets = new Map<string, MssqlSessionSecret>();
export function requiredMssqlSecret(method: MssqlAuthMethod): "password" | "clientSecret" | "accessToken" | null {
  if (method === "sql" || method === "entra_password") return "password";
  if (method === "entra_sp") return "clientSecret";
  if (method === "token") return "accessToken";
  return null;
}
export function resolveMssqlSecret(profileId: string, typed: MssqlSessionSecret): MssqlSessionSecret {
  const memory = memorySecrets.get(profileId) ?? {};
  const saved = savedMssqlSecret(profileId) ?? {};
  return {
    ...(typed.password || memory.password || saved.password ? { password: typed.password || memory.password || saved.password } : {}),
    ...(typed.clientSecret || memory.clientSecret || saved.clientSecret ? { clientSecret: typed.clientSecret || memory.clientSecret || saved.clientSecret } : {}),
    ...(typed.accessToken || memory.accessToken ? { accessToken: typed.accessToken || memory.accessToken } : {}),
  };
}
function connectRequest(profile: MssqlConnectionProfile, secret: MssqlSessionSecret): ConnectMssqlRequest {
  return {
    server: profile.server, port: profile.port, database: profile.database,
    encrypt: profile.encrypt, trust_server_certificate: profile.trustServerCertificate,
    auth: {
      method: profile.authMethod, username: profile.username, tenant_id: profile.tenantId, client_id: profile.clientId,
      ...(secret.password ? { password: secret.password } : {}),
      ...(secret.clientSecret ? { client_secret: secret.clientSecret } : {}),
      ...(secret.accessToken ? { access_token: secret.accessToken } : {}),
    },
  };
}
export async function openMssqlSession(profile: MssqlConnectionProfile, secret: MssqlSessionSecret, client = defaultMssqlSessionClient): Promise<string> {
  const result = await client.connect(connectRequest(profile, secret));
  const previous = sessionByProfileId.get(profile.id);
  if (previous && previous !== result.session_id) void client.disconnect(previous).catch(() => {});
  sessionByProfileId.set(profile.id, result.session_id);
  memorySecrets.set(profile.id, { ...secret });
  return result.session_id;
}
async function restoreSession(profileId: string, client: MssqlSessionClient): Promise<string> {
  await client.startSidecar().catch(() => {});
  const profile = readSavedMssqlConnections().find((item) => item.id === profileId);
  if (!profile) throw new MssqlReconnectRequiredError("Reconnect to SQL Server in Add Data.");
  const secret = resolveMssqlSecret(profileId, {});
  const required = requiredMssqlSecret(profile.authMethod);
  if (required && !secret[required]) throw new MssqlReconnectRequiredError("Reconnect to SQL Server in Add Data.");
  return openMssqlSession(profile, secret, client);
}
export async function withMssqlSession<T>(profileId: string, run: (sessionId: string) => Promise<T>, client = defaultMssqlSessionClient): Promise<T> {
  let sessionId = sessionByProfileId.get(profileId);
  if (!sessionId) sessionId = await restoreSession(profileId, client);
  try {
    return await run(sessionId);
  } catch (error) {
    if (!(error instanceof MssqlSessionExpiredError)) throw error;
    sessionByProfileId.delete(profileId);
    sessionId = await restoreSession(profileId, client);
    return run(sessionId);
  }
}
export function mssqlBaselineKeys(layer: GeoLibreLayer): Array<string | number> | undefined {
  const keys = layer.metadata?.mssqlBaselineKeys;
  return Array.isArray(keys) ? keys.filter((key): key is string | number => typeof key === "string" || typeof key === "number") : undefined;
}
export function resetMssqlSessions(): void {
  sessionByProfileId.clear();
  memorySecrets.clear();
}
