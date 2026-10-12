import { VECTOR_COLOR_RAMPS, getVectorColorRamp, normalizeHexColor } from "@geolibre/core";

const namedRamps: Record<string, true> = Object.fromEntries(
  VECTOR_COLOR_RAMPS.map((ramp) => [ramp.value, true]),
);

/** Unknown palettes are unavailable, never substituted or fetched. */
export function previewNamedRamp(name: string): readonly string[] | null {
  return Object.hasOwn(namedRamps, name) ? getVectorColorRamp(name).colors : null;
}

/** Saved stops are hex-only; generated heatmap transparency is never parsed as CSS. */
export function previewGradientColors(
  colors: readonly string[],
  generatedTransparentStart = false,
): string[] | null {
  const start = generatedTransparentStart ? 1 : 0;
  if (colors.length - start < 2) return null;
  const normalized: string[] = generatedTransparentStart ? ["#00000000"] : [];
  for (let index = start; index < colors.length; index++) {
    const color = normalizeHexColor(colors[index]);
    if (color === null) return null;
    normalized.push(color);
  }
  return normalized;
}
