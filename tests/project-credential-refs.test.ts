import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  changedPreferenceCredentials,
  createEmptyProject,
  overlayStoredPreferenceCredentials,
  redactProjectCredentials,
  setProjectCredentialLookup,
  splitProjectCredentials,
  withStoredRequestHeaders,
  type ProjectPreferences,
} from "@geolibre/core";

function projectWithCredentials() {
  const project = createEmptyProject("Keychain fixture");
  project.preferences.geocoding.apiKeys = { mapbox: "gk" };
  project.preferences.environmentVariables = [
    { key: "GOOGLE_MAPS_API_KEY", value: "g1", enabled: true },
    { key: "ENDPOINT", value: "https://x", enabled: true, secret: false },
  ];
  project.layers = [
    {
      id: "tiles-1",
      name: "Tiles",
      type: "3d-tiles",
      source: {
        url: "https://t/tileset.json",
        requestHeaders: { Authorization: "Bearer t" },
      },
      visible: true,
      opacity: 1,
      style: {},
      metadata: {},
    },
  ];
  return project;
}

function withStored(values: Record<string, string>) {
  setProjectCredentialLookup((account) => values[account]);
}

after(() => setProjectCredentialLookup(null));

describe("splitProjectCredentials", () => {
  it("moves every project-file credential out so the save prompt has nothing to ask", () => {
    const original = projectWithCredentials();
    const snapshot = structuredClone(original);
    const { project, secrets } = splitProjectCredentials(original);

    assert.deepEqual(secrets, {
      "project.geocoding.apiKey.mapbox": "gk",
      "project.env.GOOGLE_MAPS_API_KEY": "g1",
      "project.layer.tiles-1.requestHeaders": '{"Authorization":"Bearer t"}',
    });
    assert.deepEqual(project.preferences.geocoding.apiKeys, {});
    assert.deepEqual(project.preferences.environmentVariables, [
      { key: "GOOGLE_MAPS_API_KEY", value: "", enabled: true },
      { key: "ENDPOINT", value: "https://x", enabled: true, secret: false },
    ]);
    assert.equal("requestHeaders" in project.layers[0].source, false);
    assert.deepEqual(original, snapshot);
    assert.equal(redactProjectCredentials(project).redactedCount, 0);
  });
});

describe("overlayStoredPreferenceCredentials", () => {
  it("fills only empty values; a value in the project wins", () => {
    withStored({
      "project.geocoding.apiKey.mapbox": "stored-geo",
      "project.env.A": "stored-a",
      "project.env.B": "stored-b",
      "project.env.C": "stored-c",
    });
    const preferences = createEmptyProject("Overlay").preferences;
    preferences.geocoding.apiKeys = {};
    preferences.environmentVariables = [
      { key: "A", value: "", enabled: true },
      { key: "B", value: "from-file", enabled: true },
      { key: "C", value: "", enabled: true, secret: false },
    ];
    const overlaid = overlayStoredPreferenceCredentials(preferences);
    assert.equal(overlaid.geocoding.apiKeys.mapbox, "stored-geo");
    assert.deepEqual(
      overlaid.environmentVariables.map(({ value }) => value),
      ["stored-a", "from-file", ""],
    );
  });
});

describe("changedPreferenceCredentials", () => {
  function prefs(
    apiKeys: Record<string, string>,
    rows: Array<[string, string]>,
  ): ProjectPreferences {
    const preferences = createEmptyProject("Commit").preferences;
    return {
      ...preferences,
      geocoding: { ...preferences.geocoding, apiKeys },
      environmentVariables: rows.map(([key, value]) => ({ key, value, enabled: true })),
    };
  }

  it("returns only edits, keeping untouched overrides out of the keychain", () => {
    // OVERRIDE is plaintext from the opened file; the others were stored.
    const seeded = prefs({ mapbox: "file-geo", maptiler: "stored-mt" }, [
      ["EDITED", "stored"],
      ["OVERRIDE", "file-value"],
      ["CLEARED", "stored-cleared"],
    ]);
    const next = prefs({ mapbox: "file-geo", maptiler: "new-mt" }, [
      ["EDITED", "changed"],
      ["OVERRIDE", "file-value"],
      ["CLEARED", ""],
      ["NEW_BLANK", ""],
    ]);

    assert.deepEqual(changedPreferenceCredentials(seeded, next), {
      "project.geocoding.apiKey.maptiler": "new-mt",
      "project.env.EDITED": "changed",
      "project.env.CLEARED": "",
    });
  });
});

describe("withStoredRequestHeaders", () => {
  it("prefers the layer's headers, else parses the stored map", () => {
    withStored({
      "project.layer.stored.requestHeaders": '{"Authorization":"Bearer s"}',
      "project.layer.broken.requestHeaders": "{not json",
    });
    assert.deepEqual(withStoredRequestHeaders("stored", { "X-Key": "own" }), { "X-Key": "own" });
    assert.deepEqual(withStoredRequestHeaders("stored", undefined), {
      Authorization: "Bearer s",
    });
    assert.equal(withStoredRequestHeaders("broken", undefined), undefined);
  });
});

describe("environment variable redaction", () => {
  it("keeps non-secret rows and ignores empty secret rows", () => {
    const project = createEmptyProject("Redaction");
    project.preferences.environmentVariables = [
      { key: "PUBLIC", value: "https://x", enabled: true, secret: false },
      { key: "EMPTY_SECRET", value: "", enabled: true },
    ];
    const result = redactProjectCredentials(project);
    assert.equal(result.redactedCount, 0);
    assert.deepEqual(result.project.preferences.environmentVariables, [
      { key: "PUBLIC", value: "https://x", enabled: true, secret: false },
    ]);
  });
});
