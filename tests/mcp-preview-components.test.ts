import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { previewComponentOutputs } from "../apps/geolibre-mcp-app/src/components-outputs";

const original = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
afterEach(() => Object.assign(globalThis, original));
function withDocument(): void {
  const window = new Window();
  Object.assign(globalThis, {
    window,
    document: window.document,
    CSS: {
      supports: (_property: string, value: string) =>
        /^#[\da-f]{3,8}$/i.test(value) || value === "transparent",
    } as typeof CSS,
  });
}
function project(settings?: unknown): GeoLibreProject {
  return parseProject(
    JSON.stringify({
      version: "0.2.0",
      name: "Components preview",
      mapView: { center: [0, 0], zoom: 3 },
      layers: [],
      plugins:
        settings === undefined ? undefined : { settings: { "maplibre-gl-components": settings } },
    }),
  );
}

describe("safe saved Components outputs", () => {
  it("does not synthesize editor examples for missing or empty saved entries", () => {
    withDocument();
    for (const settings of [
      undefined,
      {},
      { legend: { visible: true, legends: [] }, colorbar: { visible: true, colorbars: [] } },
    ]) {
      const output = previewComponentOutputs(project(settings));
      assert.deepEqual(output.legends, []);
      assert.deepEqual(output.colorbars, []);
    }
  });

  it("excludes malformed entries before normalization and leaves saved input untouched", () => {
    withDocument();
    const saved = project({
      legend: {
        visible: true,
        legends: [
          null,
          [],
          { title: "bad" },
          { title: "saved", items: [{ label: "ok", color: "#123456" }] },
        ],
      },
      colorbar: {
        visible: true,
        colorbars: [null, { vmin: "bad", vmax: 1, mode: "named", colormap: "viridis" }],
      },
    });
    const before = structuredClone(saved);
    const output = previewComponentOutputs(saved);
    assert.equal(output.legends.length, 1);
    assert.equal(output.colorbars.length, 0);
    assert.deepEqual(saved, before);
  });

  it("keeps literal text, strips hostile colors and icons, and preserves legend order", () => {
    withDocument();
    const output = previewComponentOutputs(
      project({
        legend: {
          visible: true,
          legends: [
            {
              title: "<First>",
              items: [
                {
                  label: "<b>literal</b>",
                  color: "url(https://evil.example/color)",
                  icon: "https://evil.example/icon.svg",
                },
              ],
            },
            { title: "Second", items: [{ label: "Other", color: "#abcdef" }] },
          ],
        },
      }),
    );
    assert.deepEqual(
      output.legends.map(({ options }) => options.title),
      ["<First>", "Second"],
    );
    assert.equal(output.legends[0].options.items?.[0].color, "transparent");
    assert.equal("icon" in output.legends[0].options.items![0], false);
    assert.ok(output.notices.some((notice) => notice.includes("invalid")));
    assert.ok(output.notices.some((notice) => notice.includes("icons are omitted")));
  });

  it("groups colorbars by corner and retains saved stack and item orientations", () => {
    withDocument();
    const output = previewComponentOutputs(
      project({
        colorbar: {
          visible: true,
          stackOrientation: "horizontal",
          colorbars: [
            {
              mode: "named",
              colormap: "viridis",
              customColors: "#000,#fff",
              vmin: 0,
              vmax: 10,
              label: "Named",
              units: "m",
              orientation: "vertical",
              colorbarPosition: "bottom-right",
            },
            {
              mode: "custom",
              colormap: "ignored",
              customColors: "#000000, #ffffff",
              vmin: 1,
              vmax: 20,
              label: "Custom",
              units: "km",
              orientation: "horizontal",
              colorbarPosition: "bottom-right",
            },
          ],
        },
      }),
    );
    assert.equal(output.colorbars.length, 1);
    assert.equal(output.colorbars[0].position, "bottom-right");
    assert.equal(output.colorbars[0].options.stackOrientation, "horizontal");
    assert.deepEqual(
      output.colorbars[0].options.colorbars?.map((bar) => bar.orientation),
      ["vertical", "horizontal"],
    );
    assert.deepEqual(
      output.colorbars[0].options.colorbars?.map(({ vmin, vmax }) => [vmin, vmax]),
      [
        [0, 10],
        [1, 20],
      ],
    );
  });

  it("omits unavailable named ramps and invalid custom colors without fallback", () => {
    withDocument();
    const output = previewComponentOutputs(
      project({
        colorbar: {
          visible: true,
          colorbars: [
            {
              mode: "named",
              colormap: "not-a-real-ramp",
              customColors: "unused",
              vmin: 0,
              vmax: 1,
              label: "Unknown",
              units: "",
              orientation: "horizontal",
              colorbarPosition: "bottom-right",
            },
            {
              mode: "custom",
              colormap: "unused",
              customColors: "url(https://evil.example/x)",
              vmin: 0,
              vmax: 1,
              label: "Invalid",
              units: "",
              orientation: "vertical",
              colorbarPosition: "bottom-right",
            },
          ],
        },
      }),
    );
    assert.deepEqual(output.colorbars, []);
    assert.ok(output.notices.some((notice) => notice.includes("not-a-real-ramp")));
    assert.ok(output.notices.some((notice) => notice.includes("invalid")));
  });
});
