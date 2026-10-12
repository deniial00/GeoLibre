import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/client";
import {
  FIXTURE_IMAGE_PNG_BASE64,
  FIXTURE_TILEJSON,
  FIXTURE_TILE_PNG_BASE64,
  FIXTURE_VECTOR_TILE_BASE64,
  createFixture,
  type FixtureName,
} from "./fixtures";
import type { HostToolCall, MCPTestHost } from "./host-contract";

const query = new URLSearchParams(location.search);
const fixtureNames: Record<FixtureName, true> = {
  overlap: true,
  bounds: true,
  legends: true,
  "legend-order": true,
  properties: true,
  "empty-controls": true,
  "registration-failure": true,
};
const fixturePath = /^fixtures\/([^/]+)\.geolibre\.json$/;
const fixtureCandidate = query.get("fixture");
const initialFixture =
  fixtureCandidate && Object.hasOwn(fixtureNames, fixtureCandidate)
    ? (fixtureCandidate as FixtureName)
    : "overlap";
const locale = query.get("locale") ?? "en";
const theme = query.get("theme") === "dark" ? "dark" : "light";
const dimensions = {
  width: numberParam("width", 800),
  height: numberParam("height", 480),
};
const serverTools = query.get("tools") === "0" ? undefined : {};
const initialFailure = query.get("failure") === "style" ? "style" : undefined;

function numberParam(key: string, fallback: number): number {
  const parsed = Number(query.get(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const frame = document.querySelector("#app-container") as HTMLElement;
frame.style.width = `min(100vw, ${dimensions.width}px)`;
frame.style.height = `${dimensions.height}px`;

const iframe = document.createElement("iframe");
iframe.id = "app";
iframe.title = "GeoLibre map preview";
iframe.setAttribute("aria-label", "GeoLibre map preview");
iframe.style.cssText = "display:block;width:100%;height:100%;border:0";
frame.append(iframe);
let hostContext: McpUiHostContext = {
  theme,
  locale,
  containerDimensions: dimensions,
};
const bridge = new AppBridge(
  null,
  { name: "GeoLibre MCP App test host", version: "1.0.0" },
  {
    ...(serverTools ? { serverTools } : {}),
    openLinks: {},
    logging: {},
  },
  { hostContext },
);
const calls: HostToolCall[] = [];
const unexpected: string[] = [];
const closedIds: string[] = [];
const previewIds: string[] = [];
const delayedPreviewIds: string[] = [];
const cspViolations: MCPTestHost["cspViolations"] = [];
const active = new Set<string>();
const grants = new Map<string, { previewId: string; origin: string }>();
let ready = false;
let tornDown = false;
let fixture = initialFixture;
let delayed = false;
let failStyle = initialFailure !== undefined;
let styleFixtureMode = initialFailure !== undefined;
let failResource = false;
let nextGrant = 1;
let frameTransport: PostMessageTransport | undefined;
const heldPreviews: Array<{ resolve: (result: CallToolResult) => void; result: CallToolResult }> =
  [];

function toolResult(previewId: string, selectedFixture: FixtureName): CallToolResult {
  const project = createFixture(selectedFixture);
  if (styleFixtureMode) {
    project.basemapVisible = true;
    project.basemapStyleUrl = "https://styles.example.test/style.json";
  }
  return {
    content: [],
    structuredContent: { project, previewId },
  };
}

function allocatePreview(selectedFixture: FixtureName): {
  previewId: string;
  result: CallToolResult;
} {
  const previewId = `mcp-preview-${crypto.randomUUID()}`;
  previewIds.push(previewId);
  active.add(previewId);
  return { previewId, result: toolResult(previewId, selectedFixture) };
}

function validPreview(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const previewId = (value as Record<string, unknown>).preview_id;
  return typeof previewId === "string" && active.has(previewId) ? previewId : undefined;
}

function response(structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent };
}
function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
function jsonResponse(value: Record<string, unknown>): CallToolResult {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return response({ data: btoa(binary), mimeType: "application/json" });
}

bridge.oncalltool = async (params: CallToolRequest["params"]): Promise<CallToolResult> => {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  calls.push({ name: params.name, args });
  if (params.name === "get_map_preview") {
    const selected = typeof args.path === "string" ? fixturePath.exec(args.path)?.[1] : undefined;
    if (!selected || !Object.hasOwn(fixtureNames, selected))
      return errorResult("Unknown fixture project path");
    const allocated = allocatePreview(selected as FixtureName);
    if (delayed) {
      delayed = false;
      delayedPreviewIds.push(allocated.previewId);
      return await new Promise<CallToolResult>((resolve) =>
        heldPreviews.push({ resolve, result: allocated.result }),
      );
    }
    return allocated.result;
  }
  if (params.name === "close_map_preview") {
    const id = typeof args.preview_id === "string" ? args.preview_id : "";
    if (id && !closedIds.includes(id)) closedIds.push(id);
    active.delete(id);
    for (const [token, grant] of grants) if (grant.previewId === id) grants.delete(token);
    return response({ closed: true });
  }
  if (params.name === "approve_map_origin") {
    const previewId = validPreview(args);
    const origin = typeof args.origin === "string" ? args.origin : "";
    try {
      if (!previewId || new URL(origin).origin !== origin)
        return errorResult("Invalid preview or origin");
    } catch {
      return errorResult("Invalid preview or origin");
    }
    const grant = `mcp-test-grant-${nextGrant++}`;
    grants.set(grant, { previewId, origin });
    return response({ grant, expiresIn: 120 });
  }
  if (params.name === "fetch_map_resource") {
    const previewId = validPreview(args);
    const grant = typeof args.grant === "string" ? grants.get(args.grant) : undefined;
    const rawUrl = typeof args.url === "string" ? args.url : "";
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return errorResult("Invalid URL");
    }
    if (!previewId || !grant || grant.previewId !== previewId || grant.origin !== url.origin) {
      return errorResult("Preview grant is not valid for this exact origin");
    }
    if (failStyle && url.origin === "https://styles.example.test") {
      failStyle = false;
      return errorResult(
        "Failed style request https://styles.example.test/style.json?token=fixture-secret-sentinel",
      );
    }
    if (failResource) {
      failResource = false;
      return errorResult(
        "Resource failed: https://tiles.example.test/tiles.json?token=fixture-secret-sentinel",
      );
    }
    if (url.hostname === "tiles.example.test" && url.pathname === "/tiles.json") {
      return jsonResponse(FIXTURE_TILEJSON);
    }
    if (url.hostname === "tiles.example.test" && url.pathname.endsWith(".pbf")) {
      return response({
        data: FIXTURE_VECTOR_TILE_BASE64,
        mimeType: "application/vnd.mapbox-vector-tile",
      });
    }
    if (url.hostname === "tiles.example.test" && url.pathname.endsWith(".png")) {
      return response({ data: FIXTURE_TILE_PNG_BASE64, mimeType: "image/png" });
    }
    if (url.hostname === "images.example.test" && url.pathname.endsWith(".png")) {
      return response({ data: FIXTURE_IMAGE_PNG_BASE64, mimeType: "image/png" });
    }
    if (url.hostname === "styles.example.test" && url.pathname === "/style.json") {
      return jsonResponse({
        version: 8,
        sources: {},
        layers: [],
        glyphs: "https://styles.example.test/fonts/{fontstack}/{range}.pbf",
      });
    }
    return errorResult(`No deterministic fixture for ${url.origin}${url.pathname}`);
  }
  unexpected.push(`unhandled tool ${params.name}`);
  return errorResult(`Unexpected tool call ${params.name}`);
};

bridge.onupdatemodelcontext = async (params) => {
  unexpected.push(`model context update ${JSON.stringify(params)}`);
  return {};
};
bridge.onmessage = async (params) => {
  unexpected.push(`unexpected host message ${JSON.stringify(params)}`);
  return {};
};
bridge.onopenlink = async (params) => {
  unexpected.push(`open-link ${params.url}`);
  return { isError: true };
};
bridge.ondownloadfile = async (params) => {
  unexpected.push(`download-file ${JSON.stringify(params)}`);
  return { isError: true };
};
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || data.type !== "mcp-test-csp") return;
  if (event.source !== window && event.source !== iframe.contentWindow) return;
  cspViolations.push({
    blockedURI: typeof data.blockedURI === "string" ? data.blockedURI : "unknown",
    directive: typeof data.directive === "string" ? data.directive : "unknown",
  });
});

