import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_LEGEND_CONFIG,
  createEmptyProject,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerStyle,
} from "@geolibre/core";

const style = (overrides: Partial<LayerStyle> = {}): LayerStyle => ({
  ...DEFAULT_LAYER_STYLE,
  labels: { ...DEFAULT_LAYER_STYLE.labels },
  ...overrides,
});

function polygonFeature(name: string, extent: number, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    properties: { name, ...properties },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [-extent, -extent],
          [extent, -extent],
          [extent, extent],
          [-extent, extent],
          [-extent, -extent],
        ],
      ],
    },
  };
}
function polygonAt(name: string, west: number, south: number, east: number, north: number) {
  return {
    type: "Feature" as const,
    properties: { name },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

function layer(
  id: string,
  name: string,
  type: GeoLibreLayer["type"],
  options: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  return {
    id,
    name,
    type,
    source: {},
    visible: true,
    opacity: 1,
    style: style(),
    metadata: {},
    ...options,
  };
}

export function createFixture(name: FixtureName): GeoLibreProject {
  const project = createEmptyProject(`MCP App ${name}`, {
    basemapStyleUrl: "",
    mapView: { center: [0, 0], zoom: 3, bearing: 0, pitch: 0 },
  });
  project.basemapVisible = false;
  project.blankBackgroundColor = "#ffffff";
  project.layers = fixtureLayers(name);
  project.styles = Object.fromEntries(project.layers.map((entry) => [entry.id, entry.style]));
  if (name === "overlap" || name === "legends") {
    project.layerGroups = [
      { id: "hidden-group", name: "Hidden group", collapsed: false, visible: false, opacity: 0.5 },
    ];
    project.layers[0]!.groupId = "hidden-group";
    if (name === "legends") project.legend = legendConfig();
  }
  if (name === "empty-controls") project.plugins = emptyComponentsState();
  if (name === "legends") project.plugins = legendsComponentsState();
  if (name === "legend-order") project.plugins = legendOrderComponentsState();
  return project;
}

export type FixtureName =
  | "overlap"
  | "bounds"
  | "legends"
  | "legend-order"
  | "properties"
  | "empty-controls"
  | "registration-failure";

function fixtureLayers(fixture: FixtureName): GeoLibreLayer[] {
  if (fixture === "registration-failure") {
    // Inline data reaches registration without a network or a mocked renderer.
    return [
      layer("malformed", "Malformed GeoJSON", "geojson", {
        visible: false,
        geojson: {
          type: "FeatureCollection",
          features: null,
        } as unknown as GeoLibreLayer["geojson"],
      }),
    ];
  }
  if (fixture === "overlap" || fixture === "legends") {
    const lower = layer("region", "Hidden lower", "geojson", {
      visible: false,
      opacity: 1,
      geojson: { type: "FeatureCollection", features: [polygonFeature("Lower feature", 10)] },
      popup: { click: true },
      style: style({
        fillColor: "#ff0000",
        strokeColor: "#ff0000",
        fillOpacity: 1,
        strokeWidth: 0,
      }),
    });
    const upper = layer("region-fill", "Upper layer", "geojson", {
      geojson: { type: "FeatureCollection", features: [polygonFeature("Upper feature", 10)] },
      popup: { click: true },
      style: style({
        fillColor: "#0000ff",
        strokeColor: "#0000ff",
        fillOpacity: 1,
        strokeWidth: 0,
      }),
    });
    const remote = layer("remote", "Hidden public tiles", "xyz", {
      visible: false,
      source: {
        type: "raster",
        tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"],
        tileSize: 256,
      },
      style: style(),
    });
    const unsupported = layer("unsupported", "Unsupported LiDAR", "lidar", {
      visible: true,
      source: { type: "raster", url: "https://tiles.example.test/tiles.json" },
    });
    return fixture === "legends" ? [lower, upper, unsupported] : [lower, upper, remote];
  }
  if (fixture === "properties") {
    const props = layer("properties", "Properties", "geojson", {
      geojson: {
        type: "FeatureCollection",
        features: [
          polygonFeature("Readable properties", 2, {
            price: 12.5,
            secret: "never show this",
            longText: "A long property value ".repeat(24),
            tags: [1, "two", null],
            details: { nested: "value" },
            nullable: null,
            photo: "https://images.example.test/private.png",
            link: "https://example.test/private",
            description:
              '<a href="https://example.test/kml">KML link</a><img src="https://images.example.test/kml.png">',
          }),
        ],
      },
      popup: {
        click: true,
        fields: [
          {
            field: "price",
            label: "Saved price",
            kind: "number",
            format: { prefix: "$", decimals: 1 },
          },
          { field: "name" },
          { field: "longText" },
          { field: "tags" },
          { field: "details" },
          { field: "nullable" },
          { field: "photo" },
          { field: "link" },
          { field: "description" },
        ],
      },
      fieldVisibility: { secret: "hidden" },
      style: style({ fillColor: "#d79821", strokeWidth: 0 }),
    });
    const customMarkerUrl = layer("custom-marker-url", "Omitted custom marker URL", "geojson", {
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "Marker URL" },
            geometry: { type: "Point", coordinates: [-30, 10] },
          },
        ],
      },
      style: style({
        markerEnabled: true,
        markerShape: "custom",
        markerSvg: "https://images.example.test/marker.svg",
      }),
    });
    const customMarkerInline = layer("custom-marker-inline", "Omitted inline marker", "geojson", {
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "Inline marker" },
            geometry: { type: "Point", coordinates: [30, 10] },
          },
        ],
      },
      style: style({
        markerEnabled: true,
        markerShape: "custom",
        markerSvg:
          '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://images.example.test/symbol.svg#pin"/></svg>',
      }),
    });
    const customPatternInline = layer(
      "custom-pattern-inline",
      "Omitted inline pattern",
      "geojson",
      {
        geojson: {
          type: "FeatureCollection",
          features: [polygonAt("Pattern inline", 18, -8, 22, -4)],
        },
        style: style({
          fillPattern: "svg",
          fillPatternSvg:
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://images.example.test/pattern.png"/></svg>',
        }),
      },
    );
    const customPatternUrl = layer("custom-pattern-url", "Omitted pattern URL", "geojson", {
      geojson: { type: "FeatureCollection", features: [polygonAt("Pattern URL", 18, 4, 22, 8)] },
      style: style({
        fillPattern: "svg",
        fillPatternSvg: "https://images.example.test/pattern.svg",
      }),
    });
    return [props, customMarkerUrl, customMarkerInline, customPatternInline, customPatternUrl];
  }
  if (fixture === "bounds") {
    return [
      layer("point", "Point", "geojson", {
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { name: "Known point" },
              geometry: { type: "Point", coordinates: [40, 30] },
            },
          ],
        },
        popup: { click: true },
      }),
      layer("polygon", "Polygon", "geojson", {
        geojson: {
          type: "FeatureCollection",
          features: [polygonFeature("Minimum zoom polygon", 60)],
        },
        popup: { click: true },
        metadata: { minzoom: 6 },
        style: style({ minZoom: 6, fillColor: "#2d8a52", strokeWidth: 0 }),
      }),
      layer("image", "Known image extent", "image", {
        visible: false,
        source: {
          type: "image",
          url: "https://images.example.test/image.png",
          coordinates: [
            [-10, 10],
            [10, 10],
            [10, -10],
            [-10, -10],
          ],
        },
      }),
      layer("unknown", "Unknown extent", "xyz", {
        visible: false,
        source: {
          type: "raster",
          tiles: ["https://tiles.example.test/unknown/{z}/{x}/{y}.png"],
          tileSize: 256,
        },
      }),
      layer("tilejson", "Advertised TileJSON bounds", "vector-tiles", {
        visible: false,
        source: {
          type: "vector",
          url: "https://tiles.example.test/tiles.json",
          sourceLayer: "fixture",
        },
      }),
    ];
  }
  return [];
}

