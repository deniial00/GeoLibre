import { isPopupClickEnabled, type GeoLibreProject, type GeoLibreLayer } from "@geolibre/core";
import {
  createBlankMapStyle,
  createIdentifyPopupElement,
  identifyPopupShellMaxWidth,
  createLayerSync,
  identifyStyleLayerIds,
  isMapboxStyleUrl,
  resolveMapStyle,
  sourceId,
  nativeLayerIdPrefix,
  globeSafeMaxZoom,
  type LayerSync,
} from "@geolibre/map/headless";
import type { Feature } from "geojson";
import type { RequestTransformFunction } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { previewLayerUnsupportedReason } from "./unsupported-content";
import { t } from "./i18n";
import { getPreviewLayerBounds, previewEffectiveLayers, type PreviewBounds } from "./inspection";
import { formatPreviewDiagnostic, previewDiagnostic, type PreviewDiagnostic } from "./diagnostics";

export interface PreviewRenderer {
  readonly map: maplibregl.Map;
  readonly ready: boolean;
  getLayers(): readonly GeoLibreLayer[];
  getBounds(layerId: string): PreviewBounds | null;
  setLayerVisibility(layerId: string, visible: boolean): void;
  zoomToLayer(layerId: string): boolean;
  setIdentifyEnabled(enabled: boolean): void;
  refreshLabels(): void;
  dispose(): void;
}

export interface PreviewRenderOptions {
  transformRequest: RequestTransformFunction;
  onReady(): void;
  onError(source: string, message: string, diagnostic?: PreviewDiagnostic): void;
  onBoundsChanged(): void;
  onIdentifyResult(found: boolean): void;
}

type PreviewMapError = maplibregl.ErrorEvent & {
  sourceId?: string;
  sourceLayer?: string;
};

type LayerRecord = {
  layer: GeoLibreLayer;
  sync?: LayerSync;
  failed: boolean;
};

const FIT_BOUNDS_PADDING = 40;
type NativeLayerPrefix = readonly [id: string, prefix: string];

function errorSource(event: PreviewMapError, layers: readonly GeoLibreLayer[]): string {
  const sourceIdValue = event.sourceId;
  if (!sourceIdValue) return "";
  const layer = layers.find(
    (candidate) =>
      sourceId(candidate.id) === sourceIdValue ||
      candidate.id === sourceIdValue ||
      (Array.isArray(candidate.metadata.sourceIds) &&
        candidate.metadata.sourceIds.includes(sourceIdValue)),
  );
  return layer
    ? `${layer.name} (${sourceIdValue}${event.sourceLayer ? ` · ${event.sourceLayer}` : ""})`
    : event.sourceLayer
      ? `${sourceIdValue} (${event.sourceLayer})`
      : sourceIdValue;
}

function nativeIdsFor(
  map: maplibregl.Map,
  layerId: string,
  prefixes: readonly NativeLayerPrefix[],
): string[] {
  return (map.getStyle()?.layers ?? [])
    .map((layer) => layer.id)
    .filter((id) => {
      const owner = prefixes.find(([, prefix]) => id.startsWith(prefix))?.[0];
      return owner === layerId && map.getLayer(id) !== undefined;
    });
}
function reportMapError(
  event: PreviewMapError,
  layers: readonly GeoLibreLayer[],
  options: PreviewRenderOptions,
): void {
  const diagnostic = previewDiagnostic(event.error);
  options.onError(errorSource(event, layers), formatPreviewDiagnostic(diagnostic), diagnostic);
}

