import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, parseProject, type GeoLibreLayer } from "@geolibre/core";
import {
  getPreviewLayerBounds,
  previewEffectiveLayers,
  previewRenderLayer,
} from "../apps/geolibre-mcp-app/src/inspection";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  previewGradientColors,
  previewNamedRamp,
} from "../apps/geolibre-mcp-app/src/legend-swatches";

function layer(style: Partial<GeoLibreLayer["style"]> = {}): GeoLibreLayer {
  return {
    id: "layer",
    name: "Layer",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: { retained: true },
  };
}

describe("MCP preview render decoration policy", () => {
  it("returns the same layer when no active custom artwork needs omission", () => {
    for (const saved of [
      layer(),
      layer({
        markerEnabled: false,
        markerShape: "custom",
        markerSvg: "https://example.test/marker.svg",
      }),
      layer({ markerEnabled: true, markerShape: "star", markerSvg: "<svg/>" }),
      layer({ fillPattern: "dots", fillPatternSvg: "https://example.test/pattern.svg" }),
    ]) {
      assert.equal(previewRenderLayer(saved), saved);
    }
  });

  it("disables an enabled custom marker and clears URL or inline artwork on shallow copies", () => {
    for (const artwork of [
      "https://example.test/marker.svg",
      '<svg><image href="https://example.test/pixel.png"/></svg>',
    ]) {
      const saved = layer({ markerEnabled: true, markerShape: "custom", markerSvg: artwork });
      const source = saved.source;
      const metadata = saved.metadata;
      Object.freeze(saved.style);
      Object.freeze(saved);

      const rendered = previewRenderLayer(saved);
      assert.notEqual(rendered, saved);
      assert.notEqual(rendered.style, saved.style);
      assert.equal(rendered.style.markerEnabled, false);
      assert.equal(rendered.style.markerSvg, "");
      assert.equal(rendered.style.markerShape, "custom");
      assert.equal(rendered.source, source);
      assert.equal(rendered.metadata, metadata);
      assert.equal(saved.style.markerEnabled, true);
      assert.equal(saved.style.markerSvg, artwork);
    }
  });

  it("replaces SVG fill art with no pattern without mutating the saved style", () => {
    const saved = layer({
      fillPattern: "svg",
      fillPatternSvg: '<svg><image href="https://example.test/pattern.png"/></svg>',
    });
    const source = saved.source;
    const metadata = saved.metadata;
    Object.freeze(saved.style);
    Object.freeze(saved);

    const rendered = previewRenderLayer(saved);
    assert.notEqual(rendered, saved);
    assert.notEqual(rendered.style, saved.style);
    assert.equal(rendered.style.fillPattern, "none");
    assert.equal(rendered.style.fillPatternSvg, "");
    assert.equal(rendered.source, source);
    assert.equal(rendered.metadata, metadata);
    assert.equal(saved.style.fillPattern, "svg");
    assert.notEqual(saved.style.fillPatternSvg, "");
  });

  it("omits marker and pattern together while retaining unrelated style values", () => {
    const saved = layer({
      markerEnabled: true,
      markerShape: "custom",
      markerSvg: "data:image/svg+xml;base64,PHN2Zy8+",
      fillPattern: "svg",
      fillPatternSvg: "<svg/> ",
      markerColor: "#123456",
      fillColor: "#abcdef",
    });
    const rendered = previewRenderLayer(saved);

    assert.notEqual(rendered, saved);
    assert.equal(rendered.style.markerEnabled, false);
    assert.equal(rendered.style.markerSvg, "");
    assert.equal(rendered.style.fillPattern, "none");
    assert.equal(rendered.style.fillPatternSvg, "");
    assert.equal(rendered.style.markerColor, "#123456");
    assert.equal(rendered.style.fillColor, "#abcdef");
    assert.equal(saved.style.markerEnabled, true);
    assert.equal(saved.style.fillPattern, "svg");
  });
});

describe("MCP preview effective layer state", () => {
  it("allows local visibility overrides without editing saved layers/groups or losing group opacity", () => {
    const child = {
      ...layer(),
      groupId: "hidden-group",
      opacity: 0.8,
      geojson: { type: "FeatureCollection" as const, features: [] },
    };
    const standalone = { ...child, id: "standalone", groupId: undefined };
    const unsupported = { ...standalone, id: "unsupported", type: "pmtiles" };
    const saved = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Immutable saved project",
        mapView: { center: [0, 0], zoom: 3 },
        layers: [child, standalone, unsupported],
        layerGroups: [
          {
            id: "hidden-group",
            name: "Hidden group",
            collapsed: false,
            visible: false,
            opacity: 0.4,
          },
        ],
      }),
    );
    const before = structuredClone(saved);
    saved.layers.forEach((entry) => {
      Object.freeze(entry.style);
      Object.freeze(entry);
    });
    saved.layerGroups!.forEach(Object.freeze);
    Object.freeze(saved.layers);
    const effective = previewEffectiveLayers(saved);
    assert.equal(effective[0].visible, false);
    assert.equal(effective[0].opacity, 0.8 * 0.4);
    assert.equal(effective[2].visible, false);
    effective[0].visible = true;
    effective[1].visible = false;
    assert.deepEqual(saved, before);
    assert.equal(effective[0].opacity, 0.8 * 0.4);
  });
});

