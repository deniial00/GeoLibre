# Deployment Policy

`deployment.json` is a single, versioned file that describes the client-facing
settings of a GeoLibre deployment: which capabilities users have, which
interface elements are visible, which plugins may load, the curated service
library, sharing endpoints, and branding.

## Loading

The web, desktop and Jupyter builds fetch `deployment.json` from the app's base
URL (`<base>/deployment.json`) before the first render, so nothing paints with a
setting the policy then changes. No policy applies when the file is absent
(404 or an HTML fallback page), unreachable, not JSON, of an unknown `version`,
or does not arrive within 3 seconds. In those cases the app behaves exactly as
it does without the file. Reading the file from a container mount or the
desktop config directory arrives in a later release.

What each section does today:

- `capabilities` restricts the app; `[]` grants none, and omitting it leaves
  `VITE_GEOLIBRE_CAPABILITIES` (or the default full grant) in force.
- `interface` replaces `admin-profile.json` whole; fields are not merged. An
  empty `interface` (`{}`) configures nothing and counts as absent, so
  `admin-profile.json` still applies.
- `plugins.registryUrl` sets the plugin registry. `allowed`, `blocked`,
  `sideload` and `defaultActive` are stored but not enforced yet.
- `services`, `sharing`, `geolens` and `branding.appName` override the
  matching `GEOLIBRE_*` deployment settings. `sharing.embedOrigins: []` turns
  the embed API off.
- `branding.welcome: false` suppresses the first-launch wizard.
- `ai.enabled: true` points the assistant at the same-origin `/ai` proxy;
  `false` removes any operator-configured AI proxy (a provider a user enters in
  Settings is unaffected). `ai.model` picks the proxy's model.

Because the wait is bounded, `capabilities` fails open like every other
section: a `deployment.json` that is blocked or arrives late means that session
runs with the env-derived capabilities or the default full grant. See
[Deployment capabilities](deployment-capabilities.md) before using it as a
restriction.

## Example

```json
{
  "version": 1,
  "capabilities": ["project:edit", "data:add", "processing:run", "export:data", "plugins:install", "settings:manage"],
  "interface": {
    "enabled": true,
    "level": "intermediate",
    "lock": true,
    "hiddenDataSources": ["arcgis"],
    "hiddenPlugins": ["plugin-a"],
    "hiddenMenus": ["help"],
    "hiddenMenuItems": ["file.print"]
  },
  "plugins": {
    "registryUrl": "https://plugins.example.com/registry.json",
    "allowed": ["acme-tools"],
    "blocked": ["bad-plugin"],
    "sideload": false,
    "defaultActive": ["acme-tools"]
  },
  "services": {
    "builtins": true,
    "catalog": [
      {
        "id": "city-wms",
        "name": "City WMS",
        "kind": "wms",
        "category": "Municipal",
        "fields": { "url": "https://maps.example.com/wms", "version": "1.3.0", "opacity": 0.8, "transparent": true }
      }
    ]
  },
  "sharing": {
    "shareUrl": "https://projects.example.com",
    "collabUrl": "wss://relay.example.com",
    "embedOrigins": ["https://portal.example.com"]
  },
  "geolens": { "url": "same-origin" },
  "ai": { "enabled": true, "model": "gpt-5-mini" },
  "branding": { "appName": "Acme Maps", "welcome": false }
}
```

Point your editor at the schema for completion and validation by adding
`"$schema": "https://raw.githubusercontent.com/opengeos/GeoLibre/main/schema/deployment.schema.json"`.
GeoLibre ignores `$schema`.

## Field reference

Every section and every field is optional except `version`. An absent section
means "not specified": the next source in the precedence chain applies.

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Policy format version. Documents with any other version are ignored. |

### `capabilities`

An array of the capability names from
[Deployment Capabilities](deployment-capabilities.md): `project:edit`,
`data:add`, `processing:run`, `export:data`, `plugins:install`,
`settings:manage`. Omit it to grant all capabilities; `[]` grants none.

