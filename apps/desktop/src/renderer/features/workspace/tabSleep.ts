import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

import { isCanvasBusy } from "../plugins/canvasCommands";

import { apiSnapshot } from "./editorSnapshot";

import type { DocumentActions } from "./documents";
import type { WorkspaceState } from "./state";
import type { CanvasDocument, EditorSleepCheckpoint } from "./types";

export const TAB_SLEEP_DELAY = 5 * 60_000;
const RETRY_DELAY = 30_000;

export const markDocumentActive = (document: CanvasDocument) => {
  delete document.background;
  document.asleep = false;
};

export const holdDocumentAwake = (document: CanvasDocument) => {
  document.sleepPins = (document.sleepPins ?? 0) + 1;
  if (document.background) {
    document.background = { since: Date.now() };
  }
  return () => {
    document.sleepPins = document.sleepPins! - 1;
    if (document.background) {
      document.background = { since: Date.now() };
    }
  };
};

export const pinDocumentSleep = async <T>(
  document: CanvasDocument,
  operation: () => T | Promise<T>,
): Promise<T> => {
  const release = holdDocumentAwake(document);
  try {
    return await operation();
  } finally {
    release();
  }
};

export const useTabSleep = (
  workspace: WorkspaceState,
  actions: DocumentActions,
) => {
  const latest = useRef({ workspace, actions });
  latest.current = { workspace, actions };
  const { ownerWindow, documentsRef, activeRef, projectRef } = workspace;
  const reconcile = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    const timers = new Map<CanvasDocument, number>();
    const isActive = (document: CanvasDocument) =>
      !projectRef.current && activeRef.current === document.id;
    const trySleep = async (document: CanvasDocument) => {
      const { workspace, actions } = latest.current;
      const { background, api } = document;
      const canSleep = () => {
        if (
          disposed ||
          !background ||
          document.background !== background ||
          isActive(document) ||
          !documentsRef.current.includes(document) ||
          workspace.closingRef.current ||
          document.asleep ||
          !document.initialized ||
          !api ||
          document.api !== api ||
          api.isDestroyed ||
          document.sleepCheckpoint ||
          document.sleepPins ||
          document.saving ||
          document.relocating ||
          document.removalPhase ||
          document.presenting ||
          document.presentationHistory?.pending ||
          workspace.pendingImageActions.current.has(document) ||
          document.hasPendingImages?.()
        ) {
          return false;
        }
        const editor = document.activeEditor ? document.activeEditor() : api;
        return (
          editor &&
          !editor.isDestroyed &&
          !api.getAppState().isLoading &&
          !editor.getAppState().isLoading &&
          !isCanvasBusy(editor.getAppState())
        );
      };
      if (!background || background.preparing || !api || !canSleep()) {
        return;
      }
      background.preparing = true;
      try {
        actions.commitText(document);
        if (
          !canSleep() ||
          [...actions.documentMissingImageFiles(document)].some(
            (id) => !document.missingImageFilesAtOpen?.has(id),
          )
        ) {
          return;
        }
        const { revision, title, path, dirty } = document;
        if (dirty && !(await actions.writeDraft(document))) {
          return;
        }
        if (
          !canSleep() ||
          revision !== document.revision ||
          title !== document.title ||
          path !== document.path ||
          dirty !== document.dirty
        ) {
          return;
        }
        const snapshot = document.getSnapshot?.() ?? apiSnapshot(api);
        const checkpoint: EditorSleepCheckpoint =
          document.checkpointEditor?.() ?? {
            path: [],
            children: new Map(),
            history: api.history.checkpoint?.(Infinity),
          };
        const initialData = {
          ...snapshot,
          appState: {
            ...snapshot.appState,
            viewModeEnabled: api.getViewModePreference(),
            scrollConstraints: checkpoint.resetScrollConstraints
              ? null
              : snapshot.appState.scrollConstraints,
          },
        };
        if (document.activeSlideId) {
          document.slideRuntime!.set(document.activeSlideId, {
            ...checkpoint,
            snapshot: initialData,
          });
        }
        flushSync(() => {
          document.initialData = initialData;
          document.sleepCheckpoint = checkpoint;
          document.api = null;
          document.asleep = true;
          workspace.refresh();
        });
      } catch (failure) {
        if (!disposed) {
          workspace.reportError(failure);
        }
      } finally {
        delete background.preparing;
      }
    };
    const schedule = (document: CanvasDocument, minimumDelay = 0) => {
      const background = document.background;
      if (disposed || !background || document.asleep || isActive(document)) {
        return;
      }
      const timer = ownerWindow.setTimeout(() => {
        void (async () => {
          const expired =
            document.background &&
            Date.now() - document.background.since >= TAB_SLEEP_DELAY;
          if (expired) {
            await trySleep(document);
          }
          if (timers.get(document) === timer) {
            timers.delete(document);
            schedule(document, expired ? RETRY_DELAY : 0);
          }
        })();
      }, Math.max(minimumDelay, background.since + TAB_SLEEP_DELAY - Date.now()));
      timers.set(document, timer);
    };
    reconcile.current = () => {
      for (const [document, timer] of timers) {
        if (
          document.asleep ||
          isActive(document) ||
          !documentsRef.current.includes(document)
        ) {
          ownerWindow.clearTimeout(timer);
          timers.delete(document);
        }
      }
      for (const document of documentsRef.current) {
        if (!isActive(document) && !document.asleep && !timers.has(document)) {
          document.background ??= { since: Date.now() };
          schedule(document);
        }
      }
    };
    return () => {
      disposed = true;
      for (const timer of timers.values()) {
        ownerWindow.clearTimeout(timer);
      }
      timers.clear();
    };
  }, [ownerWindow, documentsRef, activeRef, projectRef]);

  useEffect(() => {
    if (!workspace.loading) {
      reconcile.current();
    }
  });
};
