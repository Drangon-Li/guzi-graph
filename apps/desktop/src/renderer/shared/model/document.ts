import { serializeAsJSON } from "@excalidraw/excalidraw";
import { collectSubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";

import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { fileName } from "./path";

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
  let previousScenes: AppState["subscenes"] | undefined;
  let subsceneSignature = "";
  let previousSubsceneSignature = "";
  let subsceneFileIds: string[] = [];
  const sceneSignatures = new WeakMap<
    object,
    { signature: string; fileIds: string[] }
  >();

  return (snapshot: SceneSnapshot) => {
    const nextElements = JSON.stringify(
      snapshot.elements.map(({ id, version, versionNonce, isDeleted }) => [
        id,
        version,
        versionNonce,
        isDeleted,
      ]),
    );
    const { subscenes, ...persistentState } = cleanAppStateForExport(
      snapshot.appState,
    );
    const nextAppState = JSON.stringify(persistentState);
    if (subscenes !== previousScenes || nextElements !== elementSignature) {
      const scenes = collectSubcanvasScenes(snapshot.elements, subscenes);
      const signatures: string[] = [];
      const fileIds = new Set<string>();
      for (const [id, scene] of Object.entries(scenes)) {
        let cached = sceneSignatures.get(scene);
        if (!cached) {
          cached = {
            signature: JSON.stringify([
              scene.title,
              scene.appState,
              scene.elements.map(({ id, version, versionNonce, isDeleted }) => [
                id,
                version,
                versionNonce,
                isDeleted,
              ]),
            ]),
            fileIds: scene.elements.flatMap((element) =>
              !element.isDeleted && element.type === "image" && element.fileId
                ? [element.fileId]
                : [],
            ),
          };
          sceneSignatures.set(scene, cached);
        }
        signatures.push(JSON.stringify([id, cached.signature]));
        cached.fileIds.forEach((id) => fileIds.add(id));
      }
      subsceneSignature = signatures.sort().join(";");
      subsceneFileIds = [...fileIds];
      previousScenes = subscenes;
    }
    const fileIds = new Set<string>(subsceneFileIds);
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
      subsceneSignature !== previousSubsceneSignature ||
      nextFiles.length !== referencedFiles.length ||
      nextFiles.some((value, index) => value !== referencedFiles[index]) ||
      !content
    ) {
      elementSignature = nextElements;
      appStateSignature = nextAppState;
      previousSubsceneSignature = subsceneSignature;
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

type ComparisonElement = {
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
  updated?: number;
  boundElements?: { id: string; type: string }[] | null;
};
type ComparisonScene = {
  elements: ComparisonElement[];
  appState?: {
    subscenes?: Record<string, { elements: ComparisonElement[] }>;
  };
};

export const documentContentSignature = (content: string) => {
  const value = JSON.parse(content) as
    | (ComparisonScene & { type: "excalidraw" })
    | { type: "guzi-presentation"; slides: { scene: ComparisonScene }[] };
  const elements = (elements: ComparisonElement[]) =>
    elements
      .filter((element) => !element.isDeleted)
      .map(({ version, versionNonce, updated, ...element }) => {
        const bindings = element.boundElements;
        // Conflicting text bindings use their order to decide which label survives repair.
        if (bindings?.length === 0) {
          element.boundElements = null;
        } else if (
          bindings &&
          bindings.filter(({ type }) => type === "text").length <= 1
        ) {
          element.boundElements = [...bindings].sort(
            (left, right) =>
              left.id.localeCompare(right.id) ||
              left.type.localeCompare(right.type),
          );
        }
        return element;
      });
  const scene = (scene: ComparisonScene) => {
    scene.elements = elements(scene.elements);
    for (const child of Object.values(scene.appState?.subscenes ?? {})) {
      child.elements = elements(child.elements);
    }
  };
  if (value.type === "guzi-presentation") {
    value.slides.forEach((slide) => scene(slide.scene));
  } else {
    scene(value);
  }
  return JSON.stringify(value, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
};

export const fileTitle = (path: string) =>
  (fileName(path) || "未命名").replace(
    /\.(excalidraw|guzi-presentation)$/i,
    "",
  );

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
