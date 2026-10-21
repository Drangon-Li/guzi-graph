import { randomId } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  duplicateElements,
  newElementWith,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import { collectSubcanvasScenes, getSubcanvasId } from "./model";

import type { SubcanvasScenes } from "./model";
import type { AppClassProperties, AppState } from "../../types";

export const setStickyNoteCreationMode = (
  app: AppClassProperties,
  mode: AppState["currentItemStickyNoteMode"],
) => {
  app.api.updateScene({
    appState: { currentItemStickyNoteMode: mode },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  app.props.desktopIntegration?.onStickyNoteModeChange?.(mode);
};

export const convertStickyNoteToSubcanvas = (
  elements: readonly ExcalidrawElement[],
  noteId: string,
  scenes: SubcanvasScenes,
  title = "子画布",
) => {
  const note = elements.find((element) => element.id === noteId);
  if (!note || note.type !== "stickynote" || getSubcanvasId(note)) {
    return null;
  }
  const text = elements.find(
    (element): element is ExcalidrawTextElement =>
      element.type === "text" &&
      element.containerId === noteId &&
      !element.isDeleted,
  );
  const sceneId = randomId();
  const childElements: ExcalidrawElement[] = text
    ? [
        {
          ...text,
          id: randomId(),
          containerId: null,
          frameId: null,
          groupIds: [],
          boundElements: null,
          x: 24,
          y: 24,
        },
      ]
    : [];
  return {
    sceneId,
    elements: elements.map((element) =>
      element.id === noteId
        ? newElementWith(note, {
            width: 48,
            height: 56,
            baseHeight: 56,
            boundElements:
              note.boundElements?.filter((bound) => bound.type !== "text") ??
              null,
            customData: {
              ...note.customData,
              subcanvas: {
                sceneId,
                title:
                  text?.originalText.trim().split("\n")[0].slice(0, 48) ||
                  title,
              },
            },
          })
        : element.id === text?.id
        ? newElementWith(element, { isDeleted: true })
        : element,
    ),
    scenes: {
      ...scenes,
      [sceneId]: {
        version: 1 as const,
        title: text?.originalText.trim().split("\n")[0].slice(0, 48) || title,
        elements: childElements,
        appState: { viewBackgroundColor: "#ffffff" },
      },
    },
  };
};

export const cloneSubcanvasScenes = (
  elements: readonly ExcalidrawElement[],
  scenes: SubcanvasScenes,
) => {
  const reachable = collectSubcanvasScenes(elements, scenes);
  const ids = new Map(Object.keys(reachable).map((id) => [id, randomId()]));
  const replaceReference = (element: ExcalidrawElement) => {
    const id = getSubcanvasId(element);
    return id && ids.has(id)
      ? {
          ...element,
          customData: {
            ...element.customData,
            subcanvas: {
              ...element.customData?.subcanvas,
              sceneId: ids.get(id),
            },
          },
        }
      : element;
  };
  const copies: SubcanvasScenes = {};
  for (const [id, scene] of Object.entries(reachable)) {
    copies[ids.get(id)!] = {
      ...scene,
      appState: { ...scene.appState },
      elements: duplicateElements({
        type: "everything",
        elements: scene.elements.filter((element) => !element.isDeleted),
      }).duplicatedElements.map(replaceReference),
    };
  }
  return { elements: elements.map(replaceReference), scenes: copies };
};
