import { arrayToMap, getFontString } from "@excalidraw/common";
import { getElementsOverlappingFrame } from "@excalidraw/element";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import { exportScene } from "@excalidraw/excalidraw/scene/export";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getPaperPages } from "./paper";

export const renderPaperPageThumbnail = async (
  api: ExcalidrawImperativeAPI,
  pageId: string,
  ownerDocument: Document,
  theme: "light" | "dark",
  cancelled: () => boolean,
) => {
  const ownerWindow = ownerDocument.defaultView!;
  const elements = api.getSceneElements();
  const page = getPaperPages(elements).find((frame) => frame.id === pageId);
  if (!page || cancelled()) {
    return null;
  }

  const visible = getElementsOverlappingFrame(
    elements,
    page,
    arrayToMap(elements),
  );
  const canvases: HTMLCanvasElement[] = [];
  try {
    const canvas = await exportScene({
      type: "canvas",
      data: { elements: visible, files: api.getFiles() },
      config: {
        theme,
        padding: 0,
        exportingFrame: page,
        frames: { name: false, outline: false, clip: true },
        scale: (width, height) => 160 / Math.max(width, height),
        environment: {
          document: ownerDocument,
          createCanvas: () => {
            const canvas = ownerDocument.createElement("canvas");
            canvases.push(canvas);
            return canvas;
          },
          createImage: () => new ownerWindow.Image(),
          loadFonts: async () => {
            await Fonts.loadElementsFonts(visible, ownerDocument);
            if (cancelled()) {
              throw new ownerWindow.DOMException(
                "Preview cancelled",
                "AbortError",
              );
            }
            const textByFont = new Map<string, string>();
            for (const element of visible) {
              if (element.type === "text") {
                const font = getFontString(element);
                textByFont.set(
                  font,
                  (textByFont.get(font) || "") +
                    element.originalText +
                    element.text,
                );
              }
            }
            await Promise.all(
              Array.from(textByFont, ([font, text]) =>
                ownerDocument.fonts.load(font, text),
              ),
            );
            if (cancelled()) {
              throw new ownerWindow.DOMException(
                "Preview cancelled",
                "AbortError",
              );
            }
          },
        },
      },
    });
    return cancelled() ? null : canvas.toDataURL("image/png");
  } finally {
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
};
