import {
  DEFAULT_LEGEND_CONFIG,
  parseHexColorList,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import { buildAutoLegend, type AutoLegendEntry } from "../../geolibre-desktop/src/lib/auto-legend";
import { isRasterLike } from "../../geolibre-desktop/src/lib/layer-swatch";
import { savedRasterAttributeTable } from "../../geolibre-desktop/src/lib/raster-attribute-table";
import { savedRasterSymbology } from "@geolibre/plugins/raster-symbology";
import { previewI18n, t } from "./i18n";
import { previewGradientColors, previewNamedRamp } from "./legend-swatches";
import { previewRenderLayer } from "./inspection";
import { previewLayerUnsupportedReason } from "./unsupported-content";

export interface PreviewLegendModel {
  entries: AutoLegendEntry[];
  notices: string[];
}

function rasterState(layer: GeoLibreLayer): { mode: string; colormap: string } {
  const raw = layer.metadata.rasterState;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mode: "", colormap: "" };
  const value = raw as Record<string, unknown>;
  return {
    mode: typeof value.mode === "string" ? value.mode : "",
    colormap: typeof value.colormap === "string" ? value.colormap : "",
  };
}

function hasExplicitRasterClassColors(layer: GeoLibreLayer): boolean {
  const symbology = savedRasterSymbology(layer);
  const table = savedRasterAttributeTable(layer);
  return !!symbology?.classified && !!table && table.rows.length === symbology.classCount;
}

function unavailableRasterRamp(layer: GeoLibreLayer): boolean {
  if (!isRasterLike(layer)) return false;
  const symbology = savedRasterSymbology(layer);
  const custom = symbology?.customColors?.length
    ? parseHexColorList(symbology.customColors.join(" "))
    : [];
  if (custom.length >= 2) return false;
  const state = rasterState(layer);
  const ramp = symbology?.ramp || state.colormap;
  return ramp !== "" && previewNamedRamp(ramp) === null;
}

function invalidRasterCustomStops(layer: GeoLibreLayer): boolean {
  const customColors = savedRasterSymbology(layer)?.customColors;
  return !!customColors?.length && parseHexColorList(customColors.join(" ")).length < 2;
}

function hasRasterRenderMetadata(layer: GeoLibreLayer): boolean {
  return savedRasterSymbology(layer) !== null || rasterState(layer).colormap !== "";
}

function validColor(color: string, notices: string[]): string {
  if (CSS.supports("color", color)) return color;
  notices.push(t("inspection.invalidColors"));
  return "transparent";
}

/** Build the desktop-compatible legend without loading or mutating project content. */
export function previewLegendModel(
  project: GeoLibreProject,
  layers: readonly GeoLibreLayer[],
): PreviewLegendModel {
  const config = project.legend ?? DEFAULT_LEGEND_CONFIG;
  const legendLayers = layers.map((layer) => {
    const safe = previewRenderLayer(layer);
    return safe.visible && previewLayerUnsupportedReason(safe) !== undefined
      ? { ...safe, visible: false }
      : safe;
  });
  const entries = buildAutoLegend(legendLayers, config, {
    locale: previewI18n.language,
    resolveColormapColors: previewNamedRamp,
    geometryGeneratorLabels: {
      centroid: previewI18n.t("style.generator.typeCentroid"),
      "bounding-box": previewI18n.t("style.generator.typeBoundingBox"),
      "convex-hull": previewI18n.t("style.generator.typeConvexHull"),
      buffer: previewI18n.t("style.generator.typeBuffer"),
    },
  });
  const layerById = new Map(legendLayers.map((layer) => [layer.id, layer]));
  const notices: string[] = [];
  const safeEntries = entries
    .filter((entry) => !entry.hidden)
    .map((entry) => {
      const layer = layerById.get(entry.id);
      const explicitRasterClasses = !!layer && hasExplicitRasterClassColors(layer);
      const invalidCustomStops = !!layer && !entry.custom && invalidRasterCustomStops(layer);
      const suppressRaster =
        !!layer &&
        !entry.custom &&
        !explicitRasterClasses &&
        (unavailableRasterRamp(layer) || invalidCustomStops);
      const noRasterMetadata =
        !!layer &&
        !entry.custom &&
        !explicitRasterClasses &&
        isRasterLike(layer) &&
        !hasRasterRenderMetadata(layer);
      const namedRamp = layer
        ? savedRasterSymbology(layer)?.ramp || rasterState(layer).colormap
        : "";
      const heatmapRamp =
        layer &&
        !entry.custom &&
        entry.shape === "circle" &&
        layer.style.pointRenderer === "heatmap"
          ? layer.style.heatmapColorRamp
          : undefined;
      const heatmap = heatmapRamp !== undefined;
      const unknownHeatmapRamp =
        heatmapRamp !== undefined && previewNamedRamp(heatmapRamp) === null;
      if (unknownHeatmapRamp) notices.push(t("inspection.rampUnavailable", { name: heatmapRamp }));
      if (invalidCustomStops) notices.push(t("inspection.invalidColors"));
      if (suppressRaster && !invalidCustomStops) {
        notices.push(t("inspection.rampUnavailable", { name: namedRamp }));
      }

      const copy = {
        ...entry,
        headerSwatch: entry.headerSwatch ? { ...entry.headerSwatch } : null,
        rows: entry.rows.map((row) => ({
          ...row,
          ...(row.marker ? { marker: { ...row.marker } } : {}),
        })),
        gradient: entry.gradient ? { ...entry.gradient, colors: [...entry.gradient.colors] } : null,
      } as Omit<AutoLegendEntry, "gradient"> & { gradient?: AutoLegendEntry["gradient"] };
      if (suppressRaster || noRasterMetadata || unknownHeatmapRamp) {
        delete copy.gradient;
      } else if (copy.gradient) {
        const colors = previewGradientColors(copy.gradient.colors, heatmap);
        if (colors) copy.gradient.colors = colors;
        else {
          delete copy.gradient;
          notices.push(t("inspection.invalidColors"));
        }
      }
      if (suppressRaster || noRasterMetadata) {
        copy.rows = copy.rows.map((row) => {
          const safe = { ...row, color: "transparent" };
          delete safe.marker;
          return safe;
        });
      } else {
        copy.rows = copy.rows.map((row) => {
          let safe = row;
          if (row.marker?.shape === "custom") {
            safe = { ...row, color: row.marker.color };
            delete safe.marker;
          }
          if (safe.marker) {
            safe.marker = { ...safe.marker, color: validColor(safe.marker.color, notices) };
          }
          return { ...safe, color: validColor(safe.color, notices) };
        });
      }
      if (copy.headerSwatch?.marker?.shape === "custom") {
        copy.headerSwatch.color = copy.headerSwatch.marker.color;
        delete copy.headerSwatch.marker;
      }
      if (copy.headerSwatch) {
        copy.headerSwatch.color = validColor(copy.headerSwatch.color, notices);
        if (copy.headerSwatch.marker) {
          copy.headerSwatch.marker = {
            ...copy.headerSwatch.marker,
            color: validColor(copy.headerSwatch.marker.color, notices),
          };
        }
      }
      return copy as AutoLegendEntry;
    });
  return { entries: safeEntries, notices: [...new Set(notices)] };
}
