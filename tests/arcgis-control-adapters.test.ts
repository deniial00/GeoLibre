import assert from "node:assert/strict";
import { it } from "node:test";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { bridgeArcgisDeckControl } from "../packages/plugins/src/plugins/arcgis-deck/control-adapter";
import type { ArcgisDeckOverlay } from "../packages/plugins/src/plugins/arcgis-deck/overlay";

for (const Overlay of [MapboxOverlay, MapLibreOverlay]) {
  it(`bridges ${Overlay.name} initial props, updates, picking and disposal`, async () => {
    const control = new Overlay({ layers: [], pickingRadius: 7 });
    const original = control.setProps;
    const updates: object[] = [];
    let finalized = 0;
    const native = {
      setProps: (props: object) => updates.push(props),
      mount: async () => {},
      getDeck: () => ({ pickObject: () => ({ picked: true }), getCanvas: () => null }),
      finalize: () => {
        finalized++;
      },
    } as unknown as ArcgisDeckOverlay;
    const dispose = bridgeArcgisDeckControl(control, native);
    assert.equal((updates[0] as { pickingRadius: number }).pickingRadius, 7);
    control.setProps({ pickingRadius: 3 });
    assert.deepEqual(updates[1], { pickingRadius: 3 });
    assert.equal(control.pickObject({ x: 1, y: 2 })?.picked, true);
    control.finalize();
    dispose();
    assert.equal(finalized, 1);
    assert.equal(control.setProps, original);
  });
}
