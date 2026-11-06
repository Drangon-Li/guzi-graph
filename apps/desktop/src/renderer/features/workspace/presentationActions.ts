import { flushSync } from "react-dom";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";
import {
  getCommonBounds,
  getNonDeletedElements,
  StoreIncrement,
} from "@excalidraw/element";
import { HistoryDelta } from "@excalidraw/excalidraw/history";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  AppState,
} from "@excalidraw/excalidraw/types";
import type { DurableIncrement, EphemeralIncrement } from "@excalidraw/element";

import { createSceneTracker } from "../../shared/model/document";
import { restoreLayerFontChanges } from "../editor/canvasFonts";
import {
  registerPreferenceFonts,
  resolveEditorPreferences,
} from "../../shared/config/editorPreferences";
import {
  copyPresentationScene,
  createPresentation,
  getSlideBounds,
  parsePresentation,
  serializePresentation,
} from "../presentation/model";

import { apiSnapshot, isEditorReady } from "./editorSnapshot";
import { pinDocumentSleep } from "./tabSleep";

import type { Presentation } from "../presentation/model";
import type { SceneSnapshot } from "../../shared/model/document";
import type {
  PresentationStructure,
  PresentationHistoryEntry,
  CanvasDocument,
} from "./types";
import type { WorkspaceState } from "./state";
import type { DocumentActions } from "./documents";

/**
 * Presentation decks: slide selection and editing, plus the deck-level
 * undo/redo history that spans slides.
 */
