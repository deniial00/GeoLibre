import { useAppStore } from "@geolibre/core";
import { createContext, useContext, type ReactNode } from "react";
import { useLayerRefresh, type LayerRefresh } from "./useLayerRefresh";

const LayerRefreshContext = createContext<LayerRefresh | null>(null);

export function LayerRefreshProvider({
  children,
  isCollapsed,
}: {
  children: ReactNode;
  isCollapsed: boolean;
}) {
  const layers = useAppStore((state) => state.layers);
  const refresh = useLayerRefresh({ layers, isCollapsed });
  return <LayerRefreshContext.Provider value={refresh}>{children}</LayerRefreshContext.Provider>;
}

export function useLayerRefreshContext(): LayerRefresh {
  const refresh = useContext(LayerRefreshContext);
  if (!refresh) throw new Error("LayerPanel must be rendered inside LayerRefreshProvider");
  return refresh;
}