### `interface`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Whether UI profile filtering is active (default true). |
| `level` | `beginner` \| `intermediate` \| `advanced` | Experience-level preset that seeds the hidden lists. |
| `lock` | boolean | Prevent users changing the profile in Settings. |
| `hiddenDataSources`, `hiddenPlugins`, `hiddenMenus`, `hiddenMenuItems` | string[] | Explicit hidden ids, overriding the preset. |

### `plugins`

| Field | Type | Meaning |
| --- | --- | --- |
| `registryUrl` | string | Plugin marketplace registry URL, absolute or relative to the app. |
| `allowed` | string[] | External plugin ids allowed to load. Omit for any; `[]` for none. |
| `blocked` | string[] | External plugin ids never loaded. |
| `sideload` | boolean | Allow installing from a manifest URL, zip, directory or project file (default true). |
| `defaultActive` | string[] | Plugin ids active in a fresh project. |

### `services`

| Field | Type | Meaning |
| --- | --- | --- |
| `builtins` | boolean | `false` hides the built-in starter services. |
| `catalog` | object[] | Curated entries: `id`, `name`, `kind` (`wms`, `wfs`, `wmts`, `xyz`, `arcgis`, `csw`), optional `category`, and non-empty `fields` (string, number or boolean values). |

### `sharing`

| Field | Type | Meaning |
| --- | --- | --- |
| `shareUrl` | string | Projects server URL (`http(s)://…`), or `off` to remove Share and the Gallery. |
| `collabUrl` | string | Live collaboration relay (`ws(s)://…`). |
| `embedOrigins` | string[] | Origins allowed to drive a framed app (`https://host`), or `*` for any. |

### `geolens`

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | string | Default GeoLens server (`http(s)://…`), `same-origin`, or `off`. |

### `ai`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Expose the same-origin AI assistant route (default false). |
| `model` | string | Default assistant model id. |

### `branding`

| Field | Type | Meaning |
| --- | --- | --- |
| `appName` | string | App name in the toolbar and tab title, at most 60 characters. |
| `welcome` | boolean | `false` skips the first-launch welcome wizard. |

## Omitted versus empty

For `capabilities` and `plugins.allowed`, leaving the field out and writing `[]`
mean opposite things. Omitted means "no restriction from this file"; `[]` means
"nothing is granted/allowed".

## Plugin precedence

An id in `blocked` is never loaded, even if it is also in `allowed`; when
`allowed` is present, any id not in it is not loaded.

## Precedence between sources

The order, highest first, is:

1. `deployment.json`
2. runtime environment (`window.__GEOLIBRE_DEPLOYMENT_ENV__`)
3. build-time environment

`admin-profile.json` is still honoured for the interface when `deployment.json`
has no `interface` section.

## Versioning

New fields are additive and keep `version: 1`. A document with any other
version is ignored with a console warning.

## Validation

The client parser is lenient and works section by section:

- A section with any invalid field, or any unknown key inside it, is dropped
  whole with a console warning. The other sections still apply.
- An unknown capability name drops the entire `capabilities` section, so the
  deployment falls back to environment settings or defaults (it does not grant
  nothing). Check the console if a restriction seems missing.
- Unknown top-level keys are ignored with one warning.
- Non-JSON content or a non-object is ignored silently.

A stricter container-side validator is planned. The schema cannot express some
rules that the parser enforces: duplicate service ids after trimming, and
numeric service field values beyond the safe-integer range.

!!! warning "Public file, no secrets"
    `deployment.json` is served to every browser. Never put secrets in it. The
    AI proxy URL and token, the sidecar token, trusted proxies, Basic Auth and
    CSP stay in server environment variables and files.

!!! warning "Client hiding is not enforcement"
    Hiding or removing an interface element does not stop someone with browser
    devtools, and it does not restrict the server. See
    [Deployment Capabilities](deployment-capabilities.md) for what the client
    gate does and does not cover.
