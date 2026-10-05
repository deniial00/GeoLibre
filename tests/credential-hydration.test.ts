import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with a working in-memory keychain. Must be in place
// before the modules load: the settings store reads localStorage on import.
const storage = new Map<string, string>([
  [
    "geolibre.desktopSettings",
    JSON.stringify({ shareToken: "glb_legacy", cesiumIonToken: "ion_legacy" }),
  ],
  ["geolibre.postgres.connectionStrings", JSON.stringify(["postgresql://a:pw@h/db"])],
]);
const keychain = new Map<string, string>();

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "secure_store_get_many") {
        const accounts = args.accounts as string[];
        return Object.fromEntries(
          accounts.filter((a) => keychain.has(a)).map((a) => [a, keychain.get(a)]),
        );
      }
      if (cmd === "secure_store_set") {
        keychain.set(args.account as string, args.secret as string);
        return null;
      }
      if (cmd === "secure_store_delete") {
        keychain.delete(args.account as string);
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { serializeDesktopSettingsForStorage, useDesktopSettingsStore } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");
const {
  forgetPostgresConnection,
  PostgresConnectionForgetError,
  readSavedPostgresConnections,
  rememberPostgresConnection,
} = await import("../apps/geolibre-desktop/src/lib/saved-postgres-connections");
const { queueCredentialChanges, useCredentialStorageStatus } =
  await import("../apps/geolibre-desktop/src/lib/credential-store");

const connectionIds = () =>
  JSON.parse(storage.get("geolibre.postgres.connectionIds") ?? "null") as string[];

describe("desktop credential hydration", () => {
  it("migrates legacy plaintext credentials into the keychain", async () => {
    await hydrateDesktopCredentials();

    assert.equal(useCredentialStorageStatus.getState().error, null);
    assert.equal(keychain.get("settings.shareToken"), "glb_legacy");
    assert.equal(keychain.get("settings.cesiumIonToken"), "ion_legacy");
    const [firstId] = connectionIds();
    assert.equal(keychain.get(`postgres.connection.${firstId}`), "postgresql://a:pw@h/db");

    const settings = useDesktopSettingsStore.getState().desktopSettings;
    assert.equal(settings.shareToken, "glb_legacy");
    const serialized = serializeDesktopSettingsForStorage(settings);
    assert.ok(!serialized.includes("glb_legacy"));
    assert.ok(!serialized.includes("ion_legacy"));

    assert.equal(storage.has("geolibre.postgres.connectionStrings"), false);
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
  });

  it("reorders saved connections without rewriting their credentials", async () => {
    const [firstId] = connectionIds();
    rememberPostgresConnection("postgresql://b:pw@h/db");
    await queueCredentialChanges({}, {});
    const [secondId, stillFirstId] = connectionIds();
    assert.equal(stillFirstId, firstId);
    assert.equal(keychain.get(`postgres.connection.${secondId}`), "postgresql://b:pw@h/db");

    const before = new Map(keychain);
    rememberPostgresConnection("postgresql://a:pw@h/db");
    await queueCredentialChanges({}, {});
    assert.deepEqual(connectionIds(), [firstId, secondId]);
    assert.deepEqual(keychain, before);
    assert.deepEqual(readSavedPostgresConnections(), [
      "postgresql://a:pw@h/db",
      "postgresql://b:pw@h/db",
    ]);
    assert.ok(![...storage.values()].some((value) => value.includes(":pw@")));
  });

  it("forgets a connection durably across a restart", async () => {
    const [, bId] = connectionIds();

    forgetPostgresConnection("postgresql://b:pw@h/db");
    await queueCredentialChanges({}, {});

    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
    assert.equal(connectionIds().includes(bId), false);
    assert.equal(keychain.has(`postgres.connection.${bId}`), false);
    await hydrateDesktopCredentials();
    assert.deepEqual(readSavedPostgresConnections(), ["postgresql://a:pw@h/db"]);
  });

  it("refuses a forget whose index write fails and changes nothing", async () => {
    rememberPostgresConnection("postgresql://b:pw@h/db");
    await queueCredentialChanges({}, {});
    const idsBefore = connectionIds();
    const keychainBefore = new Map(keychain);
    const originalSet = storage.set.bind(storage);
    storage.set = (key, value) => {
      if (key === "geolibre.postgres.connectionIds") throw new Error("storage unavailable");
      return originalSet(key, value);
    };
    try {
      assert.throws(
        () => forgetPostgresConnection("postgresql://b:pw@h/db"),
        PostgresConnectionForgetError,
      );
    } finally {
      storage.set = originalSet;
    }

    assert.ok(readSavedPostgresConnections().includes("postgresql://b:pw@h/db"));
    assert.deepEqual(connectionIds(), idsBefore);
    assert.deepEqual(keychain, keychainBefore);
    await hydrateDesktopCredentials();
  });
});
