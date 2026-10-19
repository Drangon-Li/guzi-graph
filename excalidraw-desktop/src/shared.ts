export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopSettings {
  rootDirectory: string | null;
  theme: DesktopTheme;
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
  documentId: string;
  path: string | null;
  name: string;
  content: string;
  saveAs?: boolean;
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
  | "new"
  | "open"
  | "save"
  | "save-as"
  | "projects"
  | "close-tab"
  | "close-window";

export interface DesktopAPI {
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
  }): Promise<boolean>;
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
