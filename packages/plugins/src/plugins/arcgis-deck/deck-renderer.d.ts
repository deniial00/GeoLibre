import type { DeckProps } from "@deck.gl/core";
import type { ArcgisEngine } from "@geolibre/map";
import type { RenderResources } from "./commons.js";
export interface SceneDeckRenderer {
  deck: { set(props: DeckProps): void };
  resources: RenderResources | null;
  dispose(): void;
  redraw(): void;
}
export default function createDeckRenderer(Props: unknown, RenderNode: unknown): new (
  view: NonNullable<ReturnType<ArcgisEngine["getView"]>>,
  props: DeckProps,
) => SceneDeckRenderer;
