import { useEffect, useRef, useState } from "react";

import { getFontString } from "@excalidraw/common";
import { getNonDeletedElements, loadFromBlob } from "@excalidraw/excalidraw";
import { ExcalLogo } from "@excalidraw/excalidraw/components/icons";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import { exportToCanvas } from "@excalidraw/excalidraw/scene/export";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { createThumbnailCache } from "./thumbnailCache";

import { translate } from "./i18n";

import type { DesktopLanguage } from "./i18n";
import type { ProjectFile } from "./shared";

const MAX_THUMBNAIL_SIZE = 720;
const thumbnails = new WeakMap<
  Document,
  ReturnType<typeof createThumbnailCache>
>();

const loadThumbnailFonts = async (
  elements: readonly ExcalidrawElement[],
  ownerDocument: Document,
) => {
  await Fonts.loadElementsFonts(elements, ownerDocument);
  const textPerFont = new Map<string, string>();
  for (const element of elements) {
    if (element.type === "text") {
      const font = getFontString(element);
      textPerFont.set(
        font,
        (textPerFont.get(font) || "") + element.originalText + element.text,
      );
    }
  }
  // Load with the actual glyphs, including Xiaolai in the hand-drawn CJK stack.
  // Fonts.loadElementsFonts tolerates failed requests; this also lets us retry
  // instead of caching a raster made with an unintended system fallback.
  await Promise.all(
    Array.from(textPerFont, ([font, text]) =>
      ownerDocument.fonts.load(font, text),
    ),
  );
};

const getThumbnail = (
  file: ProjectFile,
  root: HTMLElement,
  theme: "light" | "dark",
) => {
  const ownerDocument = root.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  let cache = thumbnails.get(ownerDocument);
  if (!cache) {
    cache = createThumbnailCache();
    thumbnails.set(ownerDocument, cache);
  }
  const key = JSON.stringify([file.path, file.modifiedAt, file.size, theme]);
  return cache.acquire(key, async (cancelled) => {
    const source = await ownerWindow.desktop.readFile(file.path);
    if (cancelled()) {
      return null;
    }
    const scene = await loadFromBlob(
      new ownerWindow.Blob([source.content]),
      null,
      null,
    );
    if (cancelled()) {
      return null;
    }
    const elements = getNonDeletedElements(scene.elements || []);
    if (!elements.length) {
      return null;
    }
    const appState = {
      ...restoreAppState(scene.appState, null),
      exportWithDarkMode: theme === "dark",
      width: 0,
      height: 0,
      offsetTop: 0,
      offsetLeft: 0,
    };
    let previewCanvas: HTMLCanvasElement | undefined;
    try {
      const canvas = await exportToCanvas(
        elements,
        appState,
        scene.files || {},
        {
          exportBackground: true,
          viewBackgroundColor: appState.viewBackgroundColor,
          exportPadding: 24,
        },
        (width, height) => {
          const scale = MAX_THUMBNAIL_SIZE / Math.max(width, height);
          const canvas = ownerDocument.createElement("canvas");
          previewCanvas = canvas;
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          return { canvas, scale };
        },
        async () => {
          await loadThumbnailFonts(elements, ownerDocument);
          if (cancelled()) {
            throw new ownerWindow.DOMException(
              "Thumbnail cancelled",
              "AbortError",
            );
          }
        },
      );
      return cancelled() ? null : canvas.toDataURL("image/png");
    } finally {
      if (previewCanvas) {
        previewCanvas.width = 0;
        previewCanvas.height = 0;
      }
    }
  });
};

export const FilePreview = ({
  file,
  root,
  theme,
  language = "zh-CN",
}: {
  file: ProjectFile;
  language?: DesktopLanguage;
  root: HTMLElement;
  theme: "light" | "dark";
}) => {
  const container = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    setPreview(null);
    setFailed(false);
    const node = container.current!;
    const ownerWindow = node.ownerDocument.defaultView!;
    let release: (() => void) | undefined;
    const load = () => {
      const thumbnail = getThumbnail(file, root, theme);
      release = thumbnail.release;
      void thumbnail.promise.then(
        (value) => !disposed && setPreview(value),
        () => !disposed && setFailed(true),
      );
    };
    const observer = new ownerWindow.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(node);
    return () => {
      disposed = true;
      observer.disconnect();
      release?.();
    };
  }, [file, root, theme]);
  return (
    <div className="desktop-file-preview" ref={container}>
      {preview ? (
        <img src={preview} alt="" draggable={false} />
      ) : (
        <span
          className={failed ? "desktop-preview-error" : "desktop-preview-empty"}
        >
          {failed ? translate(language, "预览不可用") : ExcalLogo}
        </span>
      )}
    </div>
  );
};
