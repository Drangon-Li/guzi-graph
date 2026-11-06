import { DEFAULT_FONT_SIZE } from "@excalidraw/common";
import {
  syncInvalidIndices,
  newElement,
  newFrameElement,
  newImageElement,
  newLinearElement,
} from "@excalidraw/element";

import type { LocalPoint } from "@excalidraw/math";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  FileId,
  NonDeleted,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFiles,
  AppState,
  Offsets,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

export type PaperTemplate = "blank" | "ruled";
export type PaperOrientation = "portrait" | "landscape";
export const A4 = { width: (210 / 25.4) * 96, height: (297 / 25.4) * 96 };
export const PAPER_GAP = 48;
export const PAPER_SIDE_MARGIN = 48;
export const PAPER_WRITING_TOP = 40;
export type PaperSettings = { lineSpacing: number; fontSize: number };
export const DEFAULT_PAPER_SETTINGS: PaperSettings = {
  lineSpacing: 32,
  fontSize: DEFAULT_FONT_SIZE,
};

export const getPaperSettings = (page: ExcalidrawElement): PaperSettings => {
  const settings = page.customData?.guziPaper?.settings;
  return {
    lineSpacing:
      Number.isFinite(settings?.lineSpacing) &&
      settings.lineSpacing >= 16 &&
      settings.lineSpacing <= 96
        ? settings.lineSpacing
        : DEFAULT_PAPER_SETTINGS.lineSpacing,
    fontSize:
      Number.isFinite(settings?.fontSize) &&
      settings.fontSize >= 8 &&
      settings.fontSize <= 72
        ? settings.fontSize
        : DEFAULT_PAPER_SETTINGS.fontSize,
  };
};

export const createPaperRules = (
  page: Pick<ExcalidrawFrameElement, "x" | "y" | "width" | "height" | "id">,
  settings: PaperSettings,
) => {
  const rules = [];
  for (
    let offset = PAPER_WRITING_TOP + settings.lineSpacing;
    offset < page.height - 48;
    offset += settings.lineSpacing
  ) {
    rules.push(
      newLinearElement({
        type: "line",
        x: page.x + 48,
        y: page.y + offset,
        width: page.width - 96,
        height: 0,
        points: [
          [0, 0],
          [page.width - 96, 0],
        ] as LocalPoint[],
        strokeColor: "#c8d5e3",
        strokeWidth: 1,
        roughness: 0,
        locked: true,
        frameId: page.id,
        customData: { guziPaperRule: true },
      }),
    );
  }
  return rules;
};

export const isPaperRule = (
  element: ExcalidrawElement,
  page: ExcalidrawFrameElement,
) =>
  !element.isDeleted &&
  element.type === "line" &&
  element.locked &&
  element.frameId === page.id &&
  !element.angle &&
  element.height === 0 &&
  element.strokeColor === "#c8d5e3" &&
  Math.abs(element.x - page.x - 48) < 0.001 &&
  Math.abs(element.width - page.width + 96) < 0.001 &&
  element.y >=
    page.y + PAPER_WRITING_TOP + getPaperSettings(page).lineSpacing - 0.001 &&
  element.y < page.y + page.height - 48 &&
  (element.customData?.guziPaperRule === true ||
    (page.customData?.guziPaper?.rulingVersion !== 1 &&
      element.strokeWidth === 1 &&
      element.strokeStyle === "solid" &&
      element.roughness === 0 &&
      element.groupIds.length === 0 &&
      element.points.length === 2 &&
      element.points[0][0] === 0 &&
      element.points[0][1] === 0 &&
      element.points[1][0] === element.width &&
      element.points[1][1] === 0 &&
      Math.abs(
        (element.y - page.y - 72) / 32 -
          Math.round((element.y - page.y - 72) / 32),
      ) < 0.001));

export const paperViewportOffsets = (offsets: Offsets): Offsets => ({
  ...offsets,
  left: (offsets.left ?? 0) + PAPER_SIDE_MARGIN,
  right: (offsets.right ?? 0) + PAPER_SIDE_MARGIN,
});

