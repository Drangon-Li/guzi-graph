import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { HistoryCheckpoint } from "@excalidraw/excalidraw/history";
import type { FontFamilyValues } from "@excalidraw/element/types";

import type { createSceneTracker } from "../../shared/model/document";

import type { Presentation } from "../presentation/model";
import type { PresentationController } from "../presentation/control";
import type { SceneSnapshot } from "../../shared/model/document";

export type SlideRuntime = {
  snapshot?: SceneSnapshot;
  history?: HistoryCheckpoint;
  children: Map<string, HistoryCheckpoint>;
};

export type PresentationStructure = {
  slides: Presentation["slides"];
  activeSlideId: string;
  runtime: Map<string, SlideRuntime>;
};

export type PresentationHistoryEntry =
  | { kind: "canvas"; slideId: string; checkpoint: HistoryCheckpoint }
  | {
      kind: "slides" | "fonts";
      before: PresentationStructure;
      after: PresentationStructure;
    };

export interface PresentationHistory {
  undo: PresentationHistoryEntry[];
  redo: PresentationHistoryEntry[];
  replaying: boolean;
  pending?: { entry: PresentationHistoryEntry; direction: "undo" | "redo" };
}

export interface CanvasDocument {
  presentation?: Presentation;
  activeSlideId?: string;
  activeSlideContent?: string;
  presenting?: boolean;
  presentationController?: PresentationController;
  invalidateSubsceneHistory?: (ids: string[]) => void;
  slideRuntime?: Map<string, SlideRuntime>;
  presentationHistory?: PresentationHistory;
  id: string;
  path: string | null;
  title: string;
  modifiedAt: number | null;
  initialData: ExcalidrawInitialDataState;
  api: ExcalidrawImperativeAPI | null;
  initialized: boolean;
  flushEditing?: () => void;
  hasPendingImages?: () => boolean;
  flushPendingImages?: () => Promise<void>;
  missingImageFilesAtOpen?: Set<string>;
  getSnapshot?: () => SceneSnapshot;
  activeEditor?: () => ExcalidrawImperativeAPI | null;
  replaceAllSceneFonts?: (fontFamily: FontFamilyValues) => void;
  dirty: boolean;
  revision: number;
  content: string;
  contentSignature: string;
  savedContentSignature: string | null;
  tracker: ReturnType<typeof createSceneTracker>;
  draftTimer?: number;
  draftTask: Promise<void>;
  saving: Promise<boolean> | null;
  relocating?: Promise<void>;
  recovered: boolean;
  unsavedCopy?: boolean;
  removalPhase?: "guarding" | "removing";
}

export interface ClosePrompt {
  title: string;
  resolve: (choice: "save" | "discard" | "cancel") => void;
}
