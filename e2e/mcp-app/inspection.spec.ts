import { expect, test, type Page } from "../test";
import type { MCPTestHost } from "./host-contract";
import { expectAccessible } from "../a11y";

/**
 * Phase-2 regression suite for the built GeoLibre MCP App resource, driven by the
 * official SDK host fixture in `e2e/mcp-app/host.ts`. Every assertion reads the
 * real resource's public DOM, rendered WebGL pixels, or the immutable
 * `window.mcpTestHost` contract — never application internals or debug globals.
 *
 * The suite is deterministic: it waits on Playwright's auto-retrying locators,
 * `expect.poll`, and `toPass` rather than sleeping. Every test fails if the app
 * attempts an outbound browser request, triggers a CSP violation, or the host
 * records an unexpected tool/context call.
 */

const IFRAME = "iframe#app";
const ORIGIN =
  process.env.MCP_APP_E2E_BASE_URL ?? `http://localhost:${process.env.MCP_APP_E2E_PORT ?? "4186"}`;

const HOST_ORIGIN = new URL(ORIGIN).origin;
const HOST_PATHS: Record<string, true> = { "/": true, "/host.js": true, "/show-map.html": true };

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

type HostState = Pick<
  MCPTestHost,
  | "ready"
  | "calls"
  | "unexpected"
  | "closedIds"
  | "previewIds"
  | "delayedPreviewIds"
  | "cspViolations"
>;

const externalByPage = new WeakMap<Page, string[]>();

async function readHost(page: Page): Promise<HostState> {
  return page.evaluate(() => {
    const host = window.mcpTestHost;
    return {
      ready: host.ready,
      calls: host.calls,
      unexpected: host.unexpected,
      closedIds: host.closedIds,
      previewIds: host.previewIds,
      delayedPreviewIds: host.delayedPreviewIds,
      cspViolations: host.cspViolations,
    };
  });
}

async function openApp(page: Page, query: string): Promise<void> {
  await page.goto(`${ORIGIN}/?${query}`);
  await expect
    .poll(() => page.evaluate(() => window.mcpTestHost.ready), {
      timeout: 30_000,
      message: "the SDK host fixture reports ready",
    })
    .toBe(true);
}
async function openLayerControl(page: Page): Promise<void> {
  const button = page.frameLocator(IFRAME).getByRole("button", { name: "Layer control" });
  if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
}

async function waitForReady(page: Page, previewCount = 1, openControl = true): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.mcpTestHost.previewIds.length), {
      timeout: 30_000,
      message: `the host allocated at least ${previewCount} preview id(s)`,
    })
    .toBeGreaterThanOrEqual(previewCount);
  await expect(page.frameLocator(IFRAME).locator("#identify")).toBeEnabled({ timeout: 30_000 });
  await expect(page.frameLocator(IFRAME).locator("#map")).toHaveAttribute("aria-busy", "false", {
    timeout: 30_000,
  });
  if (openControl) await openLayerControl(page);
}

async function clickIdentifyTarget(page: Page): Promise<void> {
  const f = page.frameLocator(IFRAME);
  const button = f.locator("#identify");
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  const canvas = f.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
}

async function identifyUntil(page: Page, text: string, timeout = 20_000): Promise<void> {
  const f = page.frameLocator(IFRAME);
  // A map click cancels a camera animation; wait for the target to paint first.
  await expectCenterPixel(
    page,
    (pixel) => Math.min(pixel.r, pixel.g, pixel.b) < 200,
    "the identify target is painted before clicking the canvas",
  );
  await expect(async () => {
    await clickIdentifyTarget(page);
    await expect(f.locator(".maplibregl-popup")).toContainText(text, { timeout: 1_500 });
  }).toPass({ timeout });
}

async function identifyEmpty(page: Page, timeout = 20_000): Promise<void> {
  const f = page.frameLocator(IFRAME);
  await expect(async () => {
    await clickIdentifyTarget(page);
    await expect(f.locator("#status")).toHaveText("No feature found at the clicked location.", {
      timeout: 1_500,
    });
  }).toPass({ timeout });
}

