import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

// A minimal but valid external GeoLibre plugin: the entry is a self-contained
// ESM module exporting a GeoLibrePlugin whose id/name/version match the
// manifest. activate/deactivate are no-ops so the plugin registers without
// needing a live map control.
const PLUGIN_ID = "e2e-sample-plugin";
const PLUGIN_NAME = "E2E Sample Plugin";
const PLUGIN_VERSION = "1.0.0";

const MANIFEST = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  entry: "plugin.js",
};

const ENTRY_SOURCE = `const plugin = {
  id: ${JSON.stringify(PLUGIN_ID)},
  name: ${JSON.stringify(PLUGIN_NAME)},
  version: ${JSON.stringify(PLUGIN_VERSION)},
  activate() {},
  deactivate() {},
};
export default plugin;
`;

// Wrap the plugin in a top-level folder (as produced by zipping a plugin
// directory) so this exercises the wrapping-folder path, not just a root
// plugin.json.
function buildPluginZip(): Buffer {
  const archive = zipSync({
    "e2e-sample-plugin/plugin.json": strToU8(JSON.stringify(MANIFEST)),
    "e2e-sample-plugin/plugin.js": strToU8(ENTRY_SOURCE),
  });
  return Buffer.from(archive);
}

/** Open Manage Plugins from the Settings dropdown and switch to its Settings tab. */
async function openManagePluginsSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage Plugins" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Manage Plugins")).toBeVisible();
  await dialog.getByRole("button", { name: "Settings", exact: true }).click();
  return dialog;
}

test("installs a plugin from an uploaded zip, persists it across reload, and uninstalls it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  // The Settings dropdown trigger is part of the toolbar; wait for it before
  // driving the menu.
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

  // 1. Install from file: the web path reads the uploaded bytes, unpacks and
  //    registers the plugin client-side, and persists it in IndexedDB.
  let dialog = await openManagePluginsSettings(page);
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: /Choose \.zip/ }).click(),
  ]);
  await fileChooser.setFiles({
    name: `${PLUGIN_ID}.zip`,
    mimeType: "application/zip",
    buffer: buildPluginZip(),
  });

  // Success notice + the plugin appears in the "installed from file" list.
  await expect(dialog.getByText(`Installed plugin "${PLUGIN_ID}".`)).toBeVisible();
  await expect(dialog.getByText(PLUGIN_NAME)).toBeVisible();
  await expect(dialog.getByRole("button", { name: `Uninstall ${PLUGIN_NAME}` })).toBeVisible();

  // Close the dialog and confirm the plugin registered (it shows in the
  // toolbar's Plugins menu, which lists registered plugins by name).
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("menu").getByText(PLUGIN_NAME)).toBeVisible();
  await page.keyboard.press("Escape");

  // 2. Persistence: reload the app. The startup loader replays the bundle from
  //    IndexedDB, so the plugin is registered again and still listed.
  await page.reload();
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("menu").getByText(PLUGIN_NAME)).toBeVisible();
  await page.keyboard.press("Escape");

  dialog = await openManagePluginsSettings(page);
  await expect(dialog.getByText(PLUGIN_NAME)).toBeVisible();

  // 3. Uninstall: removes it from IndexedDB and unregisters it.
  await dialog.getByRole("button", { name: `Uninstall ${PLUGIN_NAME}` }).click();
  await expect(dialog.getByRole("button", { name: `Uninstall ${PLUGIN_NAME}` })).toHaveCount(0);

  // It no longer appears in the Plugins menu either.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("menu").getByText(PLUGIN_NAME)).toHaveCount(0);
});

test("external plugins reproject coordinates with the host's shared proj4", async ({ page }) => {
  const manifest = {
    id: "e2e-proj4-plugin",
    name: "E2E Proj4 Plugin",
    version: "1.0.0",
    entry: "plugin.js",
  };
  const entry = `export default {
    id: "e2e-proj4-plugin",
    name: "E2E Proj4 Plugin",
    version: "1.0.0",
    async activate(app) {
      const module = await app.getProj4();
      const proj4 = module.default;
      proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
      const wgs84 = proj4("EPSG:32632", "EPSG:4326", [500000, 0]);
      const projected = proj4("EPSG:4326", "EPSG:32632", wgs84);
      const output = document.createElement("output");
      output.id = "e2e-proj4-result";
      output.textContent = JSON.stringify({ wgs84, projected });
      document.body.append(output);
    },
    deactivate() {
      document.getElementById("e2e-proj4-result")?.remove();
    },
  };`;
  const archive = Buffer.from(
    zipSync({
      "e2e-proj4-plugin/plugin.json": strToU8(JSON.stringify(manifest)),
      "e2e-proj4-plugin/plugin.js": strToU8(entry),
    }),
  );

  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  const dialog = await openManagePluginsSettings(page);
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: /Choose \.zip/ }).click(),
  ]);
  await fileChooser.setFiles({
    name: `${manifest.id}.zip`,
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(dialog.getByText(`Installed plugin "${manifest.id}".`)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menu").getByText(manifest.name, { exact: true }).click();

  const output = page.locator("#e2e-proj4-result");
  await expect(output).toBeAttached();
  const result = JSON.parse((await output.textContent())!);
  expect(Math.abs(result.wgs84[0] - 9)).toBeLessThan(1e-8);
  expect(Math.abs(result.wgs84[1])).toBeLessThan(1e-8);
  expect(Math.abs(result.projected[0] - 500000)).toBeLessThan(1e-4);
  expect(Math.abs(result.projected[1])).toBeLessThan(1e-4);
});