function legendConfig() {
  return {
    ...DEFAULT_LEGEND_CONFIG,
    title: "Saved root legend",
    panelVisible: true,
    panelCollapsed: false,
    order: ["custom:standalone", "region-fill", "region", "unsupported"],
    customEntries: {
      region: { title: "Hidden replacement", items: [{ label: "Hidden class", color: "#cc0000" }] },
      unsupported: {
        title: "Unsupported replacement",
        items: [{ label: "Unsupported row", color: "#333333" }],
      },
      "custom:standalone": {
        title: "Standalone section",
        items: [{ label: "Standalone row", color: "#663399" }],
      },
      "region-fill": {
        title: "Renamed upper",
        items: [{ label: "Saved blue class", color: "#0000ff" }],
      },
    },
  };
}

function legendsComponentsState() {
  return {
    manifestUrls: [],
    activePluginIds: [],
    mapControlPositions: {},
    settings: {
      "maplibre-gl-components": {
        legend: {
          visible: true,
          title: "First saved legend",
          items: [],
          hasLegend: true,
          legends: [
            {
              title: "First saved legend",
              items: [
                {
                  label: "Literal legend row",
                  color: "url(https://bad.example/a)",
                  icon: "<svg><script>bad()</script></svg>",
                },
              ],
            },
            {
              title: "Second saved legend",
              items: [
                {
                  label: "<b>not markup</b>",
                  color: "#336699",
                  shape: "circle",
                  icon: "https://images.example.test/icon.png",
                },
              ],
            },
            null,
            { title: "Malformed no items" },
          ],
        },
        colorbar: {
          visible: true,
          label: "Named ramp",
          units: "°C",
          colormap: "viridis",
          customColors: "#440154,#fde725",
          vmin: 0,
          vmax: 100,
          mode: "named",
          orientation: "horizontal",
          stackOrientation: "horizontal",
          colorbars: [
            {
              label: "Named ramp",
              units: "°C",
              colormap: "viridis",
              customColors: "#440154,#fde725",
              vmin: 0,
              vmax: 100,
              mode: "named",
              orientation: "horizontal",
            },
            {
              label: "Custom ramp",
              units: "m",
              colormap: "",
              customColors: "#0000ff,#ffffff",
              vmin: 1.25,
              vmax: 9.5,
              mode: "custom",
              orientation: "vertical",
            },
            {
              label: "Unknown ramp",
              units: "m",
              colormap: "not-a-real-ramp",
              customColors: "",
              vmin: -10,
              vmax: 10,
              mode: "named",
              orientation: "horizontal",
            },
            null,
            {
              label: "Malformed",
              units: "m",
              colormap: "viridis",
              customColors: "",
              vmin: "bad",
              vmax: 10,
              mode: "named",
              orientation: "horizontal",
            },
          ],
        },
      },
    },
  };
}

