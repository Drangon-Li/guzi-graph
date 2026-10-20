import {
  isTransparent,
  MAX_CUSTOM_COLORS_USED_IN_CANVAS,
} from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ColorPickerColor, ColorPaletteCustom } from "@excalidraw/common";

import { atom } from "../../editor-jotai";

export const getColorNameAndShadeFromColor = ({
  palette,
  color,
}: {
  palette: ColorPaletteCustom;
  color: string | null;
}): {
  colorName: ColorPickerColor;
  shade: number | null;
} | null => {
  if (!color) {
    return null;
  }
  for (const [colorName, colorVal] of Object.entries(palette)) {
    if (Array.isArray(colorVal)) {
      const shade = colorVal.indexOf(color);
      if (shade > -1) {
        return { colorName: colorName as ColorPickerColor, shade };
      }
    } else if (colorVal === color) {
      return { colorName: colorName as ColorPickerColor, shade: null };
    }
  }
  return null;
};

export const colorPickerHotkeyBindings = [
  ["q", "w", "e", "r", "t"],
  ["a", "s", "d", "f", "g"],
  ["z", "x", "c", "v", "b"],
].flat();

export const isCustomColor = ({
  color,
  palette,
}: {
  color: string;
  palette: ColorPaletteCustom;
}) => {
  const paletteValues = Object.values(palette).flat();
  return !paletteValues.includes(color);
};

export const getMostUsedCustomColors = (
  elements: readonly ExcalidrawElement[],
  type: Exclude<ColorPickerType, "canvasBackground">,
  palette: ColorPaletteCustom,
) => {
  const colors = elements
    .filter((element) => !element.isDeleted)
    .flatMap((element) => {
      if (type === "textHighlight") {
        return element.type === "text"
          ? element.richText?.paragraphs.flatMap((paragraph) =>
              paragraph.runs.flatMap((run) =>
                run.background ? [run.background] : [],
              ),
            ) ?? []
          : [];
      }
      if (type === "tableText" && element.type !== "text") {
        return [];
      }
      return [
        type === "elementBackground"
          ? element.backgroundColor
          : element.strokeColor,
      ];
    });
  const colorCountMap = new Map<string, number>();
  for (const color of colors) {
    if (!isTransparent(color) && isCustomColor({ color, palette })) {
      colorCountMap.set(color, (colorCountMap.get(color) ?? 0) + 1);
    }
  }

  return [...colorCountMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map((c) => c[0])
    .slice(0, MAX_CUSTOM_COLORS_USED_IN_CANVAS);
};

export type ActiveColorPickerSectionAtomType =
  | "custom"
  | "baseColors"
  | "shades"
  | "hex"
  | null;
export const activeColorPickerSectionAtom =
  atom<ActiveColorPickerSectionAtomType>(null);

export type ColorPickerType =
  | "canvasBackground"
  | "elementBackground"
  | "elementStroke"
  | "textHighlight"
  | "tableText";
