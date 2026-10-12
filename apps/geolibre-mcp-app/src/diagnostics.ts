import { t } from "./i18n";

/** Authored copy remains a translation key; external text is redacted data. */
export type PreviewDiagnostic =
  | { key: string; args?: Record<string, string | number>; detail?: PreviewDiagnostic }
  | { text: string };

export function formatPreviewDiagnostic(diagnostic: PreviewDiagnostic): string {
  if ("text" in diagnostic) return diagnostic.text;
  return t(diagnostic.key, {
    ...diagnostic.args,
    ...(diagnostic.detail ? { message: formatPreviewDiagnostic(diagnostic.detail) } : {}),
  });
}

export class PreviewError extends Error {
  constructor(readonly diagnostic: PreviewDiagnostic) {
    super(formatPreviewDiagnostic(diagnostic));
    this.name = "PreviewError";
  }
}

/** Preserve authored diagnostic codes through resource failures; redact third-party text. */
export function previewDiagnostic(error: unknown): PreviewDiagnostic {
  if (error instanceof PreviewError) return error.diagnostic;
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "[remote URL]";
      }
    })
    .replace(/([?&](?:[^=\s&]+)=)[^\s&]+/g, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 400);
  return { text };
}
