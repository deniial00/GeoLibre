import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Desktop (Tauri) runtime with an in-memory keychain. Must be in place before
// the modules load.
const INDEX_KEY = "geolibre.projectCredentials.accounts";
const storage = new Map<string, string>([
  [INDEX_KEY, JSON.stringify(["project.env.A", "project.env.B"])],
]);
const keychain = new Map<string, string>([["project.env.A", "stored-a"]]);
let failWrites = false;

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
        if (failWrites) throw new Error("keychain locked");
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
// Dynamic imports: the modules read `window` at load, so the stub above must
// exist first (static imports are hoisted above it).

const { hydrateDesktopCredentials } =
  await import("../apps/geolibre-desktop/src/lib/credential-hydration");
const { rememberProjectCredentials, useProjectCredentialStore } =
  await import("../apps/geolibre-desktop/src/lib/project-credentials");
const { lookupProjectCredential } = await import("@geolibre/core");

const index = () => JSON.parse(storage.get(INDEX_KEY) ?? "null") as string[];

describe("desktop project credentials", () => {
  it("loads indexed values and drops index entries the keychain lacks", async () => {
    await hydrateDesktopCredentials();
    assert.deepEqual(useProjectCredentialStore.getState().values, { "project.env.A": "stored-a" });
    assert.deepEqual(index(), ["project.env.A"]);
    assert.equal(lookupProjectCredential("project.env.A"), "stored-a");
  });

  it("stores new values and deletes cleared ones", async () => {
    const stored = await rememberProjectCredentials({ "project.env.C": "c", "project.env.A": "" });
    assert.equal(stored, true);
    assert.equal(keychain.get("project.env.C"), "c");
    assert.equal(keychain.has("project.env.A"), false);
    assert.deepEqual(index(), ["project.env.C"]);
  });

  it("reports a failed write but keeps the value for the session", async () => {
    failWrites = true;
    const stored = await rememberProjectCredentials({ "project.env.D": "d" });
    failWrites = false;
    assert.equal(stored, false);
    assert.equal(keychain.has("project.env.D"), false);
    assert.equal(lookupProjectCredential("project.env.D"), "d");
  });

  it("keeps a name the keychain rejects out of the index", async () => {
    const tooLong = `project.env.${"X".repeat(600)}`;
    const stored = await rememberProjectCredentials({ [tooLong]: "long", "project.env.E": "e" });
    assert.equal(stored, false);
    assert.equal(lookupProjectCredential(tooLong), "long");
    assert.equal(keychain.get("project.env.E"), "e");
    assert.ok(!index().includes(tooLong));
    // The index stays readable, so later writes still reach the keychain.
    assert.equal(await rememberProjectCredentials({ "project.env.F": "f" }), true);
    assert.equal(keychain.get("project.env.F"), "f");
  });
});
