import type { SceneDeckRenderer } from "./deck-renderer.js";
import type { DeckProps } from "@deck.gl/core";
import type { ArcgisEngine } from "@geolibre/map";
import { ARCGIS_SDK_CDN } from "@geolibre/map/arcgis-sdk";
import { initializeResources, render, finalizeResources, type RenderResources } from "./commons.js";

type ArcgisView = NonNullable<ReturnType<ArcgisEngine["getView"]>>;
type NativeLayer = ArcgisView["map"]["layers"] extends { toArray(): (infer L)[] } ? L : never;
type Subclass<T> = {
  createSubclass(definition: Record<string, unknown>): new (props: Record<string, unknown>) => T;
};
interface LayerView {
  context: WebGL2RenderingContext;
  requestRender(): void;
}

async function importModule(path: string): Promise<{ default: unknown }> {
  return import(/* @vite-ignore */ `${ARCGIS_SDK_CDN}/@arcgis/core/${path}.js`);
}

/** CDN-backed equivalent of deck.gl's DeckLayer, with explicit store-driven props. */
export class ArcgisDeckOverlay {
  private map: ArcgisView["map"];
  private native: NativeLayer | null = null;
  private resources: RenderResources | null = null;
  private layerView: LayerView | null = null;
  private generation = 0;
  private disposed = false;
  private events: { remove(): void }[] = [];
  private props: DeckProps;
  private sceneRenderer: SceneDeckRenderer | null = null;

  constructor(
    private view: ArcgisView,
    props: DeckProps,
    private loadModule = importModule,
  ) {
    this.props = props;
    this.map = view.map;
  }

  private mountPromise: Promise<void> | null = null;
  mount(): Promise<void> {
    return (this.mountPromise ??= this.attach());
  }
  private async attach(): Promise<void> {
    if (this.disposed || this.native) return;
    // Deck uses an offscreen canvas, so ArcGIS owns pointer delivery.
    for (const [eventType, callback] of [
      ["click", "onClick"],
      ["pointer-move", "onHover"],
    ] as const) {
      if (!this.view.on) continue;
      this.events.push(
        this.view.on(eventType, (event) => {
          const info = this.getDeck()?.pickObject({ x: event.x, y: event.y });
          if (!info) return;
          const handled = info.layer?.props[callback]?.(info, event as never);
          if (!handled) this.props[callback]?.(info, event as never);
        }),
      );
    }
    if (this.view.type === "3d") {
      if (this.view.viewingMode !== "local") return;
      const [module, { default: factory }] = await Promise.all([
        this.loadModule("views/3d/webgl/RenderNode"),
        import("./deck-renderer.js"),
      ]);
      if (!this.disposed) {
        const Renderer = factory(DeckState, module.default);
        this.sceneRenderer = new Renderer(this.view, this.props);
      }
      return;
    }
    const paths = ["layers/Layer", "views/2d/layers/BaseLayerViewGL2D"];
    const [layerModule, viewModule] = await Promise.all(paths.map((path) => this.loadModule(path)));
    if (this.disposed) return;
    const Layer = layerModule.default as Subclass<NativeLayer>;
    const BaseLayerView = viewModule.default as Subclass<LayerView>;
    const overlay = this;
    const DeckView = BaseLayerView.createSubclass({
      async attach(this: LayerView) {
        const generation = ++overlay.generation;
        overlay.layerView = this;
        try {
          const resources = await initializeResources.call(
            { redraw: () => this.requestRender() },
            this.context,
          );
          if (overlay.disposed || generation !== overlay.generation) {
            finalizeResources(resources);
            return;
          }
          overlay.resources = resources;
          resources.deck.setProps(overlay.props);
          overlay.props.onDeviceInitialized?.(resources.model.device);
          this.requestRender();
        } catch (error) {
          if (!overlay.disposed) overlay.props.onError?.(error as Error);
        }
      },
      detach() {
        overlay.generation++;
        if (overlay.resources) finalizeResources(overlay.resources);
        overlay.resources = null;
        overlay.layerView = null;
      },
      render({ state }: { state: { size: [number, number]; scale: number; rotation: number } }) {
        if (!overlay.resources) return;
        const [width, height] = state.size;
        render(overlay.resources, {
          width,
          height,
          latitude: overlay.view.center.latitude,
          longitude: overlay.view.center.longitude,
          // ArcGIS scales use 256px tiles; Deck's Mercator viewport uses 512px.
          zoom: Math.log2(591657527.591555 / state.scale) - 1,
          bearing: -state.rotation,
          pitch: 0,
        });
      },
    });
    const DeckLayer = Layer.createSubclass({
      createLayerView(view: ArcgisView) {
        return new DeckView({ view, layer: overlay.native });
      },
    });
    this.native = new DeckLayer({ title: "deck.gl", listMode: "hide" });
    this.map.add(this.native);
  }

  setProps(props: DeckProps): void {
    this.props = { ...this.props, ...props };
    this.resources?.deck.setProps(props);
    this.sceneRenderer?.deck.set(props);
    this.sceneRenderer?.redraw();
    this.layerView?.requestRender();
  }

  getDeck() {
    return this.resources?.deck ?? this.sceneRenderer?.resources?.deck ?? null;
  }

  finalize(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const event of this.events) event.remove();
    this.events = [];
    this.generation++;
    this.sceneRenderer?.dispose();
    this.sceneRenderer = null;
    if (this.native && !this.native.destroyed) {
      this.map.remove(this.native);
      this.native.destroy();
      this.native = null;
    }
    if (this.resources) finalizeResources(this.resources);
    this.resources = null;
    this.layerView = null;
  }
}

/** Upstream's props Accessor contract without the removed SDK Accessor.watch API. */
class DeckState {
  private listeners = new Set<(props: DeckProps) => void>();
  constructor(private props: DeckProps = {}) {}
  on(_event: string, callback: (props: DeckProps) => void): void {
    this.listeners.add(callback);
  }
  set(props: DeckProps): void {
    this.props = { ...this.props, ...props };
    for (const callback of this.listeners) callback(props);
  }
  toJSON(): DeckProps {
    return this.props;
  }
  clear(): void {
    this.listeners.clear();
  }
}
