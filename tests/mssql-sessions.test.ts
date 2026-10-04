import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MssqlSessionExpiredError, type ConnectMssqlRequest } from "@geolibre/processing";
import {
  MssqlReconnectRequiredError,
  disconnectMssqlProfileSession,
  openMssqlSession,
  releaseMssqlSession,
  requiredMssqlSecret,
  resetMssqlSessions,
  resolveMssqlSecret,
  withMssqlSession,
  type MssqlSessionClient,
} from "../apps/geolibre-desktop/src/lib/mssql-sessions";
import {
  MSSQL_CONNECTIONS_STORAGE_KEY,
  rememberMssqlConnection,
  setKeychainMssqlSecrets,
  type MssqlConnectionProfile,
} from "../apps/geolibre-desktop/src/lib/saved-mssql-connections";

const profile: MssqlConnectionProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  server: "sql.example",
  port: 1433,
  database: "gis",
  encrypt: true,
  trustServerCertificate: false,
  authMethod: "sql",
  username: "sa",
};
class Storage {
  value: string | null = null;
  getItem(key: string) {
    return key === MSSQL_CONNECTIONS_STORAGE_KEY ? this.value : null;
  }
  setItem(_key: string, value: string) {
    this.value = value;
  }
  removeItem() {
    this.value = null;
  }
}
function installStorage() {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Storage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage, dispatchEvent() {} },
  });
  return {
    storage,
    restore() {
      if (prior) Object.defineProperty(globalThis, "window", prior);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

describe("MSSQL sessions", () => {
  it("requires only credentials appropriate to the selected authentication method", () => {
    assert.equal(requiredMssqlSecret("sql"), "password");
    assert.equal(requiredMssqlSecret("entra_sp"), "clientSecret");
    assert.equal(requiredMssqlSecret("token"), "accessToken");
    assert.equal(requiredMssqlSecret("entra_interactive"), null);
    assert.deepEqual(resolveMssqlSecret(profile.id, { password: "typed" }), { password: "typed" });
  });

  it("omits stale usernames from non-password authentication requests", async () => {
    resetMssqlSessions();
    const requests: ConnectMssqlRequest[] = [];
    const client = {
      connect: async (request: ConnectMssqlRequest) => {
        requests.push(request);
        return { session_id: "session-windows" };
      },
      disconnect: async () => {},
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    try {
      await openMssqlSession({ ...profile, authMethod: "windows" }, {}, client);
      assert.equal(requests[0].auth.username, undefined);
    } finally {
      resetMssqlSessions();
    }
  });

  it("disconnects a profile session without discarding memory-only credentials", async () => {
    resetMssqlSessions();
    const disconnected: string[] = [];
    const client = {
      connect: async () => ({ session_id: "session-token" }),
      disconnect: async (sessionId: string) => {
        disconnected.push(sessionId);
      },
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    try {
      await openMssqlSession(
        { ...profile, authMethod: "token" },
        { accessToken: "memory-token" },
        client,
      );
      disconnectMssqlProfileSession(profile.id, client);
      assert.deepEqual(disconnected, ["session-token"]);
      assert.deepEqual(resolveMssqlSecret(profile.id, {}), { accessToken: "memory-token" });
    } finally {
      resetMssqlSessions();
    }
  });

  it("restores a saved credential and retries an expired session exactly once", async () => {
    const env = installStorage();
    resetMssqlSessions();
    setKeychainMssqlSecrets({});
    rememberMssqlConnection(profile, null);
    let connections = 0;
    let starts = 0;
    const requests: ConnectMssqlRequest[] = [];
    const client = {
      connect: async (request: ConnectMssqlRequest) => {
        requests.push(request);
        connections += 1;
        return { session_id: `session-${connections}` };
      },
      disconnect: async () => {},
      startSidecar: async () => {
        starts += 1;
      },
    } as unknown as MssqlSessionClient;
    try {
      await openMssqlSession(profile, { password: "secret" }, client);
      let attempts = 0;
      const result = await withMssqlSession(
        profile.id,
        async (id) => {
          attempts += 1;
          if (attempts === 1) throw new MssqlSessionExpiredError("expired");
          return id;
        },
        client,
      );
      assert.equal(result, "session-2");
      assert.equal(attempts, 2);
      assert.equal(connections, 2);
      assert.equal(starts, 1);
      assert.equal(requests[1].auth.password, "secret");
    } finally {
      resetMssqlSessions();
      env.restore();
    }
  });

  it("requires reconnect when a saved SQL profile has no restorable password", async () => {
    const env = installStorage();
    resetMssqlSessions();
    setKeychainMssqlSecrets({});
    rememberMssqlConnection(profile, null);
    let connections = 0;
    const client = {
      connect: async () => {
        connections += 1;
        return { session_id: "unexpected" };
      },
      disconnect: async () => {},
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    try {
      await assert.rejects(
        withMssqlSession(profile.id, async () => "unused", client),
        MssqlReconnectRequiredError,
      );
      assert.equal(connections, 0);
    } finally {
      resetMssqlSessions();
      env.restore();
    }
  });

  it("disconnects the previous session when reconnecting a profile", async () => {
    resetMssqlSessions();
    const disconnected: string[] = [];
    let connections = 0;
    const client = {
      connect: async () => ({ session_id: `session-${++connections}` }),
      disconnect: async (sessionId: string) => {
        disconnected.push(sessionId);
      },
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    await openMssqlSession(profile, { password: "one" }, client);
    await openMssqlSession(profile, { password: "two" }, client);
    await Promise.resolve();
    assert.deepEqual(disconnected, ["session-1"]);
    resetMssqlSessions();
  });

  it("releases abandoned sessions so the next use reconnects", async () => {
    const env = installStorage();
    resetMssqlSessions();
    setKeychainMssqlSecrets({ [profile.id]: { password: "pw" } });
    rememberMssqlConnection(profile, null);
    const disconnected: string[] = [];
    let connections = 0;
    const client = {
      connect: async () => ({ session_id: `session-${++connections}` }),
      disconnect: async (sessionId: string) => {
        disconnected.push(sessionId);
      },
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    try {
      assert.equal(await openMssqlSession(profile, { password: "pw" }, client), "session-1");
      releaseMssqlSession(profile.id, "session-1", client);
      await Promise.resolve();
      assert.deepEqual(disconnected, ["session-1"]);
      assert.equal(
        await withMssqlSession(profile.id, async (sessionId) => sessionId, client),
        "session-2",
      );
      assert.equal(connections, 2);
    } finally {
      resetMssqlSessions();
      setKeychainMssqlSecrets({});
      env.restore();
    }
  });

  it("shares one recovery between concurrent callers instead of evicting each other", async () => {
    const env = installStorage();
    resetMssqlSessions();
    setKeychainMssqlSecrets({ [profile.id]: { password: "pw" } });
    rememberMssqlConnection(profile, null);
    const disconnected: string[] = [];
    let connections = 0;
    const client = {
      connect: async () => ({ session_id: `session-${++connections}` }),
      disconnect: async (sessionId: string) => {
        disconnected.push(sessionId);
      },
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    try {
      const used = await Promise.all([
        withMssqlSession(profile.id, async (sessionId) => sessionId, client),
        withMssqlSession(profile.id, async (sessionId) => sessionId, client),
      ]);
      assert.deepEqual(used, ["session-1", "session-1"]);
      assert.equal(connections, 1);
      assert.deepEqual(disconnected, []);
    } finally {
      resetMssqlSessions();
      setKeychainMssqlSecrets({});
      env.restore();
    }
  });

  it("retries on a session another caller already restored rather than reconnecting again", async () => {
    const env = installStorage();
    resetMssqlSessions();
    setKeychainMssqlSecrets({ [profile.id]: { password: "pw" } });
    rememberMssqlConnection(profile, null);
    const disconnected: string[] = [];
    let connections = 0;
    const client = {
      connect: async () => ({ session_id: `session-${++connections}` }),
      disconnect: async (sessionId: string) => {
        disconnected.push(sessionId);
      },
      startSidecar: async () => {},
    } as unknown as MssqlSessionClient;
    try {
      await openMssqlSession(profile, { password: "pw" }, client);
      // Both callers start on session-1; it expires under both of them.
      const run = async (sessionId: string) => {
        await Promise.resolve();
        if (sessionId === "session-1") throw new MssqlSessionExpiredError("expired");
        return sessionId;
      };
      const used = await Promise.all([
        withMssqlSession(profile.id, run, client),
        withMssqlSession(profile.id, run, client),
      ]);
      assert.deepEqual(used, ["session-2", "session-2"]);
      assert.equal(connections, 2);
      // The sidecar already dropped session-1; the restored session-2 is never evicted.
      assert.deepEqual(disconnected, []);
    } finally {
      resetMssqlSessions();
      setKeychainMssqlSecrets({});
      env.restore();
    }
  });
});
