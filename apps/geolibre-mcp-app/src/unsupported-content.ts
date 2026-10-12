import {
  applyGroupEffects,
  geojsonHasZCoordinates,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import {
  classifyLayer,
  layerKindSupport,
  MAPLIBRE_SUPPORTED_LAYER_KINDS,
  isMapboxStyleUrl,
  resolveMapStyle,
} from "@geolibre/map/headless";
import { t } from "./i18n";

export type PreviewLayerUnsupportedReason =
  | "video"
  | "pmtiles"
  | "desktop-local"
  | "missing-geojson"
  | "missing-tile-url"
  | "missing-image-source"
  | "elevation-renderer"
  | "plugin-owned"
  | "plugin-renderer"
  | "unsupported-renderer";

function missingData(layer: GeoLibreLayer): PreviewLayerUnsupportedReason | undefined {
  const source = layer.source as Record<string, unknown> | undefined;
  switch (layer.type) {
    case "geojson":
      return layer.geojson ? undefined : "missing-geojson";
    case "raster":
    case "wms":
    case "wmts":
    case "xyz":
    case "vector-tiles":
      return (Array.isArray(source?.tiles) &&
        source.tiles.some((url) => typeof url === "string" && url.length > 0)) ||
        (typeof source?.url === "string" && source.url.length > 0)
        ? undefined
        : "missing-tile-url";
    case "image":
      return typeof source?.url === "string" && Array.isArray(source.coordinates)
        ? undefined
        : "missing-image-source";
    default:
      return undefined;
  }
}

function isDesktopOnly(layer: GeoLibreLayer): boolean {
  if (layer.type === "mbtiles" || layer.type === "pmtiles") return true;
  if (layer.type === "geojson" && layer.geojson) return false;
  const source = layer.source as Record<string, unknown> | undefined;
  const urls = [
    layer.sourcePath,
    source?.url,
    ...(Array.isArray(source?.tiles) ? source.tiles : []),
  ];
  return urls.some(
    (value) =>
      typeof value === "string" && /^(?:file:|mbtiles:|tauri:|\/|[A-Za-z]:[\\/])/i.test(value),
  );
}

function isDeckOnlyGeoJson(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    layer.style.elevation3dEnabled === true &&
    geojsonHasZCoordinates(layer.geojson)
  );
}

function hasImagePopupFields(layer: GeoLibreLayer): boolean {
  return layer.popup?.fields?.some((field) => field.kind === "image") ?? false;
}

/** Eligibility is independent of saved/group-effective visibility. */
export function previewLayerUnsupportedReason(
  layer: GeoLibreLayer,
): PreviewLayerUnsupportedReason | undefined {
  if (layer.type === "video") return "video";
  if (layer.type === "pmtiles") return "pmtiles";
  if (isDesktopOnly(layer)) return "desktop-local";
  const missing = missingData(layer);
  if (missing) return missing;
  if (isDeckOnlyGeoJson(layer)) return "elevation-renderer";
  if (
    layer.metadata?.externalNativeLayer === true ||
    layer.metadata?.sourceKind === "maplibre-gl-vector"
  )
    return "plugin-owned";
  const support = layerKindSupport(MAPLIBRE_SUPPORTED_LAYER_KINDS, classifyLayer(layer));
  if (support === "plugin") return "plugin-renderer";
  if (support !== "native") return "unsupported-renderer";
  return undefined;
}

/** Initially visible native layers with consent-gated requests. */
export function previewableLayers(project: GeoLibreProject): GeoLibreLayer[] {
  return project.layers.filter(
    (layer) => layer.visible && previewLayerUnsupportedReason(layer) === undefined,
  );
}

/** Origins known before loading the map; never inspect feature properties or fetch styles. */
export function previewOrigins(project: GeoLibreProject): string[] {
  const origins = new Set<string>();
  function addUrl(value: unknown): void {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password
      ) {
        origins.add(url.origin);
      }
    } catch {
      // Non-network sources and malformed URLs are handled by the renderer.
    }
  }
  function addSource(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const source = value as Record<string, unknown>;
    if (source.type === "video") return;
    addUrl(source.url);
    if (source.type === "geojson") addUrl(source.data);
    if (Array.isArray(source.tiles)) source.tiles.forEach(addUrl);
  }
  if (project.basemapVisible !== false && !isMapboxStyleUrl(project.basemapStyleUrl)) {
    const style = resolveMapStyle(project.basemapStyleUrl);
    if (typeof style === "string") {
      addUrl(style);
    } else {
      addUrl(style.glyphs);
      if (typeof style.sprite === "string") addUrl(style.sprite);
      else style.sprite?.forEach((sprite) => addUrl(sprite.url));
      Object.values(style.sources).forEach(addSource);
    }
  }
  const layers = applyGroupEffects(project.layers, project.layerGroups ?? []);
  for (const layer of previewableLayers({ ...project, layers })) addSource(layer.source);
  return [...origins];
}

/** Human-readable content present in the saved project but not rendered by this view. */
export function unsupportedContent(project: GeoLibreProject): string[] {
  const notices: string[] = [];
  for (const layer of applyGroupEffects(project.layers, project.layerGroups ?? [])) {
    if (!layer.visible) continue;
    const reason = previewLayerUnsupportedReason(layer);
    if (reason)
      notices.push(
        t("unsupported.layer", {
          name: layer.name,
          kind: classifyLayer(layer) ?? layer.type,
          reason: t(`unsupported.reasons.${reason}`),
        }),
      );
    if (hasImagePopupFields(layer)) {
      notices.push(t("unsupported.imagePopup", { name: layer.name }));
    }
    if (layer.style.markerEnabled && layer.style.markerShape === "custom") {
      notices.push(t("unsupported.customMarker", { name: layer.name }));
    }
    if (layer.style.fillPattern === "svg") {
      notices.push(t("unsupported.svgPattern", { name: layer.name }));
    }
  }
  if (project.basemapVisible !== false && isMapboxStyleUrl(project.basemapStyleUrl)) {
    notices.push(t("unsupported.mapboxBasemap"));
  }

  if (project.plugins?.activePluginIds.length) notices.push(t("unsupported.plugins"));
  if (Object.values(project.interaction?.controls ?? {}).some(Boolean))
    notices.push(t("unsupported.mapControls"));
  if (
    (project.secondaryMapViews?.length ?? 0) > 0 ||
    (project.mapLayout?.rows ?? 1) * (project.mapLayout?.cols ?? 1) > 1
  ) {
    notices.push(t("unsupported.extraViews"));
  }
  // eslint-disable-next-line local/no-renderer-kind-checks -- Names the saved engine omitted by this MapLibre-only view, not a capability decision.
  if (project.primaryRenderer && project.primaryRenderer !== "maplibre") {
    notices.push(t("unsupported.renderer", { renderer: project.primaryRenderer }));
  }
  return notices;
}
