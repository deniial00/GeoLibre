import * as React from "react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@geolibre/ui/utils";
import type { AutoLegendEntry, AutoLegendRow } from "../../lib/auto-legend";
import { GeometrySwatch, GradientBar, MarkerSwatch } from "./LegendSwatch";

export const LEGEND_PANEL_CLASS = "geolibre-legend-panel";
export const MIN_PANEL_WIDTH = 200;
export const MAX_PANEL_WIDTH = 520;
export const MIN_PANEL_HEIGHT = 140;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useMapPanelMaxHeight(host: HTMLElement | null): {
  maxHeight: number | null;
  maxHeightRef: RefObject<number | null>;
} {
  const maxHeightRef = useRef<number | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!host) return;
    const mapElement = host.closest(".maplibregl-map, .mapboxgl-map");
    if (!mapElement) return;
    const update = () => {
      const available = Math.max(MIN_PANEL_HEIGHT, mapElement.clientHeight - 24);
      maxHeightRef.current = available;
      setMaxHeight(available);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(mapElement);
    return () => observer.disconnect();
  }, [host]);
  return { maxHeight, maxHeightRef };
}

export function legendPanelStyle({
  maxHeight,
  width,
  height,
  collapsed,
}: {
  maxHeight: number | null;
  width?: number;
  height?: number;
  collapsed: boolean;
}): CSSProperties {
  return {
    maxHeight: maxHeight ?? undefined,
    ...(width !== undefined ? { width: clamp(width, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH) } : {}),
    ...(height !== undefined && !collapsed
      ? { height: clamp(height, MIN_PANEL_HEIGHT, maxHeight ?? height) }
      : {}),
  };
}

export function visibleLegendRows(rows: AutoLegendRow[]): AutoLegendRow[] {
  const visible: AutoLegendRow[] = [];
  let pendingCaption: string | undefined;
  for (const row of rows) {
    if (row.hidden) {
      if (row.caption) pendingCaption = row.caption;
      continue;
    }
    visible.push(pendingCaption && !row.caption ? { ...row, caption: pendingCaption } : row);
    pendingCaption = undefined;
  }
  return visible;
}

export function legendEntryMaxRowSize(entry: AutoLegendEntry): number {
  return entry.rows.reduce(
    (largest, row) => (row.size !== undefined && row.size > largest ? row.size : largest),
    0,
  );
}

export function LegendEntryChip({ entry }: { entry: AutoLegendEntry }) {
  if (entry.headerSwatch?.marker) {
    return <MarkerSwatch marker={entry.headerSwatch.marker} opacity={entry.opacity} />;
  }
  if (entry.headerSwatch) {
    return (
      <GeometrySwatch
        shape={entry.shape}
        color={entry.headerSwatch.color}
        opacity={entry.opacity}
      />
    );
  }
  if (entry.shape === "raster") return <GeometrySwatch shape="raster" color="" />;
  const first = entry.rows.find((row) => !row.hidden) ?? entry.rows[0];
  return (
    <GeometrySwatch shape={entry.shape} color={first?.color ?? "#94a3b8"} opacity={entry.opacity} />
  );
}

export function LegendRowSwatch({
  row,
  entry,
  maxRowSize,
}: {
  row: AutoLegendRow;
  entry: AutoLegendEntry;
  maxRowSize: number;
}) {
  return row.marker ? (
    <MarkerSwatch
      marker={row.marker}
      size={row.size}
      maxSize={maxRowSize > 0 ? maxRowSize : undefined}
      opacity={entry.opacity}
    />
  ) : (
    <GeometrySwatch
      shape={row.shape}
      color={row.color}
      size={row.size}
      maxSize={maxRowSize > 0 ? maxRowSize : undefined}
      opacity={entry.opacity}
    />
  );
}

export function LegendEntryCaptions({
  entry,
  classificationLabel,
}: {
  entry: AutoLegendEntry;
  classificationLabel: string | null;
}) {
  return (
    <>
      {entry.fieldLabel && (
        <div className="ms-6 mt-1 truncate text-[10px] font-medium text-muted-foreground">
          {entry.fieldLabel}
        </div>
      )}
      {classificationLabel && (
        <div
          className={cn(
            "ms-6 truncate text-[10px] text-muted-foreground",
            !entry.fieldLabel && "mt-1",
          )}
        >
          {classificationLabel}
        </div>
      )}
    </>
  );
}

export function LegendEntryGradient({
  entry,
  lowLabel,
  highLabel,
}: {
  entry: AutoLegendEntry;
  lowLabel: string;
  highLabel: string;
}) {
  return entry.gradient ? (
    <div className="ms-6 mt-1.5">
      <GradientBar
        colors={entry.gradient.colors}
        minLabel={entry.gradient.minLabel ?? lowLabel}
        maxLabel={entry.gradient.maxLabel ?? highLabel}
        opacity={entry.opacity}
      />
    </div>
  ) : null;
}

export function LegendEntryDisplay({
  entry,
  classificationLabel,
  lowLabel,
  highLabel,
}: {
  entry: AutoLegendEntry;
  classificationLabel: string | null;
  lowLabel: string;
  highLabel: string;
}) {
  const rows = visibleLegendRows(entry.rows);
  const maxRowSize = legendEntryMaxRowSize(entry);
  return (
    <li className={cn("px-3 py-2", entry.hidden && "opacity-40")}>
      <div className="flex items-center gap-2">
        <LegendEntryChip entry={entry} />
        <span className="min-w-0 flex-1 text-sm leading-tight line-clamp-2" title={entry.name}>
          {entry.name}
        </span>
      </div>
      <LegendEntryCaptions entry={entry} classificationLabel={classificationLabel} />
      {rows.length > 0 && (
        <ul className="ms-6 mt-1.5 space-y-0.5">
          {rows.map((row) => (
            <li key={row.key}>
              {row.caption && (
                <div className="mb-0.5 mt-1 truncate text-[10px] font-medium text-muted-foreground">
                  {row.caption}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <LegendRowSwatch row={row} entry={entry} maxRowSize={maxRowSize} />
                <span
                  className="min-w-0 flex-1 truncate text-xs text-foreground/80"
                  title={row.label}
                >
                  {row.label}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <LegendEntryGradient entry={entry} lowLabel={lowLabel} highLabel={highLabel} />
    </li>
  );
}

export function LegendPanelFrame({
  panelRef,
  style,
  collapsed,
  onToggleCollapsed,
  toggleLabel,
  title,
  actions,
  children,
}: {
  panelRef?: React.Ref<HTMLDivElement>;
  style: CSSProperties;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  toggleLabel: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      ref={panelRef}
      className="relative flex w-64 flex-col overflow-hidden rounded-lg border border-border/50 map-glass text-foreground shadow-lg"
      style={style}
    >
      <div
        className={cn(
          "group flex shrink-0 items-center gap-1 px-3 py-2",
          !collapsed && "border-b border-border/50",
        )}
      >
        <button
          type="button"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          title={toggleLabel}
          onClick={onToggleCollapsed}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")}
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        {title}
        {actions}
      </div>
      {!collapsed && children}
    </div>
  );
}

export function LegendEntryList({ children }: { children: ReactNode }) {
  return (
    <ul data-cvd-filter="" className="min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto">
      {children}
    </ul>
  );
}

export function LegendEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-xs text-muted-foreground">{children}</p>;
}
