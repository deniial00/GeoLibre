export interface OpenRouterModel {
  id: string;
  name: string;
}

const OPENROUTER_MODELS_URL =
  "https://openrouter.ai/api/v1/models?input_modalities=text&output_modalities=text&supported_parameters=tools&sort=most-popular";
const DISCOVERY_TIMEOUT_MS = 10_000;

/** Fetch the public text/tool-capable model catalog without sending user credentials. */
export async function discoverOpenRouterModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  // AbortSignal.any is newer than the WebViews supported by the app. When it is
  // absent, the deadline still bounds fetch and body reading; consumers also
  // ignore results from an aborted or superseded request.
  const requestSignal =
    signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(OPENROUTER_MODELS_URL, { signal: requestSignal });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("OpenRouter returned an invalid model catalog");
  }

  const models: OpenRouterModel[] = [];
  const seen = new Set<string>();
  for (const entry of payload.data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { id?: unknown; name?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    models.push({ id, name: name || id });
  }
  return models;
}
