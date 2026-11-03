import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import { createPaperPage, PAPER_GAP, paperScene } from "./paper";

export const PDF_IMPORT_LIMITS = {
  pages: 200,
  pagePixels: 8_000_000,
  totalPixels: 200_000_000,
  encodedBytes: 128 * 1024 * 1024,
};

export const importPdf = async (
  data: ArrayBuffer,
  ownerDocument: Document,
  signal: AbortSignal,
  onProgress: (page: number, total: number) => void,
) => {
  const ownerWindow = ownerDocument.defaultView!;
  const cancelled = () => {
    if (signal.aborted) {
      throw new ownerWindow.DOMException("Cancelled", "AbortError");
    }
  };
  cancelled();
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import(
    "pdfjs-dist/build/pdf.worker.mjs?url"
  );
  cancelled();
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const assets = new URL(
    `${import.meta.env.BASE_URL}pdfjs/`,
    ownerDocument.baseURI,
  ).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    ownerDocument,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    stopAtErrors: true,
    canvasMaxAreaInBytes: 32_000_000,
  });
  let destroyPromise: Promise<void> | undefined;
  const destroy = () => (destroyPromise ??= task.destroy());
  let cancelRender: (() => void) | undefined;
  const abort = () => {
    cancelRender?.();
    void destroy().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await task.promise;
    cancelled();
    if (pdf.numPages > PDF_IMPORT_LIMITS.pages) {
      throw new Error("PDF 最多支持 200 页，请拆分后导入。");
    }
    const elements: ExcalidrawElement[] = [];
    const files: BinaryFiles = {};
    let y = 0;
    let totalPixels = 0;
    let encodedBytes = 0;
    onProgress(0, pdf.numPages);
    for (let number = 1; number <= pdf.numPages; number++) {
      cancelled();
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 96 / 72 });
      const scale = Math.min(
        2,
        Math.sqrt(
          PDF_IMPORT_LIMITS.pagePixels / (viewport.width * viewport.height),
        ),
        8192 / Math.max(viewport.width, viewport.height),
      );
      const rendered = page.getViewport({ scale: (96 / 72) * scale });
      const canvas = ownerDocument.createElement("canvas");
      canvas.width = Math.ceil(rendered.width);
      canvas.height = Math.ceil(rendered.height);
      totalPixels += canvas.width * canvas.height;
      try {
        if (totalPixels > PDF_IMPORT_LIMITS.totalPixels) {
          throw new Error("PDF 图片总量过大，请拆分后导入。");
        }
        cancelled();
        const rendering = page.render({ canvas, viewport: rendered });
        cancelRender = () => rendering.cancel();
        await rendering.promise;
        cancelRender = undefined;
        cancelled();
        const dataURL = canvas.toDataURL("image/png") as DataURL;
        encodedBytes += dataURL.length;
        if (
          dataURL === "data:," ||
          encodedBytes > PDF_IMPORT_LIMITS.encodedBytes
        ) {
          throw new Error("PDF 图片总量过大，请拆分后导入。");
        }
        const id = ownerWindow.crypto.randomUUID() as FileId;
        const file = {
          id,
          dataURL,
          mimeType: "image/png" as const,
          created: Date.now(),
        };
        files[id] = file;
        elements.push(
          ...createPaperPage({
            width: viewport.width,
            height: viewport.height,
            y,
            name: `${number}`,
            image: file,
          }),
        );
        y += viewport.height + PAPER_GAP;
        onProgress(number, pdf.numPages);
      } finally {
        cancelRender = undefined;
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
    return paperScene(elements, files);
  } catch (error) {
    cancelled();
    if (error instanceof Error && error.name === "PasswordException") {
      throw new Error("PDF 已加密，请先解密后导入。");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await destroy();
  }
};
