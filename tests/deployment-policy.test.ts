import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function readFixture(name: string): string {
  return readFileSync(`${FIXTURES}${name}`, "utf8");
}

/** Collects console.warn messages into the returned array; restored after the test. */
function captureWarnings(t: TestContext): string[] {
  const messages: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    messages.push(args.join(" "));
  });
  return messages;
}

const SCHEMA_ID =
  "https://raw.githubusercontent.com/opengeos/GeoLibre/main/schema/deployment.schema.json";

// Small valid documents kept inline; the exhaustive one lives in good/full.json.
const GOOD_DOCUMENTS: Record<string, string> = {
  minimal: readFixture("good/minimal.json"),
  full: readFixture("good/full.json"),
  "empty lists": JSON.stringify({
    version: 1,
    capabilities: [],
    plugins: { allowed: [], sideload: false },
  }),
  "off switches": JSON.stringify({
    version: 1,
    sharing: { shareUrl: "off", embedOrigins: ["*"] },
    geolens: { url: "off" },
    services: { builtins: false },
    branding: { welcome: false },
  }),
  "with $schema": JSON.stringify({ $schema: SCHEMA_ID, version: 1, capabilities: ["data:add"] }),
};

test("good documents validate and round-trip silently", (t) => {
  const warnings = captureWarnings(t);
  for (const [name, text] of Object.entries(GOOD_DOCUMENTS)) {
    const json = JSON.parse(text);
    assert.equal(validate(json), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const { $schema: _ignored, ...expected } = json;
    assert.deepEqual(parseDeploymentPolicy(text), expected, name);
  }
  assert.equal(warnings.length, 0);
});

interface BadCase {
  input: unknown;
  /** Whether JSON Schema alone rejects it; "accept" marks rules only the parser enforces. */
  schema: "reject" | "accept";
  parser: "null" | { dropped: string[] };
}

test("bad cases match expected schema and parser results", (t) => {
  const cases = JSON.parse(readFixture("bad-cases.json")) as Record<string, BadCase>;
  const warnings = captureWarnings(t);
  for (const [name, expected] of Object.entries(cases)) {
    // 9007199254740993 cannot survive JSON.stringify, so the case holds a placeholder.
    const text = JSON.stringify(expected.input).replace('"__UNSAFE__"', "9007199254740993");
    const json = JSON.parse(text);
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
    const unknownKeyWarning = name === "unknown-top-level-key" ? 1 : 0;
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
