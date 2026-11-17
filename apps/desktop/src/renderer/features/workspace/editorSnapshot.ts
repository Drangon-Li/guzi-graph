import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { getSlideBounds } from "../presentation/model";

import type { SceneSnapshot } from "../../shared/model/document";
import type { CanvasDocument } from "./types";

export const apiSnapshot = (api: ExcalidrawImperativeAPI): SceneSnapshot => ({
  elements: api.getSceneElementsIncludingDeleted(),
  appState: api.getAppState(),
  files: api.getFiles(),
});

export const isEditorReady = (
  api: ExcalidrawImperativeAPI | null | undefined,
): api is ExcalidrawImperativeAPI =>
  !!api && !api.isDestroyed && !api.getAppState().isLoading;

export const capturePresentationViewport = (
  document: CanvasDocument,
  { scrollX, scrollY, zoom }: Pick<AppState, "scrollX" | "scrollY" | "zoom">,
) => {
  const deck = document.presentation;
  const slide = deck?.slides.find(({ id }) => id === document.activeSlideId);
  if (!deck || !slide) {
    return;
  }
  const { x, y } = getSlideBounds(slide, deck.width, deck.height);
  document.presentationViewport = {
    pageOffsetX: x + scrollX,
    pageOffsetY: y + scrollY,
    zoom,
  };
};

/** Commit any in-progress text edit in the document's active editor. */
export const flushDocumentEditing = (document: CanvasDocument | undefined) => {
  if (document?.flushEditing) {
    document.flushEditing();
  } else {
    document?.api?.commitEditing();
  }
};
