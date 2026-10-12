import { createInstance } from "i18next";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_NAMES,
  languageDirection,
  resolveLanguage,
} from "../../geolibre-desktop/src/i18n/languages";
import {
  mcpPreview as englishPreview,
  legendPanel,
  style,
} from "../../geolibre-desktop/src/i18n/locales/en.json";

const supportedLocales = Object.keys(LANGUAGE_NAMES);
const bundledResources = {
  en: { translation: { mcpPreview: englishPreview, legendPanel, style } },
};

function preferredLocale(hostLocale?: string): string {
  const host = resolveLanguage(hostLocale, supportedLocales);
  if (host) return host;
  const browserLanguages = typeof navigator === "undefined" ? [] : (navigator.languages ?? []);
  for (const language of browserLanguages) {
    const resolved = resolveLanguage(language, supportedLocales);
    if (resolved) return resolved;
  }
  return DEFAULT_LANGUAGE;
}

export const previewI18n = createInstance();
previewI18n.on("languageChanged", (language) => {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.dir = languageDirection(language);
});
void previewI18n.init({
  lng: preferredLocale(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: supportedLocales,
  resources: bundledResources,
  ns: ["translation"],
  defaultNS: "translation",
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export const t = previewI18n.getFixedT(null, "translation", "mcpPreview");

export async function setPreviewLocale(hostLocale?: string): Promise<void> {
  await previewI18n.changeLanguage(preferredLocale(hostLocale));
}
