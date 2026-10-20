import { FONT_SIZES } from "./constants";

export type FontSizePresets = Record<keyof typeof FONT_SIZES, number>;

export const getFontSizePresets = (
  presets?: FontSizePresets,
): FontSizePresets => presets ?? FONT_SIZES;
