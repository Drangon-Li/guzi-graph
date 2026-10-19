import { serializeAsJSON } from "@excalidraw/excalidraw";
import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export interface SceneSnapshot {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}

const fileSignatures = new WeakMap<object, string>();

const fileSignature = (file: BinaryFiles[string]) => {
  let signature = fileSignatures.get(file);
  if (signature === undefined) {
    signature = JSON.stringify([file.id, file.mimeType, file.dataURL]);
    fileSignatures.set(file, signature);
  }
  return signature;
};

// Image strings are compared only when a file object changes; pointer events
// keep the same objects and never serialize the embedded image data.
export const createSceneTracker = () => {
  let elementSignature = "";
  let appStateSignature = "";
  let referencedFiles: string[] = [];
  let content = "";

  return (snapshot: SceneSnapshot) => {
    const nextElements = JSON.stringify(
      snapshot.elements.map(({ id, version, versionNonce, isDeleted }) => [
        id,
        version,
        versionNonce,
        isDeleted,
      ]),
    );
    const nextAppState = JSON.stringify(
      cleanAppStateForExport(snapshot.appState),
    );
    const fileIds = new Set<string>();
    for (const element of snapshot.elements) {
      if (!element.isDeleted && "fileId" in element && element.fileId) {
        fileIds.add(element.fileId);
      }
    }
    const nextFiles = [...fileIds]
      .sort()
      .map((id) => snapshot.files[id] && fileSignature(snapshot.files[id]))
      .filter((value): value is string => !!value);
    if (
      nextElements !== elementSignature ||
      nextAppState !== appStateSignature ||
      nextFiles.length !== referencedFiles.length ||
      nextFiles.some((value, index) => value !== referencedFiles[index]) ||
      !content
    ) {
      elementSignature = nextElements;
      appStateSignature = nextAppState;
      referencedFiles = nextFiles;
      content = serializeAsJSON(
        snapshot.elements,
        snapshot.appState,
        snapshot.files,
        "local",
      );
    }
    return content;
  };
};

export const fileTitle = (path: string) =>
  (path.split(/[\\/]/).pop() || "未命名").replace(/\.excalidraw$/i, "");

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
