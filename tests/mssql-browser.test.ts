import assert from "node:assert/strict";
import { describe, it } from "node:test";
import i18next from "i18next";
import {
  fetchMssqlBrowserTables,
  type MssqlBrowserLoaderDependencies,
  type MssqlBrowserLoads,
} from "../apps/geolibre-desktop/src/lib/mssql-browser";

const table = {
  schema: "dbo",
  table: "parcels",
  geometry_column: "shape",
  column_type: "geometry" as const,
  srid: 4326,
  geometry_type: "POLYGON",
  primary_key: "id",
};
function dependencies(
  overrides: Partial<MssqlBrowserLoaderDependencies> = {},
): MssqlBrowserLoaderDependencies {
  return {
    isDesktop: () => true,
    startSidecar: async () => ({ baseUrl: "http://127.0.0.1", port: 8765, token: "test" }),
    fetchStatus: async () => ({
      available: true,
      message: "",
      driver: "ODBC Driver 18",
      auth_methods: ["sql"],
    }),
    listTables: async () => [table, table],
    withSession: async (_connectionId, run) => run("session"),
    ...overrides,
  };
}
function loadState() {
  let loads: MssqlBrowserLoads = {};
  return {
    get loads() {
      return loads;
    },
    set: (update: (previous: MssqlBrowserLoads) => MssqlBrowserLoads) => {
      loads = update(loads);
    },
  };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("MSSQL Browser table loading", () => {
  it("loads and de-duplicates tables, and does not refetch a settled connection", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    let listCalls = 0;
    const deps = dependencies({
      listTables: async () => {
        listCalls += 1;
        return [table, table];
      },
    });

    fetchMssqlBrowserTables("profile", fetched, state.set, i18next.t, deps);
    await nextTurn();
    fetchMssqlBrowserTables("profile", fetched, state.set, i18next.t, deps);

    assert.deepEqual(state.loads["mssql:profile"], { status: "loaded", tables: [table] });
    assert.equal(listCalls, 1);
  });

  it("reports desktop-only access without caching the failed load", () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({ isDesktop: () => false }),
    );

    assert.equal(fetched.has("profile"), false);
    assert.equal(state.loads["mssql:profile"]?.status, "error");
  });

  it("clears a failed runtime lookup so expanding the node can retry", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({
        fetchStatus: async () => ({
          available: false,
          message: "ODBC unavailable",
          driver: null,
          auth_methods: [],
        }),
      }),
    );
    await nextTurn();

    assert.equal(fetched.has("profile"), false);
    assert.equal(state.loads["mssql:profile"]?.status, "error");
  });
});