export function renderProject(
  container: HTMLElement,
  project: GeoLibreProject,
  options: PreviewRenderOptions,
): PreviewRenderer {
  const useBlankStyle =
    project.basemapVisible === false || isMapboxStyleUrl(project.basemapStyleUrl);
  const map = new maplibregl.Map({
    container,
    style: useBlankStyle ? createBlankMapStyle() : resolveMapStyle(project.basemapStyleUrl),
    center: project.mapView.center,
    zoom: project.mapView.zoom,
    bearing: project.mapView.bearing,
    pitch: project.mapView.pitch,
    attributionControl: { compact: true },
    maplibreLogo: false,
    transformRequest: options.transformRequest,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  const initial = previewEffectiveLayers(project);
  const records = new Map<string, LayerRecord>();
  const orderedIds = initial.map((layer) => layer.id);
  const nativePrefixes: NativeLayerPrefix[] = orderedIds
    .map((id) => [id, nativeLayerIdPrefix(id)] as const)
    .sort((a, b) => b[1].length - a[1].length);
  const boundsCache = new Map<string, PreviewBounds | null>();
  let styleReady = false;
  let usedBlankFallback = useBlankStyle;
  let notifiedReady = false;
  let disposed = false;
  let popupOwner: string | null = null;
  let currentHit: { layerId: string; feature: Feature; coordinate: maplibregl.LngLatLike } | null =
    null;
  let identifyEnabled = false;

  for (const grouped of initial) {
    records.set(grouped.id, { layer: grouped, failed: false });
  }
  let layerView: readonly GeoLibreLayer[] = orderedIds
    .map((id) => records.get(id)?.layer)
    .filter((layer): layer is GeoLibreLayer => layer !== undefined);
  const refreshLayerView = (): void => {
    layerView = orderedIds
      .map((id) => records.get(id)?.layer)
      .filter((layer): layer is GeoLibreLayer => layer !== undefined);
  };

  const popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    focusAfterOpen: false,
    maxWidth: "560px",
  });
  const clearHit = (): void => {
    currentHit = null;
    popupOwner = null;
  };
  const handlePopupClose = (): void => {
    clearHit();
  };
  popup.on("close", handlePopupClose);

  const notifyBoundsIfChanged = (layerId: string): void => {
    const record = records.get(layerId);
    if (!record) return;
    const previous = boundsCache.get(layerId) ?? null;
    if (previous) return;
    if (record.layer.type === "geojson" || record.layer.type === "image") return;
    const next = getPreviewLayerBounds(record.layer, map);
    if (!next) return;
    boundsCache.set(layerId, next);
    options.onBoundsChanged();
  };
  const stackOwnedLayers = (): void => {
    if (!styleReady || disposed) return;
    const live = map.getStyle()?.layers?.map((layer) => layer.id) ?? [];
    const ownerById = new Map<string, string>();
    for (const id of live) {
      const owner = nativePrefixes.find(([, prefix]) => id.startsWith(prefix))?.[0];
      if (owner && records.get(owner)?.sync) ownerById.set(id, owner);
    }
    // Repeatedly moving each layer to the top keeps unmanaged basemap layers
    // below the managed blocks and preserves the live within-layer order.
    for (const layerId of orderedIds) {
      if (!records.get(layerId)?.sync) continue;
      for (const id of live) {
        if (ownerById.get(id) === layerId && map.getLayer(id)) map.moveLayer(id);
      }
    }
  };
  const hidePartialLayers = (layerId: string): void => {
    for (const id of nativeIdsFor(map, layerId, nativePrefixes)) {
      try {
        map.setLayoutProperty(id, "visibility", "none");
      } catch {
        // Keep the failed row unavailable even if MapLibre rejects a partial
        // layer mutation while unwinding its failed registration.
      }
    }
  };
  const register = (record: LayerRecord): boolean => {
    if (record.failed || !styleReady || disposed) return false;
    if (record.sync) return true;
    const sync = createLayerSync(map);
    try {
      sync.sync([record.layer]);
      record.sync = sync;
      stackOwnedLayers();
      notifyBoundsIfChanged(record.layer.id);
      return true;
    } catch {
      hidePartialLayers(record.layer.id);
      sync.dispose();
      record.failed = true;
      record.layer = {
        ...record.layer,
        visible: false,
        metadata: { ...record.layer.metadata, previewRegistrationFailed: true },
      };
      refreshLayerView();
      options.onError(
        record.layer.id,
        t("errors.registrationFailed", { name: record.layer.name }),
        { key: "errors.registrationFailed", args: { name: record.layer.name } },
      );
      return false;
    }
  };
  const identifyAt = (point: maplibregl.PointLike, coordinate: maplibregl.LngLatLike): boolean => {
    if (!styleReady || disposed) return false;
    for (let index = orderedIds.length - 1; index >= 0; index -= 1) {
      const record = records.get(orderedIds[index]);
      if (
        !record ||
        !record.layer.visible ||
        !record.sync ||
        record.failed ||
        !isPopupClickEnabled(record.layer.popup)
      )
        continue;
      const ids = identifyStyleLayerIds(record.layer).filter((id) => map.getLayer(id));
      if (!ids.length) continue;
      const feature = map.queryRenderedFeatures(point, { layers: ids })[0];
      if (!feature) continue;
      currentHit = {
        layerId: record.layer.id,
        feature: feature as Feature,
        coordinate,
      };
      popupOwner = record.layer.id;
      popup
        .setMaxWidth(identifyPopupShellMaxWidth(record.layer.popup))
        .setLngLat(coordinate)
        .setDOMContent(
          createIdentifyPopupElement(record.layer.name, feature.properties ?? {}, feature.id, {
            popup: record.layer.popup,
            contentPolicy: "text-only",
            noAttributesLabel: t("inspection.noAttributes"),
            fieldVisibility: record.layer.fieldVisibility,
            feature: feature as Feature,
            zoom: map.getZoom(),
          }),
        );
      if (!popup.isOpen()) popup.addTo(map);
      options.onIdentifyResult(true);
      return true;
    }
    popup.remove();
    options.onIdentifyResult(false);
    return false;
  };

  const onError = (event: PreviewMapError): void => {
    reportMapError(event, layerView, options);
    if (!styleReady && !usedBlankFallback && !event.sourceId) {
      usedBlankFallback = true;
      map.setStyle(createBlankMapStyle());
    }
  };
  const onStyleLoad = (): void => {
    if (disposed || notifiedReady) return;
    styleReady = true;
    notifiedReady = true;
    for (const id of orderedIds) {
      const record = records.get(id);
      if (record?.layer.visible) register(record);
    }
    options.onReady();
  };
  const onSourceData = (event: maplibregl.MapSourceDataEvent): void => {
    if (disposed || event.sourceDataType !== "metadata") return;
    for (const id of orderedIds) notifyBoundsIfChanged(id);
  };
  const onMapClick = (event: maplibregl.MapMouseEvent): void => {
    if (identifyEnabled) identifyAt(event.point, event.lngLat);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || popup.isOpen() !== true) return;
    event.stopPropagation();
    popup.remove();
  };

  map.on("error", onError);
  map.on("style.load", onStyleLoad);
  map.on("sourcedata", onSourceData);
  map.on("click", onMapClick);
  document.addEventListener("keydown", onKeyDown);

  return {
    map,
    get ready() {
      return styleReady && !disposed;
    },
    getLayers() {
      return layerView;
    },
    getBounds(layerId) {
      const record = records.get(layerId);
      if (!record || record.failed || previewLayerUnsupportedReason(record.layer)) return null;
      if (!boundsCache.has(layerId)) {
        boundsCache.set(layerId, getPreviewLayerBounds(record.layer, map));
      } else if (!boundsCache.get(layerId)) {
        notifyBoundsIfChanged(layerId);
      }
      const bounds = boundsCache.get(layerId);
      return bounds ? ([...bounds] as PreviewBounds) : null;
    },
    setLayerVisibility(layerId, visible) {
      if (!styleReady || disposed) return;
      const record = records.get(layerId);
      if (!record || record.failed || previewLayerUnsupportedReason(record.layer)) return;
      if (record.layer.visible === visible) return;
      if (visible && !register(record)) return;
      const nextLayer = { ...record.layer, visible };
      try {
        record.sync?.sync([nextLayer]);
      } catch {
        hidePartialLayers(layerId);
        record.sync?.dispose();
        record.sync = undefined;
        record.failed = true;
        record.layer = {
          ...record.layer,
          visible: false,
          metadata: { ...record.layer.metadata, previewRegistrationFailed: true },
        };
        if (popupOwner === layerId) popup.remove();
        options.onError(layerId, t("errors.registrationFailed", { name: record.layer.name }), {
          key: "errors.registrationFailed",
          args: { name: record.layer.name },
        });
        refreshLayerView();
        return;
      }
      record.layer = nextLayer;
      refreshLayerView();
      if (!visible && popupOwner === layerId) {
        popup.remove();
        clearHit();
      }
      if (visible) notifyBoundsIfChanged(layerId);
      stackOwnedLayers();
    },
    zoomToLayer(layerId) {
      if (!styleReady || disposed) return false;
      const record = records.get(layerId);
      if (!record || record.failed || previewLayerUnsupportedReason(record.layer)) return false;
      const bounds = this.getBounds(layerId);
      if (!bounds) return false;
      const duration = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 800;
      if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
        map.flyTo({
          center: [bounds[0], bounds[1]],
          zoom: Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), map.getZoom(), 14)),
          duration,
        });
        return true;
      }
      const cameraBounds: [[number, number], [number, number]] = [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ];
      const canvas = map.getCanvas();
      const viewport =
        canvas.clientWidth > 0 && canvas.clientHeight > 0
          ? { width: canvas.clientWidth, height: canvas.clientHeight }
          : null;
      const ceiling = globeSafeMaxZoom(bounds, viewport, FIT_BOUNDS_PADDING);
      const cap = ceiling === null ? map.getMaxZoom() : Math.min(map.getMaxZoom(), ceiling);
      const minRenderZoom = [record.layer.source.minzoom, record.layer.metadata.minzoom].find(
        (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
      ) as number | undefined;
      const camera = map.cameraForBounds(cameraBounds, { padding: FIT_BOUNDS_PADDING });
      if (
        camera?.center &&
        typeof camera.zoom === "number" &&
        minRenderZoom !== undefined &&
        Math.min(camera.zoom, cap) < minRenderZoom
      ) {
        map.flyTo({
          center: camera.center,
          zoom: Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), minRenderZoom)),
          duration,
        });
        return true;
      }
      map.fitBounds(cameraBounds, {
        padding: FIT_BOUNDS_PADDING,
        duration,
        maxZoom: cap,
      });
      return true;
    },
    setIdentifyEnabled(enabled) {
      if (disposed) return;
      identifyEnabled = enabled;
      map.getCanvas().style.cursor = enabled ? "crosshair" : "";
    },
    refreshLabels() {
      if (!currentHit || !popup.isOpen()) return;
      const closeButton = popup
        .getElement()
        .querySelector<HTMLButtonElement>(".maplibregl-popup-close-button");
      const preserveCloseFocus = document.activeElement === closeButton;
      const record = records.get(currentHit.layerId);
      if (!record || !record.layer.visible || !record.sync || record.failed) {
        popup.remove();
        clearHit();
        return;
      }
      const { feature, coordinate } = currentHit;
      popup
        .setMaxWidth(identifyPopupShellMaxWidth(record.layer.popup))
        .setLngLat(coordinate)
        .setDOMContent(
          createIdentifyPopupElement(record.layer.name, feature.properties ?? {}, feature.id, {
            popup: record.layer.popup,
            contentPolicy: "text-only",
            noAttributesLabel: t("inspection.noAttributes"),
            fieldVisibility: record.layer.fieldVisibility,
            feature,
            zoom: map.getZoom(),
          }),
        );
      if (preserveCloseFocus) {
        popup
          .getElement()
          .querySelector<HTMLButtonElement>(".maplibregl-popup-close-button")
          ?.focus();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      map.off("error", onError);
      map.off("style.load", onStyleLoad);
      map.off("sourcedata", onSourceData);
      map.off("click", onMapClick);
      document.removeEventListener("keydown", onKeyDown);
      popup.off("close", handlePopupClose);
      popup.remove();
      clearHit();
      for (const record of records.values()) record.sync?.dispose();
      map.remove();
    },
  };
}
