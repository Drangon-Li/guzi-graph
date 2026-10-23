import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { loadFromBlob, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";
import { collectSubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";
import { getNormalizedZoom } from "@excalidraw/excalidraw/scene/normalize";
import { getCommonBounds, getNonDeletedElements } from "@excalidraw/element";
import {
  exportToCanvas,
  exportToSvg,
} from "@excalidraw/excalidraw/scene/export";

import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { HistoryCheckpoint } from "@excalidraw/excalidraw/history";

import {
  createSceneTracker,
  errorMessage,
  fileTitle,
} from "../../shared/model/document";
import { handleDesktopEditingCommand } from "../editor/desktopEditing";
import {
  CanvasCommandError,
  CANVAS_CAPABILITIES,
  canvasExportDimensions,
  isCanvasBusy,
  loadCanvasOperationFonts,
  objectArgument,
  prepareCanvasOperations,
  stringArgument,
} from "../plugins/canvasCommands";
import {
  DEFAULT_EDITOR_PREFERENCES,
  registerPreferenceFonts,
  resolveEditorPreferences,
  getPreferenceColorTopPicks,
} from "../../shared/config/editorPreferences";
import { translate } from "../../shared/i18n/i18n";
import {
  copyPresentationScene,
  createPresentation,
  getSlideBounds,
  parsePresentation,
  serializePresentation,
} from "../presentation/model";

import {
  renderSlideSvg,
  renderSlidePng,
  renderPresentationPdfPages,
} from "../presentation/renderSlide";

import type { Presentation } from "../presentation/model";
import type {
  PresentationController,
  PresentationControlCommand,
} from "../presentation/control";

import type { SceneSnapshot } from "../../shared/model/document";
import type { PluginRequest, PluginResponse } from "../../../shared/plugins";
import type {
  DesktopCommand,
  DesktopSettings,
  DiskDocument,
  ProjectFile,
  ProjectIndex,
  RecoveryDraft,
} from "../../../shared/desktop-api";

export interface CanvasDocument {
  presentation?: Presentation;
  activeSlideId?: string;
  activeSlideContent?: string;
  presenting?: boolean;
  presentationController?: PresentationController;
  invalidateSubsceneHistory?: (ids: string[]) => void;
  slideRuntime?: Map<
    string,
    {
      snapshot?: SceneSnapshot;
      history?: HistoryCheckpoint;
      children: Map<string, HistoryCheckpoint>;
    }
  >;
  id: string;
  path: string | null;
  title: string;
  modifiedAt: number | null;
  initialData: ExcalidrawInitialDataState;
  api: ExcalidrawImperativeAPI | null;
  initialized: boolean;
  flushEditing?: () => void;
  getSnapshot?: () => SceneSnapshot;
  activeEditor?: () => ExcalidrawImperativeAPI | null;
  dirty: boolean;
  revision: number;
  content: string;
  savedContent: string | null;
  tracker: ReturnType<typeof createSceneTracker>;
  draftTimer?: number;
  draftTask: Promise<void>;
  saving: Promise<boolean> | null;
  recovered: boolean;
  unsavedCopy?: boolean;
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
    toolPanelPinned: false,
    toolbarTooltips: true,
    selectionToolbar: true,
    editorPreferences: DEFAULT_EDITOR_PREFERENCES,
    language: "zh-CN",
    structuredExportFormat: "json",
    includeInferredStructure: true,
    skipRemoveConfirmation: false,
    skipTrashConfirmation: false,
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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
    plugin: async (_request: PluginRequest): Promise<unknown> => undefined,
  });
  const pluginRequests = useRef(
    new Map<
      string,
      {
        fingerprint: string;
        task: Promise<unknown>;
        documentId?: string;
      }
    >(),
  );
  const pluginDisposed = useRef(false);
  const pluginPending = useRef(new Map<string, { cancelled: boolean }>());
  const pluginWrites = useRef(new Set<string>());

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
      const previous = documentsRef.current.find(
        (item) => item.id === activeRef.current,
      );
      if (previous?.flushEditing) {
        previous.flushEditing();
      } else {
        previous?.api?.commitEditing();
      }
    }
    activeRef.current = id;
    projectRef.current = false;
    refresh();
    saveSession();
  };

  const showProjects = () => {
    const current = documentsRef.current.find(
      (item) => item.id === activeRef.current,
    );
    if (current?.flushEditing) {
      current.flushEditing();
    } else {
      current?.api?.commitEditing();
    }
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
          currentItemStickyNoteMode:
            settingsRef.current.stickyNoteMode ?? "note",
        },
      },
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

  const recordContent = (document: CanvasDocument, content: string) => {
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
    document.revision += 1;
    if (!document.initialized) {
      return;
    }
    const wasDirty = document.dirty;
    document.dirty = content !== document.savedContent;
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
      recordContent(document, sceneContent);
    }
  };

  const captureAPI = (document: CanvasDocument) => {
    if (!document.api || document.api.isDestroyed) {
      return;
    }
    capture(
      document,
      document.getSnapshot?.() ?? {
        elements: document.api.getSceneElementsIncludingDeleted(),
        appState: document.api.getAppState(),
        files: document.api.getFiles(),
      },
    );
  };

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
    document.initialized = true;
    const unsaved = document.recovered || !!document.unsavedCopy;
    document.savedContent = unsaved ? null : document.content;
    document.dirty = unsaved;
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
    const content = document.content;
    const revision = document.revision;
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
        document.savedContent = content;
        document.recovered = false;
        document.unsavedCopy = false;
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

  const requestSave = (document: CanvasDocument, saveAs = false) => {
    if (!documentsRef.current.includes(document) || document.removalPhase) {
      return Promise.resolve(false);
    }
    const editor = document.activeEditor?.() ?? document.api;
    return editor?.desktopSave(saveAs) || Promise.resolve(false);
  };

  const commitText = (document: CanvasDocument) => {
    document.flushEditing
      ? document.flushEditing()
      : document.api?.commitEditing();
    captureAPI(document);
  };

  const newPresentation = (source?: CanvasDocument) => {
    if (closingRef.current) {
      return;
    }
    if (source) {
      commitText(source);
    }
    const snapshot =
      source?.getSnapshot?.() ??
      (source?.api
        ? {
            elements: source.api.getSceneElementsIncludingDeleted(),
            appState: source.api.getAppState(),
            files: source.api.getFiles(),
          }
        : undefined);
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
    if (!document.activeSlideId || !document.api || document.api.isDestroyed) {
      return;
    }
    const previous = document.slideRuntime!.get(document.activeSlideId);
    document.slideRuntime!.set(document.activeSlideId, {
      children: previous?.children ?? new Map(),
      snapshot: document.getSnapshot?.() ?? {
        elements: document.api.getSceneElementsIncludingDeleted(),
        appState: document.api.getAppState(),
        files: document.api.getFiles(),
      },
      history: document.api.history.checkpoint?.(),
    });
  };

  const selectSlide = (document: CanvasDocument, id: string) => {
    const slide = document.presentation?.slides.find((item) => item.id === id);
    if (!slide || document.activeSlideId === id || document.presenting) {
      return;
    }
    checkpointSlide(document);
    const cached = document.slideRuntime!.get(id);
    document.activeSlideId = id;
    document.initialData = cached?.snapshot ?? slide.scene;
    document.tracker = createSceneTracker();
    document.activeSlideContent = undefined;
    document.api = null;
    delete document.getSnapshot;
    delete document.flushEditing;
    delete document.activeEditor;
    refresh();
  };

  const changeSlides = (
    document: CanvasDocument,
    change: (deck: Presentation) => void,
  ) => {
    if (!document.presentation || document.presenting) {
      return;
    }
    commitText(document);
    change(document.presentation);
    recordContent(document, serializePresentation(document.presentation));
  };

  const addSlide = (document: CanvasDocument, duplicateId?: string) => {
    let id = "";
    changeSlides(document, (deck) => {
      const source = deck.slides.find((slide) => slide.id === duplicateId);
      id = ownerWindow.crypto.randomUUID();
      const index = deck.slides.findIndex(
        (slide) => slide.id === (duplicateId ?? document.activeSlideId),
      );
      const title = settingsRef.current.language === "en" ? "Slide" : "页面";
      const slide = {
        id,
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
    });
    if (id) {
      selectSlide(document, id);
    }
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
    commitText(document);
    return serializePresentation({ ...document.presentation, slides: [slide] });
  };

  const pasteSlide = async (document: CanvasDocument, content: string) => {
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
      title: `${slide.title} ${
        settingsRef.current.language === "en" ? "copy" : "副本"
      }`,
      bounds: { ...getSlideBounds(slide, source.width, source.height) },
      scene: copyPresentationScene(slide.scene),
    }));
    changeSlides(document, (deck) => {
      const index = deck.slides.findIndex(
        (slide) => slide.id === document.activeSlideId,
      );
      deck.slides.splice(index + 1, 0, ...slides);
    });
    selectSlide(document, slides[0].id);
  };

  const deleteSlide = (document: CanvasDocument, id: string) => {
    const deck = document.presentation;
    if (!deck || deck.slides.length <= 1 || document.presenting) {
      return;
    }
    const index = deck.slides.findIndex((slide) => slide.id === id);
    if (index < 0) {
      return;
    }
    if (document.activeSlideId === id) {
      selectSlide(
        document,
        deck.slides[index + 1]?.id ?? deck.slides[index - 1].id,
      );
    }
    changeSlides(document, () => {
      deck.slides = deck.slides.filter((slide) => slide.id !== id);
      document.slideRuntime!.delete(id);
    });
  };

  const renameSlide = (document: CanvasDocument, id: string, title: string) => {
    if (title.trim()) {
      changeSlides(document, (deck) => {
        deck.slides = deck.slides.map((slide) =>
          slide.id === id ? { ...slide, title: title.trim() } : slide,
        );
      });
    }
  };

  const moveSlide = (document: CanvasDocument, id: string, toIndex: number) => {
    changeSlides(document, (deck) => {
      const fromIndex = deck.slides.findIndex((slide) => slide.id === id);
      if (fromIndex < 0 || toIndex < 0 || toIndex >= deck.slides.length) {
        return;
      }
      const slides = [...deck.slides];
      slides.splice(toIndex, 0, slides.splice(fromIndex, 1)[0]);
      deck.slides = slides;
    });
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
        settingsRef.current = next;
        if (update.stickyNoteMode) {
          for (const document of documentsRef.current) {
            for (const editor of new Set([
              document.api,
              document.activeEditor?.(),
            ])) {
              editor?.updateScene({
                appState: { currentItemStickyNoteMode: update.stickyNoteMode },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        }
        if (update.editorPreferences) {
          registerPreferenceFonts(update.editorPreferences);
          for (const document of documentsRef.current) {
            for (const editor of new Set([
              document.api,
              document.activeEditor?.(),
            ])) {
              editor?.updateScene({
                appState: {
                  fontTopPicks: update.editorPreferences.fontTopPicks,
                  colorTopPicks: getPreferenceColorTopPicks(
                    update.editorPreferences,
                    editor?.getAppState().colorTopPicks,
                  ),
                },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        }
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
    document.flushEditing
      ? document.flushEditing()
      : document.api?.commitEditing();
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

  const canvasDescriptor = (document: CanvasDocument) => ({
    documentId: document.id,
    path: document.path,
    title: document.title,
    revision: document.revision,
    dirty: document.dirty,
    initialized: document.initialized,
    kind: document.presentation ? "presentation" : "canvas",
  });

  const commandDocument = (value: unknown) => {
    const id = stringArgument(value, "documentId");
    const document = documentsRef.current.find((item) => item.id === id);
    if (!document) {
      throw new CanvasCommandError("NOT_FOUND", "Canvas document is not open.");
    }
    if (!document.initialized || !document.api || document.api.isDestroyed) {
      throw new CanvasCommandError("NOT_READY", "Canvas is not initialized.");
    }
    return document;
  };

  const assertCommandAvailable = (
    document?: CanvasDocument,
    allowPresenting = false,
  ) => {
    if (pluginDisposed.current) {
      throw new CanvasCommandError("CANCELLED", "Workspace was closed.");
    }
    if (
      !readyRef.current ||
      closingRef.current ||
      modalOpen ||
      closePrompt ||
      document?.removalPhase ||
      (!allowPresenting && document?.presenting) ||
      (document &&
        document.activeEditor &&
        document.activeEditor() !== document.api)
    ) {
      throw new CanvasCommandError(
        "BUSY",
        "Workspace or canvas is busy. Retry after editing finishes.",
      );
    }
    const editor =
      document?.api ??
      documentsRef.current
        .find((item) => item.id === activeRef.current)
        ?.activeEditor?.() ??
      documentsRef.current.find((item) => item.id === activeRef.current)?.api;
    if (editor && isCanvasBusy(editor.getAppState())) {
      throw new CanvasCommandError(
        "BUSY",
        "Canvas is being edited. Retry after editing finishes.",
      );
    }
  };

  const waitForCanvas = async (
    document: CanvasDocument,
    assertActive: () => void,
  ) => {
    const deadline = Date.now() + 10000;
    while (
      !document.initialized ||
      !document.api ||
      document.api.isDestroyed ||
      document.api.getAppState().isLoading
    ) {
      assertActive();
      if (pluginDisposed.current || !documentsRef.current.includes(document)) {
        throw new CanvasCommandError(
          "CANCELLED",
          "Canvas was closed before initialization.",
        );
      }
      if (Date.now() >= deadline) {
        throw new CanvasCommandError(
          "NOT_READY",
          "Canvas initialization timed out. Retry using list_canvases.",
        );
      }
      await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 25));
    }
    assertActive();
    captureAPI(document);
    return canvasDescriptor(document);
  };

  const presentationDescriptor = (document: CanvasDocument) => ({
    ...canvasDescriptor(document),
    width: document.presentation!.width,
    height: document.presentation!.height,
    activeSlideId: document.activeSlideId,
    presenting: !!document.presenting,
    slides: document.presentation!.slides.map((slide, index) => ({
      id: slide.id,
      title: slide.title,
      index,
      bounds: getSlideBounds(
        slide,
        document.presentation!.width,
        document.presentation!.height,
      ),
      elementCount:
        slide.scene.elements?.filter((element) => !element.isDeleted).length ??
        0,
    })),
  });

  const commandTitle = (value: unknown) => {
    const title = stringArgument(value, "title").trim();
    if (
      title.length > 200 ||
      // eslint-disable-next-line no-control-regex
      /[\\/\u0000-\u001f]/.test(title) ||
      title === "." ||
      title === ".."
    ) {
      throw new CanvasCommandError(
        "INVALID_ARGUMENT",
        "title must be a valid filename of at most 200 characters.",
      );
    }
    return title;
  };

  const assertRevision = (
    document: CanvasDocument,
    args: Record<string, unknown>,
  ) => {
    stringArgument(args.requestId, "requestId");
    if (
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision !== document.revision
    ) {
      throw new CanvasCommandError(
        "REVISION_CONFLICT",
        `Expected revision ${document.revision}. Read the document and retry.`,
      );
    }
  };

  const commandSnapshot = (
    document: CanvasDocument,
    args: Record<string, unknown>,
  ) => {
    const slideId =
      args.slideId === undefined
        ? document.activeSlideId
        : stringArgument(args.slideId, "slideId");
    if (args.slideId !== undefined && !document.presentation) {
      throw new CanvasCommandError(
        "INVALID_ARGUMENT",
        "slideId requires a presentation document.",
      );
    }
    const slide = document.presentation?.slides.find(
      (item) => item.id === slideId,
    );
    if (document.presentation && !slide) {
      throw new CanvasCommandError("NOT_FOUND", "Slide does not exist.");
    }
    const api = document.api!;
    const rootSnapshot: SceneSnapshot =
      !slide || slide.id === document.activeSlideId
        ? document.getSnapshot?.() ?? {
            elements: api.getSceneElementsIncludingDeleted(),
            appState: api.getAppState(),
            files: api.getFiles(),
          }
        : {
            elements: slide.scene.elements ?? [],
            appState: {
              ...api.getAppState(),
              ...restoreAppState(slide.scene.appState, null),
            },
            files: slide.scene.files ?? {},
          };
    const subsceneId =
      args.subsceneId === undefined
        ? undefined
        : stringArgument(args.subsceneId, "subsceneId");
    const scenes = collectSubcanvasScenes(
      rootSnapshot.elements,
      rootSnapshot.appState.subscenes,
    );
    const subscene = subsceneId ? scenes[subsceneId] : undefined;
    if (subsceneId && !subscene) {
      throw new CanvasCommandError(
        "NOT_FOUND",
        "Subcanvas is not reachable from the requested canvas or slide.",
      );
    }
    const snapshot: SceneSnapshot = subscene
      ? {
          elements: subscene.elements,
          appState: {
            ...api.getAppState(),
            ...restoreAppState(
              { ...subscene.appState, subscenes: scenes },
              null,
            ),
          },
          files: rootSnapshot.files,
        }
      : rootSnapshot;
    return { slide, subsceneId, rootSnapshot, snapshot };
  };

  const blobData = async (blob: Blob) => {
    if (blob.size > 16 * 1024 * 1024) {
      throw new CanvasCommandError(
        "EXPORT_TOO_LARGE",
        "Export exceeds 16 MiB. Reduce the document size.",
      );
    }
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new ownerWindow.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(
          new CanvasCommandError("EXPORT_FAILED", "Export encoding failed."),
        );
      reader.readAsDataURL(blob);
    });
    return { data: url.slice(url.indexOf(",") + 1), mimeType: blob.type };
  };

  const runCanvasCommand = async (request: PluginRequest) => {
    const assertActive = () => {
      const pending = pluginPending.current.get(request.requestId);
      if (pluginDisposed.current || !pending || pending.cancelled) {
        throw new CanvasCommandError(
          "CANCELLED",
          "The plugin request was cancelled.",
        );
      }
      if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) {
        throw new CanvasCommandError(
          "TIMEOUT",
          "The plugin request expired before completion.",
        );
      }
    };
    const canOpen = () => {
      try {
        assertActive();
        assertCommandAvailable();
        return true;
      } catch {
        return false;
      }
    };
    assertActive();
    const args = objectArgument(request.arguments);
    if (request.command === "get_capabilities") {
      return {
        version: 2,
        maxRequestBytes: 2 * 1024 * 1024,
        plugins: {
          apiVersion: 1,
          guide: "get_plugin_development_guide",
          schema: "get_plugin_api_schema",
          activation:
            "Enable installed plugins in Market. MCP is configured in Settings.",
          runtime: "Isolated JavaScript Worker with declared permissions",
        },
        canvas: {
          ...CANVAS_CAPABILITIES,
          controls: ["undo", "redo", "select", "fit", "zoom"],
          close: "close_document (saved documents only)",
        },
        targets: {
          canvas: "documentId",
          slide: "documentId + slideId",
          subcanvas: "documentId + optional slideId + subsceneId",
        },
        presentations: {
          create: "create_presentation",
          open: "open_canvas",
          read: "read_presentation",
          save: "save_presentation",
          operations: [
            "add",
            "duplicate",
            "rename",
            "move",
            "delete",
            "select",
            "copy_from",
          ],
          playback: ["start", "next", "previous", "goto", "stop", "status"],
          export: ["png", "svg", "pdf"],
          format: "guzi-presentation",
          aspectRatio: "16:9",
        },
        defaults: {
          roughness: 1,
          strokeWidth: 2,
          fontFamily: 5,
          style: "hand-drawn unless explicitly requested otherwise",
        },
      };
    }
    if (request.command === "list_canvases") {
      documentsRef.current.forEach(captureAPI);
      const projects = await desktop.listProjects();
      assertActive();
      return {
        activeDocumentId: activeRef.current,
        canvases: documentsRef.current.map(canvasDescriptor),
        files: projects.files.map((file) => ({
          path: file.path,
          title: fileTitle(file.path),
          kind: file.path.endsWith(".guzi-presentation")
            ? "presentation"
            : "canvas",
        })),
      };
    }
    if (
      request.command === "create_canvas" ||
      request.command === "create_presentation"
    ) {
      assertCommandAvailable();
      const title = commandTitle(args.title);
      const source =
        args.sourceDocumentId === undefined
          ? undefined
          : commandDocument(args.sourceDocumentId);
      if (source) {
        assertCommandAvailable(source);
      }
      const document =
        request.command === "create_presentation"
          ? newPresentation(source)!
          : createDocument();
      document.title = title;
      document.unsavedCopy = true;
      document.dirty = true;
      refresh();
      await waitForCanvas(document, assertActive);
      return document.presentation
        ? presentationDescriptor(document)
        : canvasDescriptor(document);
    }
    if (request.command === "open_canvas") {
      assertCommandAvailable();
      const path = stringArgument(args.path, "path");
      const file = await desktop.readFile(path);
      assertActive();
      assertCommandAvailable();
      await openDocuments([file], true, removalVersion.current, canOpen);
      assertActive();
      assertCommandAvailable();
      const document = documentsRef.current.find((item) => item.path === path);
      if (!document) {
        throw new CanvasCommandError(
          "OPEN_FAILED",
          "The requested document could not be opened.",
        );
      }
      await waitForCanvas(document, assertActive);
      return document.presentation
        ? presentationDescriptor(document)
        : canvasDescriptor(document);
    }
    const document = commandDocument(args.documentId);
    captureAPI(document);
    if (
      [
        "read_presentation",
        "update_presentation",
        "control_presentation",
        "export_presentation",
        "save_presentation",
      ].includes(request.command) &&
      !document.presentation
    ) {
      throw new CanvasCommandError(
        "UNSUPPORTED_TARGET",
        "This command requires a presentation document.",
      );
    }
    if (request.command === "read_presentation") {
      return presentationDescriptor(document);
    }
    if (request.command === "update_presentation") {
      assertCommandAvailable(document);
      assertRevision(document, args);
      const operation = objectArgument(args.operation);
      const deck = document.presentation!;
      const slideId =
        operation.slideId === undefined
          ? undefined
          : stringArgument(operation.slideId, "slideId");
      if (slideId && !deck.slides.some((slide) => slide.id === slideId)) {
        throw new CanvasCommandError("NOT_FOUND", "Slide does not exist.");
      }
      if (
        ["duplicate", "rename", "move", "delete", "select"].includes(
          String(operation.type),
        ) &&
        !slideId
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "slideId is required.",
        );
      }
      if (operation.type === "add") {
        const title =
          operation.title === undefined
            ? undefined
            : stringArgument(operation.title, "title").trim();
        const afterId =
          operation.afterSlideId === undefined
            ? undefined
            : stringArgument(operation.afterSlideId, "afterSlideId");
        if (afterId && !deck.slides.some((slide) => slide.id === afterId)) {
          throw new CanvasCommandError(
            "NOT_FOUND",
            "afterSlideId does not exist.",
          );
        }
        const insertion =
          deck.slides.findIndex(
            (slide) => slide.id === (afterId ?? document.activeSlideId),
          ) + 1;
        addSlide(document);
        if (title) {
          renameSlide(document, document.activeSlideId!, title);
        }
        moveSlide(document, document.activeSlideId!, insertion);
      } else if (operation.type === "duplicate") {
        addSlide(document, slideId);
      } else if (operation.type === "rename") {
        renameSlide(
          document,
          slideId!,
          stringArgument(operation.title, "title"),
        );
      } else if (operation.type === "move") {
        if (
          !Number.isInteger(operation.toIndex) ||
          Number(operation.toIndex) < 0 ||
          Number(operation.toIndex) >= deck.slides.length
        ) {
          throw new CanvasCommandError(
            "INVALID_ARGUMENT",
            "toIndex is outside the slide list.",
          );
        }
        moveSlide(document, slideId!, Number(operation.toIndex));
      } else if (operation.type === "delete") {
        if (deck.slides.length === 1) {
          throw new CanvasCommandError(
            "INVALID_ARGUMENT",
            "A presentation must retain at least one slide.",
          );
        }
        deleteSlide(document, slideId!);
      } else if (operation.type === "select") {
        selectSlide(document, slideId!);
      } else if (operation.type === "copy_from") {
        const source = commandDocument(operation.sourceDocumentId);
        assertCommandAvailable(source);
        captureAPI(source);
        const sourceId = stringArgument(
          operation.sourceSlideId,
          "sourceSlideId",
        );
        const slide = source.presentation?.slides.find(
          (item) => item.id === sourceId,
        );
        if (!slide) {
          throw new CanvasCommandError(
            "NOT_FOUND",
            "Source presentation slide does not exist.",
          );
        }
        const copy = {
          id: ownerWindow.crypto.randomUUID(),
          title: slide.title,
          bounds: {
            ...getSlideBounds(
              slide,
              source.presentation!.width,
              source.presentation!.height,
            ),
          },
          scene: copyPresentationScene(slide.scene),
        };
        changeSlides(document, (deck) => {
          const index = deck.slides.findIndex(
            (item) => item.id === document.activeSlideId,
          );
          deck.slides.splice(index + 1, 0, copy);
        });
        selectSlide(document, copy.id);
      } else {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Unknown presentation operation.",
        );
      }
      await waitForCanvas(document, assertActive);
      return presentationDescriptor(document);
    }
    if (request.command === "control_presentation") {
      const action = stringArgument(args.action, "action");
      if (
        !["start", "next", "previous", "goto", "stop", "status"].includes(
          action,
        )
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Unknown playback action.",
        );
      }
      if (action !== "status" && action !== "stop") {
        assertCommandAvailable(document, true);
        if (action === "start") {
          assertCommandAvailable();
          flushSync(() => activate(document.id));
        }
      }
      if (!document.presentationController) {
        throw new CanvasCommandError(
          "NOT_READY",
          "Presentation controls are not mounted.",
        );
      }
      const state = await document.presentationController.execute({
        action: action as PresentationControlCommand["action"],
        ...(args.slideId === undefined
          ? {}
          : { slideId: stringArgument(args.slideId, "slideId") }),
      });
      assertActive();
      return { documentId: document.id, ...state };
    }
    if (
      request.command === "save_canvas" ||
      request.command === "save_presentation"
    ) {
      assertCommandAvailable(document);
      if (
        !(await saveDocument(document, false, undefined, false, true, () => {
          assertActive();
          assertCommandAvailable(document);
        }))
      ) {
        throw new CanvasCommandError(
          "SAVE_FAILED",
          "The document could not be saved.",
        );
      }
      assertActive();
      return document.presentation
        ? presentationDescriptor(document)
        : canvasDescriptor(document);
    }
    if (request.command === "export_presentation") {
      const deck: Presentation = JSON.parse(
        serializePresentation(document.presentation!),
      );
      const revision = document.revision;
      const exportSlideId =
        args.slideId === undefined
          ? document.activeSlideId
          : stringArgument(args.slideId, "slideId");
      const exportSlide = deck.slides.find(
        (slide) => slide.id === exportSlideId,
      );
      if (!exportSlide) {
        throw new CanvasCommandError("NOT_FOUND", "Slide does not exist.");
      }
      let blob: Blob;
      if (args.format === "pdf") {
        const pages = await renderPresentationPdfPages(
          args.slideId === undefined
            ? deck
            : { ...deck, slides: [exportSlide] },
          ownerDocument,
        );
        assertActive();
        const [first, ...remaining] = pages;
        const bytes = await desktop.exportPdf({
          name: document.title,
          ...first,
          ...(remaining.length ? { pages: remaining } : {}),
        });
        blob = new ownerWindow.Blob([bytes], { type: "application/pdf" });
      } else if (args.format === "png" || args.format === "svg") {
        const scale =
          args.format === "png"
            ? canvasExportDimensions(deck.width, deck.height).scale
            : 1;
        blob =
          args.format === "png"
            ? await renderSlidePng(
                {
                  ...exportSlide,
                  bounds: getSlideBounds(exportSlide, deck.width, deck.height),
                },
                deck.width * scale,
                deck.height * scale,
                ownerDocument,
              )
            : new ownerWindow.Blob(
                [
                  (
                    await renderSlideSvg(
                      exportSlide,
                      deck.width,
                      deck.height,
                      ownerDocument,
                    )
                  ).outerHTML,
                ],
                { type: "image/svg+xml" },
              );
      } else {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "format must be png, svg or pdf.",
        );
      }
      const data = await blobData(blob);
      assertActive();
      return {
        documentId: document.id,
        revision,
        ...(args.format === "pdf"
          ? { file: { ...data, name: `${document.title}.pdf` } }
          : { slideId: exportSlideId, image: data }),
      };
    }
    if (request.command === "close_document") {
      assertCommandAvailable(document);
      if (document.saving) {
        throw new CanvasCommandError(
          "BUSY",
          "Wait for the current save before closing.",
        );
      }
      if (document.dirty || !document.path) {
        throw new CanvasCommandError(
          "UNSAVED_CHANGES",
          "Save the document before closing it through MCP.",
        );
      }
      assertActive();
      flushSync(() => detachDocument(document));
      return { documentId: document.id, path: document.path, closed: true };
    }
    if (request.command === "control_canvas") {
      assertCommandAvailable(document);
      const action = stringArgument(args.action, "action");
      if (!["undo", "redo", "select", "fit", "zoom"].includes(action)) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Unknown canvas control action.",
        );
      }
      if (args.subsceneId !== undefined) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Canvas controls do not accept subsceneId.",
        );
      }
      commandSnapshot(document, args);
      if (
        args.slideId !== undefined &&
        document.activeSlideId !== args.slideId
      ) {
        assertCommandAvailable();
        flushSync(() => {
          activate(document.id);
          selectSlide(document, String(args.slideId));
        });
        await waitForCanvas(document, assertActive);
        assertCommandAvailable(document);
        if (document.activeSlideId !== args.slideId) {
          throw new CanvasCommandError(
            "BUSY",
            "The active slide changed while its editor was initializing. Retry the command.",
          );
        }
      }
      const targetApi = document.api!;
      const elements = targetApi
        .getSceneElementsIncludingDeleted()
        .filter((element) => !element.isDeleted);
      const ids = args.ids === undefined ? undefined : args.ids;
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.some(
            (id) =>
              typeof id !== "string" ||
              !elements.some((element) => element.id === id),
          ))
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "ids must contain existing element IDs.",
        );
      }
      if (action === "select" && !Array.isArray(ids)) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "select requires ids (use [] to clear).",
        );
      }
      if (
        action === "zoom" &&
        (typeof args.zoom !== "number" ||
          !Number.isFinite(args.zoom) ||
          args.zoom < 0.1 ||
          args.zoom > 10)
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "zoom must be between 0.1 and 10.",
        );
      }
      assertActive();
      flushSync(() => {
        if (action === "undo" || action === "redo") {
          const operation = targetApi.history[action];
          if (!operation) {
            throw new CanvasCommandError(
              "UNSUPPORTED_TARGET",
              "History control is unavailable in this editor.",
            );
          }
          operation();
        } else if (action === "select") {
          targetApi.selection.select(ids as string[]);
        } else if (action === "fit") {
          const selected = ids
            ? elements.filter((element) =>
                (ids as string[]).includes(element.id),
              )
            : elements;
          const slide = document.presentation?.slides.find(
            (slide) => slide.id === document.activeSlideId,
          );
          targetApi.setViewport({
            target:
              !ids && slide
                ? getSlideBounds(
                    slide,
                    document.presentation!.width,
                    document.presentation!.height,
                  )
                : selected,
            fit: "contain",
            animation: false,
          });
        } else {
          targetApi.updateScene({
            appState: {
              ...targetApi.getAppState(),
              zoom: { value: getNormalizedZoom(Number(args.zoom)) },
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      });
      captureAPI(document);
      return {
        ...canvasDescriptor(document),
        slideId: document.activeSlideId,
        selectedElementIds: Object.keys(
          targetApi.getAppState().selectedElementIds,
        ),
        zoom: targetApi.getAppState().zoom.value,
      };
    }
    const target = commandSnapshot(document, args);
    const { snapshot } = target;
    const targetDescriptor = {
      ...canvasDescriptor(document),
      ...(target.slide ? { slideId: target.slide.id } : {}),
      ...(target.subsceneId ? { subsceneId: target.subsceneId } : {}),
    };
    if (request.command === "read_canvas") {
      return {
        ...targetDescriptor,
        elements: snapshot.elements.filter((element) => !element.isDeleted),
        appState: {
          viewBackgroundColor: snapshot.appState.viewBackgroundColor,
          gridModeEnabled: snapshot.appState.gridModeEnabled,
          gridSize: snapshot.appState.gridSize,
          objectsSnapModeEnabled: snapshot.appState.objectsSnapModeEnabled,
        },
        files: Object.values(snapshot.files).map(({ id, mimeType }) => ({
          id,
          mimeType,
        })),
        subscenes: Object.entries(
          collectSubcanvasScenes(
            snapshot.elements,
            snapshot.appState.subscenes,
          ),
        ).map(([id, scene]) => ({
          id,
          title: scene.title,
          elementCount: scene.elements.filter((element) => !element.isDeleted)
            .length,
        })),
      };
    }
    if (request.command === "apply_operations") {
      assertCommandAvailable(document);
      assertRevision(document, args);
      const preflight = prepareCanvasOperations(
        snapshot.elements,
        args.operations,
        snapshot.appState,
        { files: snapshot.files, subscenes: snapshot.appState.subscenes },
      );
      await loadCanvasOperationFonts(preflight.elements, ownerDocument);
      assertActive();
      commandDocument(args.documentId);
      assertCommandAvailable(document);
      captureAPI(document);
      assertRevision(document, args);
      const writeTarget = commandSnapshot(document, args);
      if (writeTarget.slide?.id !== target.slide?.id) {
        throw new CanvasCommandError(
          "BUSY",
          "The active slide changed while preparing the operation. Retry with an explicit slideId.",
        );
      }
      const writeSnapshot = writeTarget.snapshot;
      const prepared = prepareCanvasOperations(
        writeSnapshot.elements,
        args.operations,
        writeSnapshot.appState,
        {
          files: writeSnapshot.files,
          subscenes: writeSnapshot.appState.subscenes,
        },
      );
      const writeApi = document.api!;
      let next: SceneSnapshot = {
        elements: prepared.elements,
        files: prepared.files,
        appState: {
          ...writeSnapshot.appState,
          ...prepared.appState,
          subscenes: prepared.subscenes,
        },
      };
      if (writeTarget.subsceneId) {
        const original =
          writeTarget.rootSnapshot.appState.subscenes[writeTarget.subsceneId];
        next = {
          ...writeTarget.rootSnapshot,
          files: prepared.files,
          appState: {
            ...writeTarget.rootSnapshot.appState,
            subscenes: {
              ...prepared.subscenes,
              [writeTarget.subsceneId]: {
                ...original,
                elements: next.elements,
                appState: { ...original.appState, ...prepared.appState },
              },
            },
          },
        };
      }
      if (
        writeTarget.slide &&
        writeTarget.slide.id !== document.activeSlideId
      ) {
        writeTarget.slide.scene = next;
        document.slideRuntime?.delete(writeTarget.slide.id);
        recordContent(document, serializePresentation(document.presentation!));
      } else {
        document.invalidateSubsceneHistory?.(
          Object.keys(next.appState.subscenes),
        );
        flushSync(() => {
          const addedFiles = Object.values(next.files).filter(
            (file) => writeApi.getFiles()[file.id] !== file,
          );
          if (addedFiles.length) {
            writeApi.addFiles(addedFiles);
          }
          writeApi.updateScene({
            elements: next.elements,
            appState: {
              ...writeApi.getAppState(),
              ...(!writeTarget.subsceneId ? prepared.appState : {}),
              subscenes: next.appState.subscenes,
            },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
        });
        captureAPI(document);
      }
      return {
        ...targetDescriptor,
        revision: document.revision,
        dirty: document.dirty,
        idMap: prepared.idMap,
      };
    }
    if (request.command === "export_canvas") {
      if (args.format !== "png" && args.format !== "svg") {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "format must be png or svg.",
        );
      }
      const elements = JSON.parse(
        JSON.stringify(getNonDeletedElements(snapshot.elements)),
      );
      const appState = { ...snapshot.appState, exportEmbedScene: false };
      let blob: Blob;
      if (args.format === "svg") {
        const svg = await exportToSvg(elements, appState, snapshot.files, {
          ownerDocument,
        });
        blob = new ownerWindow.Blob([svg.outerHTML], { type: "image/svg+xml" });
      } else {
        const canvas = await exportToCanvas(
          elements,
          appState,
          snapshot.files,
          {
            exportBackground: appState.exportBackground,
            viewBackgroundColor: appState.viewBackgroundColor,
          },
          (width, height) => {
            const dimensions = canvasExportDimensions(width, height);
            const canvas = ownerDocument.createElement("canvas");
            canvas.width = dimensions.width;
            canvas.height = dimensions.height;
            return { canvas, scale: dimensions.scale };
          },
        );
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) =>
              result
                ? resolve(result)
                : reject(
                    new CanvasCommandError(
                      "EXPORT_FAILED",
                      "PNG encoding failed.",
                    ),
                  ),
            "image/png",
          ),
        );
      }
      const image = await blobData(blob);
      assertActive();
      return { ...targetDescriptor, image };
    }
    throw new CanvasCommandError("UNKNOWN_COMMAND", "Unknown canvas command.");
  };

  const handlePluginRequest = (request: PluginRequest) => {
    const idempotent = ["apply_operations", "update_presentation"].includes(
      request.command,
    );
    const key = idempotent
      ? `${request.command}:${String(
          request.arguments.documentId,
        )}:${stringArgument(request.arguments.requestId, "requestId")}`
      : `request:${request.requestId}`;
    const fingerprint = JSON.stringify(
      [request.command, request.arguments],
      (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
    );
    const previous = pluginRequests.current.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new CanvasCommandError(
          "REQUEST_ID_CONFLICT",
          "requestId was already used with different arguments.",
        );
      }
      return previous.task;
    }
    if (idempotent && pluginRequests.current.size >= 10000) {
      throw new CanvasCommandError(
        "BUSY",
        "Idempotent request history is full. Save and close documents, then reopen them to release their history.",
      );
    }
    const write =
      ![
        "get_capabilities",
        "list_canvases",
        "read_canvas",
        "read_presentation",
        "export_canvas",
        "export_presentation",
      ].includes(request.command) &&
      !(
        request.command === "control_presentation" &&
        request.arguments.action === "status"
      );
    const writeKey = String(request.arguments.documentId ?? "workspace");
    if (write && pluginWrites.current.has(writeKey)) {
      throw new CanvasCommandError(
        "BUSY",
        "Another command is modifying this document. Retry after it completes.",
      );
    }
    if (write) {
      pluginWrites.current.add(writeKey);
    }
    const task = runCanvasCommand(request).finally(() => {
      if (write) {
        pluginWrites.current.delete(writeKey);
      }
      if (!idempotent && pluginRequests.current.get(key)?.task === task) {
        pluginRequests.current.delete(key);
      }
    });
    pluginRequests.current.set(key, {
      fingerprint,
      task,
      documentId:
        typeof request.arguments.documentId === "string"
          ? request.arguments.documentId
          : undefined,
    });
    void task.catch(() => {
      if (pluginRequests.current.get(key)?.task === task) {
        pluginRequests.current.delete(key);
      }
    });
    return task;
  };

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
    newPresentation,
    selectSlide,
    addSlide,
    copySlide,
    pasteSlide,
    deleteSlide,
    renameSlide,
    moveSlide,
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
