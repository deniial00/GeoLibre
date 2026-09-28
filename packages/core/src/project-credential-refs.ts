/**
 * Credentials a project refers to by name rather than carrying inline.
 *
 * On the desktop app the geocoding API keys, secret environment variables,
 * and 3D Tiles request headers of a project live in the OS keychain, keyed
 * device-wide by provider id / variable name / layer id. The project file
 * keeps the names with empty values. This module is the pure half of that
 * scheme: the account names, the overlay that fills empty values from the
 * stored ones, and the split that moves values out of a project before it is
 * written. The app installs the lookup; without one (web, Jupyter) every
 * function here is the identity, so values stay in the project file.
 *
 * A non-empty value in the project always wins over the stored one: a file
 * that still carries plaintext (older files, the web build) is used as-is for
 * the session.
 */

import { GEOCODING_PROVIDERS } from "./geocoding";
import type {
  GeocodingPreferences,
  GeoLibreProject,
  ProjectPreferences,
  RuntimeEnvironmentVariable,
} from "./types";

// Account names are stable keychain data: renaming one orphans every value a
// user already stored under it.
export function geocodingApiKeyAccount(providerId: string): string {
  return `project.geocoding.apiKey.${providerId}`;
}

export function environmentVariableAccount(key: string): string {
  return `project.env.${key}`;
}

export function layerRequestHeadersAccount(layerId: string): string {
  return `project.layer.${layerId}.requestHeaders`;
}

/** Rows are secret unless explicitly marked `secret: false`. */
export function isSecretEnvironmentVariable(variable: RuntimeEnvironmentVariable): boolean {
  return variable.secret !== false;
}

export type ProjectCredentialLookup = (account: string) => string | undefined;

let projectCredentialLookup: ProjectCredentialLookup | null = null;

/** Install (or clear, with `null`) the source of stored project credentials. */
export function setProjectCredentialLookup(lookup: ProjectCredentialLookup | null): void {
  projectCredentialLookup = lookup;
}

/** The stored value for `account`, or `undefined` when none (or no lookup). */
export function lookupProjectCredential(account: string): string | undefined {
  const value = projectCredentialLookup?.(account);
  return value ? value : undefined;
}

/** Fill empty geocoding API keys from the stored ones. */
export function overlayStoredGeocodingApiKeys(
  geocoding: GeocodingPreferences,
): GeocodingPreferences {
  let apiKeys: Record<string, string> | null = null;
  for (const { id } of GEOCODING_PROVIDERS) {
    if (geocoding.apiKeys[id]?.trim()) continue;
    const stored = lookupProjectCredential(geocodingApiKeyAccount(id));
    if (!stored) continue;
    apiKeys ??= { ...geocoding.apiKeys };
    apiKeys[id] = stored;
  }
  return apiKeys ? { ...geocoding, apiKeys } : geocoding;
}

/** Fill empty secret environment variable values from the stored ones. */
export function overlayStoredEnvironmentVariables(
  variables: RuntimeEnvironmentVariable[],
): RuntimeEnvironmentVariable[] {
  let changed = false;
  const overlaid = variables.map((variable) => {
    if (!isSecretEnvironmentVariable(variable) || variable.value !== "") return variable;
    const key = variable.key.trim();
    const stored = key ? lookupProjectCredential(environmentVariableAccount(key)) : undefined;
    if (!stored) return variable;
    changed = true;
    return { ...variable, value: stored };
  });
  return changed ? overlaid : variables;
}

/** Preferences with every empty stored credential filled in. */
export function overlayStoredPreferenceCredentials(
  preferences: ProjectPreferences,
): ProjectPreferences {
  const geocoding = overlayStoredGeocodingApiKeys(preferences.geocoding);
  const environmentVariables = overlayStoredEnvironmentVariables(preferences.environmentVariables);
  if (
    geocoding === preferences.geocoding &&
    environmentVariables === preferences.environmentVariables
  ) {
    return preferences;
  }
  return { ...preferences, geocoding, environmentVariables };
}

