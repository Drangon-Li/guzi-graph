import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppState, BinaryFiles } from "../../types";

export interface SubcanvasScene {
  version: 1;
  title: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<
    Pick<
      AppState,
      | "viewBackgroundColor"
      | "scrollX"
      | "scrollY"
      | "zoom"
      | "gridModeEnabled"
      | "gridSize"
      | "objectsSnapModeEnabled"
      | "fontRegistry"
    >
  >;
}

export type SubcanvasScenes = Record<string, SubcanvasScene>;

export const getSubcanvasId = (element: ExcalidrawElement | null | undefined) =>
  element?.type === "stickynote" &&
  typeof element.customData?.subcanvas?.sceneId === "string"
    ? (element.customData.subcanvas.sceneId as string)
    : null;

export const collectSubcanvasScenes = (
  elements: readonly ExcalidrawElement[],
  scenes: SubcanvasScenes = {},
) => {
  const result: SubcanvasScenes = {};
  const visit = (elements: readonly ExcalidrawElement[]) => {
    for (const element of elements) {
      const id = !element.isDeleted && getSubcanvasId(element);
      if (id && !result[id] && scenes[id]) {
        result[id] = scenes[id];
        visit(scenes[id].elements);
      }
    }
  };
  visit(elements);
  return result;
};

export const collectSceneFiles = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  scenes: SubcanvasScenes = {},
) => {
  const result: BinaryFiles = {};
  for (const sceneElements of [
    elements,
    ...Object.values(collectSubcanvasScenes(elements, scenes)).map(
      (scene) => scene.elements,
    ),
  ]) {
    for (const element of sceneElements) {
      if (
        !element.isDeleted &&
        element.type === "image" &&
        element.fileId &&
        files[element.fileId]
      ) {
        result[element.fileId] = files[element.fileId];
      }
    }
  }
  return result;
};

export const restoreSubcanvasScenes = (
  value: unknown,
  restore: (
    elements: readonly ExcalidrawElement[],
  ) => readonly ExcalidrawElement[],
): SubcanvasScenes => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const scenes: SubcanvasScenes = {};
  for (const [id, scene] of Object.entries(value)) {
    if (
      !scene ||
      scene.version !== 1 ||
      !Array.isArray(scene.elements) ||
      typeof scene.title !== "string"
    ) {
      continue;
    }
    const state = scene.appState;
    scenes[id] = {
      version: 1,
      title: scene.title,
      elements: restore(scene.elements),
      appState: {
        viewBackgroundColor:
          typeof state?.viewBackgroundColor === "string"
            ? state.viewBackgroundColor
            : "#ffffff",
        ...(Number.isFinite(state?.scrollX) ? { scrollX: state.scrollX } : {}),
        ...(Number.isFinite(state?.scrollY) ? { scrollY: state.scrollY } : {}),
        ...(Number.isFinite(state?.zoom?.value) && state.zoom.value > 0
          ? { zoom: { value: state.zoom.value } }
          : {}),
        gridModeEnabled: state?.gridModeEnabled === true,
        ...(Number.isFinite(state?.gridSize) && state.gridSize > 0
          ? { gridSize: state.gridSize }
          : {}),
        ...(typeof state?.objectsSnapModeEnabled === "boolean"
          ? { objectsSnapModeEnabled: state.objectsSnapModeEnabled }
          : {}),
        fontRegistry: state?.fontRegistry ?? {},
      },
    };
  }
  return scenes;
};
