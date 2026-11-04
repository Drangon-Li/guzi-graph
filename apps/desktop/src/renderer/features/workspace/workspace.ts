import { useEffect } from "react";

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

import { errorMessage, fileTitle } from "../../shared/model/document";
import { handleDesktopEditingCommand } from "../editor/desktopEditing";
import { CanvasCommandError } from "../plugins/canvasCommands";
import { registerPreferenceFonts } from "../../shared/config/editorPreferences";
import { translate } from "../../shared/i18n/i18n";

import { createDocumentActions } from "./documents";
import { createPresentationActions } from "./presentationActions";
import { createFontActions } from "./fontReplacement";
import { createCloseActions } from "./closeActions";
import { createProjectFileActions } from "./projectFileActions";
import { createPluginRequestActions } from "./pluginRequests";
import { useWorkspaceState } from "./state";

import type { DiskDocument } from "../../../shared/desktop-api";
import type { PluginResponse } from "../../../shared/plugins";

export type { CanvasDocument, ClosePrompt, PresentationHistory } from "./types";

/**
 * Desktop workspace: open documents, presentations, project files and the
 * MCP/plugin command bridge. Each domain lives in its own action module;
 * this hook owns the shared state, wires the modules together and exposes
 * the public API.
 */
export const useWorkspace = (
  root: HTMLElement,
  modalOpen: boolean | (() => boolean) = false,
) => {
  const workspace = useWorkspaceState(root, modalOpen);
  const {
    isModalOpen,
    ownerDocument,
    ownerWindow,
    desktop,
    documentsRef,
    activeRef,
    projectRef,
    readyRef,
    closingRef,
    settingsRef,
    setIndex,
    setError,
    handlers,
    pluginDisposed,
    pluginPending,
    refresh,
    reportError,
    settings,
    setSettings,
    index,
    folderRelocation,
    loading,
    setLoading,
    closing,
    failure,
    setFailure,
    drafts,
    setDrafts,
    closePrompt,
    newCanvasDialog,
    setNewCanvasDialog,
    pdfImportDialog,
    setPdfImportDialog,
  } = workspace;
  const documentActions = createDocumentActions(workspace);
  const presentationActions = createPresentationActions(
    workspace,
    documentActions,
  );
  const fontActions = createFontActions(
    workspace,
    documentActions,
    presentationActions,
  );
  const closeActions = createCloseActions(workspace, documentActions);
  const projectFileActions = createProjectFileActions(
    workspace,
    documentActions,
  );
  const pluginRequestActions = createPluginRequestActions(
    workspace,
    documentActions,
    presentationActions,
    closeActions,
  );
  const {
    saveSession,
    activate,
    showProjects,
    refreshProjects,
    createDocument,
    openUnsavedCopy,
    openDocuments,
    openFiles,
    openProject,
    capture,
    initialize,
    editorSave,
    requestSave,
    commitText,
  } = documentActions;
  const {
    newPresentation,
    selectSlide,
    recordPresentationIncrement,
    resumePresentationHistory,
    performPresentationHistory,
    addSlide,
    copySlide,
    pasteSlide,
    deleteSlide,
    renameSlide,
    moveSlide,
    updateSlideNotes,
    finishSlideNotesEdit,
  } = presentationActions;
  const { applyFontToCurrentLayer, applyFontToOpenDocuments } = fontActions;
  const { closeDocument, removeFile, closeWindow } = closeActions;
  const {
    changeDirectory,
    updateSettings,
    changeTheme,
    mutateFile,
    setFolderPinned,
    moveFolder,
    renameFolder,
    createFolder,
    recover,
    renameDocument,
    discardDraft,
  } = projectFileActions;
  const { handlePluginRequest } = pluginRequestActions;

  handlers.current = {
    plugin: handlePluginRequest,
    open: (files) => {
      if (!closingRef.current) {
        void openDocuments(files);
      }
    },
    command: (command) => {
      const presenting = documentsRef.current.some(
        (document) => document.presenting,
      );
      if (presenting && command !== "close-window") {
        return;
      }
      if (command === "undo" || command === "redo") {
        void handleDesktopEditingCommand(root, command, {
          canvasActive: !!activeRef.current && !projectRef.current,
          blocked: isModalOpen() || closingRef.current || !!closePrompt,
        }).catch(reportError);
        return;
      }
      if (isModalOpen()) {
        if (command === "close-window") {
          desktop.cancelClose();
        }
        return;
      }
      if (closingRef.current) {
        if (command === "close-window") {
          desktop.cancelClose();
        }
        return;
      }
      const active = documentsRef.current.find(
        (document) => document.id === activeRef.current,
      );
      switch (command) {
        case "new":
          setNewCanvasDialog(true);
          break;
        case "new-presentation":
          newPresentation();
          break;
        case "open":
          void openFiles();
          break;
        case "save":
        case "save-as":
          if (active && !projectRef.current) {
            void requestSave(active, command === "save-as");
          }
          break;
        case "projects":
          showProjects();
          break;
        case "close-tab":
          if (active && !projectRef.current) {
            void closeDocument(active.id);
          }
          break;
        case "close-window":
          void closeWindow();
          break;
      }
    },
  };

  // Reads the documents open at unmount time, not the ones open at mount.
  const clearDraftTimers = () => {
    for (const document of documentsRef.current) {
      ownerWindow.clearTimeout(document.draftTimer);
    }
  };

  useEffect(() => {
    let disposed = false;
    const pendingPluginRequests = pluginPending.current;
    pluginDisposed.current = false;
    if (!desktop) {
      setError("请通过 Excalidraw 桌面应用打开此页面。");
      setLoading(false);
      return;
    }
    const removeCommand = desktop.onCommand((command) =>
      handlers.current.command(command),
    );
    const removeFiles = desktop.onFilesOpened((files) =>
      handlers.current.open(files),
    );
    const removePlugin = desktop.onPluginRequest?.((request) => {
      pendingPluginRequests.set(request.requestId, { cancelled: false });
      void (async () => {
        let response: PluginResponse;
        try {
          response = {
            requestId: request.requestId,
            result: await handlers.current.plugin(request),
          };
        } catch (failure) {
          response = {
            requestId: request.requestId,
            error: {
              code:
                failure instanceof CanvasCommandError
                  ? failure.code
                  : "COMMAND_FAILED",
              message: errorMessage(failure),
            },
          };
        }
        if (
          !disposed &&
          !pendingPluginRequests.get(request.requestId)?.cancelled
        ) {
          desktop.respondPluginRequest(response);
        }
        pendingPluginRequests.delete(request.requestId);
      })();
    });
    const removePluginCancellation = desktop.onPluginRequestCancelled?.(
      (requestId) => {
        const pending = pendingPluginRequests.get(requestId);
        if (pending) {
          pending.cancelled = true;
        }
      },
    );
    const initializeWorkspace = async () => {
      try {
        const [initialSettings, initialIndex, session, recovery, pending] =
          await Promise.all([
            desktop.getSettings(),
            desktop.listProjects(),
            desktop.getSession(),
            desktop.listDrafts(),
            desktop.takePendingFiles(),
          ]);
        if (disposed) {
          return;
        }
        settingsRef.current = { ...settingsRef.current, ...initialSettings };
        registerPreferenceFonts(settingsRef.current.editorPreferences);
        setSettings(settingsRef.current);
        setIndex(initialIndex);
        setDrafts(recovery);
        const restored = await Promise.allSettled(
          session.paths.map((path) => desktop.readFile(path)),
        );
        const sessionFiles: DiskDocument[] = [];
        for (let index = 0; index < restored.length; index++) {
          const result = restored[index];
          if (result.status === "fulfilled") {
            sessionFiles.push(result.value);
          } else {
            setError("上次打开的「{title}」无法读取：{error}", {
              title: fileTitle(session.paths[index]),
              error: errorMessage(result.reason),
            });
          }
        }
        await openDocuments(sessionFiles, false);
        const active = documentsRef.current.find(
          (document) => document.path === session.activePath,
        );
        if (active) {
          activate(active.id);
        } else {
          showProjects();
        }
        await openDocuments(pending);
        readyRef.current = true;
        await desktop.setPluginHostReady?.(true);
        saveSession();
      } catch (failure) {
        reportError(failure);
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };
    void initializeWorkspace();
    const onFocus = () => {
      if (readyRef.current && projectRef.current) {
        void refreshProjects();
      }
    };
    ownerWindow.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      pluginDisposed.current = true;
      for (const pending of pendingPluginRequests.values()) {
        pending.cancelled = true;
      }
      readyRef.current = false;
      void desktop.setPluginHostReady?.(false).catch(() => {});
      removeCommand();
      removeFiles();
      removePlugin?.();
      removePluginCancellation?.();
      ownerWindow.removeEventListener("focus", onFocus);
      clearDraftTimers();
    };
    // The mounted root and preload API remain stable for this window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    ownerDocument.documentElement.lang = settings.language;
  }, [ownerDocument, settings.language]);

  return {
    documents: documentsRef.current,
    activeId: activeRef.current,
    projectsVisible: projectRef.current,
    settings,
    index,
    folderRelocation,
    loading,
    closing,
    error: failure
      ? translate(
          settings.language,
          failure.message,
          failure.params &&
            Object.fromEntries(
              Object.entries(failure.params).map(([key, value]) => [
                key,
                key === "error"
                  ? translate(settings.language, String(value))
                  : value,
              ]),
            ),
        )
      : null,
    drafts,
    closePrompt,
    newCanvasDialog,
    pdfImportDialog,
    requestNewDocument: () => setNewCanvasDialog(true),
    closeNewDocument: () => setNewCanvasDialog(false),
    requestPdfImport: () => setPdfImportDialog(true),
    closePdfImport: () => setPdfImportDialog(false),
    createCanvas: (initialData: ExcalidrawInitialDataState, title: string) => {
      const document = createDocument(initialData);
      document.title = title;
      if (initialData.elements?.length) {
        document.unsavedCopy = true;
        document.dirty = true;
      }
      setNewCanvasDialog(false);
      setPdfImportDialog(false);
      refresh();
      return document;
    },
    clearError: () => setFailure(null),
    reportError,
    activate,
    showProjects,
    refreshProjects,
    newDocument: () => createDocument(),
    newPresentation,
    recordPresentationIncrement,
    performPresentationHistory,
    resumePresentationHistory,
    selectSlide,
    addSlide,
    copySlide,
    pasteSlide,
    deleteSlide,
    renameSlide,
    moveSlide,
    updateSlideNotes,
    finishSlideNotesEdit,
    commitText,
    openFiles,
    openProject,
    openUnsavedCopy,
    initialize,
    capture,
    editorSave,
    requestSave,
    closeDocument,
    removeFile,
    updateSettings,
    applyFontToCurrentLayer,
    applyFontToOpenDocuments,
    changeDirectory,
    changeTheme,
    mutateFile,
    moveFolder,
    renameFolder,
    setFolderPinned,
    renameDocument,
    createFolder,
    recover,
    discardDraft,
  };
};

export type Workspace = ReturnType<typeof useWorkspace>;
