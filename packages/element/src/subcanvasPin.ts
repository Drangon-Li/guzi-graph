import { getLineWidth } from "./textMeasurements";
import { wrapText } from "./textWrapping";

import type { RenderEnvironment } from "./renderEnvironment";
import type { ExcalidrawElement, FontString } from "./types";

export const isSubcanvasPin = (element: ExcalidrawElement) =>
  element.type === "stickynote" &&
  typeof element.customData?.subcanvas?.sceneId === "string";

export const getSubcanvasPinTitle = (
  element: Pick<ExcalidrawElement, "width" | "height" | "customData">,
  environment?: RenderEnvironment,
) => {
  const title = element.customData?.subcanvas?.title;
  if (typeof title !== "string" || !title) {
    return null;
  }
  const scale = Math.min(element.width / 48, element.height / 56);
  const fontSize = 12 * scale;
  const font = `${fontSize}px sans-serif` as FontString;
  const lines = wrapText(title, font, 160 * scale, environment).split("\n");
  const width = Math.max(
    ...lines.map((line) => getLineWidth(line, font, environment)),
  );
  const x = (element.width - width) / 2;
  const y = element.height + 4 * scale;
  const lineHeight = fontSize * 1.4;
  return {
    title,
    lines,
    font,
    fontSize,
    lineHeight,
    x,
    y,
    width,
    height: lines.length * lineHeight,
  };
};

export const getSubcanvasPinGeometry = (
  element: Pick<ExcalidrawElement, "width" | "height">,
) => {
  const point = (x: number, y: number): [number, number] => [
    (x / 48) * element.width,
    (y / 56) * element.height,
  ];
  return {
    paper: [
      point(8, 16),
      point(32, 15),
      point(39, 23),
      point(40, 51),
      point(8, 52),
    ],
    fold: [point(32, 15), point(32, 23), point(39, 23)],
    stem: [point(20, 19), point(23, 29)],
    center: point(19, 15),
    radius: Math.min(element.width / 48, element.height / 56) * 4,
    lineWidth: Math.min(element.width / 48, element.height / 56) * 1.1,
    headColor: "#868e96",
  };
};
