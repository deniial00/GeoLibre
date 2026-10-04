import { fetchMssqlStatus, listMssqlTables } from "@geolibre/processing";
import type { TFunction } from "i18next";
import { isDesktopRuntime } from "./is-mobile";
import { startGeoLibreSidecar } from "./sidecar";
import { MssqlReconnectRequiredError, withMssqlSession } from "./mssql-sessions";
import { errorMessage } from "../components/layout/add-data/helpers";
import type { ConnectionLoad } from "./browser-tree";

export type MssqlBrowserLoads = Record<string, ConnectionLoad>;
export type SetMssqlBrowserLoads = (
  update: (previous: MssqlBrowserLoads) => MssqlBrowserLoads,
) => void;

export interface MssqlBrowserLoaderDependencies {
  isDesktop: () => boolean;
  startSidecar: typeof startGeoLibreSidecar;
  fetchStatus: typeof fetchMssqlStatus;
  listTables: typeof listMssqlTables;
  withSession: typeof withMssqlSession;
}

const defaultDependencies: MssqlBrowserLoaderDependencies = {
  isDesktop: isDesktopRuntime,
  startSidecar: startGeoLibreSidecar,
  fetchStatus: fetchMssqlStatus,
  listTables: listMssqlTables,
  withSession: withMssqlSession,
};

export function fetchMssqlBrowserTables(
  connectionId: string,
  fetched: Set<string>,
  setLoads: SetMssqlBrowserLoads,
  t: TFunction,
  dependencies: MssqlBrowserLoaderDependencies = defaultDependencies,
): void {
  if (fetched.has(connectionId)) return;
  fetched.add(connectionId);
  const key = `mssql:${connectionId}`;
  const update = (load: ConnectionLoad) => setLoads((previous) => ({ ...previous, [key]: load }));

  if (!dependencies.isDesktop()) {
    fetched.delete(connectionId);
    update({ status: "error", message: t("addData.mssql.errorDesktopOnly") });
    return;
  }
  update({ status: "loading" });
  void dependencies
    .startSidecar()
    .catch(() => {})
    .then(() => dependencies.fetchStatus())
    .then((status) => {
      if (!status.available) {
        throw new Error(t("addData.mssql.errorRuntimeMissing", { detail: status.message }));
      }
      return dependencies.withSession(connectionId, (sessionId) =>
        dependencies.listTables(sessionId),
      );
    })
    .then((tables) => {
      const seen = new Set<string>();
      const unique = tables.filter((table) => {
        const tableKey = `${table.schema}.${table.table}`;
        if (seen.has(tableKey)) return false;
        seen.add(tableKey);
        return true;
      });
      update({ status: "loaded", tables: unique });
    })
    .catch((error: unknown) => {
      fetched.delete(connectionId);
      update({
        status: "error",
        message:
          error instanceof MssqlReconnectRequiredError
            ? t("addData.mssql.errorReconnectRequired")
            : errorMessage(error, t("addData.mssql.errorConnect")),
      });
    });
}
