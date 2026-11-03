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
}: {
  width: number;
  height: number;
  x?: number;
  y?: number;
  name: string;
  template?: PaperTemplate;
  image?: BinaryFileData;
}): ExcalidrawElement[] => {
  const frame = newFrameElement({
    x,
    y,
    width,
    height,
    name,
    locked: true,
    customData: { guziPaper: { version: 1, kind: image ? "pdf" : template } },
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
    for (let offset = 72; offset < height - 48; offset += 32) {
      elements.push(
        newLinearElement({
          type: "line",
          x: x + 48,
          y: y + offset,
          width: width - 96,
          height: 0,
          points: [
            [0, 0],
            [width - 96, 0],
          ] as LocalPoint[],
          strokeColor: "#c8d5e3",
          strokeWidth: 1,
          roughness: 0,
          locked: true,
          frameId: frame.id,
        }),
      );
    }
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
