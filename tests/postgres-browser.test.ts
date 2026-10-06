import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import type { PostgisTableInfo } from "@geolibre/processing";
import type { ConnectionLoads } from "../apps/geolibre-desktop/src/lib/browser-tree";
import {
  fetchPostgresBrowserTables,
  type PostgresBrowserLoaderDependencies,
} from "../apps/geolibre-desktop/src/lib/postgres-browser";
import { StaleSidecarError } from "../apps/geolibre-desktop/src/lib/sidecar";

const CONNECTION = "postgresql://u:pw@db.example/gis";
const table: PostgisTableInfo = {
  schema: "public",
  table: "roads",
  geometry_column: "geom",
  srid: 4326,
  geometry_type: "LINESTRING",
  primary_key: "id",
};
const translate = ((key: string) => key) as TFunction;

function dependencies(
  overrides: Partial<PostgresBrowserLoaderDependencies> = {},
): PostgresBrowserLoaderDependencies {
  return {
    isDesktop: () => true,
    startSidecar: async () => ({ baseUrl: "http://127.0.0.1", port: 8765, token: "test" }),
    fetchStatus: async () => ({ available: true, message: "" }),
    listTables: async () => [table, { ...table, geometry_column: "geom_2" }],
    ...overrides,
  };
}

function loadState() {
  let loads: ConnectionLoads = {};
  return {
    get loads() {
      return loads;
    },
    set: (update: (previous: ConnectionLoads) => ConnectionLoads) => {
      loads = update(loads);
    },
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PostgreSQL Browser table loading", () => {
  it("de-duplicates geometry rows and does not refetch a settled connection", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    let listCalls = 0;
    const deps = dependencies({
      listTables: async () => {
        listCalls += 1;
        return [table, { ...table, geometry_column: "geom_2" }];
      },
    });

    fetchPostgresBrowserTables(CONNECTION, fetched, state.set, translate, deps);
    await nextTurn();

    assert.deepEqual(state.loads[CONNECTION], {
      status: "loaded",
      tables: [{ schema: "public", table: "roads" }],
    });
    fetchPostgresBrowserTables(CONNECTION, fetched, state.set, translate, deps);
    await nextTurn();
    assert.equal(listCalls, 1);
  });

  it("reports desktop-only access without caching the failed load", () => {
    const state = loadState();
    const fetched = new Set<string>();

    fetchPostgresBrowserTables(
      CONNECTION,
      fetched,
      state.set,
      translate,
      dependencies({ isDesktop: () => false }),
    );

    assert.deepEqual(state.loads[CONNECTION], {
      status: "error",
      message: "addData.postgres.errorDesktopOnly",
    });
    assert.equal(fetched.has(CONNECTION), false);
  });

  it("clears a failed runtime lookup so expanding the node can retry", async () => {
    const state = loadState();
    const fetched = new Set<string>();

    fetchPostgresBrowserTables(
      CONNECTION,
      fetched,
      state.set,
      translate,
      dependencies({ fetchStatus: async () => ({ available: false, message: "missing" }) }),
    );
    await nextTurn();

    assert.deepEqual(state.loads[CONNECTION], {
      status: "error",
      message: "addData.postgres.errorRuntimeMissing",
    });
    assert.equal(fetched.has(CONNECTION), false);
  });

  it("surfaces a stale sidecar instead of querying it without a token", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    let statusCalls = 0;
    const stale =
      "A GeoLibre processing server from a previous session is still running on port 8765 " +
      "but does not accept this session's token. Quit any stray GeoLibre processes and try again.";
    fetchPostgresBrowserTables(
      CONNECTION,
      fetched,
      state.set,
      translate,
      dependencies({
        startSidecar: async () => {
          throw new StaleSidecarError(stale);
        },
        fetchStatus: async () => {
          statusCalls += 1;
          throw new Error("Missing or invalid sidecar token");
        },
      }),
    );
    await nextTurn();

    assert.deepEqual(state.loads[CONNECTION], { status: "error", message: stale });
    assert.equal(statusCalls, 0);
    assert.equal(fetched.has(CONNECTION), false);

    fetchPostgresBrowserTables(CONNECTION, fetched, state.set, translate, dependencies());
    await nextTurn();
    assert.deepEqual(state.loads[CONNECTION], {
      status: "loaded",
      tables: [{ schema: "public", table: "roads" }],
    });
  });

  it("lets the runtime status explain any other failed start", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchPostgresBrowserTables(
      CONNECTION,
      fetched,
      state.set,
      translate,
      dependencies({
        startSidecar: async () => {
          throw new Error("uv sync failed");
        },
      }),
    );
    await nextTurn();

    assert.deepEqual(state.loads[CONNECTION], {
      status: "loaded",
      tables: [{ schema: "public", table: "roads" }],
    });
  });

  it("preserves the table-list error and permits retry", async () => {
    const state = loadState();
    const fetched = new Set<string>();

    fetchPostgresBrowserTables(
      CONNECTION,
      fetched,
      state.set,
      translate,
      dependencies({
        listTables: async () => {
          throw new Error("password authentication failed");
        },
      }),
    );
    await nextTurn();

    assert.deepEqual(state.loads[CONNECTION], {
      status: "error",
      message: "password authentication failed",
    });
    assert.equal(fetched.has(CONNECTION), false);
  });
});
