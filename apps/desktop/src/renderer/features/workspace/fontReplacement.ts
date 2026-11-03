import { flushSync } from "react-dom";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";

import type {
  ExcalidrawInitialDataState,
  AppState,
} from "@excalidraw/excalidraw/types";
import type { FontFamilyValues } from "@excalidraw/element/types";

import {
  appendFontReplacementHistory,
  loadReplacementFont,
  replaceLayerFont,
  replacementFontRegistry,
  replaceSnapshotFonts,
} from "../editor/canvasFonts";
import { serializePresentation } from "../presentation/model";

import { apiSnapshot } from "./editorSnapshot";

import type { SceneSnapshot } from "../../shared/model/document";
import type { CanvasDocument } from "./types";
import type { WorkspaceState } from "./state";
import type { DocumentActions } from "./documents";
import type { PresentationActions } from "./presentationActions";

/**
 * Font replacement for the current layer or every open document, including
 * hidden presentation slides and their undo history.
 */
export const createFontActions = (
  workspace: WorkspaceState,
  {
    scheduleDraft,
    recordContent,
    capture,
    captureAPI,
    commitText,
  }: DocumentActions,
  { checkpointSlide, clonePresentationStructure }: PresentationActions,
) => {
  const { root, ownerDocument, documentsRef, refresh } = workspace;

  const applyFontToCurrentLayer = async (
    document: CanvasDocument,
    fontFamily: FontFamilyValues,
  ) => {
    commitText(document);
    const api = document.activeEditor ? document.activeEditor() : document.api;
    if (!api || api.isDestroyed) {
      return;
    }
    await loadReplacementFont(
      api.getSceneElementsIncludingDeleted(),
      fontFamily,
      ownerDocument,
    );
    if (
      !documentsRef.current.includes(document) ||
      api.isDestroyed ||
      (document.activeEditor ? document.activeEditor() : document.api) !== api
    ) {
      return;
    }
    commitText(document);
    const previous = api.getSceneElementsIncludingDeleted();
    const elements = replaceLayerFont(previous, fontFamily);
    if (
      elements === previous &&
      api.getAppState().currentItemFontFamily === fontFamily
    ) {
      return;
    }
    flushSync(() =>
      api.updateScene({
        elements,
        appState: {
          currentItemFontFamily: fontFamily,
          fontRegistry: replacementFontRegistry(
            api.getAppState().fontRegistry,
            fontFamily,
          ),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    captureAPI(document);
  };

  const applyFontToOpenDocuments = async (fontFamily: FontFamilyValues) => {
    const toSnapshot = (
      scene: ExcalidrawInitialDataState,
      viewport?: AppState,
    ): SceneSnapshot => {
      const bounds = root.getBoundingClientRect();
      return {
        elements: scene.elements ?? [],
        appState: {
          ...restoreAppState(scene.appState, viewport),
          width: scene.appState?.width ?? viewport?.width ?? root.clientWidth,
          height:
            scene.appState?.height ?? viewport?.height ?? root.clientHeight,
          offsetLeft:
            scene.appState?.offsetLeft ?? viewport?.offsetLeft ?? bounds.left,
          offsetTop:
            scene.appState?.offsetTop ?? viewport?.offsetTop ?? bounds.top,
        },
        files: scene.files ?? {},
      };
    };
    const documents = documentsRef.current.filter(
      (document) => document.removalPhase !== "removing",
    );
    documents.forEach(commitText);
    const getScenes = (document: CanvasDocument) =>
      document.presentation
        ? document.presentation.slides.map((slide) =>
            slide.id === document.activeSlideId && document.api
              ? document.getSnapshot?.() ?? apiSnapshot(document.api)
              : document.slideRuntime?.get(slide.id)?.snapshot ?? slide.scene,
          )
        : [
            document.getSnapshot?.() ??
              (document.api ? apiSnapshot(document.api) : document.initialData),
          ];
    await loadReplacementFont(
      documents.flatMap((document) =>
        getScenes(document).flatMap((scene) => [
          ...(scene.elements ?? []),
          ...Object.values(scene.appState?.subscenes ?? {}).flatMap(
            (child) => child.elements,
          ),
        ]),
      ),
      fontFamily,
      ownerDocument,
    );
    for (const document of documents) {
      if (
        !documentsRef.current.includes(document) ||
        document.removalPhase === "removing"
      ) {
        continue;
      }
      commitText(document);
      const fontHistory = document.presentationHistory;
      if (fontHistory) {
        checkpointSlide(document);
      }
      const beforeFonts = fontHistory
        ? clonePresentationStructure(document)
        : undefined;
      const beforeContent = document.content;
      if (fontHistory) {
        fontHistory.replaying = true;
      }
      try {
        if (document.replaceAllSceneFonts) {
          flushSync(() => document.replaceAllSceneFonts!(fontFamily));
          commitText(document);
          captureAPI(document);
        } else if (document.api && !document.api.isDestroyed) {
          const previous =
            getScenes(document)[
              document.presentation
                ? document.presentation.slides.findIndex(
                    (slide) => slide.id === document.activeSlideId,
                  )
                : 0
            ];
          const next = replaceSnapshotFonts(previous, fontFamily);
          if (next !== previous) {
            flushSync(() =>
              document.api!.updateScene({
                elements: next.elements,
                appState: {
                  currentItemFontFamily: fontFamily,
                  fontRegistry:
                    next.appState?.fontRegistry ??
                    document.api!.getAppState().fontRegistry,
                  subscenes:
                    next.appState?.subscenes ??
                    document.api!.getAppState().subscenes,
                },
                captureUpdate: CaptureUpdateAction.IMMEDIATELY,
              }),
            );
            captureAPI(document);
          }
        }
        if (document.presentation) {
          if (document.api) {
            checkpointSlide(document);
          }
          for (const slide of document.presentation.slides) {
            if (slide.id === document.activeSlideId && document.api) {
              continue;
            }
            const runtime = document.slideRuntime?.get(slide.id);
            const previous = runtime?.snapshot ?? slide.scene;
            const next = replaceSnapshotFonts(previous, fontFamily);
            if (next === previous) {
              continue;
            }
            if (!document.initialized) {
              document.unsavedCopy = true;
              document.dirty = true;
            }
            const children = new Map(runtime?.children);
            for (const [id, child] of Object.entries(
              previous.appState?.subscenes ?? {},
            )) {
              const childHistory = appendFontReplacementHistory(
                children.get(id),
                child,
                next.appState!.subscenes![id],
              );
              if (childHistory) {
                children.set(id, childHistory);
              }
            }
            slide.scene = next;
            document.slideRuntime!.set(slide.id, {
              snapshot: toSnapshot(next, document.api?.getAppState()),
              history: appendFontReplacementHistory(
                runtime?.history,
                previous,
                next,
              ),
              children,
            });
            if (slide.id === document.activeSlideId) {
              document.initialData = next;
            }
          }
          recordContent(document, serializePresentation(document.presentation));
        } else if (!document.api) {
          const next = replaceSnapshotFonts(document.initialData, fontFamily);
          if (next === document.initialData) {
            continue;
          }
          if (!document.initialized) {
            document.unsavedCopy = true;
            document.dirty = true;
          }
          document.initialData = next;
          capture(document, toSnapshot(document.initialData));
        }
      } finally {
        if (fontHistory) {
          fontHistory.replaying = false;
        }
      }
      if (fontHistory && beforeFonts && document.content !== beforeContent) {
        fontHistory.undo.push({
          kind: "fonts",
          before: beforeFonts,
          after: clonePresentationStructure(document),
        });
        fontHistory.redo.length = 0;
      }
      if (!document.initialized && document.dirty) {
        scheduleDraft(document);
      }
    }
    refresh();
  };

  return {
    applyFontToCurrentLayer,
    applyFontToOpenDocuments,
  };
};

export type FontActions = ReturnType<typeof createFontActions>;
