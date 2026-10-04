import type { FeatureCollection } from "geojson";

export interface RefreshedMssqlTable {
  geojson: FeatureCollection;
  feature_count: number;
}

export type MssqlWritebackOutcome<TWrite> =
  | { kind: "blocked" }
  | { kind: "stale" }
  | { kind: "missing-baseline" }
  | { kind: "write-failed"; error: unknown }
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
      return { kind: "write-failed", error };
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
