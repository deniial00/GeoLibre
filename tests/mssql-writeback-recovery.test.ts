import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import {
  canSaveMssqlWriteback,
  clearMssqlWritebackRefresh,
  reconcileMssqlWritebackMetadata,
  requireMssqlWritebackRefresh,
  writeMssqlAndRefresh,
} from "../apps/geolibre-desktop/src/lib/mssql-writeback";
import {
  isRefreshableLayer,
  supportsAutoRefresh,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";

function feature(id: number | undefined, name: string): Feature {
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { name },
  };
}

function tableFeatures(rows: Map<number, string>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...rows].map(([id, name]) => feature(id, name)),
  };
}

describe("SQL Server write-back refresh recovery", () => {
  it("blocks replayed inserts until a successful refresh restores generated keys", async () => {
    let rows = new Map<number, string>([[1, "existing"]]);
    let nextId = 2;
    let writeCalls = 0;
    let failRefresh = true;
    let refreshRequiredLayerIds: ReadonlySet<string> = new Set();
    const editedFeatures: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature(1, "edited existing"), feature(undefined, "new row")],
    };
    const source = {
      id: "layer-1",
      name: "SQL Server layer",
      type: "geojson",
      source: {},
      metadata: {
        sourceKind: "mssql-table",
        mssqlConnectionId: "saved-profile",
        mssqlTable: "parcels",
        mssqlPrimaryKey: "id",
        mssqlBaselineKeys: [1],
      },
      geojson: editedFeatures,
    } as unknown as GeoLibreLayer;
    let activeLayer = source;
    const refreshTable = async () => {
      if (failRefresh) {
        failRefresh = false;
        throw new Error("table read unavailable");
      }
      const geojson = tableFeatures(rows);
      return { geojson, feature_count: geojson.features.length };
    };
    const submit = () =>
      writeMssqlAndRefresh(
        !canSaveMssqlWriteback(activeLayer.id, refreshRequiredLayerIds),
        async () => {
          writeCalls += 1;
          let inserted = 0;
          for (const item of (activeLayer.geojson ?? editedFeatures).features) {
            const id = typeof item.id === "number" ? item.id : undefined;
            if (id === undefined) {
              rows.set(nextId++, String(item.properties?.name));
              inserted += 1;
            } else {
              rows.set(id, String(item.properties?.name));
            }
          }
          return { inserted };
        },
        refreshTable,
      );

    const firstSave = await submit();
    assert.equal(firstSave.kind, "refresh-failed");
    if (firstSave.kind !== "refresh-failed") return;
    assert.deepEqual(firstSave.writeResult, { inserted: 1 });
    assert.equal(rows.size, 2, "the first write committed before the refresh failed");
    assert.deepEqual(
      activeLayer.metadata,
      source.metadata,
      "the failed reread leaves metadata untouched",
    );

    refreshRequiredLayerIds = requireMssqlWritebackRefresh(refreshRequiredLayerIds, source.id);
    assert.equal(canSaveMssqlWriteback(activeLayer.id, refreshRequiredLayerIds), false);
    assert.equal(
      isRefreshableLayer(activeLayer, refreshRequiredLayerIds.has(activeLayer.id)),
      true,
      "manual refresh remains available",
    );
    assert.equal(
      supportsAutoRefresh(activeLayer, refreshRequiredLayerIds.has(activeLayer.id)),
      false,
      "reconciliation is never automatic",
    );

    const retry = await submit();
    assert.deepEqual(retry, { kind: "blocked" });
    assert.equal(writeCalls, 1, "a retry must not issue another table write");
    assert.equal(rows.size, 2, "the blocked retry cannot insert a duplicate row");

    const refreshed = await refreshTable();
    activeLayer = {
      ...activeLayer,
      geojson: refreshed.geojson,
      metadata: reconcileMssqlWritebackMetadata(activeLayer.metadata, refreshed),
    };
    refreshRequiredLayerIds = clearMssqlWritebackRefresh(refreshRequiredLayerIds, activeLayer.id);
    assert.equal(canSaveMssqlWriteback(activeLayer.id, refreshRequiredLayerIds), true);
    assert.deepEqual(activeLayer.metadata.mssqlBaselineKeys, [1, 2]);

    const afterRefresh = await submit();
    assert.equal(afterRefresh.kind, "reconciled");
    assert.equal(writeCalls, 2);
    assert.equal(
      rows.size,
      2,
      "the reconciled retry updates known keys instead of inserting again",
    );
  });
});
