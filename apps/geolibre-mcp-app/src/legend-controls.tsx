import type { GeoLibreProject } from "@geolibre/core";
import * as React from "react";
import { Colorbar, Legend, type ControlPosition } from "maplibre-gl-components";
import type { IControl } from "maplibre-gl";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import {
  LEGEND_PANEL_CLASS,
  LegendEmpty,
  LegendEntryDisplay,
  LegendEntryList,
  LegendPanelFrame,
  clamp,
  legendPanelStyle,
  useMapPanelMaxHeight,
} from "../../geolibre-desktop/src/components/legend/LegendDisplay";
import { graduatedSchemeLabelKey } from "../../geolibre-desktop/src/lib/classification-schemes";
import type { AutoLegendEntry } from "../../geolibre-desktop/src/lib/auto-legend";
import { previewComponentOutputs } from "./components-outputs";
import { previewLegendModel } from "./legend-model";
import { previewI18n } from "./i18n";
import type { PreviewRenderer } from "./render";

export { previewLegendModel } from "./legend-model";

type PanelLabels = { collapse: string; expand: string; low: string; high: string; empty: string };

function classificationLabel(entry: AutoLegendEntry): string | null {
  const classification = entry.classification;
  if (!classification) return null;
  const key = graduatedSchemeLabelKey(classification.scheme);
  return key
    ? previewI18n.t("legendPanel.classification", {
        method: previewI18n.t(key),
        count: classification.classCount,
      })
    : null;
}

function PreviewLegendPanel({
  host,
  title,
  entries,
  initialCollapsed,
  width,
  height,
  labels,
}: {
  host: HTMLElement;
  title: string;
  entries: AutoLegendEntry[];
  initialCollapsed: boolean;
  width?: number;
  height?: number;
  labels: PanelLabels;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const { maxHeight } = useMapPanelMaxHeight(host);
  const style = legendPanelStyle({
    maxHeight,
    width: width === undefined ? undefined : clamp(width, 200, 520),
    height,
    collapsed,
  });
  return (
    <LegendPanelFrame
      style={style}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
      toggleLabel={collapsed ? labels.expand : labels.collapse}
      title={<h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>}
    >
      {entries.length === 0 ? (
        <LegendEmpty>{labels.empty}</LegendEmpty>
      ) : (
        <LegendEntryList>
          {entries.map((entry) => (
            <LegendEntryDisplay
              key={entry.id}
              entry={entry}
              classificationLabel={classificationLabel(entry)}
              lowLabel={labels.low}
              highLabel={labels.high}
            />
          ))}
        </LegendEntryList>
      )}
    </LegendPanelFrame>
  );
}

export interface LegendControls {
  refresh(): void;
  notices(): readonly string[];
  dispose(): void;
}

/** Mount safe saved legends as read-only native controls on the preview map. */
export function createLegendControls(
  project: GeoLibreProject,
  renderer: PreviewRenderer,
): LegendControls {
  const panelVisible = project.legend?.panelVisible === true;
  const host = panelVisible ? document.createElement("div") : null;
  const panelControl: IControl | null = host
    ? {
        onAdd: () => host,
        onRemove: () => host.remove(),
      }
    : null;
  let root: Root | null = null;
  if (host && panelControl) {
    host.className = `${LEGEND_PANEL_CLASS} maplibregl-ctrl`;
    renderer.map.addControl(panelControl, project.legend?.panelPosition ?? "top-left");
    root = createRoot(host);
  }

  const outputs = previewComponentOutputs(project);
  const colorbarControls: Colorbar[] = [];
  const vendorControls: IControl[] = [];
  const theme = {
    backgroundColor: "hsl(var(--popover))",
    fontColor: "hsl(var(--popover-foreground))",
  };
  const legendsByPosition: Record<ControlPosition, typeof outputs.legends> = {
    "top-left": [],
    "top-right": [],
    "bottom-left": [],
    "bottom-right": [],
  };
  for (const output of outputs.legends) legendsByPosition[output.position].push(output);
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
    const group = legendsByPosition[position];
    // MapLibre prepends controls in bottom corners and appends them at the top.
    const ordered = position.startsWith("bottom-") ? [...group].reverse() : group;
    for (const { options } of ordered) {
      const control = new Legend(options);
      control.update(theme);
      renderer.map.addControl(control, position);
      vendorControls.push(control);
    }
  }
  for (const { position, options } of outputs.colorbars) {
    const control = new Colorbar(options);
    control.update(theme);
    renderer.map.addControl(control, position);
    vendorControls.push(control);
    colorbarControls.push(control);
  }

  let disposed = false;
  let colorbarLocale = previewI18n.language;
  let currentNotices: string[] = [];
  const refresh = (): void => {
    if (disposed) return;
    const model = previewLegendModel(project, renderer.getLayers());
    const componentNotices = previewComponentOutputs(project).notices;
    currentNotices = [...new Set([...model.notices, ...componentNotices])];
    if (colorbarLocale !== previewI18n.language) {
      colorbarLocale = previewI18n.language;
      for (const control of colorbarControls) control.update(theme);
    }
    if (!host || !root) return;
    host.dir = document.documentElement.dir;
    flushSync(() =>
      root?.render(
        <PreviewLegendPanel
          host={host}
          title={project.legend?.title ?? ""}
          entries={model.entries}
          initialCollapsed={project.legend?.panelCollapsed === true}
          width={project.legend?.panelWidth}
          height={project.legend?.panelHeight}
          labels={{
            collapse: previewI18n.t("legendPanel.collapsePanel"),
            expand: previewI18n.t("legendPanel.expandPanel"),
            low: previewI18n.t("legendPanel.low"),
            high: previewI18n.t("legendPanel.high"),
            empty: previewI18n.t("legendPanel.empty"),
          }}
        />,
      ),
    );
  };
  refresh();

  return {
    refresh,
    notices: () => currentNotices,
    dispose() {
      if (disposed) return;
      disposed = true;
      root?.unmount();
      if (panelControl) {
        try {
          renderer.map.removeControl(panelControl);
        } catch {
          /* map already removed */
        }
      }
      for (const control of vendorControls) {
        try {
          renderer.map.removeControl(control);
        } catch {
          /* map already removed */
        }
      }
    },
  };
}
