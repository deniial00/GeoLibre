import { existsSync, readdirSync, readFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

// Scoped installs may contain any subset of the patched dependencies.
const patchDirectory = "patches";
const requiredControlPatch = "maplibre-gl-layer-control+0.18.2.patch";
const controlManifest = "node_modules/maplibre-gl-layer-control/package.json";
if (existsSync(controlManifest) && !existsSync(join(patchDirectory, requiredControlPatch))) {
  throw new Error(`Installed layer control requires patches/${requiredControlPatch}`);
}

const selected = [];
for (const filename of existsSync(patchDirectory) ? readdirSync(patchDirectory) : []) {
  if (!filename.endsWith(".patch")) continue;
  const parts = filename.slice(0, -6).split("+");
  const version = parts.pop();
  const packageName = parts.join("/");
  const manifestPath = join("node_modules", packageName, "package.json");
  if (!existsSync(manifestPath)) continue;
  const installed = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  if (installed !== version) {
    throw new Error(`${packageName}: patch requires ${version}, installed ${installed}`);
  }
  selected.push(filename);
}

if (selected.length === 0) process.exit(0);
const temporary = mkdtempSync(join(tmpdir(), "geolibre-dependency-patches-"));
let status = 1;
try {
  for (const filename of selected) {
    copyFileSync(join(patchDirectory, filename), join(temporary, filename));
  }
  const result = spawnSync(
    "patch-package",
    ["--error-on-fail", "--patch-dir", relative(process.cwd(), temporary)],
    {
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.exit(status);
