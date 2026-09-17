import assert from "node:assert/strict";
import { it } from "node:test";
import { openArcgisZarrGrid } from "../packages/map/src/arcgis-zarr";
import { registerZarrStore } from "../packages/map/src/zarr-source";
import { geojsonLayer } from "./helpers/layer-fixtures";

it("renders the selected CF slice with north-up orientation, packing and fill masking", async () => {
  const bytes = new Map<string, Uint8Array>();
  const json = (path: string, value: unknown) =>
    bytes.set(path, new TextEncoder().encode(JSON.stringify(value)));
  function array(
    name: string,
    shape: number[],
    dims: string[],
    values: number[],
    attrs: object = {},
  ) {
    json(`/${name}/.zarray`, {
      zarr_format: 2,
      shape,
      chunks: shape,
      dtype: "<f8",
      fill_value: null,
      order: "C",
      filters: null,
      compressor: null,
    });
    json(`/${name}/.zattrs`, { _ARRAY_DIMENSIONS: dims, ...attrs });
    bytes.set(
      `/${name}/${shape.map(() => 0).join(".")}`,
      new Uint8Array(new Float64Array(values).buffer),
    );
  }
  array("lat", [2], ["lat"], [-45, 45]);
  array("lon", [2], ["lon"], [-90, 90]);
  array("air", [2, 2, 2], ["time", "lat", "lon"], [1, 2, 3, 4, 10, 20, 30, -999], {
    scale_factor: 2,
    add_offset: 10,
    _FillValue: -999,
  });
  const layer = geojsonLayer({
    type: "zarr",
    source: {
      url: "local-zarr://test",
      variable: "air",
      selector: { time: 1 },
      clim: [0, 100],
      colormap: ["#000000", "#ffffff"],
    },
  });
  const dispose = registerZarrStore(layer.id, { get: async (key) => bytes.get(key) });
  const abort = new AbortController();
  try {
    const grid = await openArcgisZarrGrid(layer, abort.signal);
    const rgba = await grid.renderTile(0, 0, 0, abort.signal);
    const pixel = (x: number, y: number) =>
      Array.from(rgba.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
    assert.ok(Math.abs(pixel(64, 64)[0] - 179) <= 1);
    assert.equal(pixel(64, 64)[3], 255);
    assert.ok(Math.abs(pixel(64, 192)[0] - 77) <= 1);
    assert.equal(pixel(192, 64)[3], 0);
    abort.abort();
    await assert.rejects(grid.renderTile(0, 0, 0, abort.signal), { name: "AbortError" });
  } finally {
    dispose();
  }
});
