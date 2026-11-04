import { loadFromBlob } from "@excalidraw/excalidraw";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import {
  createSceneTracker,
  documentContentSignature,
  errorMessage,
  fileTitle,
} from "../../shared/model/document";
import { findMissingImageFiles } from "../editor/imageIntegrity";
import {
  registerPreferenceFonts,
  resolveEditorPreferences,
  getPreferenceColorTopPicks,
} from "../../shared/config/editorPreferences";
import { translate } from "../../shared/i18n/i18n";
import {
  parsePresentation,
  serializePresentation,
} from "../presentation/model";

import { apiSnapshot, flushDocumentEditing } from "./editorSnapshot";

import type { Presentation } from "../presentation/model";
import type { SceneSnapshot } from "../../shared/model/document";
import type {
  DiskDocument,
  ProjectFile,
  RecoveryDraft,
} from "../../../shared/desktop-api";
import type { CanvasDocument } from "./types";
import type { WorkspaceState } from "./state";

/**
 * Canvas document lifecycle: session, opening files, recovery drafts,
 * content capture/dirty tracking and saving.
 */
export const createDocumentActions = (workspace: WorkspaceState) => {
  const {
    ownerWindow,
    desktop,
    documentsRef,
    activeRef,
    projectRef,
    readyRef,
    closingRef,
    openQueue,
    fileDialogPending,
    removalVersion,
    removedPaths,
    pendingRemovals,
    sessionQueue,
    settingsRef,
    setIndex,
    setError,
    refresh,
    reportError,
    settings,
    setDrafts,
  } = workspace;

  const saveSession = () => {
    if (!readyRef.current) {
      return Promise.resolve();
    }
    const active = documentsRef.current.find(
      (document) => document.id === activeRef.current,
    );
    const session = {
      paths: documentsRef.current.flatMap((document) =>
        document.path ? [document.path] : [],
      ),
      activePath: projectRef.current ? null : active?.path || null,
    };
    sessionQueue.current = sessionQueue.current
      .then(() => desktop.setSession(session))
      .catch(reportError);
    return sessionQueue.current;
  };

  const activate = (id: string) => {
    if (activeRef.current !== id) {
      flushDocumentEditing(
        documentsRef.current.find((item) => item.id === activeRef.current),
      );
    }
    activeRef.current = id;
    projectRef.current = false;
    refresh();
    saveSession();
  };

  const showProjects = () => {
    flushDocumentEditing(
      documentsRef.current.find((item) => item.id === activeRef.current),
    );
    projectRef.current = true;
    refresh();
    saveSession();
    void refreshProjects();
  };

  const refreshProjects = async () => {
    try {
      const nextIndex = await desktop.listProjects();
      if (nextIndex.rootDirectory !== settingsRef.current.rootDirectory) {
        return null;
      }
      setIndex(nextIndex);
      return nextIndex;
    } catch (failure) {
      reportError(failure);
      return null;
    }
  };

  const createDocument = (
    initialData: ExcalidrawInitialDataState & {
      presentation?: Presentation;
    } = {},
    file?: DiskDocument,
    draft?: RecoveryDraft,
    activateOnOpen = true,
  ) => {
    const { presentation, ...sceneData } = initialData;
    initialData = sceneData;
    const preferences = resolveEditorPreferences(
      settingsRef.current.editorPreferences,
    );
    const registry = registerPreferenceFonts(preferences);
    if (!file && !draft) {
      initialData = {
        ...initialData,
        appState: {
          currentItemFontFamily: preferences.defaultFontFamily,
          currentItemStrokeColor: preferences.defaultStrokeColor,
          currentItemBackgroundColor: preferences.defaultElementBackground,
          viewBackgroundColor: preferences.defaultBackground,
          fontTopPicks: preferences.fontTopPicks,
          ...initialData.appState,
          fontRegistry: { ...registry, ...initialData.appState?.fontRegistry },
          colorTopPicks: getPreferenceColorTopPicks(
            preferences,
            initialData.appState?.colorTopPicks,
          ),
        },
      };
    } else {
      initialData = {
        ...initialData,
        appState: {
          ...initialData.appState,
          fontTopPicks: preferences.fontTopPicks,
          colorTopPicks: getPreferenceColorTopPicks(
            preferences,
            initialData.appState?.colorTopPicks,
          ),
        },
      };
    }
    const document: CanvasDocument = {
      presentation,
      activeSlideId: presentation?.slides[0].id,
      slideRuntime: presentation ? new Map() : undefined,
      presentationHistory: presentation
        ? { undo: [], redo: [], replaying: false }
        : undefined,
      id: draft?.id || ownerWindow.crypto.randomUUID(),
      path: file?.path || null,
      title: draft
        ? draft.title
        : file
        ? fileTitle(file.path)
        : translate(settings.language, "未命名"),
      modifiedAt: file?.modifiedAt || null,
      initialData: {
        ...initialData,
        ...(file || draft ? { scrollToContent: true } : {}),
        appState: {
          ...initialData.appState,
          currentItemFontFamily: preferences.defaultFontFamily,
          fontRegistry: { ...initialData.appState?.fontRegistry, ...registry },
          currentItemStickyNoteMode:
            settingsRef.current.stickyNoteMode ?? "note",
        },
      },
      api: null,
      initialized: false,
      dirty: !!draft,
      revision: 0,
      content: "",
      contentSignature: "",
      savedContentSignature: null,
      tracker: createSceneTracker(),
      draftTask: Promise.resolve(),
      saving: null,
      recovered: !!draft,
    };
    documentsRef.current = [...documentsRef.current, document];
    if (activateOnOpen) {
      activate(document.id);
    } else {
      refresh();
    }
    return document;
  };

  const parse = async (content: string) => {
    const presentation = await parsePresentation(content, ownerWindow);
    return presentation
      ? { ...presentation.slides[0].scene, presentation }
      : loadFromBlob(new ownerWindow.Blob([content]), null, null);
  };

  const openUnsavedCopy = async (title: string, content: string) => {
    if (closingRef.current) {
      return null;
    }
    try {
      const data = await parse(content);
      if (closingRef.current) {
        return null;
      }
      const document = createDocument({ ...data, scrollToContent: true });
      document.title = title;
      document.unsavedCopy = true;
      document.dirty = true;
      refresh();
      return document;
    } catch (failure) {
      reportError(failure);
      return null;
    }
  };

  const recordOpenedFile = async (path: string) => {
    try {
      await desktop.recordOpenedFile(path);
      await refreshProjects();
    } catch (failure) {
      reportError(failure);
    }
  };

  const canCompleteOpen = (path: string, requestedAt: number) =>
    (removedPaths.current.get(path) || 0) <= requestedAt;

  const openDocuments = (
    files: DiskDocument[],
    activateOnOpen = true,
    requestedAt = removalVersion.current,
    canOpen?: () => boolean,
  ) => {
    openQueue.current = openQueue.current.then(async () => {
      for (const file of files) {
        while (pendingRemovals.current.has(file.path)) {
          await pendingRemovals.current.get(file.path);
        }
        if (!canCompleteOpen(file.path, requestedAt) || canOpen?.() === false) {
          continue;
        }
        const existing = documentsRef.current.find(
          (document) => document.path === file.path,
        );
        if (existing) {
          if (activateOnOpen) {
            activate(existing.id);
          }
          await recordOpenedFile(file.path);
          continue;
        }
        try {
          const data = await parse(file.content);
          while (pendingRemovals.current.has(file.path)) {
            await pendingRemovals.current.get(file.path);
          }
          if (
            !canCompleteOpen(file.path, requestedAt) ||
            canOpen?.() === false
          ) {
            continue;
          }
          createDocument(data, file, undefined, activateOnOpen);
          await recordOpenedFile(file.path);
        } catch (failure) {
          setError("无法打开「{title}」：{error}", {
            title: fileTitle(file.path),
            error: errorMessage(failure),
          });
        }
      }
    });
    return openQueue.current;
  };

  const openFiles = async () => {
    if (fileDialogPending.current) {
      return;
    }
    fileDialogPending.current = true;
    const requestedAt = removalVersion.current;
    try {
      await openDocuments(await desktop.openFiles(), true, requestedAt);
    } catch (failure) {
      reportError(failure);
    } finally {
      fileDialogPending.current = false;
    }
  };

  const openProject = async (file: ProjectFile) => {
    const requestedAt = removalVersion.current;
    while (pendingRemovals.current.has(file.path)) {
      await pendingRemovals.current.get(file.path);
    }
    if (!canCompleteOpen(file.path, requestedAt)) {
      return;
    }
    const existing = documentsRef.current.find(
      (document) => document.path === file.path,
    );
    if (existing) {
      activate(existing.id);
      await recordOpenedFile(file.path);
      return;
    }
    try {
      await openDocuments(
        [await desktop.readFile(file.path)],
        true,
        requestedAt,
      );
    } catch (failure) {
      reportError(failure);
    }
  };

  const enqueueDraft = (
    document: CanvasDocument,
    task: () => Promise<void>,
  ) => {
    document.draftTask = document.draftTask.then(task, task).catch(reportError);
    return document.draftTask;
  };

  const deleteDraft = (document: CanvasDocument) => {
    ownerWindow.clearTimeout(document.draftTimer);
    return enqueueDraft(document, () => desktop.deleteDraft(document.id));
  };

  const scheduleDraft = (document: CanvasDocument) => {
    ownerWindow.clearTimeout(document.draftTimer);
    if (document.relocating) {
      return;
    }
    if (!document.dirty) {
      void deleteDraft(document);
      return;
    }
    document.draftTimer = ownerWindow.setTimeout(() => {
      const draft: RecoveryDraft = {
        id: document.id,
        path: document.path,
        title: document.title,
        content: document.content,
        modifiedAt: Date.now(),
      };
      void enqueueDraft(document, () => desktop.writeDraft(draft));
    }, 750);
  };

  const recordContent = (
    document: CanvasDocument,
    content: string,
    options?: { files?: BinaryFiles; notesOnly?: boolean },
  ) => {
    if (
      !documentsRef.current.includes(document) ||
      document.removalPhase === "removing"
    ) {
      return;
    }
    if (content === document.content) {
      return;
    }
    document.content = content;
    document.contentSignature = documentContentSignature(
      content,
      (id) =>
        options?.files?.[id] ??
        (document.presentation
          ? document.presentation.slides.find(
              (slide) => slide.scene.files?.[id],
            )?.scene.files?.[id]
          : document.api && !document.api.isDestroyed
          ? document.api.getFiles()[id]
          : undefined),
    );
    document.revision += 1;
    if (document.presentation && !options?.notesOnly) {
      document.presentationPreviewRevision = document.revision;
    }
    if (!document.initialized) {
      return;
    }
    const wasDirty = document.dirty;
    document.dirty =
      document.contentSignature !== document.savedContentSignature;
    scheduleDraft(document);
    if (wasDirty !== document.dirty || document.presentation) {
      refresh();
    }
  };

  const capture = (document: CanvasDocument, snapshot: SceneSnapshot) => {
    const sceneContent = document.tracker(snapshot);
    if (document.presentation) {
      const slide = document.presentation.slides.find(
        (item) => item.id === document.activeSlideId,
      );
      if (!slide || sceneContent === document.activeSlideContent) {
        return;
      }
      document.activeSlideContent = sceneContent;
      slide.scene = snapshot;
      recordContent(document, serializePresentation(document.presentation));
    } else {
      recordContent(document, sceneContent, { files: snapshot.files });
    }
  };

  const captureAPI = (document: CanvasDocument) => {
    if (!document.api || document.api.isDestroyed) {
      return;
    }
    capture(document, document.getSnapshot?.() ?? apiSnapshot(document.api));
  };

  const documentMissingImageFiles = (document: CanvasDocument) =>
    findMissingImageFiles(
      document.presentation?.slides ?? [
        {
          id: document.id,
          scene:
            document.getSnapshot?.() ??
            (document.api && !document.api.isDestroyed
              ? apiSnapshot(document.api)
              : document.initialData),
        },
      ],
    );

  const initialize = (
    document: CanvasDocument,
    api: ExcalidrawImperativeAPI,
  ) => {
    document.api = api;
    captureAPI(document);
    if (document.initialized) {
      refresh();
      return;
    }
    document.missingImageFilesAtOpen = documentMissingImageFiles(document);
    document.initialized = true;
    const unsaved = document.recovered || !!document.unsavedCopy;
    document.savedContentSignature = unsaved ? null : document.contentSignature;
    document.dirty =
      document.contentSignature !== document.savedContentSignature;
    if (document.dirty) {
      scheduleDraft(document);
    }
    refresh();
  };

  const saveDocument = async (
    document: CanvasDocument,
    saveAs = false,
    snapshot?: SceneSnapshot,
    allowRemovalSave = false,
    automation = false,
    assertAutomationActive?: () => void,
  ): Promise<boolean> => {
    assertAutomationActive?.();
    if (document.relocating) {
      await document.relocating;
      assertAutomationActive?.();
    }
    if (
      !documentsRef.current.includes(document) ||
      (document.removalPhase && !allowRemovalSave)
    ) {
      return false;
    }
    if (document.hasPendingImages?.()) {
      await document.flushPendingImages?.();
      assertAutomationActive?.();
      // The supplied snapshot predates image initialization.
      snapshot = undefined;
      if (!documentsRef.current.includes(document)) {
        return false;
      }
    }
    if (snapshot) {
      capture(document, snapshot);
    } else {
      captureAPI(document);
    }
    if (document.saving) {
      await document.saving;
      assertAutomationActive?.();
      if (!document.dirty && !saveAs) {
        return true;
      }
      return saveDocument(
        document,
        saveAs,
        undefined,
        allowRemovalSave,
        automation,
        assertAutomationActive,
      );
    }
    if (!document.initialized) {
      setError("画布正在加载，请稍后保存。");
      return false;
    }
    const missingImages = documentMissingImageFiles(document);
    if (
      [...missingImages].some(
        (id) => !document.missingImageFilesAtOpen?.has(id),
      )
    ) {
      setError(
        "图片资源尚未完整加载，已阻止保存以免丢失图片。请等待图片导入完成后重试。",
      );
      return false;
    }
    delete document.presentationHistory?.editingNotes;
    const content = document.content;
    const contentSignature = document.contentSignature;
    const performSave = async () => {
      try {
        const file = await desktop.saveFile({
          ...(document.presentation ? { format: "presentation" as const } : {}),
          documentId: document.id,
          path: document.path,
          name: document.title,
          content,
          saveAs,
          ...(automation ? { automation: true } : {}),
          expectedModifiedAt: document.modifiedAt,
          occupiedPaths: documentsRef.current.flatMap((item) =>
            item !== document && item.path ? [item.path] : [],
          ),
        });
        if (!file) {
          return false;
        }
        const duplicate = documentsRef.current.find(
          (candidate) =>
            candidate.id !== document.id && candidate.path === file.path,
        );
        if (duplicate) {
          throw new Error("此文件已经在另一个标签中打开，请选择其他文件名。");
        }
        document.path = file.path;
        document.title = fileTitle(file.path);
        document.modifiedAt = file.modifiedAt;
        document.savedContentSignature = contentSignature;
        document.missingImageFilesAtOpen = missingImages;
        document.recovered = false;
        document.unsavedCopy = false;
        document.dirty =
          document.contentSignature !== document.savedContentSignature;
        if (document.dirty) {
          scheduleDraft(document);
        } else {
          await deleteDraft(document);
        }
        setDrafts((current) =>
          current.filter((draft) => draft.id !== document.id),
        );
        saveSession();
        void refreshProjects();
        return true;
      } catch (failure) {
        if (automation) {
          throw failure;
        }
        reportError(failure);
        return false;
      } finally {
        document.saving = null;
        refresh();
      }
    };
    document.saving = performSave();
    refresh();
    return document.saving;
  };

  const editorSave = async (
    document: CanvasDocument,
    snapshot: SceneSnapshot,
    saveAs: boolean,
  ) => {
    return saveDocument(document, saveAs, snapshot);
  };

  const requestSave = async (document: CanvasDocument, saveAs = false) => {
    if (document.hasPendingImages?.()) {
      await document.flushPendingImages?.();
    }
    if (!documentsRef.current.includes(document) || document.removalPhase) {
      return false;
    }
    const editor = document.activeEditor?.() ?? document.api;
    return editor && !editor.isDestroyed
      ? editor.desktopSave(saveAs)
      : saveDocument(document, saveAs);
  };

  const commitText = (document: CanvasDocument) => {
    flushDocumentEditing(document);
    captureAPI(document);
  };

  return {
    saveSession,
    activate,
    showProjects,
    refreshProjects,
    createDocument,
    parse,
    openUnsavedCopy,
    openDocuments,
    openFiles,
    openProject,
    deleteDraft,
    scheduleDraft,
    recordContent,
    capture,
    captureAPI,
    initialize,
    saveDocument,
    editorSave,
    requestSave,
    commitText,
  };
};

export type DocumentActions = ReturnType<typeof createDocumentActions>;
