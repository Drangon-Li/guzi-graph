import { arrayToMap } from "@excalidraw/common";

import {
  getBoundTextElement,
  getCommonBounds,
  isTextElement,
} from "@excalidraw/element";

import type { ElementsMap, ExcalidrawElement } from "@excalidraw/element/types";

const footprint = (element: ExcalidrawElement, elementsMap: ElementsMap) =>
  JSON.stringify([
    element.type,
    element.width,
    element.height,
    element.angle,
    "points" in element ? element.points : null,
    isTextElement(element) ? element.text : null,
    element.type === "image" ? element.fileId : null,
    getBoundTextElement(element, elementsMap)?.originalText ?? null,
  ]);

const positionKey = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`;

/** Only the copied content and its existing copies participate, not a containing background. */
export const getClipboardPasteOffset = (
  source: readonly ExcalidrawElement[],
  placed: readonly ExcalidrawElement[],
  scene: readonly ExcalidrawElement[],
  gap: number,
) => {
  if (!source.length || !scene.length) {
    return 0;
  }
  const sourceIds = new Set(source.map((element) => element.id));
  const sourceMap = arrayToMap(source);
  const sceneMap = arrayToMap(scene);
  // Bound labels are laid out again on insertion. Their containers determine
  // the footprint even if that layout corrects stale label coordinates.
  const geometry = source.filter(
    (element) =>
      !isTextElement(element) ||
      !element.containerId ||
      !sourceIds.has(element.containerId),
  );
  const sceneByFootprint = new Map<string, ExcalidrawElement[]>();
  const sceneAtPosition = new Map<string, ExcalidrawElement[]>();
  for (const element of scene) {
    const key = footprint(element, sceneMap);
    const matches = sceneByFootprint.get(key) ?? [];
    matches.push(element);
    sceneByFootprint.set(key, matches);
    const location = `${key}:${positionKey(element.x, element.y)}`;
    const colocated = sceneAtPosition.get(location) ?? [];
    colocated.push(element);
    sceneAtPosition.set(location, colocated);
  }
  const blockers = [];
  const originals = scene.filter((element) => sourceIds.has(element.id));
  if (originals.length) {
    blockers.push(getCommonBounds(originals, sceneMap));
  }
  const anchor = geometry[0];
  if (anchor) {
    const keys = geometry.map((element) => footprint(element, sourceMap));
    for (const match of sceneByFootprint.get(keys[0]) ?? []) {
      const dx = match.x - anchor.x;
      const dy = match.y - anchor.y;
      const matchedIds = new Set<string>();
      const copy = geometry.map((element, index) => {
        const location = `${keys[index]}:${positionKey(
          element.x + dx,
          element.y + dy,
        )}`;
        const candidate = sceneAtPosition
          .get(location)
          ?.find((element) => !matchedIds.has(element.id));
        if (candidate) {
          matchedIds.add(candidate.id);
        }
        return candidate;
      });
      if (copy.every((element) => !!element)) {
        blockers.push(getCommonBounds(copy as ExcalidrawElement[], sceneMap));
      }
    }
  }
  const [left, top, right, bottom] = getCommonBounds(placed);
  let offset = 0;
  // Each shift passes the right edge of a blocker, so the search is bounded
  // by the number of current copies and needs no persistent paste counter.
  for (let index = 0; index < blockers.length; index++) {
    const candidateLeft = left + offset;
    const candidateRight = right + offset;
    const overlaps = blockers.filter(
      ([x1, y1, x2, y2]) =>
        candidateLeft <= x2 &&
        candidateRight >= x1 &&
        top <= y2 &&
        bottom >= y1,
    );
    if (!overlaps.length) {
      break;
    }
    offset = Math.max(...overlaps.map((bounds) => bounds[2])) + gap - left;
  }
  return offset;
};
