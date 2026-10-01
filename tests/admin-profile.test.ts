import assert from "node:assert/strict";
import { it } from "node:test";
import { loadAdminProfile } from "../apps/geolibre-desktop/src/lib/admin-profile";
import { setDeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-env";

it("a policy interface replaces admin-profile.json without fetching it", async (t) => {
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetched = true;
    throw new Error("admin-profile.json must not be read");
  });
  try {
    setDeploymentPolicy({
      version: 1,
      interface: { level: "beginner", lock: true },
    });
    const patch = await loadAdminProfile([]);
    assert.equal(patch?.level, "beginner");
    assert.equal(patch?.locked, true);
    assert.equal(patch?.onboarded, true);
    assert.equal(fetched, false);
  } finally {
    setDeploymentPolicy(null);
  }
});

it("an empty policy interface still replaces admin-profile.json", async (t) => {
  // A present section is authoritative even when it sets nothing: the policy,
  // not a stale admin-profile.json, decides the profile.
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetched = true;
    throw new Error("admin-profile.json must not be read");
  });
  try {
    setDeploymentPolicy({ version: 1, interface: {} });
    const patch = await loadAdminProfile([]);
    assert.equal(patch?.onboarded, true);
    assert.equal(fetched, false);
  } finally {
    setDeploymentPolicy(null);
  }
});
