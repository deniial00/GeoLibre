import { parseHexColorList, type GeoLibreProject } from "@geolibre/core";
import {
  isValidColormap,
  type ColorbarOptions,
  type ControlPosition,
  type LegendOptions,
} from "maplibre-gl-components";
import { normalizeColorbarState, normalizeLegendState } from "@geolibre/plugins/components-state";
import { previewI18n, t } from "./i18n";

type SavedObject = Record<string, unknown>;
function object(value: unknown): value is SavedObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface PreviewComponentOutputs {
  legends: { position: ControlPosition; options: LegendOptions }[];
  colorbars: { position: ControlPosition; options: ColorbarOptions }[];
  notices: string[];
}

/** Normalize persisted component state into safe, read-only native controls. */
export function previewComponentOutputs(project: GeoLibreProject): PreviewComponentOutputs {
  const output: PreviewComponentOutputs = { legends: [], colorbars: [], notices: [] };
  const settings: unknown = project.plugins?.settings?.["maplibre-gl-components"];
  if (!object(settings)) return output;

  if (object(settings.legend) && Array.isArray(settings.legend.legends)) {
    const entries: SavedObject[] = [];
    for (const entry of settings.legend.legends) {
      if (!object(entry) || !Array.isArray(entry.items)) {
        output.notices.push(t("inspection.invalidControl"));
        continue;
      }
      entries.push({
        ...entry,
        items: entry.items.map((item: unknown) => (object(item) ? { ...item } : item)),
      });
    }
    const state = normalizeLegendState({ ...settings.legend, legends: entries });
    if (state?.visible) {
      for (const legend of state.legends) {
        const items = legend.items.map((item) => {
          const color = CSS.supports("color", item.color) ? item.color : "transparent";
          if (color === "transparent" && item.color !== "transparent") {
            output.notices.push(t("inspection.invalidColors"));
          }
          const safeItem: NonNullable<LegendOptions["items"]>[number] = {
            label: item.label,
            color,
            ...(item.shape ? { shape: item.shape } : {}),
          };
          if (item.strokeColor !== undefined) {
            if (CSS.supports("color", item.strokeColor)) safeItem.strokeColor = item.strokeColor;
            else output.notices.push(t("inspection.invalidColors"));
          }
          if (item.icon) output.notices.push(t("unsupported.componentIcon"));
          return safeItem;
        });
        output.legends.push({
          position: legend.legendPosition,
          options: { title: legend.title, items, collapsible: true, collapsed: false },
        });
      }
    }
  }

  if (object(settings.colorbar) && Array.isArray(settings.colorbar.colorbars)) {
    const entries: SavedObject[] = [];
    for (const entry of settings.colorbar.colorbars) {
      const colors =
        object(entry) && entry.mode === "custom"
          ? entry.customColors
          : object(entry) && entry.mode === "named"
            ? entry.colormap
            : undefined;
      if (
        !object(entry) ||
        (entry.mode !== "named" && entry.mode !== "custom") ||
        typeof entry.vmin !== "number" ||
        !Number.isFinite(entry.vmin) ||
        typeof entry.vmax !== "number" ||
        !Number.isFinite(entry.vmax) ||
        typeof colors !== "string" ||
        !colors.trim()
      ) {
        output.notices.push(t("inspection.invalidControl"));
        continue;
      }
      entries.push({ ...entry });
    }
    const state = normalizeColorbarState({ ...settings.colorbar, colorbars: entries });
    if (state?.visible) {
      const grouped = new Map<ControlPosition, NonNullable<ColorbarOptions["colorbars"]>>();
      for (const bar of state.colorbars) {
        let colormap: NonNullable<ColorbarOptions["colorbars"]>[number]["colormap"];
        if (bar.mode === "named") {
          if (!isValidColormap(bar.colormap)) {
            output.notices.push(t("inspection.rampUnavailable", { name: bar.colormap }));
            continue;
          }
          colormap = bar.colormap as NonNullable<ColorbarOptions["colorbars"]>[number]["colormap"];
        } else {
          colormap = parseHexColorList(bar.customColors);
          if (colormap.length < 2) {
            output.notices.push(t("inspection.invalidColors"));
            continue;
          }
        }
        const range = bar.vmax - bar.vmin;
        const fractionDigits = range >= 100 ? 0 : range >= 1 ? 1 : range >= 0.1 ? 2 : 3;
        let locale = previewI18n.language;
        const createFormatter = (language: string): Intl.NumberFormat =>
          new Intl.NumberFormat(language, {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
            ...(language.split("-")[0].toLowerCase() === "ar" ? { numberingSystem: "arab" } : {}),
          });
        let formatter = createFormatter(locale);
        const item = {
          colormap,
          vmin: bar.vmin,
          vmax: bar.vmax,
          label: bar.label,
          units: bar.units,
          orientation: bar.orientation,
          ticks: {
            format(value: number) {
              if (locale !== previewI18n.language) {
                locale = previewI18n.language;
                formatter = createFormatter(locale);
              }
              return `${formatter.format(value)}${bar.units}`;
            },
          },
        };
        const bars = grouped.get(bar.colorbarPosition) ?? [];
        bars.push(item);
        grouped.set(bar.colorbarPosition, bars);
      }
      for (const [position, colorbars] of grouped) {
        output.colorbars.push({
          position,
          options: { position, colorbars, stackOrientation: state.stackOrientation },
        });
      }
    }
  }

  output.notices = [...new Set(output.notices)];
  return output;
}
