import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import { DEPLOYMENT_CAPABILITIES } from "@geolibre/core";
import { SERVICE_KINDS } from "../apps/geolibre-desktop/src/components/layout/add-data/service-library";
import { EXPERIENCE_LEVELS } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  parseDeploymentPolicy,
  resolveDeploymentPolicy,
} from "../apps/geolibre-desktop/src/lib/deployment-policy";

const FIXTURES = fileURLToPath(new URL("./fixtures/deployment-policy/", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schema/deployment.schema.json", import.meta.url));

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const validate = new Ajv2020.default({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
}).compile(schema);

const SECTIONS = [
  "capabilities",
  "interface",
  "plugins",
  "services",
  "sharing",
  "geolens",
  "ai",
  "branding",
];

function fixtureNames(kind: "good" | "bad"): string[] {
  return readdirSync(`${FIXTURES}${kind}`)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort();
}

function readFixture(kind: "good" | "bad", name: string): string {
  return readFileSync(`${FIXTURES}${kind}/${name}`, "utf8");
}

/** Collects console.warn messages into the returned array; restored after the test. */
function captureWarnings(t: TestContext): string[] {
  const messages: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    messages.push(args.join(" "));
  });
  return messages;
}

test("good fixtures validate and round-trip silently", (t) => {
  const warnings = captureWarnings(t);
  for (const name of fixtureNames("good")) {
    const text = readFixture("good", name);
    const json = JSON.parse(text);
    assert.equal(validate(json), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const { $schema: _ignored, ...expected } = json;
    assert.deepEqual(parseDeploymentPolicy(text), expected, name);
  }
  assert.equal(warnings.length, 0);
});

test("bad fixtures match the manifest for schema and parser", (t) => {
  const manifest = JSON.parse(readFixture("bad", "manifest.json")) as Record<
    string,
    { schema: "reject" | "accept"; parser: "null" | { dropped: string[] } }
  >;
  const names = fixtureNames("bad");
  assert.deepEqual(Object.keys(manifest).sort(), names);

  const warnings = captureWarnings(t);
  for (const name of names) {
    const text = readFixture("bad", name);
    const json = JSON.parse(text);
    const expected = manifest[name];
    assert.equal(validate(json), expected.schema === "accept", `${name}: schema`);

    warnings.length = 0;
    const result = parseDeploymentPolicy(text);
    if (expected.parser === "null") {
      assert.equal(result, null, name);
      continue;
    }
    const kept = SECTIONS.filter(
      (s) => json[s] !== undefined && !expected.parser.dropped.includes(s),
    );
    assert.deepEqual(
      Object.keys(result ?? {})
        .filter((k) => k !== "version")
        .sort(),
      kept.sort(),
      name,
    );
    const unknownKeyWarning = name === "unknown-top-level-key.json" ? 1 : 0;
    assert.equal(warnings.length, expected.parser.dropped.length + unknownKeyWarning, name);
  }
});

test("unsupported versions return null with one warning", (t) => {
  const warnings = captureWarnings(t);
  for (const text of ['{"version":2}', "{}", '{"version":"1"}']) {
    warnings.length = 0;
    assert.equal(parseDeploymentPolicy(text), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unsupported version/);
  }
});

test("non-objects and non-JSON return null silently", (t) => {
  const warnings = captureWarnings(t);
  assert.equal(parseDeploymentPolicy("[]"), null);
  assert.equal(parseDeploymentPolicy("<!doctype html>"), null);
  assert.equal(parseDeploymentPolicy(""), null);
  assert.equal(parseDeploymentPolicy(null), null);
  assert.equal(warnings.length, 0);
});

test("an invalid section does not affect the others", (t) => {
  captureWarnings(t);
  const policy = resolveDeploymentPolicy({
    version: 1,
    capabilities: ["data:add"],
    plugins: { sideload: "no" },
  });
  assert.deepEqual(policy, { version: 1, capabilities: ["data:add"] });
});

test("omitted differs from empty", () => {
  assert.equal(resolveDeploymentPolicy({ version: 1 })?.capabilities, undefined);
  assert.deepEqual(resolveDeploymentPolicy({ version: 1, capabilities: [] })?.capabilities, []);
  assert.equal(resolveDeploymentPolicy({ version: 1, plugins: {} })?.plugins?.allowed, undefined);
  assert.deepEqual(
    resolveDeploymentPolicy({ version: 1, plugins: { allowed: [] } })?.plugins?.allowed,
    [],
  );
});

test("id lists are trimmed", () => {
  const policy = resolveDeploymentPolicy({ version: 1, plugins: { blocked: [" a "] } });
  assert.deepEqual(policy?.plugins?.blocked, ["a"]);
});

test("schema enums stay in sync with code", () => {
  assert.equal(
    schema.$id,
    "https://raw.githubusercontent.com/opengeos/GeoLibre/main/schema/deployment.schema.json",
  );
  assert.deepEqual(schema.properties.capabilities.items.enum, [...DEPLOYMENT_CAPABILITIES]);
  assert.deepEqual(schema.properties.interface.properties.level.enum, [...EXPERIENCE_LEVELS]);
  assert.deepEqual(schema.properties.services.properties.catalog.items.properties.kind.enum, [
    ...SERVICE_KINDS,
  ]);
});
