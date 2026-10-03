import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePlugin, type PluginSource } from "../apps/geolibre-desktop/src/lib/plugin-policy";
import type { DeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-policy";

const sources: PluginSource[] = [
  "registry",
  "manifest-url",
  "zip",
  "directory",
  "project-file",
  "bundled",
];
for (const source of sources) {
  test(`${source}: policy precedence truth table`, () => {
    const cases: [DeploymentPolicy | null, boolean, RegExp?][] = [
      [null, true],
      [{ version: 1 }, true],
      [{ version: 1, plugins: {} }, true],
      [{ version: 1, plugins: { allowed: ["demo"] } }, true],
      [{ version: 1, plugins: { blocked: ["other"] } }, true],
      [{ version: 1, plugins: { allowed: [] } }, source === "bundled", /not allowed/],
      [{ version: 1, plugins: { blocked: ["demo"], allowed: ["demo"] } }, false, /blocked/],
      [
        { version: 1, plugins: { sideload: false } },
        source === "registry" || source === "bundled",
        /sideloading/,
      ],
      [
        { version: 1, plugins: { sideload: false, blocked: ["demo"], allowed: [] } },
        false,
        source === "registry" || source === "bundled" ? /blocked/ : /sideloading/,
      ],
    ];
    for (const [policy, allowed, reason] of cases) {
      const result = evaluatePlugin("demo", source, policy);
      assert.equal(result.allowed, allowed, JSON.stringify(policy));
      if (!result.allowed && reason) assert.match(result.reason, reason);
    }
  });
}
