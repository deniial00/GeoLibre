import { MssqlSessionExpiredError, MssqlWriteRejectedError } from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";

export class MssqlWriteUncertainError extends Error {
  override readonly name = "MssqlWriteUncertainError";
}

/** Preserve definitive sidecar errors; a lost response can follow a committed write. */
export async function runMssqlWriteRequest<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof MssqlWriteRejectedError || error instanceof MssqlSessionExpiredError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new MssqlWriteUncertainError(message, { cause: error });
  }
}

interface MssqlLoadedRows {
  generation: number;
  primaryKey: string;
  rows: Map<string, { geometry: string; properties: Record<string, unknown> }>;
}

const loadedMssqlRows = new Map<string, MssqlLoadedRows>();

function mssqlRowKey(key: string | number): string {
  return `${typeof key}:${key}`;
}

/** Resolve an SQL Server row identity using the same property/id precedence as the sidecar. */
export function mssqlFeatureKey(feature: Feature, primaryKey: string): string | number | undefined {
  const key = feature.properties?.[primaryKey] ?? feature.id;
  return typeof key === "string" || typeof key === "number" ? key : undefined;
}

/** Keep an immutable in-memory baseline for identifying user-edited values. */
export function rememberMssqlLoadedRows(
  layerId: string,
  generation: number,
  primaryKey: string,
  geojson: FeatureCollection,
): void {
  const rows = new Map<string, { geometry: string; properties: Record<string, unknown> }>();
  for (const feature of geojson.features) {
    const key = mssqlFeatureKey(feature, primaryKey);
    if (key === undefined) continue;
    rows.set(mssqlRowKey(key), {
      geometry: JSON.stringify(feature.geometry ?? null),
      properties: structuredClone(feature.properties ?? {}),
    });
  }
  loadedMssqlRows.set(layerId, { generation, primaryKey, rows });
}

/** Send only edited properties while retaining geometry for compatible older sidecars. */
export function mssqlWritePayload(
  layerId: string,
  generation: number,
  geojson: FeatureCollection,
): {
  geojson: FeatureCollection;
  unchangedGeometryKeys?: Array<string | number>;
} {
  const baseline = loadedMssqlRows.get(layerId);
  if (!baseline || baseline.generation !== generation) return { geojson };

  let matchedRows = 0;
  const unchangedGeometryKeys: Array<string | number> = [];
  const features = geojson.features.map((feature) => {
    const key = mssqlFeatureKey(feature, baseline.primaryKey);
    if (key === undefined) return feature;
    const row = baseline.rows.get(mssqlRowKey(key));
    if (!row) return feature;

    matchedRows += 1;
    const properties = feature.properties ?? {};
    const changed: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      if (
        name !== baseline.primaryKey &&
        (!Object.prototype.hasOwnProperty.call(row.properties, name) ||
          JSON.stringify(value) !== JSON.stringify(row.properties[name]))
      ) {
        changed[name] = value;
      }
    }
    if (JSON.stringify(feature.geometry ?? null) === row.geometry) {
      unchangedGeometryKeys.push(key);
    }
    return {
      ...feature,
      properties: { [baseline.primaryKey]: key, ...changed },
    };
  });

  if (!matchedRows) return { geojson };
  return {
    geojson: { ...geojson, features },
    ...(unchangedGeometryKeys.length ? { unchangedGeometryKeys } : {}),
  };
}

/** Clear module-local baselines between isolated tests. */
export function resetMssqlLoadedRows(): void {
  loadedMssqlRows.clear();
}

export interface RefreshedMssqlTable {
  geojson: FeatureCollection;
  feature_count: number;
}

export type MssqlWritebackOutcome<TWrite> =
  | { kind: "blocked" }
  | { kind: "stale" }
  | { kind: "missing-baseline" }
  | { kind: "write-failed"; error: unknown }
  | { kind: "write-rejected"; error: unknown }
  | { kind: "refresh-failed"; writeResult: TWrite }
  | { kind: "reconciled"; writeResult: TWrite; refreshed: RefreshedMssqlTable };

/** Reconcile a successful table read into the layer's current metadata. */
export function reconcileMssqlWritebackMetadata(
  metadata: Record<string, unknown>,
  refreshed: RefreshedMssqlTable,
): Record<string, unknown> {
  return {
    ...metadata,
    featureCount: refreshed.feature_count,
    mssqlBaselineKeys: refreshed.geojson.features
      .map((feature) => feature.id)
      .filter((id): id is string | number => typeof id === "string" || typeof id === "number"),
  };
}

/** Write once per layer, then reconcile database keys only for the originating project. */
export async function writeMssqlAndRefresh<TWrite>(
  request: {
    layerId: string;
    inFlightLayerIds: Set<string>;
    refreshRequired: boolean;
    baselineKeys: ReadonlyArray<string | number> | undefined;
    isCurrent: () => boolean;
  },
  write: () => Promise<TWrite>,
  refresh: () => Promise<RefreshedMssqlTable>,
): Promise<MssqlWritebackOutcome<TWrite>> {
  if (request.refreshRequired || request.inFlightLayerIds.has(request.layerId)) {
    return { kind: "blocked" };
  }
  if (!request.isCurrent()) return { kind: "stale" };
  if (request.baselineKeys === undefined) return { kind: "missing-baseline" };

  request.inFlightLayerIds.add(request.layerId);
  try {
    let writeResult: TWrite;
    try {
      writeResult = await write();
    } catch (error) {
      if (!request.isCurrent()) return { kind: "stale" };
      if (error instanceof MssqlWriteUncertainError) return { kind: "write-failed", error };
      return { kind: "write-rejected", error };
    }
    if (!request.isCurrent()) return { kind: "stale" };
    try {
      const refreshed = await refresh();
      if (!request.isCurrent()) return { kind: "stale" };
      return { kind: "reconciled", writeResult, refreshed };
    } catch {
      if (!request.isCurrent()) return { kind: "stale" };
      return { kind: "refresh-failed", writeResult };
    }
  } finally {
    request.inFlightLayerIds.delete(request.layerId);
  }
}
