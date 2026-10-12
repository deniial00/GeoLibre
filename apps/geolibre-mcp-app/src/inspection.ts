import { applyGroupEffects, type GeoLibreLayer, type GeoLibreProject } from "@geolibre/core";
import type { Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { getLayerBounds, sourceId } from "@geolibre/map/headless";
import { previewLayerUnsupportedReason } from "./unsupported-content";

export type PreviewBounds = [number, number, number, number];

function validBounds(value: unknown): PreviewBounds | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    return null;
  const [west, south, savedEast, north] = value as PreviewBounds;
  const east = savedEast < west ? savedEast + 360 : savedEast;
  if (south > north || south < -90 || north > 90 || east < west || east - west > 360) return null;
  return [west, south, east, north];
}

function validCoordinates(value: unknown, depth: number): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  if (depth > 0) return value.every((child) => validCoordinates(child, depth - 1));
  return (
    value.length >= 2 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function validGeometry(geometry: Geometry): boolean {
  switch (geometry.type) {
    case "Point":
      return validCoordinates(geometry.coordinates, 0);
    case "MultiPoint":
    case "LineString":
      return validCoordinates(geometry.coordinates, 1);
    case "MultiLineString":
    case "Polygon":
      return validCoordinates(geometry.coordinates, 2);
    case "MultiPolygon":
      return validCoordinates(geometry.coordinates, 3);
    case "GeometryCollection":
      return geometry.geometries.length > 0 && geometry.geometries.every(validGeometry);
    default:
      return false;
  }
}

/** Saved/local extents and already-loaded TileJSON only; never fetch to find bounds. */
export function getPreviewLayerBounds(
  layer: GeoLibreLayer,
  map?: MapLibreMap,
): PreviewBounds | null {
  if (previewLayerUnsupportedReason(layer)) return null;
  try {
    const saved = getLayerBounds(layer);
    if (layer.type === "geojson") {
      const geometries =
        layer.geojson?.features
          .map((feature) => feature.geometry)
          .filter((geometry): geometry is Geometry => geometry != null) ?? [];
      if (!geometries.length || !geometries.every(validGeometry)) return null;
    }
    if (saved) return validBounds(saved);
    if (layer.type === "image") {
      const coordinates = layer.source.coordinates;
      if (
        !Array.isArray(coordinates) ||
        coordinates.length !== 4 ||
        !coordinates.every(
          (point) =>
            Array.isArray(point) &&
            point.length === 2 &&
            point.every((n) => typeof n === "number" && Number.isFinite(n)),
        )
      )
        return null;
      const points = coordinates as [number, number][];
      const reference = points[0][0];
      const longitudes = points.map(
        ([longitude]) => reference + ((((longitude - reference) % 360) + 540) % 360) - 180,
      );
      return validBounds([
        Math.min(...longitudes),
        Math.min(...points.map((p) => p[1])),
        Math.max(...longitudes),
        Math.max(...points.map((p) => p[1])),
      ]);
    }
    const source = map?.getSource(sourceId(layer.id));
    return validBounds(source && "bounds" in source ? source.bounds : undefined);
  } catch {
    return null;
  }
}

/** Omit custom artwork whose loaders bypass the preview's consent transport. */
export function previewRenderLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const omitMarker = layer.style.markerEnabled === true && layer.style.markerShape === "custom";
  const omitPattern = layer.style.fillPattern === "svg";
  if (!omitMarker && !omitPattern) return layer;

  const style = { ...layer.style };
  if (omitMarker) {
    style.markerEnabled = false;
    style.markerSvg = "";
  }
  if (omitPattern) {
    style.fillPattern = "none";
    style.fillPatternSvg = "";
  }
  return { ...layer, style };
}

/** Detached effective state: local toggles never edit saved visibility or groups. */
export function previewEffectiveLayers(project: GeoLibreProject): GeoLibreLayer[] {
  return applyGroupEffects(project.layers, project.layerGroups ?? []).map((layer) =>
    previewRenderLayer({
      ...layer,
      visible: layer.visible && previewLayerUnsupportedReason(layer) === undefined,
    }),
  );
}
