import assert from "node:assert/strict";
import { it } from "node:test";
import type { ArcgisEngine } from "../packages/map/src/arcgis-engine";
import { ArcgisDeckOverlay } from "../packages/plugins/src/plugins/arcgis-deck/overlay";

type View = NonNullable<ReturnType<ArcgisEngine["getView"]>>;
function fixture(type = "2d", viewingMode = "local") {
  const added: object[] = [];
  const removed: object[] = [];
  const instances: { destroyed: boolean }[] = [];
  const module = {
    default: {
      createSubclass(definition: object) {
        class Native {
          destroyed = false;
          constructor(props: object) {
            Object.assign(this, props);
            instances.push(this);
          }
          destroy() {
            this.destroyed = true;
          }
        }
        Object.assign(Native.prototype, definition);
        return Native;
      },
    },
  };
  const view = {
    type,
    viewingMode,
    map: {
      add: (layer: object) => added.push(layer),
      remove: (layer: object) => removed.push(layer),
    },
  } as unknown as View;
  return { view, module, added, removed, instances };
}

it("cancels an ArcGIS overlay removed while CDN modules are loading", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const overlay = new ArcgisDeckOverlay(f.view, {}, async () => {
    await wait;
    return f.module;
  });
  const first = overlay.mount();
  assert.equal(overlay.mount(), first, "concurrent producers share the same mount");
  overlay.finalize();
  release();
  await first;
  assert.equal(f.added.length, 0);
});

it("mounts one native 2D layer and can dispose after the old view loses its map", async () => {
  const f = fixture();
  const overlay = new ArcgisDeckOverlay(f.view, {}, async () => f.module);
  await Promise.all([overlay.mount(), overlay.mount()]);
  assert.equal(f.added.length, 1);
  Object.assign(f.view, { map: null });
  overlay.finalize();
  overlay.finalize();
  assert.deepEqual(f.removed, f.added);
  assert.equal(f.instances[0].destroyed, true);
});

it("destroys a local scene RenderNode and does not mount in a global scene", async () => {
  const local = fixture("3d", "local");
  const overlay = new ArcgisDeckOverlay(local.view, {}, async () => local.module);
  await overlay.mount();
  assert.equal(local.added.length, 0, "RenderNode registers with the view, not map.layers");
  assert.equal(local.instances.length, 1);
  overlay.finalize();
  assert.equal(local.instances[0].destroyed, true);
  const global = fixture("3d", "global");
  let imports = 0;
  const globeOverlay = new ArcgisDeckOverlay(global.view, {}, async () => {
    imports++;
    return global.module;
  });
  await globeOverlay.mount();
  assert.equal(imports, 0);
});
