import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const oldSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const oldLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = { getItem: () => null };
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { search: "" } },
});
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
// The imported plugin reads browser storage during module initialization; provide Node-safe globals only for that import.
const { isMssqlEditableLayer } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/layer-panel-utils");
if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
else Reflect.deleteProperty(globalThis, "window");
if (oldSessionStorage) Object.defineProperty(globalThis, "sessionStorage", oldSessionStorage);
else Reflect.deleteProperty(globalThis, "sessionStorage");
if (oldLocalStorage) Object.defineProperty(globalThis, "localStorage", oldLocalStorage);
else Reflect.deleteProperty(globalThis, "localStorage");

function layer(metadata: Record<string, unknown>): GeoLibreLayer {
  return { type: "geojson", metadata } as unknown as GeoLibreLayer;
}
function withLayerType(layer: GeoLibreLayer, type: string): GeoLibreLayer {
  return { ...layer, type } as unknown as GeoLibreLayer;
}

describe("MSSQL editable layers", () => {
  it("requires a GeoJSON table layer, table name, primary key, and saved connection reference", () => {
    const valid = layer({
      sourceKind: "mssql-table",
      mssqlTable: "parcels",
      mssqlPrimaryKey: "parcel_id",
      mssqlConnectionId: "profile-id",
    });
    assert.equal(isMssqlEditableLayer(valid), true);
    assert.equal(isMssqlEditableLayer(withLayerType(valid, "vector")), false);
    assert.equal(
      isMssqlEditableLayer(layer({ ...valid.metadata, sourceKind: "postgis-table" })),
      false,
    );
    assert.equal(isMssqlEditableLayer(layer({ ...valid.metadata, mssqlTable: undefined })), false);
    assert.equal(isMssqlEditableLayer(layer({ ...valid.metadata, mssqlPrimaryKey: null })), false);
    assert.equal(
      isMssqlEditableLayer(layer({ ...valid.metadata, mssqlConnectionId: undefined })),
      false,
    );
  });
});
