import { applyDarkModeFilter, THEME } from "@excalidraw/common";
import rough from "roughjs/bin/rough";

import { getCornerRadius } from "./utils";
import { generateRoughOptions } from "./shape";

import type { ExcalidrawImageElement } from "./types";
import type { RoughCanvas } from "roughjs/bin/canvas";

const borderGenerator = rough.generator();

export const getImageBorderStyle = (element: ExcalidrawImageElement) => {
  const strokeWidth = Math.min(
    element.strokeWidth,
    element.width,
    element.height,
  );
  return {
    inset: strokeWidth / 2,
    width: Math.max(0, element.width - strokeWidth),
    height: Math.max(0, element.height - strokeWidth),
    radius: element.roundness
      ? Math.max(
          0,
          getCornerRadius(Math.min(element.width, element.height), element) -
            strokeWidth / 2,
        )
      : 0,
    strokeWidth,
    dash:
      element.strokeStyle === "dashed"
        ? [strokeWidth * 8, strokeWidth * 4]
        : element.strokeStyle === "dotted"
        ? [strokeWidth, strokeWidth * 3]
        : [],
  };
};

export const getImageBorderDrawable = (
  element: ExcalidrawImageElement,
  theme: string,
) => {
  if (!element.imageBorder || element.roughness === 0) {
    return null;
  }
  const style = getImageBorderStyle(element);
  const options = {
    ...generateRoughOptions(
      { ...element, type: "rectangle", backgroundColor: "transparent" },
      false,
      theme === THEME.DARK,
    ),
    strokeWidth: style.strokeWidth,
    strokeLineDash: style.dash,
  };
  const x = style.inset;
  const y = style.inset;
  const right = x + style.width;
  const bottom = y + style.height;
  const radius = Math.min(style.radius, style.width / 2, style.height / 2);
  return radius
    ? borderGenerator.path(
        `M ${x + radius} ${y} H ${right - radius} Q ${right} ${y} ${right} ${
          y + radius
        } V ${bottom - radius} Q ${right} ${bottom} ${
          right - radius
        } ${bottom} H ${x + radius} Q ${x} ${bottom} ${x} ${
          bottom - radius
        } V ${y + radius} Q ${x} ${y} ${x + radius} ${y} Z`,
        options,
      )
    : borderGenerator.rectangle(x, y, style.width, style.height, options);
};

export const drawImageBorder = (
  context: CanvasRenderingContext2D,
  element: ExcalidrawImageElement,
  theme: string,
  rc?: RoughCanvas,
) => {
  if (!element.imageBorder) {
    return;
  }
  const style = getImageBorderStyle(element);
  context.save();
  try {
    context.filter = "none";
    const drawable = getImageBorderDrawable(element, theme);
    if (drawable) {
      (rc ?? rough.canvas(context.canvas)).draw(drawable);
      return;
    }
    context.strokeStyle = applyDarkModeFilter(
      element.strokeColor,
      theme === THEME.DARK,
    );
    context.lineWidth = style.strokeWidth;
    context.setLineDash(style.dash);
    context.beginPath();
    if (style.radius && context.roundRect) {
      context.roundRect(
        style.inset,
        style.inset,
        style.width,
        style.height,
        style.radius,
      );
    } else {
      context.rect(style.inset, style.inset, style.width, style.height);
    }
    context.stroke();
  } finally {
    context.restore();
  }
};
