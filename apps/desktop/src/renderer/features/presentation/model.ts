import { loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import { serializeForJSON } from "@excalidraw/excalidraw/data/json";

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export interface PresentationSlide {
  id: string;
  title: string;
  scene: ExcalidrawInitialDataState;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface Presentation {
  type: "guzi-presentation";
  version: 1;
  width: number;
  height: number;
  slides: PresentationSlide[];
}

export const createPresentation = (
  id: string,
  title: string,
  scene: ExcalidrawInitialDataState = {},
): Presentation => ({
  type: "guzi-presentation",
  version: 1,
  width: 1280,
  height: 720,
  slides: [{ id, title, scene }],
});

function invalid(): never {
  throw new Error("演示文稿数据损坏或格式不受支持。");
}

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hasSlideAspectRatio = (width: number, height: number) =>
  Math.abs(width * 9 - height * 16) <= Math.max(width * 9, height * 16) * 1e-9;

const validateBounds = (bounds: unknown) => {
  if (
    !isRecord(bounds) ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !hasSlideAspectRatio(bounds.width, bounds.height)
  ) {
    invalid();
  }
};

export const getSlideBounds = (
  slide: PresentationSlide,
  width: number,
  height: number,
) => {
  const bounds = slide.bounds ?? { x: 0, y: 0, width, height };
  validateBounds(bounds);
  return bounds;
};

const validateElements = (elements: unknown) => {
  if (!Array.isArray(elements)) {
    return invalid();
  }
  const ids = new Set<string>();
  for (const element of elements) {
    if (
      !isRecord(element) ||
      typeof element.id !== "string" ||
      !element.id ||
      ids.has(element.id) ||
      typeof element.type !== "string" ||
      ![element.x, element.y, element.width, element.height].every(
        Number.isFinite,
      )
    ) {
      invalid();
    }
    ids.add(element.id);
  }
};

const validateScene = (scene: unknown) => {
  if (
    !isRecord(scene) ||
    (scene.type !== undefined && scene.type !== "excalidraw") ||
    (scene.appState != null && !isRecord(scene.appState)) ||
    (scene.files !== undefined && !isRecord(scene.files))
  ) {
    return invalid();
  }
  validateElements(scene.elements);
  const subscenes = scene.appState?.subscenes;
  if (subscenes !== undefined) {
    if (!isRecord(subscenes)) {
      invalid();
    }
    for (const child of Object.values(subscenes)) {
      if (
        !isRecord(child) ||
        child.version !== 1 ||
        typeof child.title !== "string" ||
        !isRecord(child.appState)
      ) {
        invalid();
      }
      validateElements(child.elements);
    }
  }
  for (const [id, file] of Object.entries(scene.files ?? {})) {
    if (
      !isRecord(file) ||
      file.id !== id ||
      typeof file.dataURL !== "string" ||
      typeof file.mimeType !== "string"
    ) {
      invalid();
    }
  }
};

function validatePresentation(value: unknown): asserts value is Presentation {
  if (
    !isRecord(value) ||
    value.type !== "guzi-presentation" ||
    value.version !== 1 ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width <= 0 ||
    value.height <= 0 ||
    !hasSlideAspectRatio(value.width, value.height) ||
    !Array.isArray(value.slides) ||
    !value.slides.length
  ) {
    return invalid();
  }
  const ids = new Set<string>();
  for (const slide of value.slides) {
    if (
      !isRecord(slide) ||
      typeof slide.id !== "string" ||
      !slide.id.trim() ||
      ids.has(slide.id) ||
      typeof slide.title !== "string" ||
      !isRecord(slide.scene)
    ) {
      invalid();
    }
    ids.add(slide.id);
    if (slide.bounds !== undefined) {
      validateBounds(slide.bounds);
    }
  }
}

const assertRestoredElements = (
  source: ExcalidrawInitialDataState,
  restored: ExcalidrawInitialDataState,
) => {
  const matches = (
    before: ExcalidrawInitialDataState["elements"],
    after: ExcalidrawInitialDataState["elements"],
  ) =>
    before?.length === after?.length &&
    before?.every((element, index) => element.id === after?.[index]?.id);
  if (!matches(source.elements, restored.elements)) {
    invalid();
  }
  for (const [id, child] of Object.entries(source.appState?.subscenes ?? {})) {
    if (
      !matches(child.elements, restored.appState?.subscenes?.[id]?.elements)
    ) {
      invalid();
    }
  }
};

export const parsePresentation = async (
  content: string,
  ownerWindow: Window,
): Promise<Presentation | null> => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== "guzi-presentation") {
    return null;
  }
  validatePresentation(value);
  const { Blob } = ownerWindow as Window & typeof globalThis;
  const slides: PresentationSlide[] = [];
  for (const slide of value.slides) {
    validateScene(slide.scene);
    const scene = await loadFromBlob(
      new Blob([JSON.stringify({ ...slide.scene, type: "excalidraw" })]),
      null,
      null,
    );
    assertRestoredElements(slide.scene, scene);
    slides.push({
      id: slide.id,
      title: slide.title,
      scene,
      ...(slide.bounds ? { bounds: slide.bounds } : {}),
    });
  }
  return { ...value, slides };
};

export const copyPresentationScene = (
  scene: ExcalidrawInitialDataState,
): ExcalidrawInitialDataState =>
  JSON.parse(
    serializeAsJSON(
      scene.elements ?? [],
      scene.appState ?? {},
      scene.files ?? {},
      "local",
    ),
  );

export const serializePresentation = (deck: Presentation): string => {
  validatePresentation(deck);
  return JSON.stringify(
    {
      type: deck.type,
      version: deck.version,
      width: deck.width,
      height: deck.height,
      slides: deck.slides.map((slide) => ({
        id: slide.id,
        title: slide.title,
        ...(slide.bounds ? { bounds: slide.bounds } : {}),
        scene: serializeForJSON(
          slide.scene.elements ?? [],
          slide.scene.appState ?? {},
          slide.scene.files ?? {},
          "local",
        ),
      })),
    },
    null,
    2,
  );
};
