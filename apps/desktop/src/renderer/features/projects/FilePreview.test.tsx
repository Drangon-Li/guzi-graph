import { act, render, waitFor } from "@testing-library/react";

import { FONT_FAMILY } from "@excalidraw/common";
import {
  newFrameElement,
  newImageElement,
  newTextElement,
} from "@excalidraw/element";
import { loadFromBlob } from "@excalidraw/excalidraw";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import { exportScene } from "@excalidraw/excalidraw/scene/export";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import { A4, createPaperPage } from "../paper/paper";

import { FilePreview } from "./FilePreview";

import type { MockInstance } from "vitest";

import type { ProjectFile } from "../../../shared/desktop-api";

vi.mock("@excalidraw/excalidraw", () => ({
  loadFromBlob: vi.fn(),
  getNonDeletedElements: (elements: any[]) =>
    elements.filter((element) => !element.isDeleted),
}));

vi.mock("@excalidraw/excalidraw/scene/export", () => ({
  exportScene: vi.fn(),
}));

describe("desktop canvas thumbnails", () => {
  let root: HTMLDivElement;
  let file: ProjectFile;
  let intersect: () => void;
  let readFile: ReturnType<typeof vi.fn>;
  let rendered: ReturnType<typeof vi.fn>;
  let loadFonts: MockInstance<typeof Fonts.loadElementsFonts>;
  let loadGlyphs: MockInstance<FontFaceSet["load"]>;
  let sequence = 0;
  let canvasSize: [number, number];
  const files: BinaryFiles = {
    image: {
      id: "image" as FileId,
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA" as DataURL,
      created: 1,
    },
  };

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    file = {
      path: `/drawings/preview-${++sequence}.excalidraw`,
      relativePath: "preview.excalidraw",
      name: "preview.excalidraw",
      category: "",
      modifiedAt: 100,
      size: 200,
    };
    readFile = vi.fn().mockResolvedValue({ content: "scene" });
    root.ownerDocument.defaultView!.desktop = { readFile } as any;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private disconnected = false;
        constructor(callback: IntersectionObserverCallback) {
          intersect = () => {
            if (!this.disconnected) {
              callback(
                [{ isIntersecting: true } as IntersectionObserverEntry],
                this as unknown as IntersectionObserver,
              );
            }
          };
        }
        observe() {}
        disconnect() {
          this.disconnected = true;
        }
      },
    );
    vi.mocked(loadFromBlob).mockResolvedValue({
      elements: [
        {
          type: "text",
          fontFamily: FONT_FAMILY.Excalifont,
          fontSize: 20,
          originalText: "中文手写",
          text: "中文手写",
          isDeleted: false,
        },
        { type: "image", fileId: "image", isDeleted: false },
        { type: "rectangle", isDeleted: true },
      ],
      appState: { viewBackgroundColor: "#fffce8", exportWithDarkMode: false },
      files,
    } as any);
    loadFonts = vi.spyOn(Fonts, "loadElementsFonts").mockResolvedValue([]);
    loadGlyphs = vi
      .spyOn(root.ownerDocument.fonts, "load")
      .mockResolvedValue([]);
    rendered = vi.fn();
    canvasSize = [2400, 600];
    vi.mocked(exportScene).mockImplementation(async ({ config }) => {
      await config!.environment!.loadFonts!();
      const canvas = config!.environment!.createCanvas!();
      const frame = config!.exportingFrame;
      const [width, height] = frame ? [frame.width, frame.height] : canvasSize;
      const scale = (
        config!.scale as (width: number, height: number) => number
      )(width, height);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      rendered(canvas, scale, [canvas.width, canvas.height]);
      return canvas;
    });
  });

  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(exportScene).mockClear();
    vi.mocked(loadFromBlob).mockClear();
  });

  const show = () => act(() => intersect());

  it.each([
    { name: "large scene", size: [2400, 600], expected: [720, 180, 0.3] },
    {
      name: "small text scene",
      size: [108, 72],
      expected: [720, 480, 720 / 108],
    },
  ])(
    "waits for CJK fonts before rendering a bounded raster for a $name",
    async ({ size, expected }) => {
      canvasSize = [size[0], size[1]];
      let register!: () => void;
      let glyphs!: () => void;
      loadFonts.mockImplementation(
        () =>
          new Promise<FontFace[]>((resolve) => (register = () => resolve([]))),
      );
      loadGlyphs.mockImplementation(
        () =>
          new Promise<FontFace[]>((resolve) => (glyphs = () => resolve([]))),
      );
      const view = render(<FilePreview file={file} root={root} theme="dark" />);
      expect(readFile).not.toHaveBeenCalled();
      show();
      await waitFor(() => expect(loadFonts).toHaveBeenCalled());
      expect(loadFonts).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
        root.ownerDocument,
      );
      expect(rendered).not.toHaveBeenCalled();
      expect(loadGlyphs).not.toHaveBeenCalled();
      await act(async () => register());
      await waitFor(() => expect(loadGlyphs).toHaveBeenCalled());
      expect(loadGlyphs).toHaveBeenCalledWith(
        "20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji",
        "中文手写中文手写",
      );
      expect(rendered).not.toHaveBeenCalled();
      await act(async () => glyphs());
      await waitFor(() =>
        expect(
          view.container.querySelector<HTMLImageElement>(
            ".desktop-file-preview > img",
          ),
        ).not.toBeNull(),
      );
      const [canvas, scale, dimensions] = rendered.mock.calls[0];
      expect(canvas.ownerDocument).toBe(root.ownerDocument);
      expect([...dimensions, scale]).toEqual(expected);
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      expect(
        view.container.querySelector<HTMLImageElement>(
          ".desktop-file-preview > img",
        )!.src,
      ).toMatch(/^data:image\/png/);
      const [{ type, data, config }] = vi.mocked(exportScene).mock.calls[0];
      expect(type).toBe("canvas");
      expect(data.elements).toHaveLength(2);
      expect(data.files).toBe(files);
      expect(config).toMatchObject({
        theme: "dark",
        canvasBackgroundColor: "#fffce8",
        padding: 24,
        environment: { document: root.ownerDocument },
      });
    },
  );

  it.each(["blank", "ruled"] as const)(
    "crops a %s A4 thumbnail to the first page in paper order",
    async (template) => {
      const first = createPaperPage({ ...A4, name: "A4", template });
      const firstFrame = first.at(-1)!;
      const second = createPaperPage({ ...A4, y: 1500, name: "A4", template });
      const secondPageText = newTextElement({
        x: 48,
        y: 1550,
        text: "Second page",
        frameId: second.at(-1)!.id,
      });
      if (template === "ruled") {
        first.unshift(
          newImageElement({
            type: "image",
            x: 100,
            y: 100,
            width: 100,
            height: 100,
            fileId: files.image.id,
            status: "saved",
            frameId: firstFrame.id,
          }),
        );
      }
      vi.mocked(loadFromBlob).mockResolvedValue({
        elements: restoreElements([...second, secondPageText, ...first], null),
        appState: restoreAppState(null, null),
        files,
      });
      render(<FilePreview file={file} root={root} theme="light" />);
      show();
      await waitFor(() => expect(rendered).toHaveBeenCalledTimes(1));
      const [{ config, data }] = vi.mocked(exportScene).mock.calls[0];
      expect(config?.exportingFrame?.id).toBe(firstFrame.id);
      expect(config?.padding).toBe(0);
      expect(rendered.mock.calls[0][2]).toEqual([509, 720]);
      expect(loadGlyphs).not.toHaveBeenCalled();
      if (template === "ruled") {
        expect(data.files).toBe(files);
        expect(loadFonts.mock.calls[0][0]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ fileId: files.image.id }),
          ]),
        );
      }
    },
  );

  it.each(["regular frames", "imported PDF"] as const)(
    "keeps the full preview for %s",
    async (format) => {
      const elements = [0, 1500].flatMap((y) =>
        format === "imported PDF"
          ? createPaperPage({ ...A4, y, name: "PDF", image: files.image })
          : [newFrameElement({ ...A4, x: 0, y })],
      );
      vi.mocked(loadFromBlob).mockResolvedValue({
        elements: restoreElements(elements, null),
        appState: restoreAppState(null, null),
        files,
      });
      render(<FilePreview file={file} root={root} theme="light" />);
      show();
      await waitFor(() => expect(rendered).toHaveBeenCalledTimes(1));
      const [{ config, data }] = vi.mocked(exportScene).mock.calls[0];
      expect(config?.exportingFrame).toBeUndefined();
      expect(config?.padding).toBe(24);
      expect(data.elements.map((element) => element.id)).toEqual(
        elements.map((element) => element.id),
      );
    },
  );

  it("isolates themes and file revisions while reusing cached thumbnails", async () => {
    const view = render(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() => expect(rendered).toHaveBeenCalledTimes(1));
    expect(vi.mocked(exportScene).mock.calls[0][0].config?.theme).toBe("light");
    view.rerender(<FilePreview file={file} root={root} theme="dark" />);
    show();
    await waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
    expect(vi.mocked(exportScene).mock.calls[1][0].config?.theme).toBe("dark");
    view.rerender(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLImageElement>(
          ".desktop-file-preview > img",
        ),
      ).not.toBeNull(),
    );
    expect(readFile).toHaveBeenCalledTimes(2);
    view.rerender(
      <FilePreview
        file={{ ...file, modifiedAt: 101 }}
        root={root}
        theme="light"
      />,
    );
    show();
    await waitFor(() => expect(rendered).toHaveBeenCalledTimes(3));
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it("keeps a loaded preview when a project refresh recreates the same file entry", async () => {
    const view = render(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() =>
      expect(
        view.container.querySelector(".desktop-file-preview > img"),
      ).not.toBeNull(),
    );
    const image = view.container.querySelector(".desktop-file-preview > img");
    view.rerender(<FilePreview file={{ ...file }} root={root} theme="light" />);
    // No intersection is needed: the preview is kept, not reloaded.
    expect(view.container.querySelector(".desktop-file-preview > img")).toBe(
      image,
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("evicts a failed font load so the same file can be retried", async () => {
    loadGlyphs.mockRejectedValueOnce(new Error("font unavailable"));
    const first = render(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() =>
      expect(first.getByText("预览不可用")).toBeInTheDocument(),
    );
    expect(rendered).not.toHaveBeenCalled();
    first.rerender(
      <FilePreview file={{ ...file }} root={root} theme="light" />,
    );
    show();
    await waitFor(() =>
      expect(
        first.container.querySelector<HTMLImageElement>(
          ".desktop-file-preview > img",
        ),
      ).not.toBeNull(),
    );
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("ignores an obsolete load after a file revision changes", async () => {
    let finish!: (value: { content: string }) => void;
    readFile.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const view = render(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    view.rerender(
      <FilePreview
        file={{ ...file, modifiedAt: 101 }}
        root={root}
        theme="light"
      />,
    );
    show();
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLImageElement>(
          ".desktop-file-preview > img",
        ),
      ).not.toBeNull(),
    );
    const preview = view.container.querySelector<HTMLImageElement>(
      ".desktop-file-preview > img",
    )!.src;
    await act(async () => finish({ content: "old scene" }));
    expect(exportScene).toHaveBeenCalledTimes(1);
    expect(loadFromBlob).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector<HTMLImageElement>(
        ".desktop-file-preview > img",
      )!.src,
    ).toBe(preview);
    expect(view.queryByText("预览不可用")).toBeNull();
  });
});