describe("MCP preview fetch-free bounds", () => {
  it("returns finite point bounds and rejects empty, null, or malformed geometry", () => {
    const saved = layer();
    saved.geojson = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [12, 34] } },
      ],
    };
    assert.deepEqual(getPreviewLayerBounds(saved), [12, 34, 12, 34]);
    const nullGeometry = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Null geometry",
        mapView: { center: [0, 0], zoom: 3 },
        layers: [
          {
            ...saved,
            geojson: {
              type: "FeatureCollection",
              features: [{ type: "Feature", properties: {}, geometry: null }],
            },
          },
        ],
      }),
    ).layers[0];
    assert.equal(getPreviewLayerBounds(nullGeometry), null);
    saved.geojson.features[0].geometry = { type: "Point", coordinates: [12, NaN] };
    assert.equal(getPreviewLayerBounds(saved), null);
    saved.geojson.features[0].geometry = { type: "Point", coordinates: [12, 91] };
    assert.equal(getPreviewLayerBounds(saved), null);
    saved.geojson.features = [];
    assert.equal(getPreviewLayerBounds(saved), null);
  });

  it("derives four image corners locally, including an antimeridian crossing", () => {
    const saved: GeoLibreLayer = {
      ...layer(),
      type: "image",
      source: {
        type: "image",
        url: "https://images.example.test/image.png",
        coordinates: [
          [170, 10],
          [-170, 10],
          [-170, -10],
          [170, -10],
        ],
      },
    };
    assert.deepEqual(getPreviewLayerBounds(saved), [170, -10, 190, 10]);
    saved.source.coordinates = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    assert.equal(getPreviewLayerBounds(saved), null);
    saved.source.coordinates = [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, Infinity],
    ];
    assert.equal(getPreviewLayerBounds(saved), null);
  });

  it("uses advertised extents, never loaded tile fragments, and rejects invalid boxes", () => {
    const saved: GeoLibreLayer = {
      ...layer(),
      type: "xyz",
      source: {
        type: "raster",
        tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"],
      },
    };
    assert.equal(getPreviewLayerBounds(saved), null);
    const liveMap = {
      getSource: () => ({ bounds: [170, -20, -170, 20] }),
    } as unknown as MapLibreMap;
    assert.deepEqual(getPreviewLayerBounds(saved, liveMap), [170, -20, 190, 20]);
    for (const bounds of [
      [0, 20, 10, -20],
      [0, -91, 10, 20],
      [0, -20, 361, 20],
      [NaN, 0, 1, 1],
      [0, 0, -400, 1],
    ]) {
      saved.source.bounds = bounds;
      assert.equal(getPreviewLayerBounds(saved), null);
    }
    const throwing = {
      getSource: () => {
        throw new Error("removed map");
      },
    } as unknown as MapLibreMap;
    delete saved.source.bounds;
    assert.equal(getPreviewLayerBounds(saved, throwing), null);
    assert.equal(getPreviewLayerBounds({ ...saved, type: "video" }, liveMap), null);
  });
});

describe("MCP preview safe color ramps", () => {
  it("rejects unavailable named ramps instead of substituting a registered palette", () => {
    assert.equal(previewNamedRamp("not-a-palette"), null);
    assert.equal(previewNamedRamp("__proto__"), null);
    assert.deepEqual(previewNamedRamp("viridis"), ["#440154", "#31688e", "#35b779", "#fde725"]);
  });

  it("normalizes every gradient stop and refuses unsafe or insufficient colors", () => {
    assert.deepEqual(previewGradientColors(["#f00", "00FF00"]), ["#ff0000", "#00ff00"]);
    assert.deepEqual(previewGradientColors(["#f00", "#00f"]), ["#ff0000", "#0000ff"]);
    assert.deepEqual(previewGradientColors(["#fff"]), null);
    assert.deepEqual(
      previewGradientColors(["#fff", "url(https://outside.invalid/image.svg)"]),
      null,
    );
    assert.deepEqual(previewGradientColors(["red", "#000"]), null);
    assert.deepEqual(previewGradientColors(["#440154", "#31688e", "#35b779", "#fde725"], true), [
      "#00000000",
      "#31688e",
      "#35b779",
      "#fde725",
    ]);
  });
});
