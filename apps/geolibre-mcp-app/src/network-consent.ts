import type { App } from "@modelcontextprotocol/ext-apps";
import type { AddProtocolAction, RequestTransformFunction } from "maplibre-gl";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createElement, Map as MapIcon } from "lucide";
import { previewI18n, t as translate } from "./i18n";
import { PreviewError, previewDiagnostic, type PreviewDiagnostic } from "./diagnostics";

const t = previewI18n.getFixedT(null, "translation", "mcpPreview.networkConsent");

const PREFIX = "geolibre-preview://";
const MAX_BYTES = 4 * 1024 * 1024;
const grantSchema = z.object({
  grant: z.string().min(1),
  expiresIn: z.number().positive().max(300),
});
const resourceSchema = z.object({
  data: z.string().max(4 * Math.ceil(MAX_BYTES / 3)),
  mimeType: z.string().min(1),
  cacheControl: z.string().optional(),
  expires: z.string().optional(),
});

export type PreviewToolTransport = App["callServerTool"];

export interface NetworkConsent {
  transformRequest: RequestTransformFunction;
  load: AddProtocolAction;
  dispose(): Promise<void>;
  refreshLabels(): void;
}

export async function closeMapPreview(
  previewId: string,
  callServerTool: PreviewToolTransport,
): Promise<void> {
  try {
    await callServerTool(
      { name: "close_map_preview", arguments: { preview_id: previewId } },
      { timeout: 2000 },
    );
  } catch {
    // Revocation is best-effort when the host disconnects; server expiry remains mandatory.
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function toolPayload(result: CallToolResult): unknown {
  if (!result || typeof result !== "object")
    throw new PreviewError({ key: "errors.invalidToolResponse" });
  if (result.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text;
    throw new PreviewError(message ? previewDiagnostic(message) : { key: "errors.serverRejected" });
  }
  // Do not treat cached text content as resource bytes or a grant.
  if (!result.structuredContent) throw new PreviewError({ key: "errors.noStructuredData" });
  return result.structuredContent;
}

function decodeResource(encoded: string): ArrayBuffer {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new PreviewError({ key: "errors.invalidBase64" });
  }
  const binary = atob(encoded);
  if (binary.length > MAX_BYTES) throw new PreviewError({ key: "errors.resourceTooLarge" });
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function createNetworkConsent(
  panel: HTMLElement,
  previewId: string,
  callServerTool: PreviewToolTransport,
  onUnsupported: (message: string, diagnostic?: PreviewDiagnostic) => void,
  initialOrigins: readonly string[],
  background?: HTMLElement,
): NetworkConsent {
  if (!previewId) throw new PreviewError({ key: "errors.missingSession" });
  const decisions = new Map<string, boolean>();
  const origins = new Set(initialOrigins);
  const pending = new Map<
    string,
    {
      promise: Promise<boolean>;
      resolve: (allowed: boolean) => void;
      waiters: number;
    }
  >();
  const grants = new Map<string, { token: string; expiresAt: number }>();
  const acquiring = new Map<
    string,
    {
      promise: Promise<string>;
      controller: AbortController;
      waiters: number;
    }
  >();
  const lifecycle = new AbortController();
  let disposal: Promise<void> | undefined;
  let previousFocus: HTMLElement | null = null;
  const backgroundWasInert = background?.inert ?? false;

  function restoreBackgroundFocus(): void {
    if (background) background.inert = backgroundWasInert;
    if (previousFocus?.isConnected) {
      let target = previousFocus;
      let collapsed = previousFocus.closest("details:not([open])");
      while (collapsed) {
        target = collapsed.querySelector<HTMLElement>(":scope > summary") ?? target;
        collapsed = collapsed.parentElement?.closest("details:not([open])") ?? null;
      }
      target.focus();
    }
    previousFocus = null;
  }

  function decideAll(allowed: boolean): void {
    if (lifecycle.signal.aborted) return;
    // Consent covers the displayed project origins, even if their requests have
    // not started yet. Never approve an origin discovered after this decision.
    for (const origin of origins) {
      if (!decisions.has(origin)) decisions.set(origin, allowed);
    }
    for (const [origin, entry] of pending) entry.resolve(decisions.get(origin) === true);
    pending.clear();
    showPrompt();
  }

  function showPrompt(): void {
    const wasOpen = !panel.hidden && panel.childElementCount > 0;
    const focusedAction = (document.activeElement as HTMLElement | null)?.dataset.consentAction;
    if (!wasOpen && pending.size) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    panel.replaceChildren();
    panel.hidden = pending.size === 0;
    if (panel.hidden) {
      restoreBackgroundFocus();
      return;
    }
    if (background) background.inert = true;
    const card = document.createElement("div");
    card.className = "consent-card";
    const header = document.createElement("div");
    header.className = "consent-header";
    const mark = document.createElement("span");
    mark.className = "consent-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.append(createElement(MapIcon, { width: 24, height: 24 }));
    const heading = document.createElement("div");
    const label = document.createElement("p");
    label.className = "consent-eyebrow";
    label.textContent = t("previewLabel");
    const title = document.createElement("h2");
    title.id = "consent-title";
    title.textContent = t("title");
    heading.append(label, title);
    header.append(mark, heading);
    const description = document.createElement("p");
    description.id = "consent-description";
    description.className = "consent-description";
    description.textContent = t("description");
    const count = document.createElement("p");
    count.className = "consent-count";
    count.textContent = t("servers", { count: origins.size });
    const list = document.createElement("ul");
    list.className = "consent-origins";
    for (const origin of origins) {
      const item = document.createElement("li");
      const address = document.createElement("code");
      address.dir = "ltr";
      address.textContent = origin;
      item.append(address);
      const decision = decisions.get(origin);
      if (decision !== undefined) {
        const badge = document.createElement("span");
        badge.className = "consent-decision";
        badge.textContent = t(decision ? "allowed" : "blocked");
        item.append(badge);
      }
      list.append(item);
    }
    const privacy = document.createElement("p");
    privacy.id = "consent-privacy";
    privacy.className = "consent-privacy";
    privacy.textContent = t("privacy");
    const scope = document.createElement("p");
    scope.id = "consent-scope";
    scope.className = "consent-scope";
    scope.textContent = t("scope");
    const actions = document.createElement("div");
    actions.className = "consent-actions";
    const block = document.createElement("button");
    block.type = "button";
    block.dataset.consentAction = "block";
    block.textContent = t("blockAll");
    block.addEventListener("click", () => decideAll(false));
    const allow = document.createElement("button");
    allow.type = "button";
    allow.dataset.consentAction = "allow";
    allow.className = "consent-allow";
    allow.textContent = t("allowAll");
    allow.addEventListener("click", () => decideAll(true));
    actions.append(block, allow);
    card.append(header, description, count, list, privacy, scope, actions);
    panel.append(card);
    (focusedAction === "allow" ? allow : block).focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (panel.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      decideAll(false);
    } else if (event.key === "Tab") {
      const buttons = panel.querySelectorAll<HTMLButtonElement>("button");
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
  panel.addEventListener("keydown", onKeyDown);

  async function approve(origin: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let allowed = decisions.get(origin);
    if (allowed === undefined) {
      let entry = pending.get(origin);
      if (!entry) {
        let resolve!: (allowed: boolean) => void;
        const promise = new Promise<boolean>((done) => {
          resolve = done;
        });
        entry = { promise, resolve, waiters: 0 };
        pending.set(origin, entry);
        const isNewOrigin = !origins.has(origin);
        origins.add(origin);
        if (pending.size === 1 || isNewOrigin) showPrompt();
      }
      const current = entry;
      current.waiters++;
      try {
        allowed = await abortable(current.promise, signal);
      } finally {
        current.waiters--;
        if (current.waiters === 0 && pending.get(origin) === current) {
          pending.delete(origin);
          current.resolve(false);
          showPrompt();
        }
      }
    }
    signal.throwIfAborted();
    if (!allowed) throw new PreviewError({ key: "errors.originDeclined", args: { origin } });
  }

  async function getGrant(origin: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const cached = grants.get(origin);
    if (cached && cached.expiresAt - Date.now() > 5000) return cached.token;
    grants.delete(origin);
    let entry = acquiring.get(origin);
    if (!entry) {
      const controller = new AbortController();
      const startedAt = Date.now();
      const current = { controller, waiters: 0, promise: undefined! as Promise<string> };
      acquiring.set(origin, current);
      current.promise = (async () => {
        try {
          const result = await callServerTool(
            {
              name: "approve_map_origin",
              arguments: { preview_id: previewId, origin },
            },
            { signal: controller.signal },
          );
          controller.signal.throwIfAborted();
          lifecycle.signal.throwIfAborted();
          const parsed = grantSchema.safeParse(toolPayload(result));
          if (!parsed.success) throw new PreviewError({ key: "errors.invalidGrant" });
          const expiresAt = startedAt + parsed.data.expiresIn * 1000;
          if (expiresAt <= Date.now()) throw new PreviewError({ key: "errors.expiredGrant" });
          grants.set(origin, { token: parsed.data.grant, expiresAt });
          return parsed.data.grant;
        } finally {
          if (acquiring.get(origin) === current) acquiring.delete(origin);
        }
      })();
      entry = current;
    }
    const current = entry;
    current.waiters++;
    try {
      return await abortable(current.promise, signal);
    } finally {
      current.waiters--;
      if (current.waiters === 0 && acquiring.get(origin) === current) {
        acquiring.delete(origin);
        current.controller.abort();
      }
    }
  }

  function parseUrl(value: string): URL {
    if (/[\u0000-\u001f\u007f]/.test(value))
      throw new PreviewError({ key: "errors.controlCharacters" });
    let url: URL;
    try {
      url = new URL(value, window.location.href);
    } catch {
      throw new PreviewError({ key: "errors.invalidUrl" });
    }
    if (url.username || url.password)
      throw new PreviewError({ key: "errors.credentialUrl", args: { origin: url.origin } });
    return url;
  }

  const transformRequest: RequestTransformFunction = (value) => {
    const url = parseUrl(value);
    if (url.protocol === "http:" || url.protocol === "https:") return { url: PREFIX + url.href };
    if (url.protocol === "data:" || url.protocol === "blob:") return { url: value };
    throw new PreviewError({ key: "errors.unsupportedProtocol", args: { protocol: url.protocol } });
  };

  const load: AddProtocolAction = async (request, controller) => {
    const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
    signal.throwIfAborted();
    if (!request.url.startsWith(PREFIX))
      throw new PreviewError({ key: "errors.invalidResourceProtocol" });
    const url = parseUrl(request.url.slice(PREFIX.length));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new PreviewError({
        key: "errors.unsupportedProtocol",
        args: { protocol: url.protocol },
      });
    if ((request.method && request.method !== "GET") || request.body != null)
      throw new PreviewError({ key: "errors.publicGetOnly", args: { origin: url.origin } });
    try {
      await approve(url.origin, signal);
      const grant = await getGrant(url.origin, signal);
      signal.throwIfAborted();
      const result = await abortable(
        callServerTool(
          {
            name: "fetch_map_resource",
            arguments: { preview_id: previewId, grant, url: url.href },
          },
          { signal },
        ),
        signal,
      );
      signal.throwIfAborted();
      const parsed = resourceSchema.safeParse(toolPayload(result));
      if (!parsed.success) throw new PreviewError({ key: "errors.invalidResourceData" });
      const bytes = decodeResource(parsed.data.data);
      let data = request.type === "string" ? new TextDecoder().decode(bytes) : bytes;
      if (request.type === "json") {
        try {
          data = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new PreviewError({ key: "errors.invalidJson" });
        }
      }
      // MapLibre video sources assign <source src> directly and bypass request
      // transforms. Remove them before a fetched style can instantiate media.
      if (
        request.type === "json" &&
        data &&
        typeof data === "object" &&
        "sources" in data &&
        "layers" in data &&
        Array.isArray(data.layers)
      ) {
        const sources = data.sources;
        if (sources && typeof sources === "object" && !Array.isArray(sources)) {
          const omitted = new Set<string>();
          for (const [id, source] of Object.entries(sources)) {
            if (
              source &&
              typeof source === "object" &&
              "type" in source &&
              source.type === "video"
            ) {
              omitted.add(id);
              delete (sources as Record<string, unknown>)[id];
              onUnsupported(translate("unsupported.styleVideo", { id }), {
                key: "unsupported.styleVideo",
                args: { id },
              });
            }
          }
          if (omitted.size)
            data.layers = data.layers.filter(
              (layer: { source?: string }) => !layer.source || !omitted.has(layer.source),
            );
        }
      }
      return { data, cacheControl: parsed.data.cacheControl, expires: parsed.data.expires };
    } catch (error) {
      signal.throwIfAborted();
      throw new PreviewError({
        key: "errors.fetchFailed",
        args: { origin: url.origin },
        detail: previewDiagnostic(error),
      });
    }
  };

  return {
    transformRequest,
    load,
    refreshLabels: showPrompt,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      lifecycle.abort(new DOMException("Preview closed", "AbortError"));
      for (const entry of pending.values()) entry.resolve(false);
      pending.clear();
      decisions.clear();
      grants.clear();
      for (const entry of acquiring.values()) entry.controller.abort();
      acquiring.clear();
      panel.removeEventListener("keydown", onKeyDown);
      panel.replaceChildren();
      panel.hidden = true;
      restoreBackgroundFocus();
      disposal = closeMapPreview(previewId, callServerTool);
      return disposal;
    },
  };
}