/**
 * The credential changes an edited Settings draft makes, keyed by account
 * (`""` deletes).
 *
 * - `seeded`: the overlaid preferences the dialog opened with.
 * - `next`: the normalized draft being saved.
 *
 * Only values the user changed are returned, so an untouched session override
 * (plaintext from the opened file) stays out of the keychain and opening a
 * file never writes it. Removing, renaming, or un-secreting a variable never
 * deletes its stored value: names are shared by every project on the device.
 */
export function changedPreferenceCredentials(
  seeded: ProjectPreferences,
  next: ProjectPreferences,
): Record<string, string> {
  const changes: Record<string, string> = {};

  const providerIds = new Set([
    ...Object.keys(seeded.geocoding.apiKeys),
    ...Object.keys(next.geocoding.apiKeys),
  ]);
  for (const providerId of providerIds) {
    const seededKey = seeded.geocoding.apiKeys[providerId]?.trim() ?? "";
    const nextKey = next.geocoding.apiKeys[providerId]?.trim() ?? "";
    if (nextKey !== seededKey) changes[geocodingApiKeyAccount(providerId)] = nextKey;
  }

  const seededSecrets = new Map<string, string>();
  for (const variable of seeded.environmentVariables) {
    if (!isSecretEnvironmentVariable(variable) || seededSecrets.has(variable.key)) continue;
    seededSecrets.set(variable.key, variable.value);
  }
  for (const variable of next.environmentVariables) {
    if (!isSecretEnvironmentVariable(variable)) continue;
    const seededValue = seededSecrets.get(variable.key);
    // A new blank row falls back to any value stored under the name; it
    // never deletes it.
    if (seededValue === undefined && variable.value === "") continue;
    if (variable.value !== seededValue) {
      changes[environmentVariableAccount(variable.key)] = variable.value;
    }
  }

  return changes;
}

function stringEntries(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Move every project-file credential out of `project` (a copy; the input is
 * untouched) into `secrets`, keyed by account.
 *
 * `requestHeaders` keys are deleted rather than blanked: credential redaction
 * counts any `requestHeaders` key regardless of value, so a blanked map would
 * still trigger the save prompt.
 */
export function splitProjectCredentials(project: GeoLibreProject): {
  project: GeoLibreProject;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};

  for (const [providerId, apiKey] of Object.entries(project.preferences.geocoding.apiKeys)) {
    const trimmed = apiKey.trim();
    if (trimmed) secrets[geocodingApiKeyAccount(providerId)] = trimmed;
  }
  const environmentVariables = project.preferences.environmentVariables.map((variable) => {
    if (!isSecretEnvironmentVariable(variable) || variable.value === "") return variable;
    const key = variable.key.trim();
    if (key) secrets[environmentVariableAccount(key)] = variable.value;
    return { ...variable, value: "" };
  });

  const layers = project.layers.map((layer) => {
    if (!layer.source || !("requestHeaders" in layer.source)) return layer;
    const { requestHeaders, ...source } = layer.source;
    const headers = stringEntries(requestHeaders);
    if (headers) secrets[layerRequestHeadersAccount(layer.id)] = JSON.stringify(headers);
    return { ...layer, source };
  });

  return {
    project: {
      ...project,
      preferences: {
        ...project.preferences,
        geocoding: { ...project.preferences.geocoding, apiKeys: {} },
        environmentVariables,
      },
      layers,
    },
    secrets,
  };
}

/**
 * The request headers a 3D Tiles layer should send: the layer's own headers
 * when it has any (session override), else the stored ones.
 */
export function withStoredRequestHeaders(
  layerId: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers && Object.keys(headers).length > 0) return headers;
  const stored = lookupProjectCredential(layerRequestHeadersAccount(layerId));
  if (!stored) return headers;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return headers;
    const values = Object.values(parsed);
    if (values.length === 0 || !values.every((value) => typeof value === "string")) {
      return headers;
    }
    return parsed as Record<string, string>;
  } catch {
    return headers;
  }
}
