import type { GeoLibreLayer } from "@geolibre/core";
import { nativeLayerIdPrefix } from "@geolibre/map/headless";
import {
  LayerControl,
  type CustomLayerAdapter,
  type LayerControlLabels,
} from "maplibre-gl-layer-control";
import { t } from "./i18n";
import type { PreviewRenderer } from "./render";
import { previewLayerUnsupportedReason } from "./unsupported-content";

export interface PreviewLayerControl {
  refresh(): void;
  dispose(): void;
}

const savedSymbolTypes = new Set(["fill", "line", "circle", "symbol", "raster", "custom"]);

function labels(): LayerControlLabels {
  return {
    control: t("inspection.layerControl"),
    layers: t("inspection.layers"),
    showAll: t("inspection.showAllLayers"),
    hideAll: t("inspection.hideAllLayers"),
    emptyLayers: t("inspection.emptyLayers"),
    showLayer: (name) => t("inspection.showLayer", { name }),
    zoomToLayer: (name) => t("inspection.zoomToLayer", { name }),
    layerType: (type) => t("inspection.layerType", { type }),
  };
}

/** The renderer owns visibility and honest bounds; this control only presents them. */
export function createPreviewLayerControl(
  renderer: PreviewRenderer,
  onVisibilityChange: () => void,
): PreviewLayerControl {
  let control: LayerControl | undefined;
  let disposed = false;
  let visibilityChanged: (() => void) | undefined = onVisibilityChange;
  let cachedLayers: readonly GeoLibreLayer[] | undefined;
  let styleChanged = true;
  const layerById = new Map<string, GeoLibreLayer>();
  const symbolById = new Map<string, string>();

  function updateLayerCache(): void {
    const layers = renderer.getLayers();
    if (layers === cachedLayers && !styleChanged) return;
    cachedLayers = layers;
    styleChanged = false;
    layerById.clear();
    symbolById.clear();
    for (const layer of layers) {
      layerById.set(layer.id, layer);
      const saved = layer.metadata.customLayerType;
      symbolById.set(
        layer.id,
        typeof saved === "string" && savedSymbolTypes.has(saved) ? saved : "custom",
      );
    }
    // Match the renderer's longest-prefix ownership, including overlapping IDs.
    const prefixes = layers
      .map((layer) => [layer.id, nativeLayerIdPrefix(layer.id)] as const)
      .sort((a, b) => b[1].length - a[1].length);
    const liveOwners = new Set<string>();
    // Style inspection must never register a hidden source just to improve its glyph.
    let nativeLayers;
    try {
      nativeLayers = renderer.map.getStyle()?.layers ?? [];
    } catch {
      return;
    }
    for (const native of nativeLayers) {
      const owner = prefixes.find(([, prefix]) => native.id.startsWith(prefix))?.[0];
      if (!owner || liveOwners.has(owner)) continue;
      const live = renderer.map.getLayer(native.id);
      if (!live) continue;
      symbolById.set(owner, live.type);
      liveOwners.add(owner);
    }
  }

  const adapter: CustomLayerAdapter = {
    type: "geolibre-preview",
    getLayerIds: () => (disposed ? [] : renderer.getLayers().map((layer) => layer.id)),
    getLayerState(layerId) {
      if (disposed) return null;
      updateLayerCache();
      const layer = layerById.get(layerId);
      if (!layer) return null;
      const unsupported = previewLayerUnsupportedReason(layer);
      const failed = layer.metadata.previewRegistrationFailed === true;
      const disabledReason = failed
        ? t("errors.registrationFailed", { name: layer.name })
        : unsupported
          ? t(`unsupported.reasons.${unsupported}`)
          : undefined;
      const disabled = !renderer.ready || !!disabledReason;
      const zoomDisabled = disabled || renderer.getBounds(layerId) === null;
      return {
        name: layer.name,
        visible: !disabled && layer.visible,
        opacity: layer.opacity,
        isCustomLayer: true,
        customLayerType: symbolById.get(layerId) ?? "custom",
        disabled,
        disabledReason,
        zoomDisabled,
        zoomDisabledReason:
          disabledReason ?? (zoomDisabled ? t("inspection.extentUnavailable") : undefined),
      };
    },
    getName(layerId) {
      if (disposed) return "";
      updateLayerCache();
      return layerById.get(layerId)?.name ?? "";
    },
    getSymbolType(layerId) {
      if (disposed) return "custom";
      updateLayerCache();
      return symbolById.get(layerId) ?? "custom";
    },
    getBounds: (layerId) => (disposed ? null : renderer.getBounds(layerId)),
    setVisibility(layerId, visible) {
      if (disposed) return;
      renderer.setLayerVisibility(layerId, visible);
      control?.refreshCustomLayers();
      visibilityChanged?.();
    },
  };

  function refresh(): void {
    if (disposed || !renderer.ready) return;
    if (!control) {
      control = new LayerControl({
        collapsed: true,
        panelWidth: 280,
        panelMinWidth: 240,
        panelMaxWidth: 340,
        autoDetect: false,
        showStyleEditor: false,
        showOpacitySlider: false,
        showLayerSymbol: true,
        enableContextMenu: false,
        enableDragAndDrop: false,
        enableBackgroundPresets: false,
        showZoomButton: true,
        customLayerAdapters: [adapter],
        labels: labels(),
        onZoomToLayer(layerId) {
          if (!disposed) renderer.zoomToLayer(layerId);
        },
      });
      renderer.map.addControl(control, "top-right");
      renderer.map.on("styledata", onStyleData);
    } else {
      control.setLabels(labels());
      control.refreshCustomLayers();
    }
  }

  function onStyleData(): void {
    if (disposed) return;
    styleChanged = true;
    control?.refreshCustomLayers();
  }

  refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      visibilityChanged = undefined;
      if (control) {
        renderer.map.off("styledata", onStyleData);
        renderer.map.removeControl(control);
        control = undefined;
      }
      cachedLayers = undefined;
      layerById.clear();
      symbolById.clear();
    },
  };
}
