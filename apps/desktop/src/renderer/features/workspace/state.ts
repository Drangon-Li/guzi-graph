import { useRef, useState } from "react";

import { errorMessage } from "../../shared/model/document";
import { DEFAULT_EDITOR_PREFERENCES } from "../../shared/config/editorPreferences";

import type { PluginRequest } from "../../../shared/plugins";
import type {
  DesktopCommand,
  DesktopSettings,
  DiskDocument,
  ProjectCategory,
  ProjectIndex,
  RecoveryDraft,
} from "../../../shared/desktop-api";
import type { CanvasDocument, ClosePrompt } from "./types";

/** Refs and React state shared by every workspace action module. */
export const useWorkspaceState = (
  root: HTMLElement,
  modalOpen: boolean | (() => boolean),
) => {
  const isModalOpen = () =>
    typeof modalOpen === "function" ? modalOpen() : modalOpen;
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const desktop = ownerWindow.desktop;
  const documentsRef = useRef<CanvasDocument[]>([]);
  const activeRef = useRef<string | null>(null);
  const projectRef = useRef(true);
  const readyRef = useRef(false);
  const closingRef = useRef(false);
  const openQueue = useRef(Promise.resolve());
  const fileDialogPending = useRef(false);
  const pendingImageActions = useRef(
    new WeakMap<CanvasDocument, (() => void)[]>(),
  );
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
    pinnedFoldersByRoot: {},
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [{ index, folderRelocation }, setProjects] = useState<{
    index: ProjectIndex;
    folderRelocation: null | {
      id: number;
      rootDirectory: string;
      source: string;
      destination: string;
    };
  }>({
    index: { rootDirectory: null, files: [], folders: [], history: [] },
    folderRelocation: null,
  });
  const relocationId = useRef(0);
  const setIndex = (index: ProjectIndex) =>
    setProjects((current) => ({
      index,
      folderRelocation:
        index.rootDirectory === current.folderRelocation?.rootDirectory
          ? current.folderRelocation
          : null,
    }));
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
  const [newCanvasDialog, setNewCanvasDialog] = useState<{
    initialSaveCategory?: ProjectCategory;
  } | null>(null);
  const [pdfImportDialog, setPdfImportDialog] = useState(false);
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

  return {
    root,
    isModalOpen,
    ownerDocument,
    ownerWindow,
    desktop,
    documentsRef,
    activeRef,
    projectRef,
    readyRef,
    closingRef,
    openQueue,
    fileDialogPending,
    pendingImageActions,
    removalVersion,
    removedPaths,
    pendingRemovals,
    sessionQueue,
    settingsQueue,
    settingsRef,
    relocationId,
    setIndex,
    setError,
    handlers,
    pluginRequests,
    pluginDisposed,
    pluginPending,
    pluginWrites,
    refresh,
    reportError,
    settings,
    setSettings,
    index,
    folderRelocation,
    setProjects,
    loading,
    setLoading,
    closing,
    setClosing,
    failure,
    setFailure,
    drafts,
    setDrafts,
    closePrompt,
    setClosePrompt,
    newCanvasDialog,
    setNewCanvasDialog,
    pdfImportDialog,
    setPdfImportDialog,
  };
};

export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
