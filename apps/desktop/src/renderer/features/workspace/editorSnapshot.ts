import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { SceneSnapshot } from "../../shared/model/document";
import type { CanvasDocument } from "./types";

export const apiSnapshot = (api: ExcalidrawImperativeAPI): SceneSnapshot => ({
  elements: api.getSceneElementsIncludingDeleted(),
  appState: api.getAppState(),
  files: api.getFiles(),
});

/** Commit any in-progress text edit in the document's active editor. */
export const flushDocumentEditing = (document: CanvasDocument | undefined) => {
  if (document?.flushEditing) {
    document.flushEditing();
  } else {
    document?.api?.commitEditing();
  }
};
