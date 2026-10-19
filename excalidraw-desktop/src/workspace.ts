import { useEffect, useRef, useState } from "react";

import { loadFromBlob } from "@excalidraw/excalidraw";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { createSceneTracker, errorMessage, fileTitle } from "./document";
import { handleDesktopEditingCommand } from "./desktopEditing";
import { translate } from "./i18n";

import type { SceneSnapshot } from "./document";
import type {
  DesktopCommand,
  DesktopSettings,
  DiskDocument,
  ProjectFile,
  ProjectIndex,
  RecoveryDraft,
} from "./shared";

export interface CanvasDocument {
  id: string;
  path: string | null;
  title: string;
  modifiedAt: number | null;
  initialData: ExcalidrawInitialDataState;
  api: ExcalidrawImperativeAPI | null;
  initialized: boolean;
  dirty: boolean;
  revision: number;
  content: string;
  savedContent: string | null;
  tracker: ReturnType<typeof createSceneTracker>;
  draftTimer?: number;
  draftTask: Promise<void>;
  saving: Promise<boolean> | null;
  recovered: boolean;
  removalPhase?: "guarding" | "removing";
}

export interface ClosePrompt {
  title: string;
  resolve: (choice: "save" | "discard" | "cancel") => void;
}

export const useWorkspace = (root: HTMLElement, modalOpen = false) => {
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const desktop = ownerWindow.desktop;
  const documentsRef = useRef<CanvasDocument[]>([]);
  const activeRef = useRef<string | null>(null);
  const projectRef = useRef(true);
  const readyRef = useRef(false);
  const closingRef = useRef(false);
  const openQueue = useRef(Promise.resolve());
  const removalVersion = useRef(0);
  const removedPaths = useRef(new Map<string, number>());
  const pendingRemovals = useRef(new Map<string, Promise<void>>());
  const sessionQueue = useRef(Promise.resolve());
  const settingsQueue = useRef(Promise.resolve());
  const [, render] = useState(0);
  const [settings, setSettings] = useState<DesktopSettings>({
    rootDirectory: null,
    theme: "system",
    toolPanelDock: "floating",
    toolPanelWidth: 280,
    language: "zh-CN",
    structuredExportFormat: "json",
    includeInferredStructure: true,
    skipRemoveConfirmation: false,
    skipTrashConfirmation: false,
  });
  const [index, setIndex] = useState<ProjectIndex>({
    rootDirectory: null,
    files: [],
    folders: [],
    history: [],
  });
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [failure, setFailure] = useState<{
    message: string;
    params?: Record<string, string | number>;
  } | null>(null);
  const setError = (
    message: string,
    params?: Record<string, string | number>,
  ) => setFailure({ message, params });
  const [drafts, setDrafts] = useState<RecoveryDraft[]>([]);
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
  const handlers = useRef({
    command: (_command: DesktopCommand) => {},
    open: (_files: DiskDocument[]) => {},
  });

  const refresh = () => render((value) => value + 1);
  const reportError = (failure: unknown) => setError(errorMessage(failure));

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
      documentsRef.current
        .find((item) => item.id === activeRef.current)
        ?.api?.commitEditing();
    }
    activeRef.current = id;
    projectRef.current = false;
    refresh();
    saveSession();
  };

  const showProjects = () => {
    documentsRef.current
      .find((item) => item.id === activeRef.current)
      ?.api?.commitEditing();
    projectRef.current = true;
    refresh();
    saveSession();
    void refreshProjects();
  };

  const refreshProjects = async () => {
    try {
      const nextIndex = await desktop.listProjects();
      setIndex(nextIndex);
      return nextIndex;
    } catch (failure) {
      reportError(failure);
      return null;
    }
  };

  const createDocument = (
    initialData: ExcalidrawInitialDataState = {},
    file?: DiskDocument,
    draft?: RecoveryDraft,
    activateOnOpen = true,
  ) => {
    const document: CanvasDocument = {
      id: draft?.id || ownerWindow.crypto.randomUUID(),
      path: file?.path || null,
      title: draft
        ? draft.title
        : file
        ? fileTitle(file.path)
        : translate(settings.language, "未命名"),
      modifiedAt: file?.modifiedAt || null,
      initialData:
        file || draft ? { ...initialData, scrollToContent: true } : initialData,
      api: null,
      initialized: false,
      dirty: !!draft,
      revision: 0,
      content: "",
      savedContent: null,
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

  const parse = (content: string) =>
    loadFromBlob(new ownerWindow.Blob([content]), null, null);

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
  ) => {
    openQueue.current = openQueue.current.then(async () => {
      for (const file of files) {
        while (pendingRemovals.current.has(file.path)) {
          await pendingRemovals.current.get(file.path);
        }
        if (!canCompleteOpen(file.path, requestedAt)) {
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
          if (!canCompleteOpen(file.path, requestedAt)) {
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
    const requestedAt = removalVersion.current;
    try {
      await openDocuments(await desktop.openFiles(), true, requestedAt);
    } catch (failure) {
      reportError(failure);
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

  const capture = (document: CanvasDocument, snapshot: SceneSnapshot) => {
    if (
      !documentsRef.current.includes(document) ||
      document.removalPhase === "removing"
    ) {
      return;
    }
    const content = document.tracker(snapshot);
    if (content === document.content) {
      return;
    }
    document.content = content;
    document.revision += 1;
    if (!document.initialized) {
      return;
    }
    const wasDirty = document.dirty;
    document.dirty = content !== document.savedContent;
    scheduleDraft(document);
    if (wasDirty !== document.dirty) {
      refresh();
    }
  };

  const captureAPI = (document: CanvasDocument) => {
    if (!document.api || document.api.isDestroyed) {
      return;
    }
    capture(document, {
      elements: document.api.getSceneElementsIncludingDeleted(),
      appState: document.api.getAppState(),
      files: document.api.getFiles(),
    });
  };

  const initialize = (
    document: CanvasDocument,
    api: ExcalidrawImperativeAPI,
  ) => {
    document.api = api;
    captureAPI(document);
    document.initialized = true;
    document.savedContent = document.recovered ? null : document.content;
    document.dirty = document.recovered;
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
  ): Promise<boolean> => {
    if (
      !documentsRef.current.includes(document) ||
      (document.removalPhase && !allowRemovalSave)
    ) {
      return false;
    }
    if (snapshot) {
      capture(document, snapshot);
    } else {
      captureAPI(document);
    }
    if (document.saving) {
      await document.saving;
      if (!document.dirty && !saveAs) {
        return true;
      }
      return saveDocument(document, saveAs, undefined, allowRemovalSave);
    }
    if (!document.initialized) {
      setError("画布正在加载，请稍后保存。");
      return false;
    }
    const content = document.content;
    const revision = document.revision;
    const performSave = async () => {
      try {
        const file = await desktop.saveFile({
          documentId: document.id,
          path: document.path,
          name: document.title,
          content,
          saveAs,
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
        document.savedContent = content;
        document.recovered = false;
        document.dirty =
          document.revision !== revision || document.content !== content;
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

  const requestSave = (document: CanvasDocument, saveAs = false) => {
    if (!documentsRef.current.includes(document) || document.removalPhase) {
      return Promise.resolve(false);
    }
    return document.api?.desktopSave(saveAs) || Promise.resolve(false);
  };

  const commitText = (document: CanvasDocument) => {
    document.api?.commitEditing();
    captureAPI(document);
  };

  const guardClose = async (
    documents: CanvasDocument[],
    discarded: Map<string, number>,
    allowRemovalSave = false,
  ) => {
    for (const document of documents) {
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

  const changeDirectory = async () => {
    try {
      const next = await desktop.chooseDirectory();
      if (next) {
        setSettings(next);
        await refreshProjects();
      }
    } catch (failure) {
      reportError(failure);
    }
  };

  const updateSettings = (update: Partial<DesktopSettings>) => {
    const task = settingsQueue.current.then(async () => {
      try {
        const next = await desktop.updateSettings(update);
        setSettings(next);
        return next;
      } catch (failure) {
        reportError(failure);
        return null;
      }
    });
    settingsQueue.current = task.then(() => {});
    return task;
  };

  const changeTheme = (theme: DesktopSettings["theme"]) =>
    updateSettings({ theme });

  const mutateFile = async (
    operation: "rename" | "move",
    file: ProjectFile,
    value: string,
  ) => {
    if (closingRef.current) {
      return false;
    }
    try {
      const next = await (operation === "rename"
        ? desktop.renameFile(file.path, value)
        : desktop.moveFile(file.path, value));
      const document = documentsRef.current.find(
        (item) => item.path === file.path,
      );
      if (document) {
        document.path = next.path;
        document.title = fileTitle(next.path);
        if (document.dirty) {
          scheduleDraft(document);
        }
        refresh();
        saveSession();
      }
      await refreshProjects();
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    }
  };

  const createFolder = async (name: string) => {
    try {
      await desktop.createFolder(name);
      await refreshProjects();
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    }
  };

  const recover = async (draft: RecoveryDraft) => {
    const existing = documentsRef.current.find(
      (document) => document.id === draft.id,
    );
    if (existing) {
      activate(existing.id);
      return true;
    }
    try {
      const data = await parse(draft.content);
      const opened = documentsRef.current.find(
        (document) => document.id === draft.id,
      );
      if (opened) {
        activate(opened.id);
        return true;
      }
      await desktop.writeDraft({ ...draft, path: null });
      const recovered = documentsRef.current.find(
        (document) => document.id === draft.id,
      );
      if (recovered) {
        activate(recovered.id);
        return true;
      }
      createDocument(data, undefined, draft);
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    }
  };

  const renameDocument = async (id: string, name: string) => {
    const document = documentsRef.current.find((item) => item.id === id);
    if (!document || closingRef.current) {
      return false;
    }
    const trimmed = name.trim();
    const title = fileTitle(trimmed);
    if (
      !trimmed ||
      !title ||
      title === "." ||
      title === ".." ||
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      Array.from(trimmed).some((character) => character.charCodeAt(0) < 32)
    ) {
      setError("请输入有效的画布名称，不要包含路径或特殊字符。");
      return false;
    }
    document.api?.commitEditing();
    captureAPI(document);
    if (document.saving) {
      await document.saving;
    }
    if (document.path) {
      return mutateFile(
        "rename",
        {
          path: document.path,
          relativePath: document.path,
          name: document.path.split("/").pop()!,
          category: "",
          modifiedAt: document.modifiedAt || 0,
          size: document.content.length,
        },
        title,
      );
    }
    document.title = title;
    if (document.dirty) {
      scheduleDraft(document);
    }
    refresh();
    return true;
  };

  const discardDraft = async (id: string) => {
    try {
      await desktop.deleteDraft(id);
      setDrafts((current) => current.filter((draft) => draft.id !== id));
    } catch (failure) {
      reportError(failure);
    }
  };

  handlers.current = {
    open: (files) => {
      if (!closingRef.current) {
        void openDocuments(files);
      }
    },
    command: (command) => {
      if (command === "undo" || command === "redo") {
        void handleDesktopEditingCommand(root, command, {
          canvasActive: !!activeRef.current && !projectRef.current,
          blocked: modalOpen || closingRef.current || !!closePrompt,
        }).catch(reportError);
        return;
      }
      if (modalOpen) {
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
          createDocument();
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

  useEffect(() => {
    let disposed = false;
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
        setSettings((current) => ({ ...current, ...initialSettings }));
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
      removeCommand();
      removeFiles();
      ownerWindow.removeEventListener("focus", onFocus);
      for (const document of documentsRef.current) {
        ownerWindow.clearTimeout(document.draftTimer);
      }
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
    clearError: () => setFailure(null),
    reportError,
    activate,
    showProjects,
    refreshProjects,
    newDocument: () => createDocument(),
    openFiles,
    openProject,
    initialize,
    capture,
    editorSave,
    requestSave,
    closeDocument,
    removeFile,
    updateSettings,
    changeDirectory,
    changeTheme,
    mutateFile,
    renameDocument,
    createFolder,
    recover,
    discardDraft,
  };
};

export type Workspace = ReturnType<typeof useWorkspace>;
