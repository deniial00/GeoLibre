import type { FeatureCollection } from "geojson";

export interface RefreshedMssqlTable {
  geojson: FeatureCollection;
  feature_count: number;
}

export type MssqlWritebackOutcome<TWrite> =
  | { kind: "blocked" }
  | { kind: "refresh-failed"; writeResult: TWrite; error: unknown }
  | { kind: "reconciled"; writeResult: TWrite; refreshed: RefreshedMssqlTable };

/** Whether a SQL Server layer may save without replaying a committed insert. */
export function canSaveMssqlWriteback(
  layerId: string,
  refreshRequiredLayerIds: ReadonlySet<string>,
): boolean {
  return !refreshRequiredLayerIds.has(layerId);
}

/** Track a committed write whose follow-up table read failed, without changing layer metadata. */
export function requireMssqlWritebackRefresh(
  current: ReadonlySet<string>,
  layerId: string,
): ReadonlySet<string> {
  const next = new Set(current);
  next.add(layerId);
  return next;
}

/** Release the save guard only after a successful table reread. */
export function clearMssqlWritebackRefresh(
  current: ReadonlySet<string>,
  layerId: string,
): ReadonlySet<string> {
  if (!current.has(layerId)) return current;
  const next = new Set(current);
  next.delete(layerId);
  return next;
}

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

/** Write once, then reconcile generated database keys before another save is allowed. */
export async function writeMssqlAndRefresh<TWrite>(
  refreshRequired: boolean,
  write: () => Promise<TWrite>,
  refresh: () => Promise<RefreshedMssqlTable>,
): Promise<MssqlWritebackOutcome<TWrite>> {
  if (refreshRequired) return { kind: "blocked" };

  const writeResult = await write();
  try {
    return { kind: "reconciled", writeResult, refreshed: await refresh() };
  } catch (error) {
    return { kind: "refresh-failed", writeResult, error };
  }
}
