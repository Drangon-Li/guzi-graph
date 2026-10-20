import { act, render, waitFor } from "@testing-library/react";

import { FONT_FAMILY } from "@excalidraw/common";
import { loadFromBlob } from "@excalidraw/excalidraw";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import { exportToCanvas } from "@excalidraw/excalidraw/scene/export";

import { FilePreview } from "./FilePreview";

import type { MockInstance } from "vitest";

import type { ProjectFile } from "./shared";

vi.mock("@excalidraw/excalidraw", () => ({
  loadFromBlob: vi.fn(),
  getNonDeletedElements: (elements: any[]) =>
    elements.filter((element) => !element.isDeleted),
}));

vi.mock("@excalidraw/excalidraw/scene/export", () => ({
  exportToCanvas: vi.fn(),
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
  const files = {
    image: {
      id: "image",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AAAA",
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
    vi.mocked(exportToCanvas).mockImplementation(
      async (
        _elements,
        _appState,
        _files,
        _options,
        createCanvas,
        prepareFonts,
      ) => {
        await prepareFonts!();
        const { canvas, scale } = createCanvas!(...canvasSize);
        rendered(canvas, scale, [canvas.width, canvas.height]);
        return canvas;
      },
    );
  });

  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(exportToCanvas).mockClear();
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
        expect(view.container.querySelector("img")).not.toBeNull(),
      );
      const [canvas, scale, dimensions] = rendered.mock.calls[0];
      expect(canvas.ownerDocument).toBe(root.ownerDocument);
      expect([...dimensions, scale]).toEqual(expected);
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      expect(view.container.querySelector("img")!.src).toMatch(
        /^data:image\/png/,
      );
      const [elements, appState, imageFiles, options] =
        vi.mocked(exportToCanvas).mock.calls[0];
      expect(elements).toHaveLength(2);
      expect(appState.exportWithDarkMode).toBe(true);
      expect(imageFiles).toBe(files);
      expect(options).toEqual({
        exportBackground: true,
        viewBackgroundColor: "#fffce8",
        exportPadding: 24,
      });
    },
  );

  it("isolates themes and file revisions while reusing cached thumbnails", async () => {
    const view = render(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() => expect(rendered).toHaveBeenCalledTimes(1));
    expect(vi.mocked(exportToCanvas).mock.calls[0][1].exportWithDarkMode).toBe(
      false,
    );
    view.rerender(<FilePreview file={file} root={root} theme="dark" />);
    show();
    await waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
    expect(vi.mocked(exportToCanvas).mock.calls[1][1].exportWithDarkMode).toBe(
      true,
    );
    view.rerender(<FilePreview file={file} root={root} theme="light" />);
    show();
    await waitFor(() =>
      expect(view.container.querySelector("img")).not.toBeNull(),
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
      expect(first.container.querySelector("img")).not.toBeNull(),
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
      expect(view.container.querySelector("img")).not.toBeNull(),
    );
    const preview = view.container.querySelector("img")!.src;
    await act(async () => finish({ content: "old scene" }));
    expect(exportToCanvas).toHaveBeenCalledTimes(1);
    expect(loadFromBlob).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("img")!.src).toBe(preview);
    expect(view.queryByText("预览不可用")).toBeNull();
  });
});
