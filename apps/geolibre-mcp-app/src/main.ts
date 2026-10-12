import "./validation-config";
import "./maplibre-worker";
import "./style.css";
import { parseProject, type GeoLibreProject } from "@geolibre/core";
import {
  App,
  applyDocumentTheme,
  type McpUiHostContext,
  type McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import { addProtocol, removeProtocol } from "maplibre-gl";
import { z } from "zod";
import { buttonVariants } from "@geolibre/ui/button-variants";
import { createElement, Crosshair, RotateCcw } from "lucide";
import { closeMapPreview, createNetworkConsent, type NetworkConsent } from "./network-consent";
import { renderProject, type PreviewRenderer } from "./render";
import { previewOrigins, unsupportedContent } from "./unsupported-content";
import { previewI18n, setPreviewLocale, t } from "./i18n";
import { createLegendControls, type LegendControls } from "./legend-controls";
import { createPreviewLayerControl, type PreviewLayerControl } from "./layer-control";
import {
  formatPreviewDiagnostic,
  PreviewError,
  previewDiagnostic,
  type PreviewDiagnostic,
} from "./diagnostics";

const app = new App({ name: "GeoLibre map preview", version: "1.0.0" });
const mapEl = document.getElementById("map")!;
const previewEl = document.getElementById("preview")!;
const identifyButton = document.getElementById("identify") as HTMLButtonElement;
const reloadButton = document.getElementById("reload") as HTMLButtonElement;
const diagnosticsEl = document.getElementById("diagnostics-list")!;
const statusEl = document.getElementById("status")!;
const consentEl = document.getElementById("network-consent")!;
identifyButton.className = buttonVariants({
  variant: "ghost",
  size: "sm",
  className: "preview-toolbar-action preview-identify-action",
});
reloadButton.className = buttonVariants({
  variant: "ghost",
  size: "sm",
  className: "preview-toolbar-action",
});
identifyButton.append(createElement(Crosshair, { width: 16, height: 16, "aria-hidden": "true" }));
reloadButton.prepend(createElement(RotateCcw, { width: 16, height: 16, "aria-hidden": "true" }));
let renderer: PreviewRenderer | undefined;
let layerControl: PreviewLayerControl | undefined;
let legendControls: LegendControls | undefined;
let currentProject: GeoLibreProject | undefined;
let identifyEmpty = false;
let consent: NetworkConsent | undefined;
let generation = 0;
let loading: "loadingProject" | "loadingResources" | undefined;
let notices: string[] = [];
let mainFailure: PreviewDiagnostic | undefined;
let lastValidPath: string | undefined;
let loadingPreview = false;
let tornDown = false;
let protocolRegistered = false;
const extraNotices = new globalThis.Map<string, PreviewDiagnostic>();
const failures = new globalThis.Map<string, { count: number; diagnostic: PreviewDiagnostic }>();
const summarySchema = z.object({ path: z.string().optional() });
const previewSchema = z.object({ project: z.unknown(), previewId: z.string().min(1) });
const previewSessionSchema = z.object({ previewId: z.string().min(1) });

async function disposePreview(): Promise<void> {
  const previousConsent = consent;
  consent = undefined;
  identifyButton.disabled = true;
  layerControl?.dispose();
  layerControl = undefined;
  legendControls?.dispose();
  legendControls = undefined;
  renderer?.dispose();
  renderer = undefined;
  currentProject = undefined;
  identifyEmpty = false;
  identifyButton.setAttribute("aria-pressed", "false");
  if (protocolRegistered) {
    removeProtocol("geolibre-preview");
    protocolRegistered = false;
  }
  await previousConsent?.dispose();
}

function closeLatePreview(data: { structuredContent?: unknown }): void {
  const parsed = previewSessionSchema.safeParse(data.structuredContent);
  if (!parsed.success) return;
  void closeMapPreview(parsed.data.previewId, (params, options) =>
    app.callServerTool(params, options),
  );
}

function updateReloadButton(): void {
  reloadButton.disabled =
    tornDown || loadingPreview || !lastValidPath || !app.getHostCapabilities()?.serverTools;
}

async function beginLoad(): Promise<number> {
  const current = ++generation;
  loadingPreview = true;
  loading = "loadingProject";
  notices = [];
  extraNotices.clear();
  failures.clear();
  mainFailure = undefined;
  updateReloadButton();
  updateStatus();
  await disposePreview();
  return current;
}

app.onteardown = async () => {
  tornDown = true;
  generation++;
  loadingPreview = false;
  updateReloadButton();
  resizeObserver.disconnect();
  previewI18n.off("languageChanged", refreshLabels);
  identifyButton.removeEventListener("click", toggleIdentify);
  reloadButton.removeEventListener("click", reloadPreview);
  app.removeEventListener("hostcontextchanged", applyContext);
  app.removeEventListener("toolresult", onToolResult);
  await disposePreview();
  return {};
};

function updateStatus(): void {
  const messages = [...new Set([...notices, ...(legendControls?.notices() ?? [])])];
  let failureCount = mainFailure ? 1 : 0;
  if (mainFailure) messages.push(formatPreviewDiagnostic(mainFailure));
  for (const [source, failure] of failures) {
    failureCount += failure.count;
    messages.push(
      `${source || t("errors.mapStyle")}: ${formatPreviewDiagnostic(failure.diagnostic)}`,
    );
  }
  statusEl.textContent = loading
    ? t(`status.${loading}`)
    : identifyEmpty
      ? t("inspection.noFeature")
      : failureCount
        ? t("status.failureCount", { count: failureCount })
        : "";
  statusEl.hidden = !statusEl.textContent;
  diagnosticsEl.replaceChildren(
    ...messages.map((message) => {
      const item = document.createElement("li");
      item.textContent = message;
      return item;
    }),
  );
  diagnosticsEl.hidden = messages.length === 0;
  mapEl.setAttribute("aria-busy", String(Boolean(loading)));
}

function refreshControls(): void {
  layerControl?.refresh();
  legendControls?.refresh();
  updateStatus();
}
function refreshLabels(): void {
  document.title = t("networkConsent.previewLabel");
  mapEl.setAttribute("aria-label", t("inspection.map"));
  document.getElementById("read-only")!.textContent = t("inspection.readOnly");
  identifyButton.setAttribute("aria-label", t("inspection.identify"));
  identifyButton.title = t("inspection.identify");
  reloadButton.setAttribute("aria-label", t("inspection.reload"));
  document.getElementById("reload-label")!.textContent = t("inspection.reload");
  reloadButton.title = t("inspection.reloadHelp");
  document.getElementById("reload-help")!.textContent = t("inspection.reloadHelp");
  updateReloadButton();
  consent?.refreshLabels();
  if (currentProject) notices = unsupportedContent(currentProject);
  refreshControls();
  renderer?.refreshLabels();
  updateStatus();
}
previewI18n.on("languageChanged", refreshLabels);
refreshLabels();

const resizeObserver = new ResizeObserver(() => renderer?.map.resize());
resizeObserver.observe(previewEl);
const toggleIdentify = (): void => {
  const enabled = identifyButton.getAttribute("aria-pressed") !== "true";
  renderer?.setIdentifyEnabled(enabled);
  identifyButton.setAttribute("aria-pressed", String(enabled));
};
identifyButton.addEventListener("click", toggleIdentify);
const reloadPreview = (): void => {
  if (tornDown || loadingPreview || !lastValidPath || !app.getHostCapabilities()?.serverTools) {
    updateReloadButton();
    return;
  }
  void loadPreview(lastValidPath);
};
reloadButton.addEventListener("click", reloadPreview);

function showFailure(diagnostic: PreviewDiagnostic): void {
  loading = undefined;
  loadingPreview = false;
  mainFailure = diagnostic;
  updateReloadButton();
  updateStatus();
}

function applyContext(context: McpUiHostContext): void {
  if (context.theme) {
    applyDocumentTheme(context.theme);
    document.documentElement.classList.toggle("dark", context.theme === "dark");
  }
  if ("locale" in context) void setPreviewLocale(context.locale);
  const dimensions = context.containerDimensions;
  if (dimensions) {
    for (const property of ["height", "maxHeight", "width", "maxWidth"] as const) {
      if (!(property in dimensions)) continue;
      const value = (dimensions as unknown as Record<string, unknown>)[property];
      const valid = typeof value === "number" && Number.isFinite(value) && value > 0;
      previewEl.style[property] = valid
        ? property === "width" || property === "maxWidth"
          ? `min(100vw, ${value}px)`
          : `${value}px`
        : "";
    }
  }
  updateReloadButton();
}

async function loadPreview(path: string): Promise<void> {
  if (tornDown) return;
  const current = await beginLoad();
  if (current !== generation || tornDown) return;
  if (!app.getHostCapabilities()?.serverTools) {
    showFailure({ key: "errors.hostToolsUnavailable" });
    return;
  }
  let responsePreviewId: string | undefined;
  try {
    const data = await app.callServerTool({ name: "get_map_preview", arguments: { path } });
    const preview = previewSchema.safeParse(data.structuredContent);
    if (current !== generation || tornDown) {
      closeLatePreview(data);
      return;
    }
    if (data.isError) {
      closeLatePreview(data);
      const text = data.content?.find((item) => item.type === "text")?.text;
      showFailure(text ? previewDiagnostic(new Error(text)) : { key: "errors.getPreviewFailed" });
      return;
    }
    if (!preview.success) {
      closeLatePreview(data);
      throw new PreviewError({ key: "errors.invalidSession" });
    }
    let project: GeoLibreProject;
    try {
      project = parseProject(JSON.stringify(preview.data.project));
    } catch (error) {
      closeLatePreview(data);
      throw error;
    }
    responsePreviewId = preview.data.previewId;
    consent = createNetworkConsent(
      consentEl,
      preview.data.previewId,
      (params, options) => app.callServerTool(params, options),
      (notice, diagnostic) => {
        if (current !== generation || tornDown) return;
        const item = diagnostic ?? { text: notice };
        extraNotices.set(JSON.stringify(item), item);
        updateStatus();
      },
      previewOrigins(project),
      previewEl,
    );
    addProtocol("geolibre-preview", consent.load);
    protocolRegistered = true;
    notices = unsupportedContent(project);
    currentProject = project;
    loading = "loadingResources";
    updateStatus();
    renderer = renderProject(mapEl, project, {
      transformRequest: consent.transformRequest,
      onReady() {
        if (current !== generation || tornDown) return;
        loading = undefined;
        loadingPreview = false;
        identifyButton.disabled = false;
        updateReloadButton();
        refreshControls();
        updateStatus();
      },
      onError(source, message, diagnostic) {
        if (current !== generation || tornDown) return;
        const previous = failures.get(source);
        failures.set(source, {
          count: (previous?.count ?? 0) + 1,
          diagnostic: diagnostic ?? { text: message },
        });
        updateStatus();
      },
      onBoundsChanged() {
        if (current === generation && !tornDown) refreshControls();
      },
      onIdentifyResult(found) {
        if (current !== generation || tornDown) return;
        identifyEmpty = !found;
        updateStatus();
      },
    });
    legendControls = createLegendControls(project, renderer);
    layerControl = createPreviewLayerControl(renderer, () => {
      legendControls?.refresh();
      updateStatus();
    });
    layerControl.refresh();
  } catch (error) {
    if (responsePreviewId && !consent) {
      void closeMapPreview(responsePreviewId, (params, options) =>
        app.callServerTool(params, options),
      );
    }
    if (current !== generation || tornDown) return;
    await disposePreview();
    if (current !== generation || tornDown) return;
    showFailure({
      key: "errors.loadFailed",
      detail: previewDiagnostic(error),
    });
  }
}

async function onToolResult(result: McpUiToolResultNotification["params"]): Promise<void> {
  if (tornDown) return;
  if (result.isError) {
    const current = await beginLoad();
    if (current !== generation || tornDown) return;
    const text = result.content?.find((item) => item.type === "text")?.text;
    showFailure(text ? previewDiagnostic(new Error(text)) : { key: "errors.showMapFailed" });
    return;
  }
  const summary = summarySchema.safeParse(result.structuredContent ?? {});
  if (!summary.success) {
    const current = await beginLoad();
    if (current === generation && !tornDown) showFailure({ key: "errors.invalidSummary" });
    return;
  }
  const { path } = summary.data;
  if (!path) {
    const current = await beginLoad();
    if (current === generation && !tornDown) showFailure({ key: "errors.missingPath" });
    return;
  }
  lastValidPath = path;
  updateReloadButton();
  await loadPreview(path);
}

app.addEventListener("hostcontextchanged", applyContext);
app.addEventListener("toolresult", onToolResult);

try {
  await app.connect();
  applyContext(app.getHostContext() ?? {});
} catch (error) {
  if (!tornDown)
    showFailure({
      key: "errors.hostConnectFailed",
      detail: previewDiagnostic(error),
    });
}
