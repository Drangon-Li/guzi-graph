import type { FontSizePresets } from "@excalidraw/common";

import type {
  PluginRequest,
  PluginResponse,
  PluginState,
  UserPluginPackage,
  UserPluginState,
} from "./plugins";

export interface StylePreset {
  id: string;
  name: string;
  shortcut: string;
  tool: "arrow" | "line" | "rectangle" | "ellipse";
  strokeStyle: "solid" | "dashed" | "dotted";
  strokeWidth: 1 | 2 | 4;
  strokeColor: string;
  endArrowhead?: "arrow" | null;
}

export interface EditorPreferences {
  defaultFontFamily: number;
  defaultFontName?: string;
  defaultBackground: string;
  defaultStrokeColor?: string;
  defaultElementBackground?: string;
  elementStrokeTopPicks?: string[];
  elementBackgroundTopPicks?: string[];
  fontSizePresets?: FontSizePresets;
  fontTopPicks: number[];
  backgroundTopPicks: string[];
  systemFonts: { id: number; family: string }[];
}

export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopSettings {
  rootDirectory: string | null;
  theme: DesktopTheme;
  toolPanelDock: "floating" | "left" | "right";
  toolPanelWidth: number;
  toolPanelPinned?: boolean;
  toolbarTooltips?: boolean;
  selectionToolbar?: boolean;
  stickyNoteMode?: "note" | "subcanvas";
  editorPreferences?: EditorPreferences;
  stylePresets?: StylePreset[];
  language: "zh-CN" | "en";
  structuredExportFormat: "json" | "md";
  includeInferredStructure: boolean;
  skipRemoveConfirmation: boolean;
  skipTrashConfirmation: boolean;
}

export interface DiskDocument {
  path: string;
  content: string;
  modifiedAt: number;
  size: number;
}

export interface ProjectFile {
  path: string;
  relativePath: string;
  name: string;
  category: string;
  modifiedAt: number;
  size: number;
}

export interface RecentFile extends ProjectFile {
  lastOpenedAt: number;
}

export interface ProjectIndex {
  rootDirectory: string | null;
  files: ProjectFile[];
  folders: string[];
  history: RecentFile[];
}

export interface SaveRequest {
  format?: "presentation";
  documentId: string;
  path: string | null;
  name: string;
  content: string;
  saveAs?: boolean;
  automation?: boolean;
  expectedModifiedAt?: number | null;
  occupiedPaths?: string[];
}

export interface RecoveryDraft {
  id: string;
  path: string | null;
  title: string;
  content: string;
  modifiedAt: number;
}

export interface DesktopSession {
  paths: string[];
  activePath: string | null;
}

export type DesktopCommand =
  | "undo"
  | "redo"
  | "new"
  | "new-presentation"
  | "open"
  | "save"
  | "save-as"
  | "projects"
  | "close-tab"
  | "close-window";

export interface DesktopAPI {
  readonly platform: string;
  getUserPlugins(): Promise<UserPluginState[]>;
  installUserPlugin(
    plugin: UserPluginPackage,
    overwrite?: boolean,
  ): Promise<UserPluginState[]>;
  setUserPluginEnabled(
    id: string,
    enabled: boolean,
  ): Promise<UserPluginState[]>;
  removeUserPlugin(id: string): Promise<UserPluginState[]>;
  runUserPluginCommand(
    id: string,
    commandId: string,
    args?: Record<string, unknown>,
  ): Promise<unknown>;
  onUserPluginState(callback: (plugins: UserPluginState[]) => void): () => void;
  getPlugins(): Promise<PluginState[]>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginState[]>;
  configurePlugin(
    id: string,
    configuration: { port: number },
  ): Promise<PluginState[]>;
  onPluginState(callback: (plugins: PluginState[]) => void): () => void;
  onPluginRequest(callback: (request: PluginRequest) => void): () => void;
  onPluginRequestCancelled(callback: (requestId: string) => void): () => void;
  respondPluginRequest(response: PluginResponse): void;
  setPluginHostReady(ready: boolean): Promise<void>;
  getSettings(): Promise<DesktopSettings>;
  updateSettings(settings: Partial<DesktopSettings>): Promise<DesktopSettings>;
  chooseDirectory(): Promise<DesktopSettings | null>;
  listProjects(): Promise<ProjectIndex>;
  openFiles(): Promise<DiskDocument[]>;
  readFile(path: string): Promise<DiskDocument>;
  recordOpenedFile(path: string): Promise<void>;
  saveFile(request: SaveRequest): Promise<DiskDocument | null>;
  saveExport(request: {
    name: string;
    extension: string;
    data: ArrayBuffer;
    assets?: { name: string; data: ArrayBuffer }[];
    assetDirectory?: string;
  }): Promise<boolean>;
  savePdf(request: {
    name: string;
    svg: string;
    width: number;
    height: number;
    pages?: { title?: string; svg: string; width: number; height: number }[];
  }): Promise<boolean>;
  exportPdf(request: {
    name: string;
    svg: string;
    width: number;
    height: number;
    pages?: { title?: string; svg: string; width: number; height: number }[];
  }): Promise<ArrayBuffer>;
  editText(command: "undo" | "redo"): Promise<void>;
  removeFile(path: string, mode: "remove" | "trash"): Promise<void>;
  renameFile(path: string, name: string): Promise<DiskDocument>;
  moveFile(path: string, category: string): Promise<DiskDocument>;
  createFolder(category: string): Promise<void>;
  revealFile(path: string): Promise<void>;
  getSession(): Promise<DesktopSession>;
  setSession(session: DesktopSession): Promise<void>;
  listDrafts(): Promise<RecoveryDraft[]>;
  writeDraft(draft: RecoveryDraft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  takePendingFiles(): Promise<DiskDocument[]>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  onFilesOpened(callback: (files: DiskDocument[]) => void): () => void;
  confirmClose(): void;
  cancelClose(): void;
}

declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
