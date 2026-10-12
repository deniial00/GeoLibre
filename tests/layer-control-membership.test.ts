import {
  LayerControl,
  type CustomLayerAdapter,
  type LayerControlOptions,
  type LayerState,
} from "maplibre-gl-layer-control";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  LayerControlHost,
  type LayerControlHostAdapter,
} from "../packages/map/src/layer-control-host";
import { geojsonLayer } from "./helpers/layer-fixtures";

it("mounts one row per project layer, mapped or not, top-most first", () => {
  const { window } = parseHTML('<div id="map"><div class="maplibregl-ctrl-top-right"></div></div>');
  const globals = globalThis as { document?: unknown; window?: unknown };
  const previous = { document: globals.document, window: globals.window };
  globals.document = window.document;
  globals.window = window;
  try {
    const container = window.document.getElementById("map")!;
    // Even layers have a mounted native style layer; odd ones are hidden or
    // still loading and have none yet.
    const layers = Array.from({ length: 85 }, (_, index) =>
      geojsonLayer({ id: `layer-${index}`, name: `Layer ${index}`, visible: index % 2 === 0 }),
    );
    const isMapped = (layer: GeoLibreLayer) => Number(layer.id.slice(6)) % 2 === 0;
    const styleLayers = layers
      .filter(isMapped)
      .map((layer) => ({ id: `native-${layer.id}`, type: "circle", source: layer.id }));
    const map = {
      getLayer: (id: string) => styleLayers.find((layer) => layer.id === id),
      getStyle: () => ({ version: 8, sources: {}, layers: styleLayers }),
      getSource: () => undefined,
      getContainer: () => container,
      getLayoutProperty: () => undefined,
      getPaintProperty: () => undefined,
      on: () => {},
      off: () => {},
    };
    let mounted: { onRemove?: (map: unknown) => void } | null = null;
    const adapter: LayerControlHostAdapter = {
      getMap: () => map,
      addControl: (control) => {
        mounted = control as typeof mounted;
        container.firstElementChild!.appendChild(control.onAdd(map as never));
      },
      removeControl: (control) => {
        control.onRemove?.(map as never);
      },
      getLayers: () => layers,
      getNativeLayerIds: (layer) => (isMapped(layer) ? [`native-${layer.id}`] : []),
      getCandidateNativeLayerIds: (layer) => [`native-${layer.id}`],
      getSourceIds: () => [],
      excludedLayerIds: [],
      getBasemapStyleUrl: () => null,
      getBasemapLayerIds: () => [],
      getBasemapState: () => ({ visible: true, opacity: 1 }),
    };
    const host = new LayerControlHost(adapter);
    assert.equal(host.add("top-right"), true);
    assert.ok(mounted);
    const rows = Array.from(container.querySelectorAll(".layer-control-item"))
      .map((item) => item.getAttribute("data-layer-id"))
      .filter((id) => id !== "Background");
    // The panel lists the top-most layer first; the store is bottom-to-top.
    assert.deepEqual(rows, layers.map((layer) => layer.id).reverse());
    host.destroy();
  } finally {
    globals.document = previous.document;
    globals.window = previous.window;
  }
});
function mount(
  adapter: CustomLayerAdapter,
  mapLayers: Array<{ id: string; type: string }> = [],
  overrides: LayerControlOptions = {},
) {
  const { window } = parseHTML('<div id="map"></div>');
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const pending = new Map<number, () => void>();
  let nextCallback = 0;
  let focused: Element | null = null;
  // linkedom does not implement focus tracking or layout. These browser seams
  // let the real installed control keep ownership of every rendered DOM node.
  Object.defineProperty(window.document, "activeElement", { get: () => focused });
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.assign(globalThis, {
    document: window.document,
    window,
    HTMLElement: window.HTMLElement,
    setTimeout: ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
      const id = ++nextCallback;
      pending.set(id, () => callback(...args));
      return id;
    }) as typeof setTimeout,
    clearTimeout: ((id: number) => pending.delete(id)) as unknown as typeof clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextCallback;
      pending.set(id, () => callback(0));
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      pending.delete(id);
    },
  });
  const container = window.document.getElementById("map")!;
  container.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 480,
    width: 800,
    height: 480,
    toJSON: () => ({}),
  });
  const callbacks = new Map<string, Set<(event?: unknown) => void>>();
  const map = {
    getContainer: () => container,
    getStyle: () => ({ version: 8, sources: {}, layers: mapLayers }),
    getLayer: (id: string) => mapLayers.find((layer) => layer.id === id),
    getSource: () => undefined,
    getLayoutProperty: () => undefined,
    getPaintProperty: () => undefined,
    setLayoutProperty: () => {},
    setPaintProperty: () => {},
    on: (event: string, callback: (event?: unknown) => void) => {
      const set = callbacks.get(event) ?? new Set();
      set.add(callback);
      callbacks.set(event, set);
    },
    off: (event: string, callback: (event?: unknown) => void) =>
      callbacks.get(event)?.delete(callback),
    getCanvas: () => container,
  };
  let control: LayerControl | undefined;
  let removed = false;
  const remove = () => {
    if (!removed) {
      removed = true;
      control?.onRemove();
    }
  };
  const restore = () => {
    try {
      remove();
    } finally {
      pending.clear();
      Object.assign(globalThis, previous);
    }
  };
  try {
    control = new LayerControl({
      autoDetect: false,
      collapsed: true,
      customLayerAdapters: [adapter],
      showStyleEditor: false,
      showOpacitySlider: false,
      showLayerSymbol: true,
      enableContextMenu: false,
      enableDragAndDrop: false,
      enableBackgroundPresets: false,
      showZoomButton: true,
      ...overrides,
    });
    container.append(control.onAdd(map as never));
    return {
      window,
      container,
      control,
      map,
      remove,
      restore,
      emit(event: string) {
        const payload =
          event === "data"
            ? { sourceDataType: "content" }
            : event === "sourcedata"
              ? { sourceDataType: "metadata" }
              : undefined;
        for (const callback of callbacks.get(event) ?? []) callback(payload);
      },
      queuedCallbacks: () => [...pending.values()],
      listenerCount: () => [...callbacks.values()].reduce((sum, set) => sum + set.size, 0),
      flush() {
        for (let turn = 0; pending.size > 0; turn += 1) {
          assert.ok(turn < 100, "control callbacks must settle");
          const work = [...pending.values()];
          pending.clear();
          for (const callback of work) callback();
        }
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}

function layerState(overrides: Partial<LayerState> = {}): LayerState {
  return { name: "Preview layer", visible: true, opacity: 1, ...overrides };
}

it("keeps adapter-only membership through native map events and reflects visibility readback", () => {
  const visible = false;
  const ids = ["project"];
  const nativeLayers = [{ id: "native-basemap", type: "background" }];
  const adapter: CustomLayerAdapter = {
    type: "preview",
    getLayerIds: () => ids,
    getLayerState: (id) => (id === "project" ? layerState({ visible }) : null),
    getName: () => "Preview layer",
    setVisibility: () => {
      /* deliberately leaves readback unchanged */
    },
  };
  const mounted = mount(adapter, nativeLayers);
  try {
    const row = () =>
      mounted.container.querySelector('.layer-control-item[data-layer-id="project"]');
    assert.ok(row());
    assert.equal(
      mounted.container.querySelector('.layer-control-item[data-layer-id="native-basemap"]'),
      null,
    );
    nativeLayers.push({ id: "native-added-later", type: "fill" });
    mounted.emit("styledata");
    mounted.emit("data");
    mounted.emit("sourcedata");
    mounted.flush();
    assert.equal(mounted.container.querySelectorAll(".layer-control-item").length, 1);
    const checkbox = row()!.querySelector<HTMLInputElement>(".layer-control-checkbox")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    assert.equal(checkbox.checked, false);
  } finally {
    mounted.restore();
  }
});

it("keeps authored adapter IDs and numeric order without rebuilding unchanged rows", () => {
  const ids = ["__proto__", "Background", "2", "1", 'quoted"[]'];
  const states = new Map(ids.map((id) => [id, layerState({ name: id, visible: false })]));
  const adapter: CustomLayerAdapter = {
    type: "preview",
    getLayerIds: () => ids,
    getLayerState: (id) => states.get(id) ?? null,
    getName: (id) => id,
    setVisibility: (id, visible) => {
      states.get(id)!.visible = visible;
    },
  };
  const mounted = mount(adapter);
  try {
    const rows = [...mounted.container.querySelectorAll<HTMLElement>(".layer-control-item")];
    assert.deepEqual(
      rows.map((row) => row.dataset.layerId),
      [...ids].reverse(),
    );
    const checkboxes = rows.map((row) =>
      row.querySelector<HTMLInputElement>(".layer-control-checkbox")!,
    );
    for (const checkbox of checkboxes) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    }
    assert.equal(states.get("Background")!.visible, true);
    assert.equal(states.get("__proto__")!.visible, true);
    mounted.map.getStyle = () => {
      throw new Error("Adapter-only control must not inspect native style");
    };
    mounted.control.refreshCustomLayers();
    mounted.emit("styledata");
    mounted.flush();
    assert.deepEqual(
      [...mounted.container.querySelectorAll(".layer-control-checkbox")],
      checkboxes,
    );
    assert.deepEqual(
      [...states.values()].map((state) => state.visible),
      ids.map(() => true),
    );
  } finally {
    mounted.restore();
  }
});

for (const bulk of [false, true]) {
  it(`rereads registration failure into a disabled unchecked row after ${bulk ? "Show All" : "an individual toggle"}`, () => {
    let state = layerState({ visible: false });
    const adapter: CustomLayerAdapter = {
      type: "preview",
      getLayerIds: () => ["failed"],
      getLayerState: () => state,
      getName: () => state.name!,
      setVisibility: () => {
        state = layerState({
          visible: false,
          disabled: true,
          disabledReason: "Registration failed",
          zoomDisabled: true,
        });
      },
    };
    const mounted = mount(adapter);
    try {
      const checkbox =
        mounted.container.querySelector<HTMLInputElement>(".layer-control-checkbox")!;
      if (bulk)
        mounted.container.querySelector<HTMLButtonElement>(".layer-control-action-btn")!.click();
      else {
        checkbox.checked = true;
        checkbox.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
      }
      assert.equal(checkbox.checked, false);
      assert.equal(checkbox.disabled, true);
      assert.equal(
        mounted.container.querySelector<HTMLButtonElement>(".layer-control-zoom")!.disabled,
        true,
      );
      const reason = mounted.container.querySelector<HTMLElement>(".layer-control-explanation")!;
      assert.equal(checkbox.getAttribute("aria-describedby"), reason.id);
      assert.equal(reason.textContent, state.disabledReason);
      assert.equal(mounted.container.querySelector(".layer-control-checkbox"), checkbox);
    } finally {
      mounted.restore();
    }
  });
}

it("disables unsupported rows for individual and bulk visibility actions", () => {
  const calls: string[] = [];
  let supportedVisible = false;
  const adapter: CustomLayerAdapter = {
    type: "preview",
    getLayerIds: () => ["unsupported", "supported"],
    getLayerState: (id) =>
      layerState({
        name: id,
        visible: id === "supported" ? supportedVisible : false,
        ...(id === "unsupported" ? { disabled: true, disabledReason: "Unsupported data" } : {}),
      }),
    getName: (id) => id,
    setVisibility: (id, visible) => {
      calls.push(`${id}:${visible}`);
      if (id === "supported") supportedVisible = visible;
    },
    setOpacity: () => {},
  };
  const mounted = mount(adapter);
  try {
    const row = mounted.container.querySelector<HTMLElement>(
      '.layer-control-item[data-layer-id="unsupported"]',
    )!;
    const checkbox = row.querySelector<HTMLInputElement>(".layer-control-checkbox")!;
    assert.equal(checkbox.disabled, true);
    assert.equal(row.querySelector(".layer-control-explanation")?.textContent, "Unsupported data");
    checkbox.checked = true;
    checkbox.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    assert.equal(checkbox.checked, false);
    assert.deepEqual(calls, []);
    const [showAll, hideAll] = mounted.container.querySelectorAll<HTMLButtonElement>(
      ".layer-control-action-btn",
    );
    showAll!.click();
    assert.deepEqual(calls, ["supported:true"]);
    hideAll!.click();
    assert.deepEqual(calls, ["supported:true", "supported:false"]);
  } finally {
    mounted.restore();
  }
});

it("refreshes labels and layer state without replacing the focused row", () => {
  let name = "Before";
  let visible = true;
  const adapter: CustomLayerAdapter = {
    type: "preview",
    getLayerIds: () => ["project"],
    getLayerState: () => layerState({ name, visible }),
    getName: () => name,
    setVisibility: (_id, value) => {
      visible = value;
    },
    setOpacity: () => {},
  };
  const mounted = mount(adapter);
  try {
    const checkbox = mounted.container.querySelector<HTMLInputElement>(".layer-control-checkbox")!;
    const panel = mounted.container.querySelector(".layer-control-panel");
    const toggle = mounted.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    const expanded = toggle?.getAttribute("aria-expanded");
    panel!.scrollTop = 17;
    checkbox.focus();
    name = "After";
    visible = false;
    mounted.control.setLabels({ showAll: "Display all" });
    mounted.control.refreshCustomLayers();
    assert.equal(mounted.container.querySelector(".layer-control-panel"), panel);
    assert.equal(toggle?.getAttribute("aria-expanded"), expanded);
    assert.equal(panel!.scrollTop, 17);
    assert.equal(mounted.container.querySelector(".layer-control-checkbox"), checkbox);
    assert.equal(mounted.window.document.activeElement, checkbox);
    assert.equal(
      mounted.container.querySelector(".layer-control-item")?.textContent?.includes("After"),
      true,
    );
    assert.equal(checkbox.checked, false);
    assert.equal(
      mounted.container.querySelector(".layer-control-action-btn")?.textContent,
      "Display all",
    );
  } finally {
    mounted.restore();
  }
});
it("removes the installed control and its event handlers during teardown", () => {
  let stateReads = 0;
  const adapter: CustomLayerAdapter = {
    type: "preview",
    getLayerIds: () => {
      stateReads += 1;
      return ["project"];
    },
    getLayerState: () => {
      stateReads += 1;
      return layerState();
    },
    getName: () => "Project",
    setVisibility: () => {},
    setOpacity: () => {},
  };
  const mounted = mount(adapter, [{ id: "native-basemap", type: "background" }]);
  const row = mounted.container.querySelector(".layer-control-item");
  assert.ok(row);
  mounted.emit("styledata");
  assert.ok(mounted.queuedCallbacks().length > 0);
  mounted.remove();
  assert.equal(mounted.listenerCount(), 0);
  assert.equal(mounted.queuedCallbacks().length, 0);
  const readsAfterRemoval = stateReads;
  mounted.emit("styledata");
  mounted.emit("data");
  mounted.emit("sourcedata");
  mounted.window.document.dispatchEvent(new mounted.window.Event("click", { bubbles: true }));
  mounted.flush();
  assert.equal(stateReads, readsAfterRemoval);
  assert.equal(mounted.container.querySelector(".layer-control-panel"), null);
  assert.equal(mounted.container.querySelector(".layer-control-item"), null);
});
