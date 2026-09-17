import { fetchCapabilitiesText, proxyFeedRequestUrl } from "../components/layout/add-data/helpers";
import { WMS_PROXY_PATH } from "../components/layout/add-data/constants";
import { isTauri } from "./is-tauri";
import {
  assertWcsTiff,
  parseWcsCapabilities,
  parseWcsDescription,
  wcsRequestUrl,
  waitForWcsRequest,
  WcsError,
} from "./wcs";

async function fetchWcsXml(url: string, signal: AbortSignal): Promise<string> {
  const result = await fetchCapabilitiesText(url, WMS_PROXY_PATH, signal);
  if (!result.ok) throw new Error(`WCS HTTP ${result.status}`);
  return result.text;
}

export async function discoverWcs(endpoint: string, signal: AbortSignal) {
  return parseWcsCapabilities(
    await fetchWcsXml(wcsRequestUrl(endpoint, "GetCapabilities"), signal),
  );
}

export async function describeWcs(endpoint: string, coverage: string, signal: AbortSignal) {
  return parseWcsDescription(
    await fetchWcsXml(wcsRequestUrl(endpoint, "DescribeCoverage", { COVERAGE: coverage }), signal),
    coverage,
  );
}

const MAX_BYTES = 128 * 1024 * 1024;

/** Fetch the complete subset once: WCS responses need not support byte ranges. */
export async function downloadWcs(url: string, name: string, signal: AbortSignal): Promise<File> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  abort.throwIfAborted();
  let bytes: Uint8Array<ArrayBuffer>;
  if (isTauri()) {
    const { fetchUrlBytes } = await import("./native-http");
    bytes = new Uint8Array(
      await waitForWcsRequest(
        fetchUrlBytes(url, {
          context: "WCS GetCoverage",
          timeoutSecs: 120,
          maxBytes: MAX_BYTES,
        }).catch((error: unknown) => {
          if (String(error).includes("download limit")) throw new WcsError("size");
          throw error instanceof Error ? error : new Error(String(error));
        }),
        abort,
      ),
    );
    abort.throwIfAborted();
    if (bytes.byteLength > MAX_BYTES) throw new WcsError("size");
  } else {
    const response = await fetch(proxyFeedRequestUrl(url), { signal: abort });
    if (!response.ok) throw new Error(`WCS HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new WcsError("response");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new WcsError("size");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new WcsError("size");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  assertWcsTiff(bytes);
  return new File([bytes], `${name.replace(/[^\p{L}\p{N}._-]/gu, "_") || "coverage"}.tif`, {
    type: "image/tiff",
  });
}
