import type { MapRendererKind } from "@geolibre/core";

// These loaders still depend on MapLibre protocols or custom render passes.
// Keep the menu and command palette in agreement until they have adapters.
// Sources drawn through the shared deck.gl overlay (Deck.gl Layer, 3D Model,
// DuckDB, 3D Tiles, LiDAR) are not listed: `@deck.gl/mapbox` hosts them on
// Mapbox natively. KML/KMZ is not listed either: off the globe it goes through
// the host KML importer, the same path a dropped file takes on any renderer.
const MAPBOX_UNSUPPORTED_SOURCES = new Set(["mbtiles", "splatting", "cesium-ion", "czml"]);

// The ArcGIS deck overlay hosts Deck.gl Layer and 3D Model in flat/local views.
// The remaining plugin loaders still require a MapLibre control, as do
// the archives and cloud rasters that need a MapLibre protocol, and the Vector
// and Raster panels, which are MapLibre plugin controls with nowhere to mount
// (see packages/map/src/arcgis-layers.ts for what it does draw). Ids are the
// catalog's (`DATA_SOURCE_CATALOG` in ui-profile.ts).
const ARCGIS_UNSUPPORTED_SOURCES = new Set([
  ...[...MAPBOX_UNSUPPORTED_SOURCES].filter((id) => id !== "mbtiles"),
  "vector",
  "raster",
  "lidar",
  "3d-tiles",
  "duckdb",
]);

export function supportsAddDataRenderer(id: string, renderer: MapRendererKind): boolean {
  if (renderer === "mapbox") return !MAPBOX_UNSUPPORTED_SOURCES.has(id);
  if (renderer === "arcgis") return !ARCGIS_UNSUPPORTED_SOURCES.has(id);
  return true;
}