export const isPaperFrame = (
  element: ExcalidrawElement,
): element is NonDeleted<ExcalidrawFrameElement> =>
  element.type === "frame" &&
  !element.isDeleted &&
  element.customData?.guziPaper?.version === 1;

export const createPaperPage = ({
  width,
  height,
  x = 0,
  y = 0,
  name,
  template = "blank",
  image,
  settings = DEFAULT_PAPER_SETTINGS,
}: {
  width: number;
  height: number;
  x?: number;
  y?: number;
  name: string;
  template?: PaperTemplate;
  image?: BinaryFileData;
  settings?: PaperSettings;
}): ExcalidrawElement[] => {
  const frame = newFrameElement({
    x,
    y,
    width,
    height,
    name,
    locked: true,
    customData: {
      guziPaper: {
        version: 1,
        kind: image ? "pdf" : template,
        ...(!image && template === "ruled" ? { rulingVersion: 1 } : {}),
        ...(!image ? { settings: { ...settings } } : {}),
      },
    },
  });
  const elements: ExcalidrawElement[] = [
    image
      ? newImageElement({
          type: "image",
          x,
          y,
          width,
          height,
          fileId: image.id as FileId,
          status: "saved",
          locked: true,
          frameId: frame.id,
        })
      : newElement({
          type: "rectangle",
          x,
          y,
          width,
          height,
          backgroundColor: "#ffffff",
          strokeColor: "transparent",
          fillStyle: "solid",
          roughness: 0,
          locked: true,
          frameId: frame.id,
        }),
  ];
  if (!image && template === "ruled") {
    elements.push(...createPaperRules(frame, settings));
  }
  elements.push(frame);
  return elements;
};

export const getPaperPages = (elements: readonly ExcalidrawElement[]) =>
  elements
    .filter(isPaperFrame)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));

export const appendPaperPage = (elements: readonly ExcalidrawElement[]) => {
  const last = getPaperPages(elements).at(-1);
  const template = last?.customData?.guziPaper?.kind;
  if (!last || (template !== "blank" && template !== "ruled")) {
    return null;
  }
  const page = createPaperPage({
    x: last.x,
    y: last.y + last.height + PAPER_GAP,
    width: last.width,
    height: last.height,
    name: last.name ?? "A4",
    template,
    settings: getPaperSettings(last),
  });
  // The entire sheet must sit below existing ink, including off-page ink.
  return {
    elements: syncInvalidIndices([...page, ...elements]),
    frame: page.at(-1)! as NonDeleted<ExcalidrawFrameElement>,
  };
};

export const paperViewport = (
  frame: ExcalidrawFrameElement,
  state: AppState,
  offsets: Offsets,
  fitWidth = false,
) => {
  const paddedOffsets = paperViewportOffsets(offsets);
  const left = paddedOffsets.left!;
  const right = paddedOffsets.right!;
  const top = offsets.top ?? 24;
  const width = Math.max(1, state.width - left - right);
  const zoom = fitWidth
    ? Math.min(30, Math.max(0.1, width / frame.width))
    : state.zoom.value;
  return {
    zoom: { value: zoom as AppState["zoom"]["value"] },
    scrollX: (left + width / 2) / zoom - frame.x - frame.width / 2,
    scrollY: top / zoom - frame.y,
  };
};

export const paperScene = (
  elements: ExcalidrawElement[],
  files: BinaryFiles = {},
): ExcalidrawInitialDataState => ({
  elements: syncInvalidIndices(elements),
  files,
  appState: { viewBackgroundColor: "#e9ecef", exportWithDarkMode: false },
  scrollToContent: true,
});

export const createPaperTemplate = (
  template: PaperTemplate,
  orientation: PaperOrientation,
): ExcalidrawInitialDataState =>
  paperScene(
    createPaperPage({
      width: orientation === "portrait" ? A4.width : A4.height,
      height: orientation === "portrait" ? A4.height : A4.width,
      name: "A4",
      template,
    }),
  );
