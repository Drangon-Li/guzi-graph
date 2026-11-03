import { collectSubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export const findMissingImageFiles = (
  scenes: readonly { id: string; scene: ExcalidrawInitialDataState }[],
) => {
  const missing = new Set<string>();
  for (const { id, scene } of scenes) {
    const elements = [
      ...(scene.elements ?? []),
      ...Object.values(
        collectSubcanvasScenes(scene.elements ?? [], scene.appState?.subscenes),
      ).flatMap((child) => child.elements),
    ];
    for (const element of elements) {
      if (
        element.type === "image" &&
        !element.isDeleted &&
        (!element.fileId || !scene.files?.[element.fileId]?.dataURL)
      ) {
        missing.add(`${id}:${element.fileId ?? `placeholder:${element.id}`}`);
      }
    }
  }
  return missing;
};
