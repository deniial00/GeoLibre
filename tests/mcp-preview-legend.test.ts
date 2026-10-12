import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import {
  DEFAULT_LAYER_STYLE,
  parseProject,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import { previewLegendModel } from "../apps/geolibre-mcp-app/src/legend-model";
import { visibleLegendRows } from "../apps/geolibre-desktop/src/components/legend/LegendDisplay";

const original = {
  window: globalThis.window,
  document: globalThis.document,
  CSS: globalThis.CSS,
  HTMLElement: globalThis.HTMLElement,
  ResizeObserver: globalThis.ResizeObserver,
  Node: globalThis.Node,
  Element: globalThis.Element,
  Event: globalThis.Event,
};
afterEach(() => {
  const current = globalThis.window as unknown as Window | undefined;
  current?.happyDOM.close();
  Object.assign(globalThis, original);
});
function withDocument(): void {
  const window = new Window();
  Object.assign(globalThis, {
    window,
    document: window.document,
    CSS: {
      supports: (_property: string, value: string) =>
        /^#[\da-f]{3,8}$/i.test(value) || value === "transparent",
    } as typeof CSS,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Element: window.Element,
    Event: window.Event,
  });
}

function project(legend: unknown): GeoLibreProject {
  return parseProject(
    JSON.stringify({
      version: "0.2.0",
      name: "Legend preview",
      mapView: { center: [0, 0], zoom: 3 },
      layers: [],
      legend,
    }),
  );
}

function vector(id: string, visible = true): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    visible,
    opacity: 1,
    source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    geojson: { type: "FeatureCollection", features: [] },
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  };
}

describe("MCP preview root legend model", () => {
  it("omits hidden and unsupported custom entries but retains standalone entries", () => {
    withDocument();
    const saved = project({
      title: "Saved legend",
      groupByLayer: true,
      order: [],
      overrides: {},
      customEntries: {
        hidden: { title: "Hidden custom", items: [{ label: "Hidden row", color: "#123456" }] },
        unsupported: {
          title: "Unsupported custom",
          items: [{ label: "Unsupported row", color: "#654321" }],
        },
        "custom:standalone": {
          title: "Standalone",
          items: [{ label: "Standalone row", color: "#abcdef" }],
        },
      },
    });
    const unsupported: GeoLibreLayer = {
      ...vector("unsupported"),
      type: "pmtiles",
      source: { type: "vector" },
    };
    const { entries } = previewLegendModel(saved, [vector("hidden", false), unsupported]);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["Standalone"],
    );
    assert.equal(entries[0].rows[0].label, "Standalone row");
  });

  it("removes unsafe raster gradients and replaces fabricated rows with transparent swatches", () => {
    withDocument();
    const saved = project({ title: "Raster legend", groupByLayer: true, order: [], overrides: {} });
    const unknownRamp: GeoLibreLayer = {
      ...vector("unknown-ramp"),
      name: "Unknown ramp raster",
      type: "raster",
      source: { type: "raster", tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"] },
      metadata: {
        rasterSymbology: {
          classified: false,
          ramp: "saved-unavailable-ramp",
          method: "equal-interval",
          classCount: 2,
          breaks: [0, 10, 20],
        },
        rasterState: { mode: "single", colormap: "", rescale: [[2, 8]] },
      },
    };
    const noPalette: GeoLibreLayer = {
      ...unknownRamp,
      id: "no-palette",
      name: "No palette raster",
      metadata: {},
    };
    const { entries, notices } = previewLegendModel(saved, [unknownRamp, noPalette]);
    assert.equal(
      entries.some((entry) => "gradient" in entry),
      false,
    );
    assert.equal(
      entries.every((entry) => entry.rows.every((row) => row.color === "transparent")),
      true,
    );
    assert.ok(notices.some((notice) => notice.includes("saved-unavailable-ramp")));
  });

  it("carries a hidden secondary-field caption onto its next visible row", () => {
    withDocument();
    const saved = project({
      groupByLayer: true,
      order: [],
      overrides: { "two-fields::p:3": { hidden: true } },
    });
    const sized = vector("two-fields");
    sized.metadata.geometryType = "point";
    sized.style = {
      ...sized.style,
      vectorStyleMode: "categorized",
      vectorStyleProperty: "region",
      vectorStyleStops: [
        { value: "north", color: "#440154" },
        { value: "south", color: "#31688e" },
        { value: "east", color: "#fde725" },
      ],
      proportionalSizeEnabled: true,
      proportionalSizeProperty: "pop_max",
      proportionalSizeMinValue: 0,
      proportionalSizeMaxValue: 100,
      proportionalSizeMinRadius: 4,
      proportionalSizeMaxRadius: 12,
    };
    const entry = previewLegendModel(saved, [sized]).entries[0];
    const rows = visibleLegendRows(entry.rows);
    assert.deepEqual(
      rows.map((row) => row.label),
      ["north", "south", "east", "50", "100"],
    );
    assert.equal(rows.find((row) => row.label === "50")?.caption, "pop_max");
  });

  it("keeps safe known heatmap colors and removes an unavailable ramp", () => {
    withDocument();
    const known = vector("known-heatmap");
    known.metadata.geometryType = "point";
    known.style = { ...known.style, pointRenderer: "heatmap", heatmapColorRamp: "viridis" };
    const unknown: GeoLibreLayer = {
      ...known,
      id: "unknown-heatmap",
      name: "Unknown heatmap",
      style: { ...known.style, heatmapColorRamp: "saved-unknown-heatmap-ramp" },
    };
    const { entries, notices } = previewLegendModel(
      project({ groupByLayer: true, order: [], overrides: {} }),
      [known, unknown],
    );
    const knownEntry = entries.find((entry) => entry.id === known.id)!;
    const unknownEntry = entries.find((entry) => entry.id === unknown.id)!;
    assert.equal(knownEntry.gradient?.colors[0], "#00000000");
    assert.ok(!("gradient" in unknownEntry));
    assert.ok(notices.some((notice) => notice.includes("saved-unknown-heatmap-ramp")));
  });
});