bridge.oninitialized = async () => {
  ready = true;
  await bridge.sendToolInput({ arguments: { path: `fixtures/${fixture}.geolibre.json` } });
  await bridge.sendToolResult(response({ path: `fixtures/${fixture}.geolibre.json` }));
};
bridge.onrequestteardown = () => {
  // Keep the frame and transport mounted so explicit late-preview cleanup remains observable.
};

const host: MCPTestHost = {
  get ready() {
    return ready;
  },
  calls,
  unexpected,
  closedIds,
  previewIds,
  delayedPreviewIds,
  cspViolations,
  async show(selectedFixture) {
    fixture = selectedFixture;
    if (!ready || tornDown) return;
    await bridge.sendToolResult(response({ path: `fixtures/${selectedFixture}.geolibre.json` }));
  },
  async context(partial) {
    const dimensions = partial.containerDimensions
      ? { ...hostContext.containerDimensions, ...partial.containerDimensions }
      : hostContext.containerDimensions;
    hostContext = {
      ...hostContext,
      ...partial,
      ...(dimensions ? { containerDimensions: dimensions } : {}),
    };
    if (partial.containerDimensions && dimensions) {
      const size = dimensions as Record<string, unknown>;
      const width =
        typeof size.width === "number" && typeof size.maxWidth === "number"
          ? Math.min(size.width, size.maxWidth)
          : (size.width ?? size.maxWidth);
      const height =
        typeof size.height === "number" && typeof size.maxHeight === "number"
          ? Math.min(size.height, size.maxHeight)
          : (size.height ?? size.maxHeight);
      frame.style.width = typeof width === "number" ? `min(100vw, ${width}px)` : "100vw";
      frame.style.height = typeof height === "number" ? `${height}px` : "480px";
    }
    bridge.setHostContext(hostContext);
  },
  failNext(kind) {
    if (kind === "style") {
      styleFixtureMode = true;
      failStyle = true;
    } else failResource = true;
  },
  delayNextPreview() {
    delayed = true;
  },
  releasePreviews() {
    for (const pending of heldPreviews.splice(0)) pending.resolve(pending.result);
  },
  async teardown() {
    if (tornDown) return;
    tornDown = true;
    try {
      await bridge.teardownResource({}, { timeout: 10_000 });
    } finally {
      this.releasePreviews();
    }
  },
};
window.mcpTestHost = host;

void (async () => {
  frameTransport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
  await bridge.connect(frameTransport);
  iframe.src = `/show-map.html${location.search}`;
})();