function legendOrderComponentsState() {
  const legend = (title: string, legendPosition: "top-left" | "bottom-left") => ({
    title,
    legendPosition,
    items: [{ label: `${title} row`, color: "#336699" }],
  });
  return {
    manifestUrls: [],
    activePluginIds: [],
    mapControlPositions: {},
    settings: {
      "maplibre-gl-components": {
        legend: {
          visible: true,
          legends: [
            legend("Top first", "top-left"),
            legend("Top second", "top-left"),
            legend("Bottom first", "bottom-left"),
            legend("Bottom second", "bottom-left"),
          ],
        },
        colorbar: { visible: false, colorbars: [] },
      },
    },
  };
}

function emptyComponentsState() {
  return {
    manifestUrls: [],
    activePluginIds: [],
    mapControlPositions: {},
    settings: {
      "maplibre-gl-components": {
        legend: { visible: true, title: "", items: [], legends: [], hasLegend: false },
        colorbar: {
          visible: true,
          label: "",
          units: "",
          colormap: "",
          customColors: "",
          vmin: 0,
          vmax: 0,
          colorbars: [],
          hasColorbar: false,
        },
      },
    },
  };
}

const rasterTilePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4P5PhPwAGywKYdXfpmQAAAABJRU5ErkJggg==";
export const FIXTURE_TILE_PNG_BASE64 = rasterTilePng;
export const FIXTURE_TILEJSON = {
  tilejson: "3.0.0",
  tiles: ["https://tiles.example.test/{z}/{x}/{y}.pbf"],
  vector_layers: [{ id: "fixture", fields: {} }],
  bounds: [-5, -5, 5, 5],
  minzoom: 0,
  maxzoom: 14,
};
export const FIXTURE_IMAGE_PNG_BASE64 = rasterTilePng;
// MVT v2: a point at tile center in the "fixture" layer, extent 4096.
export const FIXTURE_VECTOR_TILE_BASE64 = "GhsKB2ZpeHR1cmUSCwgBGAEiBQmAIIAgKIAgeAI=";