export const createPresentationActions = (
  workspace: WorkspaceState,
  { createDocument, recordContent, captureAPI, commitText }: DocumentActions,
) => {
  const {
    root,
    ownerWindow,
    documentsRef,
    closingRef,
    pendingImageActions,
    settingsRef,
    refresh,
    reportError,
  } = workspace;

  const newPresentation = (source?: CanvasDocument) => {
    if (closingRef.current) {
      return;
    }
    if (
      source &&
      deferUntilImagesReady(source, () => newPresentation(source))
    ) {
      return;
    }
    if (source) {
      commitText(source);
    }
    const snapshot =
      source?.getSnapshot?.() ??
      (source?.api ? apiSnapshot(source.api) : undefined);
    const pageTitle =
      settingsRef.current.language === "en" ? "Slide 1" : "第 1 页";
    const deck = createPresentation(
      ownerWindow.crypto.randomUUID(),
      pageTitle,
      snapshot ? JSON.parse(source!.tracker(snapshot)) : {},
    );
    const live = getNonDeletedElements(snapshot?.elements ?? []);
    if (live.length) {
      const [x1, y1, x2, y2] = getCommonBounds(live);
      const width = Math.max(x2 - x1, ((y2 - y1) * 16) / 9, 128) / 0.9;
      const height = (width * 9) / 16;
      deck.slides[0].bounds = {
        x: (x1 + x2 - width) / 2,
        y: (y1 + y2 - height) / 2,
        width,
        height,
      };
    }
    const document = createDocument({
      ...deck.slides[0].scene,
      presentation: deck,
    });
    document.title =
      source?.title ||
      (settingsRef.current.language === "en"
        ? "Untitled presentation"
        : "未命名演示文稿");
    document.unsavedCopy = true;
    document.dirty = true;
    refresh();
    return document;
  };

  const checkpointSlide = (document: CanvasDocument) => {
    commitText(document);
    if (!document.activeSlideId || !isEditorReady(document.api)) {
      return;
    }
    const previous = document.slideRuntime!.get(document.activeSlideId);
    document.slideRuntime!.set(document.activeSlideId, {
      children: previous?.children ?? new Map(),
      snapshot: document.getSnapshot?.() ?? apiSnapshot(document.api),
      history: document.api.history.checkpoint?.(),
    });
  };

  const deferUntilImagesReady = (
    document: CanvasDocument,
    action: () => void,
  ) => {
    if (!document.hasPendingImages?.()) {
      return false;
    }
    const waiting = pendingImageActions.current.get(document);
    if (waiting) {
      waiting.push(action);
    } else {
      pendingImageActions.current.set(document, [action]);
      void document.flushPendingImages!()
        .then(() => {
          const next = pendingImageActions.current.get(document);
          pendingImageActions.current.delete(document);
          if (
            documentsRef.current.includes(document) &&
            !document.removalPhase
          ) {
            next?.forEach((action) => action());
          }
        })
        .catch((failure) => {
          pendingImageActions.current.delete(document);
          reportError(failure);
        });
    }
    return true;
  };

  const finishSlideNotesEdit = (document: CanvasDocument) => {
    delete document.presentationHistory?.editingNotes;
  };

  const selectSlide = (document: CanvasDocument, id: string) => {
    const slide = document.presentation?.slides.find((item) => item.id === id);
    if (!slide || document.activeSlideId === id || document.presenting) {
      return;
    }
    if (deferUntilImagesReady(document, () => selectSlide(document, id))) {
      return;
    }
    finishSlideNotesEdit(document);
    if (
      document.presentation!.slides.some(
        (slide) => slide.id === document.activeSlideId,
      )
    ) {
      checkpointSlide(document);
    }
    const cached = document.slideRuntime!.get(id);
    document.activeSlideId = id;
    delete document.sleepCheckpoint;
    const preferences = resolveEditorPreferences(
      settingsRef.current.editorPreferences,
    );
    const scene = cached?.snapshot ?? slide.scene;
    document.initialData = {
      ...scene,
      appState: {
        ...scene.appState,
        currentItemFontFamily: preferences.defaultFontFamily,
        fontRegistry: {
          ...scene.appState?.fontRegistry,
          ...registerPreferenceFonts(preferences),
        },
      },
    };
    document.tracker = createSceneTracker();
    document.activeSlideContent = undefined;
    document.api = null;
    delete document.getSnapshot;
    delete document.flushEditing;
    delete document.activeEditor;
    refresh();
  };

  const recordPresentationIncrement = (
    document: CanvasDocument,
    increment: DurableIncrement | EphemeralIncrement,
  ) => {
    const history = document.presentationHistory;
    if (
      !history ||
      history.replaying ||
      history.pending ||
      !StoreIncrement.isDurable(increment) ||
      increment.delta instanceof HistoryDelta ||
      !document.activeSlideId
    ) {
      return;
    }
    const delta = increment.delta;
    const state = delta.appState.delta.inserted;
    if (
      delta.elements.isEmpty() &&
      !("viewBackgroundColor" in state) &&
      !("name" in state)
    ) {
      return;
    }
    history.undo.push({
      kind: "canvas",
      slideId: document.activeSlideId,
      checkpoint: { undo: [HistoryDelta.inverse(delta)], redo: [] },
    });
    history.redo.length = 0;
    refresh();
  };

  const replayPresentationCanvas = (
    document: CanvasDocument,
    entry: Extract<PresentationHistoryEntry, { kind: "canvas" }>,
    direction: "undo" | "redo",
  ) => {
    const history = document.presentationHistory!;
    const api = document.api;
    if (!api || api.isDestroyed || api.getAppState().isLoading) {
      history.pending = { entry, direction };
      refresh();
      return;
    }
    history.replaying = true;
    try {
      api.history.restoreCheckpoint!(entry.checkpoint);
      flushSync(() => api.history[direction]!());
      entry.checkpoint = api.history.checkpoint!();
      captureAPI(document);
    } finally {
      history.replaying = false;
      delete history.pending;
    }
    refresh();
  };

  const resumePresentationHistory = (
    document: CanvasDocument,
    api: ExcalidrawImperativeAPI,
  ) => {
    const pending = document.presentationHistory?.pending;
    if (!pending || pending.entry.kind !== "canvas") {
      return;
    }
    // Initialization calls back before the store commits the mounted scene.
    ownerWindow.queueMicrotask(() => {
      if (
        document.api === api &&
        !api.isDestroyed &&
        document.presentationHistory?.pending === pending &&
        pending.entry.kind === "canvas"
      ) {
        replayPresentationCanvas(document, pending.entry, pending.direction);
      }
    });
  };

  const presentationStructure = (
    document: CanvasDocument,
  ): PresentationStructure => ({
    slides: document.presentation!.slides.map((slide) => ({ ...slide })),
    activeSlideId: document.activeSlideId!,
    runtime: new Map(document.slideRuntime),
  });

  const clonePresentationStructure = (
    document: CanvasDocument,
  ): PresentationStructure => {
    const state = presentationStructure(document);
    return {
      ...state,
      slides: JSON.parse(JSON.stringify(state.slides)),
      runtime: new Map(
        [...state.runtime].map(([id, runtime]) => [
          id,
          {
            ...runtime,
            snapshot: runtime.snapshot
              ? JSON.parse(JSON.stringify(runtime.snapshot))
              : undefined,
            children: new Map(runtime.children),
          },
        ]),
      ),
    };
  };

  const replayPresentationFonts = (
    document: CanvasDocument,
    source: PresentationStructure,
    target: PresentationStructure,
  ) => {
    const restoreLayer = (
      current: ExcalidrawInitialDataState,
      previous: ExcalidrawInitialDataState,
      next: ExcalidrawInitialDataState,
    ): SceneSnapshot => {
      const state: AppState = {
        ...restoreAppState(current.appState, undefined),
        width: current.appState?.width ?? root.clientWidth,
        height: current.appState?.height ?? root.clientHeight,
        offsetLeft: current.appState?.offsetLeft ?? 0,
        offsetTop: current.appState?.offsetTop ?? 0,
      };
      return {
        elements: restoreLayerFontChanges(
          current.elements ?? [],
          previous.elements ?? [],
          next.elements ?? [],
        ),
        appState: {
          ...state,
          fontRegistry: {
            ...state.fontRegistry,
            ...next.appState?.fontRegistry,
          },
        },
        files: current.files ?? {},
      };
    };
    for (const slide of document.presentation!.slides) {
      const previous = source.slides.find(
        (item) => item.id === slide.id,
      )?.scene;
      const next = target.slides.find((item) => item.id === slide.id)?.scene;
      if (!previous || !next) {
        continue;
      }
      const runtime = document.slideRuntime!.get(slide.id);
      const current = runtime?.snapshot ?? slide.scene;
      const restored = restoreLayer(current, previous, next);
      const subscenes = { ...current.appState?.subscenes };
      for (const [id, child] of Object.entries(subscenes)) {
        const previousChild = previous.appState?.subscenes?.[id];
        const nextChild = next.appState?.subscenes?.[id];
        if (previousChild && nextChild) {
          const restoredChild = restoreLayer(child, previousChild, nextChild);
          subscenes[id] = {
            ...child,
            elements: restoredChild.elements,
            appState: {
              ...child.appState,
              fontRegistry: restoredChild.appState.fontRegistry,
            },
          };
        }
      }
      restored.appState.subscenes = subscenes;
      slide.scene = restored;
      document.slideRuntime!.set(slide.id, {
        ...runtime,
        snapshot: restored,
        children: runtime?.children ?? new Map(),
      });
      if (slide.id === document.activeSlideId && document.api) {
        flushSync(() =>
          document.api!.updateScene({
            elements: restored.elements,
            appState: {
              fontRegistry: restored.appState.fontRegistry,
              subscenes,
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          }),
        );
      }
    }
    selectSlide(document, target.activeSlideId);
    recordContent(document, serializePresentation(document.presentation!));
    refresh();
  };

  const performPresentationHistory = (
    document: CanvasDocument,
    direction: "undo" | "redo",
  ) => {
    const history = document.presentationHistory;
    if (!history || history.replaying) {
      return false;
    }
    if (document.presenting || history.pending) {
      return true;
    }
    if (
      deferUntilImagesReady(document, () =>
        performPresentationHistory(document, direction),
      )
    ) {
      return true;
    }
    commitText(document);
    finishSlideNotesEdit(document);
    const entry = history[direction].pop();
    if (!entry) {
      return true;
    }
    history[direction === "undo" ? "redo" : "undo"].push(entry);
    if (entry.kind === "canvas") {
      if (document.activeSlideId === entry.slideId) {
        replayPresentationCanvas(document, entry, direction);
      } else {
        history.pending = { entry, direction };
        selectSlide(document, entry.slideId);
      }
    } else if (entry.kind === "notes") {
      const slide = document.presentation!.slides.find(
        (slide) => slide.id === entry.slideId,
      )!;
      slide.notes = direction === "undo" ? entry.before : entry.after;
      selectSlide(document, entry.slideId);
      recordContent(document, serializePresentation(document.presentation!), {
        notesOnly: true,
      });
    } else {
      checkpointSlide(document);
      const target = direction === "undo" ? entry.before : entry.after;
      if (entry.kind === "fonts") {
        replayPresentationFonts(
          document,
          direction === "undo" ? entry.after : entry.before,
          target,
        );
        return true;
      }
      const currentScenes = new Map(
        document.presentation!.slides.map((slide) => [slide.id, slide.scene]),
      );
      // A removed page must retain child edits and local history made after insertion.
      const source = direction === "undo" ? entry.after : entry.before;
      source.slides = source.slides.map((slide) => ({
        ...slide,
        scene: currentScenes.get(slide.id) ?? slide.scene,
      }));
      source.runtime = new Map(
        source.slides.flatMap((slide) => {
          const runtime =
            document.slideRuntime!.get(slide.id) ??
            source.runtime.get(slide.id);
          return runtime ? [[slide.id, runtime] as const] : [];
        }),
      );
      document.presentation!.slides = target.slides.map((slide) => ({
        ...slide,
        scene: currentScenes.get(slide.id) ?? slide.scene,
      }));
      document.slideRuntime = new Map(
        [...target.runtime].map(([id, runtime]) => [
          id,
          document.slideRuntime!.get(id) ?? runtime,
        ]),
      );
      selectSlide(document, target.activeSlideId);
      recordContent(document, serializePresentation(document.presentation!));
      refresh();
    }
    return true;
  };

  const changeSlides = (
    document: CanvasDocument,
    change: (deck: Presentation) => void,
    activeAfter?: () => string,
    affectedSlideId?: string,
  ) => {
    if (!document.presentation || document.presenting) {
      return;
    }
    if (
      deferUntilImagesReady(document, () =>
        changeSlides(document, change, activeAfter, affectedSlideId),
      )
    ) {
      return;
    }
    checkpointSlide(document);
    const before = presentationStructure(document);
    const previousContent = serializePresentation(document.presentation);
    change(document.presentation);
    const content = serializePresentation(document.presentation);
    if (content === previousContent) {
      return;
    }
    if (activeAfter) {
      selectSlide(document, activeAfter());
    }
    const after = presentationStructure(document);
    if (affectedSlideId) {
      before.activeSlideId = affectedSlideId;
      after.activeSlideId = affectedSlideId;
    }
    const history = document.presentationHistory!;
    history.undo.push({ kind: "slides", before, after });
    history.redo.length = 0;
    recordContent(document, content);
    refresh();
  };

  const addSlide = (document: CanvasDocument, duplicateId?: string) => {
    let id = "";
    changeSlides(
      document,
      (deck) => {
        const source = deck.slides.find((slide) => slide.id === duplicateId);
        id = ownerWindow.crypto.randomUUID();
        const index = deck.slides.findIndex(
          (slide) => slide.id === (duplicateId ?? document.activeSlideId),
        );
        const title = settingsRef.current.language === "en" ? "Slide" : "页面";
        const slide = {
          id,
          notes: source?.notes,
          ...(source?.bounds ? { bounds: { ...source.bounds } } : {}),
          title: source
            ? `${source.title} ${
                settingsRef.current.language === "en" ? "copy" : "副本"
              }`
            : `${title} ${deck.slides.length + 1}`,
          scene: source
            ? copyPresentationScene(source.scene)
            : {
                appState: {
                  ...document.initialData.appState,
                  subscenes: {},
                  selectedElementIds: {},
                  viewBackgroundColor: "#ffffff",
                },
                elements: [],
                files: {},
              },
        };
        deck.slides = [
          ...deck.slides.slice(0, index + 1),
          slide,
          ...deck.slides.slice(index + 1),
        ];
      },
      () => id,
    );
  };

  const copySlide = (document: CanvasDocument, id: string): string | null => {
    if (
      !document.presentation ||
      !documentsRef.current.includes(document) ||
      document.presenting ||
      document.removalPhase ||
      closingRef.current
    ) {
      return null;
    }
    const slide = document.presentation.slides.find((slide) => slide.id === id);
    if (!slide) {
      return null;
    }
    finishSlideNotesEdit(document);
    commitText(document);
    return serializePresentation({ ...document.presentation, slides: [slide] });
  };

  const pasteSlide = (document: CanvasDocument, content: string) =>
    pinDocumentSleep(document, async () => {
      const deck = document.presentation;
      const canPaste = () =>
        !!deck &&
        document.presentation === deck &&
        documentsRef.current.includes(document) &&
        !document.presenting &&
        !document.removalPhase &&
        !closingRef.current;
      if (!canPaste()) {
        return;
      }
      const source = await parsePresentation(content, ownerWindow);
      if (!source || !canPaste()) {
        return;
      }
      const slides = source.slides.map((slide) => ({
        id: ownerWindow.crypto.randomUUID(),
        notes: slide.notes,
        title: `${slide.title} ${
          settingsRef.current.language === "en" ? "copy" : "副本"
        }`,
        bounds: { ...getSlideBounds(slide, source.width, source.height) },
        scene: copyPresentationScene(slide.scene),
      }));
      changeSlides(
        document,
        (deck) => {
          const index = deck.slides.findIndex(
            (slide) => slide.id === document.activeSlideId,
          );
          deck.slides.splice(index + 1, 0, ...slides);
        },
        () => slides[0].id,
      );
    });

  const deleteSlide = (document: CanvasDocument, id: string) => {
    const deck = document.presentation;
    if (!deck || deck.slides.length <= 1 || document.presenting) {
      return;
    }
    const index = deck.slides.findIndex((slide) => slide.id === id);
    if (index < 0) {
      return;
    }
    const activeAfter =
      document.activeSlideId === id
        ? deck.slides[index + 1]?.id ?? deck.slides[index - 1].id
        : document.activeSlideId!;
    changeSlides(
      document,
      () => {
        deck.slides = deck.slides.filter((slide) => slide.id !== id);
        document.slideRuntime!.delete(id);
      },
      () => activeAfter,
    );
  };

  const renameSlide = (document: CanvasDocument, id: string, title: string) => {
    if (title.trim()) {
      changeSlides(
        document,
        (deck) => {
          deck.slides = deck.slides.map((slide) =>
            slide.id === id ? { ...slide, title: title.trim() } : slide,
          );
        },
        undefined,
        id,
      );
    }
  };

  const moveSlide = (document: CanvasDocument, id: string, toIndex: number) => {
    changeSlides(
      document,
      (deck) => {
        const fromIndex = deck.slides.findIndex((slide) => slide.id === id);
        if (fromIndex < 0 || toIndex < 0 || toIndex >= deck.slides.length) {
          return;
        }
        const slides = [...deck.slides];
        slides.splice(toIndex, 0, slides.splice(fromIndex, 1)[0]);
        deck.slides = slides;
      },
      undefined,
      id,
    );
  };

  const updateSlideNotes = (
    document: CanvasDocument,
    id: string,
    notes: string,
  ) => {
    const deck = document.presentation;
    const slide = deck?.slides.find((slide) => slide.id === id);
    if (
      !deck ||
      !slide ||
      (slide.notes ?? "") === notes ||
      !document.initialized ||
      document.presenting ||
      document.removalPhase ||
      closingRef.current ||
      !documentsRef.current.includes(document)
    ) {
      return;
    }
    const history = document.presentationHistory!;
    const editing = history.editingNotes;
    const before = slide.notes;
    const after = notes || undefined;
    slide.notes = after;
    if (editing?.slideId === id && editing === history.undo.at(-1)) {
      if ((editing.before ?? "") === notes) {
        slide.notes = editing.before;
        history.undo.pop();
        finishSlideNotesEdit(document);
      } else {
        editing.after = after;
      }
    } else {
      const entry = {
        kind: "notes" as const,
        slideId: id,
        before,
        after,
      };
      history.undo.push(entry);
      history.editingNotes = entry;
    }
    history.redo.length = 0;
    recordContent(document, serializePresentation(deck), { notesOnly: true });
  };

  return {
    newPresentation,
    checkpointSlide,
    selectSlide,
    recordPresentationIncrement,
    resumePresentationHistory,
    clonePresentationStructure,
    performPresentationHistory,
    changeSlides,
    addSlide,
    copySlide,
    pasteSlide,
    deleteSlide,
    renameSlide,
    moveSlide,
    updateSlideNotes,
    finishSlideNotesEdit,
  };
};

export type PresentationActions = ReturnType<typeof createPresentationActions>;
