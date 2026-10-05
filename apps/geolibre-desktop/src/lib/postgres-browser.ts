import { fetchPostgisStatus, listPostgisTables } from "@geolibre/processing";
import type { TFunction } from "i18next";
import { errorMessage } from "../components/layout/add-data/helpers";
import { uniqueDatabaseTables } from "./database-tables";
import { isDesktopRuntime } from "./is-mobile";
import { startGeoLibreSidecar } from "./sidecar";
import type { ConnectionLoad, SetConnectionLoads } from "./browser-tree";

export interface PostgresBrowserLoaderDependencies {
  isDesktop: () => boolean;
  startSidecar: typeof startGeoLibreSidecar;
  fetchStatus: typeof fetchPostgisStatus;
  listTables: typeof listPostgisTables;
}

const defaultDependencies: PostgresBrowserLoaderDependencies = {
  isDesktop: isDesktopRuntime,
  startSidecar: startGeoLibreSidecar,
  fetchStatus: fetchPostgisStatus,
  listTables: listPostgisTables,
};

/**
 * Lazily introspect a desktop PostgreSQL connection once per successful load.
 * Publish loading/error/table state; failures clear the fetched marker for retry.
 */
export function fetchPostgresBrowserTables(
  connectionString: string,
  fetched: Set<string>,
  setLoads: SetConnectionLoads,
  t: TFunction,
  dependencies: PostgresBrowserLoaderDependencies = defaultDependencies,
): void {
  if (fetched.has(connectionString)) return;
  fetched.add(connectionString);
  const key = connectionString;
  const update = (load: ConnectionLoad) => setLoads((previous) => ({ ...previous, [key]: load }));

  // PostGIS browsing needs the desktop sidecar/Martin, so outside the
  // desktop shell show the same localized "requires GeoLibre Desktop"
  // message the Add Data dialog gives rather than letting
  // startGeoLibreSidecar/fetch fail with a raw network error. The gate is
  // isDesktopRuntime(), not isTauri(): the packaged mobile apps are Tauri
  // too and have no sidecar to reach (GeoLibre#2091). Dropped from the
  // fetched set so it can retry on desktop.
  if (!dependencies.isDesktop()) {
    fetched.delete(connectionString);
    update({ status: "error", message: t("addData.postgres.errorDesktopOnly") });
    return;
  }
  update({ status: "loading" });
  // The desktop sidecar is spawned on demand and only authenticated after
  // startGeoLibreSidecar runs, so ensure it is up before hitting /postgis —
  // best-effort, mirroring PostgresSource.handleConnectEditable (a failed
  // start still lets the status/list calls surface the real error).
  void dependencies
    .startSidecar()
    .catch(() => {})
    .then(() => dependencies.fetchStatus())
    .then((status) => {
      // Same runtime gate as the Add Data dialog, so a missing postgis
      // extra reads as the friendly "install the extra" message rather
      // than a raw connection error from /postgis/tables.
      if (!status.available) {
        throw new Error(t("addData.postgres.errorRuntimeMissing"));
      }
      return dependencies.listTables(connectionString);
    })
    .then((tables) => {
      // geometry_columns returns one row per geometry column, so a table
      // with several geometry columns appears several times; keep the first
      // because the Browser tree represents tables, while the Add Data
      // dialog provides the geometry-column picker after a table is chosen.
      const unique = uniqueDatabaseTables(tables).map(({ schema, table }) => ({ schema, table }));
      update({ status: "loaded", tables: unique });
    })
    .catch((err: unknown) => {
      // Allow a retry: drop the fetched marker so collapsing and
      // re-expanding the connection re-runs introspection rather than
      // sticking on the error. Reuse the Add Data errorMessage helper for a
      // translated fallback, matching the dialog's PostGIS entry point.
      fetched.delete(connectionString);
      update({
        status: "error",
        message: errorMessage(err, t("addData.postgres.errorConnect")),
      });
    });
}
