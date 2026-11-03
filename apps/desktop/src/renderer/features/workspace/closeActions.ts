import type { ProjectFile } from "../../../shared/desktop-api";
import type { CanvasDocument } from "./types";
import type { WorkspaceState } from "./state";
import type { DocumentActions } from "./documents";

/**
 * Closing tabs and the window and removing files, with unsaved-change
 * prompts.
 */
export const createCloseActions = (
  workspace: WorkspaceState,
  {
    saveSession,
    activate,
    refreshProjects,
    deleteDraft,
    scheduleDraft,
    captureAPI,
    saveDocument,
    requestSave,
    commitText,
  }: DocumentActions,
) => {
  const {
    ownerWindow,
    desktop,
    documentsRef,
    activeRef,
    projectRef,
    closingRef,
    removalVersion,
    removedPaths,
    pendingRemovals,
    pluginRequests,
    refresh,
    reportError,
    setClosing,
    setDrafts,
    setClosePrompt,
  } = workspace;

  const guardClose = async (
    documents: CanvasDocument[],
    discarded: Map<string, number>,
    allowRemovalSave = false,
  ) => {
    for (const document of documents) {
      if (document.hasPendingImages?.()) {
        await document.flushPendingImages?.();
      }
      commitText(document);
      if (document.saving) {
        await document.saving;
        captureAPI(document);
      }
      while (
        document.dirty &&
        discarded.get(document.id) !== document.revision
      ) {
        if (!allowRemovalSave) {
          activate(document.id);
        }
        const choice = await new Promise<"save" | "discard" | "cancel">(
          (resolve) => {
            setClosePrompt({ title: document.title, resolve });
          },
        );
        setClosePrompt(null);
        if (choice === "cancel") {
          return false;
        }
        if (choice === "discard") {
          discarded.set(document.id, document.revision);
          break;
        }
        if (
          !(await (allowRemovalSave
            ? saveDocument(document, false, undefined, true)
            : requestSave(document)))
        ) {
          return false;
        }
        captureAPI(document);
      }
    }
    return true;
  };

  const detachDocument = (document: CanvasDocument) => {
    ownerWindow.clearTimeout(document.draftTimer);
    for (const [key, entry] of pluginRequests.current) {
      if (entry.documentId === document.id) {
        pluginRequests.current.delete(key);
      }
    }
    const position = documentsRef.current.indexOf(document);
    documentsRef.current = documentsRef.current.filter(
      (item) => item !== document,
    );
    if (activeRef.current === document.id) {
      activeRef.current =
        documentsRef.current[Math.max(0, position - 1)]?.id || null;
      projectRef.current = !activeRef.current;
    }
    refresh();
    void saveSession();
  };

  const closeDocument = async (id: string): Promise<boolean> => {
    if (closingRef.current) {
      return false;
    }
    const document = documentsRef.current.find((item) => item.id === id);
    if (!document) {
      return false;
    }
    closingRef.current = true;
    setClosing(true);
    try {
      const discarded = new Map<string, number>();
      if (!(await guardClose([document], discarded))) {
        return false;
      }
      if (discarded.has(document.id)) {
        await deleteDraft(document);
      }
      detachDocument(document);
      return true;
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };

  const removeFile = async (file: ProjectFile, mode: "remove" | "trash") => {
    if (closingRef.current) {
      return false;
    }
    const document = documentsRef.current.find(
      (item) => item.path === file.path,
    );
    closingRef.current = true;
    setClosing(true);
    if (document) {
      document.removalPhase = "guarding";
    }
    let finishRemoval!: () => void;
    pendingRemovals.current.set(
      file.path,
      new Promise<void>((resolve) => {
        finishRemoval = resolve;
      }),
    );
    try {
      if (document && !(await guardClose([document], new Map(), true))) {
        return false;
      }
      if (document) {
        document.removalPhase = "removing";
        ownerWindow.clearTimeout(document.draftTimer);
        await document.draftTask;
      }
      await desktop.removeFile(file.path, mode);
      removedPaths.current.set(file.path, ++removalVersion.current);
      if (document?.path === file.path) {
        await deleteDraft(document);
        setDrafts((current) =>
          current.filter((draft) => draft.id !== document.id),
        );
        detachDocument(document);
      }
      await refreshProjects();
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    } finally {
      pendingRemovals.current.delete(file.path);
      finishRemoval();
      if (document) {
        delete document.removalPhase;
        if (documentsRef.current.includes(document) && document.dirty) {
          scheduleDraft(document);
        }
      }
      closingRef.current = false;
      setClosing(false);
    }
  };

  const closeWindow = async () => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setClosing(true);
    const discarded = new Map<string, number>();
    try {
      while (true) {
        if (!(await guardClose([...documentsRef.current], discarded))) {
          desktop.cancelClose();
          return;
        }
        await Promise.all(
          documentsRef.current
            .filter(
              (document) => discarded.get(document.id) === document.revision,
            )
            .map(deleteDraft),
        );
        await saveSession();
        // Native dialogs and file writes yield to the event loop. Recheck every
        // document immediately before accepting the window close.
        documentsRef.current.forEach(captureAPI);
        if (
          documentsRef.current.some(
            (document) =>
              document.dirty &&
              discarded.get(document.id) !== document.revision,
          )
        ) {
          continue;
        }
        desktop.confirmClose();
        return;
      }
    } catch (failure) {
      reportError(failure);
      desktop.cancelClose();
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };

  return {
    detachDocument,
    closeDocument,
    removeFile,
    closeWindow,
  };
};

export type CloseActions = ReturnType<typeof createCloseActions>;
