import type { ExcalidrawElement } from "./types";

export const isSubcanvasPin = (element: ExcalidrawElement) =>
  element.type === "stickynote" &&
  typeof element.customData?.subcanvas?.sceneId === "string";

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
