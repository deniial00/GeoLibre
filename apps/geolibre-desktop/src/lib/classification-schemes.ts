import type { ParseKeys } from "i18next";

export const GRADUATED_CLASSIFICATION_SCHEMES: ReadonlyArray<{
  value: string;
  labelKey: ParseKeys;
}> = [
  { value: "equal-interval", labelKey: "style.symbology.schemeEqualInterval" },
  { value: "quantile", labelKey: "style.symbology.schemeQuantile" },
  { value: "natural-breaks", labelKey: "style.symbology.schemeNaturalBreaks" },
  { value: "standard-deviation", labelKey: "style.symbology.schemeStandardDeviation" },
  { value: "geometric-interval", labelKey: "style.symbology.schemeGeometricInterval" },
  { value: "manual", labelKey: "style.symbology.schemeManual" },
];

export function graduatedSchemeLabelKey(scheme: string): ParseKeys | null {
  return (
    GRADUATED_CLASSIFICATION_SCHEMES.find((option) => option.value === scheme)?.labelKey ?? null
  );
}
