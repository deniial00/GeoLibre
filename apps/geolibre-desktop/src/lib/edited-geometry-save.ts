import type { GeoLibreLayer } from "@geolibre/core";

/** Layers with committed geometry edits that need an explicit embedding choice. */
export function hasEditedGeometry(layer: GeoLibreLayer): boolean {
  return layer.metadata.geometryEdited === true && layer.geojson !== undefined;
}

/** Make the edited features authoritative in a saved project snapshot. */
export function embedEditedGeometry(layer: GeoLibreLayer): GeoLibreLayer {
  if (!hasEditedGeometry(layer)) return layer;
  const { url: _url, ...source } = layer.source;
  const {
    originalUrl: _originalUrl,
    localFileReloadable: _reload,
    geometryEdited: _edited,
    ...metadata
  } = layer.metadata;
  return {
    ...layer,
    source,
    metadata:
      layer.metadata.sourceKind === "maplibre-gl-vector"
        ? { ...metadata, embeddedGeoJSON: layer.geojson }
        : metadata,
  };
}
/** Honor an explicit no-embed choice for edited WFS layers. */
export function discardEditedWfsGeometry(layer: GeoLibreLayer): GeoLibreLayer {
  if (!hasEditedGeometry(layer) || layer.metadata.sourceKind !== "wfs-getfeature") return layer;
  const { geojson: _geojson, ...rest } = layer;
  const { geometryEdited: _edited, ...metadata } = layer.metadata;
  return { ...rest, metadata };
}