async function readMapPixels(
  page: Page,
  points: Array<{ x: number; y: number }>,
): Promise<Pixel[]> {
  const frame = page.frameLocator(IFRAME);
  const toggle = frame.getByRole("button", { name: "Layer control" });
  const expanded = (await toggle.getAttribute("aria-expanded")) === "true";
  if (expanded) await toggle.click();
  let buffer: Buffer;
  try {
    // Measure rendered geometry, not the newly overlaid layer panel.
    await expect(frame.locator(".layer-control-panel")).not.toBeVisible();
    buffer = await frame.locator("#map").screenshot();
  } finally {
    if (expanded) await openLayerControl(page);
  }
  const b64 = buffer.toString("base64");
  return page.evaluate(
    async ({ data, samples }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("map screenshot failed to decode"));
        image.src = `data:image/png;base64,${data}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(image, 0, 0);
      return samples.map((sample) => {
        const data2 = context.getImageData(
          Math.min(image.width - 1, Math.max(0, Math.round(sample.x * image.width))),
          Math.min(image.height - 1, Math.max(0, Math.round(sample.y * image.height))),
          1,
          1,
        ).data;
        return { r: data2[0], g: data2[1], b: data2[2], a: data2[3] };
      });
    },
    { data: b64, samples: points },
  );
}

async function expectCenterPixel(
  page: Page,
  predicate: (pixel: Pixel) => boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const [pixel] = await readMapPixels(page, [{ x: 0.5, y: 0.5 }]);
        return predicate(pixel);
      },
      { timeout: 20_000, message },
    )
    .toBe(true);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page
    .frameLocator(IFRAME)
    .locator("html")
    .evaluate(() => {
      const element = document.scrollingElement ?? document.documentElement;
      return element.scrollWidth - document.documentElement.clientWidth;
    });
  expect(overflow, "the preview must not scroll horizontally").toBeLessThanOrEqual(1);
}

function isAllowedUrl(url: string): boolean {
  if (/^(blob:|data:|about:|geolibre-preview:)/.test(url)) return true;
  try {
    const address = new URL(url);
    return address.origin === HOST_ORIGIN && Object.hasOwn(HOST_PATHS, address.pathname);
  } catch {
    return false;
  }
}

test.describe("MCP App real-resource inspection", () => {
  test.beforeEach(async ({ page }) => {
    const external: string[] = [];
    externalByPage.set(page, external);
    page.on("request", (request) => {
      const url = request.url();
      if (!isAllowedUrl(url)) external.push(url);
    });
    page.on("requestfailed", (request) => {
      const url = request.url();
      const entry = `failed:${url}`;
      if (!isAllowedUrl(url) && !external.includes(entry)) external.push(entry);
    });
    // The app and every frame report CSP blocks to the host through a plain
    // test message; no app global or SDK replacement is involved.
    await page.addInitScript(() => {
      window.addEventListener("securitypolicyviolation", (event) => {
        const message = {
          type: "mcp-test-csp",
          blockedURI: event.blockedURI,
          directive: event.violatedDirective,
        };
        if (window.parent !== window) window.parent.postMessage(message, "*");
        else window.postMessage(message, "*");
      });
    });
  });

  test.afterEach(async ({ page }, testInfo) => {
    let state: HostState | null = null;
    try {
      state = await readHost(page);
    } catch {
      // The page may already be gone; the request log below still applies.
    }
    if (state) {
      await testInfo.attach("host-csp-violations", {
        body: JSON.stringify(state.cspViolations, null, 2),
        contentType: "application/json",
      });
      expect(state.unexpected, "host recorded unexpected tool/context calls").toEqual([]);
      expect(state.cspViolations, "the app triggered a CSP violation").toEqual([]);
    }
    const external = externalByPage.get(page) ?? [];
    expect(external, `the app attempted outbound browser requests: ${external.join(", ")}`).toEqual(
      [],
    );
  });

  test("case 1: hidden-group override, stacking, and topmost identify (overlap)", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page, 1, false);
    await expect(page.locator(IFRAME)).toHaveAttribute("title", "GeoLibre map preview");
    const layerToggle = page.frameLocator(IFRAME).getByRole("button", { name: "Layer control" });
    await expect(layerToggle).toHaveAttribute("aria-expanded", "false");
    const unopenedState = await readHost(page);
    expect(unopenedState.calls.map((call) => call.name)).not.toContain("approve_map_origin");
    expect(unopenedState.calls.map((call) => call.name)).not.toContain("fetch_map_resource");
    await openLayerControl(page);

    const f = page.frameLocator(IFRAME);
    const rows = f.locator(".layer-control-item[data-layer-id]");
    await expect(rows).toHaveCount(3);
    const ids = await rows.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.layerId),
    );
    expect(ids).toEqual(expect.arrayContaining(["region", "region-fill", "remote"]));
    // Rows are topmost-first: the upper layer sits above the hidden lower one.
    expect(ids.indexOf("region-fill")).toBeLessThan(ids.indexOf("region"));

    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox'),
    ).toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox'),
    ).not.toBeChecked();

    const state = await readHost(page);
    expect(state.ready).toBe(true);
    expect(state.calls.map((call) => call.name)).toContain("get_map_preview");

    // Saved state: the opaque upper blue layer owns the center pixel.
    await expectCenterPixel(
      page,
      (pixel) => pixel.b > 150 && pixel.b > pixel.r + 40 && pixel.b > pixel.g + 40,
      "the upper blue layer renders on top before any override",
    );
    await testInfo.attach("overlap-upper-blue", {
      body: await page.frameLocator(IFRAME).locator("#map").screenshot(),
      contentType: "image/png",
    });

    await identifyUntil(page, "Upper feature");
    await expect(f.locator(".maplibregl-popup")).not.toContainText("Lower feature");
    await testInfo.attach("overlap-identify-upper", {
      body: await page.frameLocator(IFRAME).locator("#map").screenshot(),
      contentType: "image/png",
    });
    await f.locator(".maplibregl-popup-close-button").click();
    await expect(f.locator(".maplibregl-popup")).toHaveCount(0);
    // Capture the blank baseline with both polygons hidden, then restore the
    // upper layer before enabling the lower one.
    await openLayerControl(page);
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox')
      .uncheck();
    await expectCenterPixel(
      page,
      (pixel) => pixel.r > 240 && pixel.g > 240 && pixel.b > 240,
      "the map center is blank after hiding both polygons",
    );
    const [blankPixel] = await readMapPixels(page, [{ x: 0.5, y: 0.5 }]);
    await testInfo.attach("overlap-blank-baseline", {
      body: await page.frameLocator(IFRAME).locator("#map").screenshot(),
      contentType: "image/png",
    });
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox')
      .check();

    await expectCenterPixel(
      page,
      (pixel) => pixel.b > 150 && pixel.b > pixel.r + 40 && pixel.b > pixel.g + 40,
      "the upper blue layer is restored before the lower group member is enabled",
    );

    // Enabling the hidden group member keeps it below the upper layer.
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox')
      .check();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).toBeChecked();
    await expectCenterPixel(
      page,
      (pixel) => pixel.b > 150 && pixel.b > pixel.r + 40,
      "the upper blue layer still covers the center after the lower layer is enabled",
    );

    // Hiding the upper layer reveals the lower one with the saved group opacity
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox')
      .uncheck();
    await expectCenterPixel(
      page,
      (pixel) => pixel.r > 180 && pixel.g > 40 && pixel.g < 200 && pixel.b < 200,
      "the lower red layer is visible after hiding the upper layer",
    );
    // (0.5), i.e. a blend over the blank background rather than pure red.
    const [lowerPixel] = await readMapPixels(page, [{ x: 0.5, y: 0.5 }]);
    expect(lowerPixel.r).toBeGreaterThan(180);
    expect(lowerPixel.r).toBeGreaterThan(lowerPixel.b + 40);
    expect(Math.abs(lowerPixel.g - lowerPixel.b)).toBeLessThan(60);
    // Opaque red at group opacity 0.5 must be the measured 50/50 blend over
    // the actual blank-map baseline, not merely a red-dominant pixel.
    expect(Math.abs(lowerPixel.r - (255 * 0.5 + blankPixel.r * 0.5))).toBeLessThan(8);
    expect(Math.abs(lowerPixel.g - blankPixel.g * 0.5)).toBeLessThan(8);
    expect(Math.abs(lowerPixel.b - blankPixel.b * 0.5)).toBeLessThan(8);
    await testInfo.attach("overlap-lower-red", {
      body: await page.frameLocator(IFRAME).locator("#map").screenshot(),
      contentType: "image/png",
    });

    await identifyUntil(page, "Lower feature");
    await f.locator(".maplibregl-popup-close-button").click();

    // The hidden custom entry never became a standalone legend section.
    await expect(rows).toHaveCount(3);
  });

  test("case 2: bounds, minimum render zoom, unavailable extent, and TileJSON (bounds)", async ({
    page,
  }) => {
    await openApp(page, "fixture=bounds");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(5);

    // Neither the off-center point nor the below-floor polygon is identified.
    await identifyEmpty(page);
    await openLayerControl(page);

    // The polygon honours its saved minimum render zoom when framed.
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="polygon"] .layer-control-zoom'),
    ).toBeEnabled();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="polygon"] .layer-control-zoom')
      .click();
    await identifyUntil(page, "Minimum zoom polygon");
    await f.locator(".maplibregl-popup-close-button").click();
    await openLayerControl(page);
    // Zooming changed no visibility.
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="point"] .layer-control-checkbox'),
    ).toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="polygon"] .layer-control-checkbox'),
    ).toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="image"] .layer-control-checkbox'),
    ).not.toBeChecked();

    // Isolate the point: hide the polygon, then frame the point.
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="polygon"] .layer-control-checkbox')
      .uncheck();
    await identifyEmpty(page);
    await openLayerControl(page);
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="point"] .layer-control-zoom'),
    ).toBeEnabled();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="point"] .layer-control-zoom')
      .click();
    await identifyUntil(page, "Known point");
    await f.locator(".maplibregl-popup-close-button").click();
    await openLayerControl(page);
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="point"] .layer-control-checkbox'),
    ).toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="image"] .layer-control-checkbox'),
    ).not.toBeChecked();

    // A hidden image source with saved coordinates zooms without consent or a
    // visibility change.
    const callsBeforeImage = (await readHost(page)).calls.length;
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="image"] .layer-control-zoom'),
    ).toBeEnabled();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="image"] .layer-control-zoom')
      .click();
    await expect(f.locator("#network-consent")).toBeHidden();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="image"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await expect.poll(async () => (await readHost(page)).calls.length).toBe(callsBeforeImage);

    // A bare tile template with no advertised bounds stays unavailable and
    // fetches nothing for Zoom.
    const unknownZoom = page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="unknown"] .layer-control-zoom');
    await expect(unknownZoom).toBeDisabled();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="unknown"]')
        .locator(".layer-control-explanation"),
    ).toHaveText("Layer extent is unavailable.");
    await expect.poll(async () => (await readHost(page)).calls.length).toBe(callsBeforeImage);
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="unknown"] .layer-control-checkbox'),
    ).not.toBeChecked();

    // The hidden TileJSON source only gets bounds after an approved response.
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="tilejson"] .layer-control-zoom'),
    ).toBeDisabled();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="tilejson"] .layer-control-checkbox')
      .check();
    const consent = f.locator("#network-consent");
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="allow"]').click();
    await expect(consent).toBeHidden();
    await openLayerControl(page);
    await expect
      .poll(async () =>
        (await readHost(page)).calls.some((call) => call.name === "fetch_map_resource"),
      )
      .toBe(true);
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="tilejson"] .layer-control-zoom'),
    ).toBeEnabled({ timeout: 20_000 });
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="tilejson"] .layer-control-checkbox')
      .uncheck();
  });

  test("case 3: saved root legend and Components legends/colorbars (legends)", async ({ page }) => {
    await openApp(page, "fixture=legends");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);

    const root = f.locator("#map .maplibregl-ctrl-top-left .geolibre-legend-panel");
    await expect(root.locator("h2")).toHaveText("Saved root legend");
    const rootEntries = root.locator("[data-cvd-filter] > li");
    await expect(root).toContainText("Standalone section");
    await expect(root).toContainText("Standalone row");
    await expect(root).toContainText("Saved blue class");
    await expect(root).toContainText("Renamed upper");
    await expect(root).not.toContainText("Hidden class");
    await expect(root).not.toContainText("Hidden replacement");
    await expect(root).not.toContainText("Unsupported replacement");
    const collapse = root.locator('button[aria-expanded="true"]');
    await collapse.click();
    await expect(rootEntries).toHaveCount(0);
    await root.locator('button[aria-expanded="false"]').click();
    await expect(rootEntries.first()).toContainText("Standalone section");
    const entryText = await rootEntries.evaluateAll((entries) =>
      entries.map((entry) => entry.textContent ?? ""),
    );
    const standaloneIndex = entryText.findIndex((entry) => entry.includes("Standalone section"));
    const renamedIndex = entryText.findIndex((entry) => entry.includes("Renamed upper"));
    expect(standaloneIndex).toBeGreaterThanOrEqual(0);
    expect(renamedIndex).toBeGreaterThanOrEqual(0);
    expect(standaloneIndex).toBeLessThan(renamedIndex);
    await openLayerControl(page);
    const unsupportedRow = f.locator('.layer-control-item[data-layer-id="unsupported"]');
    const unsupportedCheckbox = unsupportedRow.locator(".layer-control-checkbox");
    await expect(unsupportedCheckbox).toBeDisabled();
    await expect(unsupportedRow.locator(".layer-control-zoom")).toBeDisabled();
    await expect(unsupportedCheckbox).toHaveAttribute(
      "aria-describedby",
      (await unsupportedRow.locator(".layer-control-explanation").getAttribute("id"))!,
    );
    const bulkButtons = f.locator(".layer-control-action-btn");
    await bulkButtons.nth(0).click();
    await expect(unsupportedCheckbox).not.toBeChecked();
    await expect(
      f.locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).toBeChecked();
    await bulkButtons.nth(1).click();
    await expect(unsupportedCheckbox).not.toBeChecked();
    await expect(
      f.locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await f.locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox').check();
    await expect(root).toContainText("Hidden replacement");
    await f
      .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox')
      .uncheck();
    await expect(root).not.toContainText("Hidden replacement");

    const legends = f.locator("#map .maplibregl-ctrl-bottom-left .maplibre-gl-legend");
    await expect(legends.locator(".maplibre-gl-legend-title")).toHaveText([
      "First saved legend",
      "Second saved legend",
    ]);
    const literal = legends.getByText("<b>not markup</b>", { exact: true });
    await expect(literal).toHaveCount(1);
    await expect(literal.locator("b")).toHaveCount(0);
    await expect(legends.locator("img, script")).toHaveCount(0);
    const inlineStyles = await legends
      .locator("[style]")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("style") ?? ""));
    expect(inlineStyles.join(" ")).not.toContain("url(");
    const attributeNames = await legends
      .locator("*")
      .evaluateAll((elements) => elements.flatMap((element) => element.getAttributeNames()));
    expect(attributeNames.some((name) => name.startsWith("on"))).toBe(false);

    const colorbars = f.locator("#map .maplibregl-ctrl-bottom-right .maplibre-gl-colorbar-entry");
    await expect(colorbars).toHaveCount(2);
    const named = colorbars.filter({ hasText: "Named ramp" });
    await expect(named).toContainText("°C");
    const custom = colorbars.filter({ hasText: "Custom ramp" });
    await expect(custom).toHaveCount(1);
    await expect(colorbars.filter({ hasText: "Unknown ramp" })).toHaveCount(0);
    await expect(f.locator("#diagnostics-list")).toContainText(
      "Colormap “not-a-real-ramp” is unavailable in this preview.",
    );
    await expect(f.locator("#inspection")).toHaveCount(0);
    const workspaceWidth = await f
      .locator("#workspace")
      .evaluate((element) => element.getBoundingClientRect().width);
    const mapWidth = await f
      .locator("#map")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(mapWidth).toBe(workspaceWidth);
  });

  test("case 3b: empty layers and saved control arrays synthesize nothing (empty-controls)", async ({
    page,
  }) => {
    await openApp(page, "fixture=empty-controls");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);

    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(0);
    await expect(f.locator(".layer-control-empty")).toHaveText("This project has no layers.");
    await expect(f.locator(".geolibre-legend-panel")).toHaveCount(0);
    await expect(f.locator(".maplibre-gl-legend")).toHaveCount(0);
    await expect(f.locator(".maplibre-gl-colorbar-entry")).toHaveCount(0);
    await expect(f.locator("#map .maplibregl-canvas")).toBeVisible();
  });

  test("case 3c: Components legend order is stable in top and bottom map corners (legend-order)", async ({
    page,
  }) => {
    await openApp(page, "fixture=legend-order");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);

    await expect(f.locator("#map .maplibregl-ctrl-top-left .maplibre-gl-legend-title")).toHaveText([
      "Top first",
      "Top second",
    ]);
    await expect(
      f.locator("#map .maplibregl-ctrl-bottom-left .maplibre-gl-legend-title"),
    ).toHaveText(["Bottom first", "Bottom second"]);
  });

  test("case 4a: lazily requested consent gates the first external request (overlap)", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");
    await expect(consent).toBeHidden();
    await expect(f.locator("#diagnostics-list li")).toHaveCount(0);

    const before = await readHost(page);
    expect(before.calls.map((call) => call.name)).not.toContain("approve_map_origin");
    expect(before.calls.map((call) => call.name)).not.toContain("fetch_map_resource");

    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("tiles.example.test");

    // No approval or fetch happens before Allow.
    await expect.poll(async () => (await readHost(page)).calls.length).toBe(before.calls.length);
    const pending = await readHost(page);
    expect(pending.calls.map((call) => call.name)).not.toContain("approve_map_origin");
    expect(pending.calls.map((call) => call.name)).not.toContain("fetch_map_resource");

    await consent.locator('[data-consent-action="allow"]').click();
    await expect(consent).toBeHidden();
    await expect
      .poll(async () => (await readHost(page)).calls.map((call) => call.name))
      .toContain("approve_map_origin");
    await expect
      .poll(async () => (await readHost(page)).calls.map((call) => call.name))
      .toContain("fetch_map_resource");
    await expectCenterPixel(
      page,
      (pixel) => pixel.r > 230 && pixel.g > 110 && pixel.g < 190 && pixel.b < 40,
      "Allow serves the deterministic orange tile through the host",
    );
    await testInfo.attach("consented-orange-tile", {
      body: await page.frameLocator(IFRAME).locator("#map").screenshot(),
      contentType: "image/png",
    });
  });

  test("case 4b: Block persists and inline geometry stays usable (overlap)", async ({ page }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");

    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="block"]').click();
    await expect(consent).toBeHidden();
    await openLayerControl(page);
    const blocked = await readHost(page);
    expect(blocked.calls.map((call) => call.name)).not.toContain("approve_map_origin");
    const afterBlock = blocked.calls.length;

    // A further enable cannot undo the saved Block decision.
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .uncheck();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeHidden();
    await expect.poll(async () => (await readHost(page)).calls.length).toBe(afterBlock);
    expect((await readHost(page)).calls.map((call) => call.name)).not.toContain(
      "approve_map_origin",
    );

    // Inline geometry is still fully usable.
    await identifyUntil(page, "Upper feature");
    await f.locator(".maplibregl-popup-close-button").click();
  });

  test("case 4b2: Escape blocks and restores the previous focus (overlap)", async ({ page }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");
    const remote = page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox');

    await remote.check();
    await expect(consent).toBeVisible();
    await expect(consent.locator('[data-consent-action="block"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(consent).toBeHidden();
    await expect(remote).toBeFocused();

    const state = await readHost(page);
    expect(state.calls.map((call) => call.name)).not.toContain("approve_map_origin");
    expect(state.calls.map((call) => call.name)).not.toContain("fetch_map_resource");
    await identifyUntil(page, "Upper feature");
    await f.locator(".maplibregl-popup-close-button").click();
  });

  test("case 4c: reload closes the old preview, resets state, and clears diagnostics (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const first = await readHost(page);
    expect(first.previewIds).toHaveLength(1);
    const firstId = first.previewIds[0];

    // Ephemeral state must not survive a reload.
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox')
      .check();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).toBeChecked();
    const consent = f.locator("#network-consent");
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="block"]').click();
    await expect(consent).toBeHidden();
    await expect(f.locator("#diagnostics-list li").first()).toBeVisible();

    await f.locator("#reload").click();
    await expect.poll(async () => (await readHost(page)).previewIds.length).toBe(2);
    const second = await readHost(page);
    expect(second.closedIds).toContain(firstId);
    expect(second.previewIds[1]).not.toBe(firstId);

    await waitForReady(page, 2, false);
    const layerToggle = f.getByRole("button", { name: "Layer control" });
    await expect(layerToggle).toHaveAttribute("aria-expanded", "false");
    await openLayerControl(page);
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(3);
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox'),
    ).toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await expect(f.locator("#diagnostics-list li")).toHaveCount(0);
    await f.locator("#reload").click();
    await expect.poll(async () => (await readHost(page)).previewIds.length).toBe(3);
    const third = await readHost(page);
    expect(third.closedIds).toContain(second.previewIds[1]);
    await waitForReady(page, 3, false);
    await expect(layerToggle).toHaveAttribute("aria-expanded", "false");
    await openLayerControl(page);
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(3);
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox'),
    ).toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="block"]').click();
  });

  test("case 4d: a one-shot failure persists until the explicit reload (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap&failure=style");
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="allow"]').click();
    await waitForReady(page);
    await expect(f.locator("#diagnostics-list li").first()).toBeVisible();
    await expect(f.locator("#status")).toContainText("failure");
    // The blank basemap fallback still renders a usable map.
    await expect(f.locator("#map .maplibregl-canvas")).toBeVisible();
    await expectCenterPixel(
      page,
      (pixel) => pixel.b > 150 && pixel.b > pixel.r + 40,
      "inline geometry renders over the blank fallback style",
    );
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(3);

    await f.locator("#reload").click();
    await expect.poll(async () => (await readHost(page)).previewIds.length).toBe(2);
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="allow"]').click();
    await waitForReady(page, 2);
    await expect(f.locator("#diagnostics-list li")).toHaveCount(0);
    await expect(f.locator("#status")).not.toContainText("failure");
  });

  test("case 4d2: resource failures are redacted and recover on reload (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");
    await page.evaluate(() => window.mcpTestHost.failNext("resource"));

    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    await consent.locator('[data-consent-action="allow"]').click();
    await expect
      .poll(async () => (await readHost(page)).calls.map((call) => call.name))
      .toContain("fetch_map_resource");
    await expect(f.locator("#diagnostics-list li").first()).toBeVisible();
    await expect(f.locator("#diagnostics-list")).not.toContainText("fixture-secret-sentinel");
    await expect(f.locator("#diagnostics-list")).not.toContainText("token=");

    await f.locator("#reload").click();
    await expect.poll(async () => (await readHost(page)).previewIds.length).toBe(2);
    await waitForReady(page, 2);
    await expect(f.locator("#diagnostics-list li")).toHaveCount(0);
  });

  for (const bulk of [false, true]) {
    test(`registration failure disables actual renderer readback after ${bulk ? "Show All" : "individual enable"}`, async ({
      page,
    }) => {
      await openApp(page, "fixture=registration-failure");
      await waitForReady(page);
      const f = page.frameLocator(IFRAME);
      const row = f.locator('.layer-control-item[data-layer-id="malformed"]');
      const checkbox = row.locator(".layer-control-checkbox");
      const node = await checkbox.elementHandle();
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).not.toBeChecked();
      if (bulk) await f.locator(".layer-control-action-btn").first().click();
      else await checkbox.click();
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toBeDisabled();
      await expect(row.locator(".layer-control-zoom")).toBeDisabled();
      await expect(checkbox).toHaveAttribute(
        "aria-describedby",
        (await row.locator(".layer-control-explanation").getAttribute("id"))!,
      );
      expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(f.locator("#diagnostics-list")).toContainText("Malformed GeoJSON");
      const names = (await readHost(page)).calls.map((call) => call.name);
      expect(names).not.toContain("approve_map_origin");
      expect(names).not.toContain("fetch_map_resource");
    });
  }

  test("case 4e: a superseded late preview is closed and never shown (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(3);

    await page.evaluate(() => window.mcpTestHost.delayNextPreview());
    await page.evaluate(() => window.mcpTestHost.show("bounds"));
    await expect.poll(async () => (await readHost(page)).delayedPreviewIds.length).toBe(1);
    await page.evaluate(() => window.mcpTestHost.show("overlap"));
    await waitForReady(page, 3);
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(3);
    await page.evaluate(() => window.mcpTestHost.releasePreviews());

    await expect
      .poll(
        async () => {
          const state = await readHost(page);
          return (
            state.delayedPreviewIds.length === 1 &&
            state.closedIds.includes(state.delayedPreviewIds[0])
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // The superseded preview never replaced the map.
    await expect(f.locator('.layer-control-item[data-layer-id="point"]')).toHaveCount(0);
    await identifyUntil(page, "Upper feature");
  });

  test("case 4e2: a late preview after teardown is closed and shows nothing (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);

    await page.evaluate(() => window.mcpTestHost.delayNextPreview());
    await page.evaluate(() => window.mcpTestHost.show("bounds"));
    await expect.poll(async () => (await readHost(page)).delayedPreviewIds.length).toBe(1);
    await page.evaluate(() => window.mcpTestHost.teardown());
    await page.evaluate(() => window.mcpTestHost.releasePreviews());

    await expect
      .poll(
        async () => {
          const state = await readHost(page);
          return (
            state.delayedPreviewIds.length === 1 &&
            state.closedIds.includes(state.delayedPreviewIds[0])
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(0);
    await expect(f.locator('.layer-control-item[data-layer-id="point"]')).toHaveCount(0);
  });

  test("case 4f: a host without server tools explains itself and calls no data tool (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap&tools=0");
    const f = page.frameLocator(IFRAME);
    await expect(f.locator("#diagnostics-list li")).toHaveCount(1);
    await expect(f.locator("#diagnostics-list li")).toBeVisible();
    await expect(f.locator("#reload")).toBeDisabled();
    await expect(f.locator(".layer-control-item[data-layer-id]")).toHaveCount(0);
    const state = await readHost(page);
    expect(state.calls.map((call) => call.name)).not.toContain("get_map_preview");
    expect(state.calls.map((call) => call.name)).not.toContain("fetch_map_resource");
  });

  test("case 5: formatted, hidden, and non-navigable feature properties (properties)", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=properties");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);

    // Custom marker artwork and SVG patterns are omitted rather than loaded.
    const diagnostics = f.locator("#diagnostics-list");
    await expect(diagnostics).toContainText("custom marker artwork is omitted");
    await expect(diagnostics).toContainText("custom SVG fill patterns are omitted");

    await identifyUntil(page, "Readable properties");
    const popup = f.locator(".maplibregl-popup");
    await expect(popup).toContainText("Saved price");
    await expect(popup).toContainText("$12.5");
    await expect(popup).not.toContainText("never show this");
    await expect(popup.locator(".geolibre-identify-popup-row").first().locator("dt")).toHaveCount(
      1,
    );
    await expect(popup.locator(".geolibre-identify-popup-row").first().locator("dd")).toHaveCount(
      1,
    );
    await expect(popup).toContainText("longText");
    await expect(popup).toContainText("tags");
    await expect(popup).toContainText("details");
    await expect(
      popup.locator(".geolibre-identify-popup-row").filter({ hasText: "nullable" }),
    ).toHaveCount(0);

    // Remote image/link/KML content is inert text: no images, no navigable
    // anchors, no inline event handlers.
    await expect(popup.locator("img")).toHaveCount(0);
    await expect(popup.locator("a[href]")).toHaveCount(0);
    await expect(popup.locator("script")).toHaveCount(0);
    const eventAttributes = await popup
      .locator("*")
      .evaluateAll((elements) =>
        elements
          .flatMap((element) => element.getAttributeNames())
          .filter((name) => name.startsWith("on")),
      );
    expect(eventAttributes).toEqual([]);

    // The shell scrolls inside a bounded height without horizontal overflow.
    const root = popup.locator(".geolibre-identify-popup-root");
    await expect(root).toBeVisible();
    const box = await root.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(370);
    expect(await root.evaluate((element) => getComputedStyle(element).overflowY)).toMatch(
      /auto|scroll/,
    );
    const scroll = await root.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { position: element.scrollTop, maximum: element.scrollHeight - element.clientHeight };
    });
    expect(scroll.maximum).toBeGreaterThan(0);
    expect(scroll.position).toBe(scroll.maximum);
    await expect(root.getByText("KML link", { exact: true })).toBeInViewport();
    expect(
      await popup
        .locator(".maplibregl-popup-content")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    await testInfo.attach("properties-popup", {
      body: await page.frameLocator(IFRAME).locator("#map").screenshot(),
      contentType: "image/png",
    });
    await popup.locator(".maplibregl-popup-close-button").click();
    await expect(popup).toHaveCount(0);
  });

  test("case 6a: 800x480 English layout, keyboard, and axe (legends)", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=legends&width=800&height=480&locale=en&theme=light");
    await waitForReady(page, 1, false);
    const f = page.frameLocator(IFRAME);
    const initiallyCollapsed = f.getByRole("button", { name: "Layer control" });
    await expect(initiallyCollapsed).toHaveAttribute("aria-expanded", "false");
    await openLayerControl(page);
    await expectNoHorizontalOverflow(page);

    await expect(f.locator("#inspection")).toHaveCount(0);
    const mapBox = await f.locator("#map").boundingBox();
    const legendBox = await f.locator("#map .geolibre-legend-panel").boundingBox();
    expect(legendBox).not.toBeNull();
    expect(legendBox!.x).toBeGreaterThanOrEqual(mapBox!.x);
    expect(legendBox!.x + legendBox!.width).toBeLessThanOrEqual(mapBox!.x + mapBox!.width);
    const workspaceWidth = await f
      .locator("#workspace")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(mapBox!.width).toBe(workspaceWidth);

    const layerToggle = f.getByRole("button", { name: "Layer control" });
    await f.locator(".layer-control-checkbox:not(:disabled)").first().press("Escape");
    await expect(layerToggle).toHaveAttribute("aria-expanded", "false");
    await expect(layerToggle).toBeFocused();
    await layerToggle.press("Enter");
    await expect(layerToggle).toHaveAttribute("aria-expanded", "true");
    // Keyboard layer visibility and activation of the click-targeted Identify tool.
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox')
      .press("Space");
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox'),
    ).not.toBeChecked();
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox')
      .press("Space");
    await expect(
      page
        .frameLocator(IFRAME)
        .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox'),
    ).toBeChecked();
    await expectCenterPixel(
      page,
      (pixel) => pixel.b > 150 && pixel.b > pixel.r + 40,
      "the keyboard-enabled upper layer has painted before Identify",
    );
    await f.locator("#identify").press("Enter");
    await expect(f.locator("#identify")).toHaveAttribute("aria-pressed", "true");
    await expect(f.locator(".maplibregl-popup")).toHaveCount(0);
    await expect(f.locator(".maplibregl-canvas")).toHaveCSS("cursor", "crosshair");
    await clickIdentifyTarget(page);
    await expect(f.locator(".maplibregl-popup")).toContainText("Upper feature");
    await page.keyboard.press("Escape");
    await expect(f.locator(".maplibregl-popup")).toHaveCount(0);
    // A click away from the central polygon must not identify the central feature.
    await f.locator(".maplibregl-canvas").click({ position: { x: 600, y: 20 } });
    await expect(f.locator(".maplibregl-popup")).toHaveCount(0);
    await expect(f.locator("#status")).toHaveText("No feature found at the clicked location.");
    await f.locator("#identify").click();
    await expect(f.locator("#identify")).toHaveAttribute("aria-pressed", "false");
    await expect(f.locator(".maplibregl-canvas")).not.toHaveCSS("cursor", "crosshair");
    const canvasBox = await f.locator(".maplibregl-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    await f.locator(".maplibregl-canvas").click({
      position: { x: canvasBox!.width / 2, y: canvasBox!.height / 2 },
    });
    await expect(f.locator(".maplibregl-popup")).toHaveCount(0);
    await openLayerControl(page);

    // Keyboard Zoom and keyboard Reload also work.
    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="region-fill"] .layer-control-zoom')
      .press("Enter");
    const beforeReload = (await readHost(page)).previewIds.length;
    await f.locator("#reload").press("Enter");
    await expect.poll(async () => (await readHost(page)).previewIds.length).toBe(beforeReload + 1);
    await waitForReady(page);

    await testInfo.attach("layout-800-en", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await expectAccessible(page, "mcp-app-legends-800", testInfo);
  });

  test("case 6b: 320x480 layout stays reachable without overflow (legends)", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=legends&width=320&height=480&locale=en");
    await waitForReady(page, 1, false);
    const f = page.frameLocator(IFRAME);
    await expect(f.getByRole("button", { name: "Layer control" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expectNoHorizontalOverflow(page);

    await expect(f.locator("#inspection")).toHaveCount(0);
    const mapBox = await f.locator("#map").boundingBox();
    const legendBox = await f.locator("#map .geolibre-legend-panel").boundingBox();
    expect(legendBox).not.toBeNull();
    expect(legendBox!.x).toBeGreaterThanOrEqual(mapBox!.x);
    expect(legendBox!.y).toBeGreaterThanOrEqual(mapBox!.y);
    expect(legendBox!.x + legendBox!.width).toBeLessThanOrEqual(mapBox!.x + mapBox!.width);
    expect(legendBox!.y + legendBox!.height).toBeLessThanOrEqual(mapBox!.y + mapBox!.height);
    await expectNoHorizontalOverflow(page);
    await testInfo.attach("layout-320-en", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
  test("case 6b2: short narrow maps keep the collapsed control and open panel inside bounds", async ({
    page,
  }) => {
    await openApp(page, "fixture=legends&width=320&height=240&locale=en");
    await waitForReady(page, 1, false);
    const f = page.frameLocator(IFRAME);
    const toggle = f.getByRole("button", { name: "Layer control" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const map = await f.locator("#map").boundingBox();
    expect(map).not.toBeNull();
    await openLayerControl(page);
    const panel = await f.locator(".layer-control-panel").boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(map!.x);
    expect(panel!.y).toBeGreaterThanOrEqual(map!.y);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(map!.x + map!.width + 1);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(map!.y + map!.height + 1);
    await expectNoHorizontalOverflow(page);
  });

  test("case 6c: in-place es/ar locale updates format legend ticks and preserve direction", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=legends&width=800&height=480&locale=en");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    await expect(f.locator("html")).toHaveAttribute("lang", "en");
    await expect(f.locator("html")).toHaveAttribute("dir", "ltr");
    // English fallback copy is retained; the saved title is literal.
    await expect(f.locator("#read-only")).toHaveText("Preview changes are not saved.");
    await expect(f.locator("#map .geolibre-legend-panel h2")).toHaveText("Saved root legend");
    const custom = f.locator(".maplibre-gl-colorbar-entry").filter({ hasText: "Custom ramp" });

    await page.evaluate(() => window.mcpTestHost.context({ locale: "es" }));
    await expect(f.locator("html")).toHaveAttribute("lang", "es");
    const esTick = new Intl.NumberFormat("es", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(1.25);
    await expect(custom.locator(".maplibre-gl-colorbar-tick").first()).toHaveText(`${esTick}m`);

    await page.evaluate(() => window.mcpTestHost.context({ locale: "ar" }));
    await expect(f.locator("html")).toHaveAttribute("lang", "ar");
    await expect(f.locator("html")).toHaveAttribute("dir", "rtl");
    expect(
      await f
        .locator("#map .geolibre-legend-panel")
        .evaluate((element) => getComputedStyle(element).direction),
    ).toBe("rtl");
    expect(
      await f
        .locator(".maplibregl-control-container")
        .evaluate((element) => getComputedStyle(element).direction),
    ).toBe("ltr");
    const arTick = new Intl.NumberFormat("ar", {
      numberingSystem: "arab",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(1.25);
    await expect(custom.locator(".maplibre-gl-colorbar-tick").first()).toHaveText(`${arTick}m`);
    await testInfo.attach("mcp-preview-arabic-legends", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("case 6d: partial context updates preserve theme, consent decisions, focus, and inert (overlap)", async ({
    page,
  }, testInfo) => {
    await openApp(page, "fixture=overlap&theme=dark&locale=en");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");
    await expect(f.locator("html")).toHaveClass(/dark/);
    const regionCheckbox = f.locator(
      '.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox',
    );
    const regionCheckboxNode = await regionCheckbox.elementHandle();
    expect(regionCheckboxNode).not.toBeNull();
    await regionCheckbox.focus();
    await page.evaluate(() => window.mcpTestHost.context({ locale: "es" }));
    await expect(f.locator("html")).toHaveAttribute("lang", "es");
    await expect(regionCheckbox).toBeFocused();
    expect(
      await regionCheckboxNode!.evaluate(
        (node) =>
          node.isConnected &&
          document.querySelector(
            '.layer-control-item[data-layer-id="region-fill"] .layer-control-checkbox',
          ) === node,
      ),
    ).toBe(true);

    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    const background = f.locator("#preview");
    await expect(background).toHaveAttribute("inert", "");
    await expect(consent.locator('[data-consent-action="block"]')).toBeFocused();
    await consent.locator('[data-consent-action="allow"]').focus();

    // A locale-only update keeps the theme, the pending decision, and focus.
    await page.evaluate(() => window.mcpTestHost.context({ locale: "ar" }));
    await expect(f.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(f.locator("html")).toHaveClass(/dark/);
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("tiles.example.test");
    await expect(consent.locator('[data-consent-action="allow"]')).toBeFocused();

    await page.evaluate(() =>
      window.mcpTestHost.context({
        containerDimensions: { width: 320, height: 480 },
      }),
    );
    await expect.poll(async () => (await page.locator(IFRAME).boundingBox())?.width).toBe(320);
    await expectNoHorizontalOverflow(page);
    await expect(consent.locator('[data-consent-action="allow"]')).toBeFocused();
    await f.locator("#identify").evaluate((element) => (element as HTMLElement).focus());
    await expect(consent.locator('[data-consent-action="allow"]')).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(consent.locator('[data-consent-action="block"]')).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(consent.locator('[data-consent-action="allow"]')).toBeFocused();
    await testInfo.attach("consent-modal-ar-dark", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await expectAccessible(page, "mcp-app-consent-320-ar-dark", testInfo);

    await page.keyboard.press("Escape");
    await expect(consent).toBeHidden();
    await expect(background).not.toHaveAttribute("inert", "");
    await expect(
      f.locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox'),
    ).toBeFocused();
    await page.evaluate(() =>
      window.mcpTestHost.context({
        theme: "light",
        containerDimensions: { width: 800, height: 480 },
      }),
    );
    await expect(f.locator("html")).toHaveAttribute("lang", "ar");
    await expect(f.locator("html")).not.toHaveClass(/dark/);

    // Teardown also leaves the background non-inert.
    await page.evaluate(() => window.mcpTestHost.teardown());
    await expect(background).not.toHaveAttribute("inert", "");
  });

  test("case 6e: teardown during open consent restores the background (overlap)", async ({
    page,
  }) => {
    await openApp(page, "fixture=overlap");
    await waitForReady(page);
    const f = page.frameLocator(IFRAME);
    const consent = f.locator("#network-consent");
    const background = f.locator("#preview");

    await page
      .frameLocator(IFRAME)
      .locator('.layer-control-item[data-layer-id="remote"] .layer-control-checkbox')
      .check();
    await expect(consent).toBeVisible();
    await expect(background).toHaveAttribute("inert", "");

    await page.evaluate(() => window.mcpTestHost.teardown());
    await expect(consent).toBeHidden();
    await expect(background).not.toHaveAttribute("inert", "");
  });
});
