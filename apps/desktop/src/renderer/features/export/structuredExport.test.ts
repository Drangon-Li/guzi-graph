import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { StructuredExportDialog } from "./StructuredExportDialog";

import {
  buildStructuredExport,
  escapeMarkdown,
  exportCanvasPdf,
  prepareStructuredExport,
  structuredExportToMarkdown,
} from "./structuredExport";

import type { DesktopAPI } from "../../../shared/desktop-api";

const element = (
  id: string,
  type = "rectangle",
  overrides: Record<string, unknown> = {},
): ExcalidrawElement =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    isDeleted: false,
    frameId: null,
    groupIds: [],
    boundElements: [],
    link: null,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 0,
    seed: 1,
    version: 1,
    versionNonce: 1,
    index: null,
    updated: 1,
    created: null,
    locked: false,
    ...(type === "text"
      ? {
          text: "text",
          originalText: "text",
          containerId: null,
          fontSize: 20,
          fontFamily: 1,
          lineHeight: 1.25,
          textAlign: "left",
          verticalAlign: "top",
          autoResize: false,
        }
      : {}),
    ...(type === "arrow" || type === "line"
      ? {
          points: [
            [0, 0],
            [100, 0],
          ],
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: type === "arrow" ? "arrow" : null,
          elbowed: false,
        }
      : {}),
    ...overrides,
  } as unknown as ExcalidrawElement);
const options = { title: "Canvas", includeInferredStructure: true };
const decode = (data: ArrayBuffer) => new TextDecoder().decode(data);

vi.mock("@excalidraw/utils/export", () => ({ exportToSvg: vi.fn() }));

describe("desktop structured export", () => {
  it("covers every live ID once, retains original paragraphs and filters deleted data", () => {
    const elements = [
      element("box"),
      element("label", "text", {
        originalText: "a long original paragraph",
        text: "a long\noriginal\nparagraph",
        containerId: "box",
      }),
      element("deleted", "text", { isDeleted: true }),
      element("arrow", "arrow", {
        startBinding: { elementId: "box", focus: 0.2, gap: 3 },
        endBinding: { elementId: "deleted", focus: 0, gap: 1 },
      }),
    ];
    const result = buildStructuredExport(elements, {}, options);
    expect(
      [...result.nodes, ...result.connectors].map((node) => node.id).sort(),
    ).toEqual(["arrow", "box", "label"]);
    expect(
      result.nodes.find((node) => node.id === "box")?.labelTextIds,
    ).toEqual(["label"]);
    expect(result.nodes.find((node) => node.id === "label")).toMatchObject({
      originalText: "a long original paragraph",
      renderedText: "a long\noriginal\nparagraph",
    });
    expect(result.connectors[0].end.binding?.elementId).toBe("deleted");
    expect(
      result.diagnostics.some((item) => item.code === "missing-binding-target"),
    ).toBe(true);
    expect(result.source).toEqual({
      liveElementCount: 3,
      deletedElementCount: 1,
    });
    expect(
      structuredExportToMarkdown(result).match(/a long original paragraph/g),
    ).toHaveLength(1);
  });

  it("uses arrowhead direction and preserves both endpoint bindings, self-loops and unknown endpoints", () => {
    const binding = {
      elementId: "box",
      focus: 0.4,
      gap: 3,
      fixedPoint: [0.2, 1],
    };
    const elements = [
      element("box"),
      element("forward", "arrow", {
        startBinding: binding,
        endBinding: binding,
      }),
      element("reverse", "arrow", {
        startArrowhead: "arrow",
        endArrowhead: null,
      }),
      element("both", "arrow", {
        startArrowhead: "arrow",
        endArrowhead: "arrow",
      }),
      element("line", "line"),
    ];
    const result = buildStructuredExport(elements, {}, options);
    expect(result.connectors.map((connector) => connector.direction)).toEqual([
      "start-to-end",
      "end-to-start",
      "bidirectional",
      "undirected",
    ]);
    expect(result.connectors[0].start.binding).toEqual(binding);
    expect(
      result.diagnostics.filter(
        (item) => item.code === "same-container-self-loop",
      ),
    ).toHaveLength(1);
    const markdown = structuredExportToMarkdown(result);
    expect(markdown).toContain(
      "| forward | arrow | box @ (0, 0) | start-to-end | box @ (100, 0)",
    );
    expect(markdown).toContain("unknown @ (0, 0)");
  });

  it("rotates endpoints around the correct bounds even with negative local coordinates", () => {
    const result = buildStructuredExport(
      [
        element("rotated", "arrow", {
          x: 10,
          y: 20,
          width: 100,
          height: 40,
          angle: Math.PI / 2,
          points: [
            [0, 0],
            [-100, 40],
          ],
          startBinding: { elementId: "missing", focus: 0, gap: 4 },
        }),
      ],
      {},
      options,
    );
    expect(result.connectors[0].start.worldPoint[0]).toBeCloseTo(-20);
    expect(result.connectors[0].start.worldPoint[1]).toBeCloseTo(90);
    expect(result.connectors[0].end.worldPoint[0]).toBeCloseTo(-60);
    expect(result.connectors[0].end.worldPoint[1]).toBeCloseTo(-10);
    expect(result.connectors[0].start.binding).toEqual({
      elementId: "missing",
      focus: 0,
      gap: 4,
    });
  });

  it("separates explicit relations from smallest complete containment and respects rotated boundaries", () => {
    const elements = [
      element("outer", "rectangle", { width: 400, height: 400 }),
      element("inner", "rectangle", { x: 20, y: 20, width: 160, height: 160 }),
      element("inside", "text", { x: 30, y: 30, width: 60, height: 20 }),
      element("partial", "text", { x: 150, y: 60, width: 100, height: 20 }),
      element("frame", "frame", { name: "Frame" }),
      element("framed", "text", {
        x: 30,
        y: 30,
        width: 30,
        height: 20,
        frameId: "frame",
      }),
      element("grouped", "text", {
        x: 35,
        y: 35,
        width: 30,
        height: 20,
        groupIds: ["g"],
      }),
      element("bound", "text", {
        x: 40,
        y: 40,
        width: 30,
        height: 20,
        containerId: "frame",
      }),
      element("rotated-box", "rectangle", {
        x: 500,
        y: 0,
        width: 100,
        height: 100,
        angle: Math.PI / 4,
      }),
      element("outside-rotation", "text", {
        x: 500,
        y: 0,
        width: 10,
        height: 10,
      }),
    ];
    const result = buildStructuredExport(elements, {}, options);
    expect(
      result.layout.relations.find((item) => item.childId === "inside"),
    ).toMatchObject({ parentId: "inner", source: "inferred", tolerance: 2 });
    expect(
      result.layout.relations.find((item) => item.childId === "partial"),
    ).toMatchObject({ parentId: "outer", source: "inferred" });
    expect(
      result.layout.relations
        .filter((item) => ["framed", "grouped", "bound"].includes(item.childId))
        .every((item) => item.source === "explicit"),
    ).toBe(true);
    expect(
      result.layout.relations.find(
        (item) => item.childId === "outside-rotation",
      ),
    ).toBeUndefined();
    const explicitOnly = buildStructuredExport(
      elements,
      {},
      { ...options, includeInferredStructure: false },
    );
    expect(
      explicitOnly.layout.relations.every((item) => item.source === "explicit"),
    ).toBe(true);
    expect(
      explicitOnly.layout.readingOrder.sections
        .flatMap((section) => section.textIds)
        .sort(),
    ).toEqual(
      elements
        .filter((item) => item.type === "text")
        .map((item) => item.id)
        .sort(),
    );
  });

  it("keeps region text together and orders same-row text left to right without promoting prose into headings", () => {
    const elements = [
      element("right-region", "rectangle", { x: 400, width: 300, height: 300 }),
      element("left-region", "rectangle", { width: 300, height: 300 }),
      element("right", "text", { x: 420, y: 20, width: 60, height: 20 }),
      element("left-late", "text", { x: 20, y: 200, width: 60, height: 20 }),
      element("left-row-right", "text", {
        x: 120,
        y: 25,
        width: 60,
        height: 20,
      }),
      element("left-row-left", "text", { x: 20, y: 30, width: 60, height: 20 }),
    ];
    const result = buildStructuredExport(elements, {}, options);
    expect(
      result.layout.readingOrder.sections.map((section) => section.textIds),
    ).toEqual([["left-row-left", "left-row-right", "left-late"], ["right"]]);
    const long =
      "This paragraph is long enough that it should remain body text, even when it is the uppermost text in a region.";
    const markdown = structuredExportToMarkdown(
      buildStructuredExport(
        [element("paragraph", "text", { originalText: long, text: long })],
        {},
        options,
      ),
    );
    expect(markdown).toContain(`> ${escapeMarkdown(long)}`);
    expect(markdown).not.toContain(`### ${long}`);
  });

  it("keeps staggered multi-column paragraphs complete between full-width header and footer", () => {
    const text = (id: string, x: number, y: number, width = 240) =>
      element(id, "text", {
        x,
        y,
        width,
        height: 25,
        text: id,
        originalText: id,
      });
    const elements = [
      element("region", "rectangle", { width: 600, height: 350 }),
      text("header", 0, 0, 600),
      text("left-title", 0, 100),
      text("right-title", 320, 80),
      text("left-first", 0, 140),
      text("right-first", 320, 120),
      text("left-second", 0, 180),
      text("right-second", 320, 160),
      text("footer", 0, 280, 600),
    ];
    const result = buildStructuredExport(elements, {}, options);
    const section = result.layout.readingOrder.sections[0];
    expect(section.textIds).toEqual([
      "header",
      "left-title",
      "left-first",
      "left-second",
      "right-title",
      "right-first",
      "right-second",
      "footer",
    ]);
    expect(section.spatialCuts).toContainEqual(
      expect.objectContaining({
        source: "inferred",
        axis: "x",
        gap: 80,
        beforeTextIds: ["left-title", "left-first", "left-second"],
        afterTextIds: ["right-title", "right-first", "right-second"],
      }),
    );
    const markdown = structuredExportToMarkdown(result);
    expect(markdown.indexOf(`> ${escapeMarkdown("left-second")}`)).toBeLessThan(
      markdown.indexOf(`> ${escapeMarkdown("right-title")}`),
    );
    expect(result.layout.readingOrder.source).toBe("inferred");
    expect(new Set(section.textIds).size).toBe(8);
  });

  it("keeps short diagram labels in row order instead of inferring prose columns", () => {
    const text = (id: string, x: number, y: number) =>
      element(id, "text", {
        x,
        y,
        width: 30,
        height: 25,
        originalText: id,
        text: id,
      });
    const result = buildStructuredExport(
      [
        element("region", "rectangle", { width: 400, height: 300 }),
        text("a1", 10, 10),
        text("a2", 10, 100),
        text("b1", 200, 15),
        text("b2", 200, 110),
      ],
      {},
      options,
    );
    expect(result.layout.readingOrder.sections[0].textIds).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
    ]);
    expect(
      result.layout.readingOrder.sections[0].spatialCuts.some(
        (cut) => cut.axis === "x",
      ),
    ).toBe(false);
  });

  it("escapes Markdown and HTML in source text and emits each text element exactly once", () => {
    const originalText =
      "# heading\n- list | table\n<script>alert(1)</script>\n**bold** [link](url) `code`\\\n    indented\n";
    const result = buildStructuredExport(
      [element("text", "text", { originalText, text: "wrapped" })],
      {},
      options,
    );
    const markdown = structuredExportToMarkdown(result);
    expect(markdown).toContain("> \\# heading");
    expect(markdown).toContain("> \\- list \\| table");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&#32;&#32;&#32;&#32;indented");
    expect(
      result.layout.readingOrder.sections.flatMap((section) => section.textIds),
    ).toEqual(["text"]);
    expect(
      JSON.parse(decode(prepareStructuredExport(result, {}, "json").data))
        .nodes[0].originalText,
    ).toBe(originalText);
  });

  it("exports safe image attachments with actual bytes and JSON references, without base64 payload noise", () => {
    const files = {
      "../unsafe/image": {
        id: "../unsafe/image",
        dataURL: "data:image/png;base64,AQIDBA==",
        mimeType: "image/png",
        created: 1,
      },
    } as unknown as BinaryFiles;
    const elements = [
      element("image", "image", {
        fileId: "../unsafe/image",
        status: "saved",
        scale: [1, 1],
      }),
    ];
    const result = buildStructuredExport(elements, files, options);
    const request = prepareStructuredExport(result, files, "md");
    expect(request.assetDirectory).toMatch(/^guzi-assets-[a-z0-9]+$/);
    expect(request.assets?.[0].name).not.toMatch(/[/.]{2}|[\\/]/);
    expect(new Uint8Array(request.assets![0].data)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(decode(request.data)).toContain(
      `${request.assetDirectory}/${request.assets![0].name}`,
    );
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(
      result.diagnostics.some((item) => item.code === "images-not-ocr"),
    ).toBe(true);
    expect(result.assets[0].path).not.toBeNull();
    expect(
      buildStructuredExport(elements, {}, options).assets[0],
    ).toMatchObject({ status: "missing", path: null });
    expect(() =>
      prepareStructuredExport(
        result,
        {
          ...files,
          "../unsafe/image": {
            ...files["../unsafe/image"],
            dataURL:
              "data:image/png;base64,AA==" as BinaryFiles[string]["dataURL"],
          },
        },
        "json",
      ),
    ).toThrow("Image data changed");
  });

  it("is deterministic and does not mutate source elements or files", () => {
    const elements = [
      element("box"),
      element("text", "text", { width: 20, height: 20 }),
    ];
    const before = JSON.stringify(elements);
    const first = buildStructuredExport(elements, {}, options);
    const second = buildStructuredExport(elements, {}, options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(structuredExportToMarkdown(first)).toBe(
      structuredExportToMarkdown(second),
    );
    expect(JSON.stringify(elements)).toBe(before);
  });

  it("exports reachable subcanvas hierarchy once, keeps cycles as links, and attaches child image data", () => {
    const pin = (id: string, sceneId: string) =>
      element(id, "stickynote", { customData: { subcanvas: { sceneId } } });
    const files = {
      image: {
        id: "image",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AQID",
        created: 1,
      },
    } as unknown as BinaryFiles;
    const subscenes = {
      child: {
        version: 1 as const,
        title: "Child",
        elements: [
          element("child-text", "text", { originalText: "Child text" }),
          element("child-image", "image", {
            fileId: "image",
            scale: [1, 1],
            status: "saved",
          }),
          pin("nested-pin", "nested"),
        ],
        appState: {},
      },
      nested: {
        version: 1 as const,
        title: "Nested",
        elements: [pin("back", "child")],
        appState: {},
      },
      orphan: {
        version: 1 as const,
        title: "Orphan",
        elements: [element("unused", "text")],
        appState: {},
      },
    };
    const result = buildStructuredExport(
      [pin("pin", "child"), pin("same-child", "child")],
      files,
      { ...options, subscenes },
    );
    expect(result.subcanvases?.map((child) => child.id)).toEqual([
      "child",
      "nested",
    ]);
    expect(result.subcanvasLinks).toEqual([
      { parentSceneId: null, pinElementId: "pin", sceneId: "child" },
      { parentSceneId: "child", pinElementId: "nested-pin", sceneId: "nested" },
      { parentSceneId: "nested", pinElementId: "back", sceneId: "child" },
      { parentSceneId: null, pinElementId: "same-child", sceneId: "child" },
    ]);
    expect(result.assets).toHaveLength(1);
    expect(result.subcanvases?.[0].document.assets[0].path).toBe(
      result.assets[0].path,
    );
    const exported = prepareStructuredExport(result, files, "json");
    expect(
      exported.assets?.map((asset) => Array.from(new Uint8Array(asset.data))),
    ).toEqual([[1, 2, 3]]);
    const markdown = structuredExportToMarkdown(result);
    expect(markdown).toContain("Subcanvas hierarchy");
    expect(markdown).toContain("Child text");
    expect(markdown).toContain(result.assets[0].path);
    expect(markdown).not.toContain("Orphan");
  });

  it("adds one PDF page per reachable nonempty subcanvas when requested", async () => {
    const { exportToSvg } = await import("@excalidraw/utils/export");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100");
    svg.setAttribute("height", "200");
    vi.mocked(exportToSvg).mockResolvedValue(svg);
    const api = {
      commitEditing: vi.fn(),
      getSceneElements: () => [
        element("pin", "stickynote", {
          customData: { subcanvas: { sceneId: "child" } },
        }),
      ],
      getFiles: () => ({}),
      getAppState: () => ({
        subscenes: {
          child: {
            version: 1,
            title: "Child",
            elements: [element("inside", "text")],
            appState: { viewBackgroundColor: "#eeeeee" },
          },
        },
      }),
    } as unknown as ExcalidrawImperativeAPI;
    const savePdf = vi.fn().mockResolvedValue(true);
    const snapshot = {
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
    };
    const staleApi = {
      ...api,
      getSceneElements: () => [],
    } as unknown as ExcalidrawImperativeAPI;
    await exportCanvasPdf(
      staleApi,
      "Canvas",
      { savePdf } as unknown as DesktopAPI,
      {
        includeSubcanvases: true,
        snapshot,
      },
    );
    expect(savePdf).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Canvas",
        pages: [
          { title: "Child", svg: svg.outerHTML, width: 100, height: 200 },
        ],
      }),
    );
    expect(exportToSvg).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "inside" })],
        appState: expect.objectContaining({ viewBackgroundColor: "#eeeeee" }),
      }),
    );
  });

  it("commits edits before taking a PDF snapshot and saves an embedded SVG at scene dimensions", async () => {
    const { exportToSvg } = await import("@excalidraw/utils/export");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "900");
    svg.setAttribute("height", "600");
    vi.mocked(exportToSvg).mockResolvedValue(svg);
    const commitEditing = vi.fn();
    const getSceneElements = vi.fn(() => [element("box")]);
    const files = {};
    const api = {
      commitEditing,
      getSceneElements,
      getAppState: () => ({ exportScale: 4 }),
      getFiles: () => files,
    } as unknown as ExcalidrawImperativeAPI;
    const savePdf = vi.fn().mockResolvedValue(true);
    expect(
      await exportCanvasPdf(api, "Canvas", {
        savePdf,
      } as unknown as DesktopAPI),
    ).toBe(true);
    expect(commitEditing.mock.invocationCallOrder[0]).toBeLessThan(
      getSceneElements.mock.invocationCallOrder[0],
    );
    expect(exportToSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          exportScale: 1,
          exportEmbedScene: false,
        }),
        files,
        reuseImages: true,
      }),
    );
    expect(savePdf).toHaveBeenCalledWith({
      name: "Canvas",
      width: 900,
      height: 600,
      svg: svg.outerHTML,
    });
  });
});

describe("structured export dialog", () => {
  afterEach(cleanup);
  const setup = (saveExport: ReturnType<typeof vi.fn>) => {
    const root = document.createElement("div");
    document.body.append(root);
    root.ownerDocument.defaultView!.desktop = {
      saveExport,
    } as unknown as DesktopAPI;
    const source = [
      element("text", "text", {
        originalText: "Captured original",
        text: "Captured original",
      }),
    ];
    const api = {
      commitEditing: vi.fn(),
      getSceneElements: () => source,
      getFiles: () => ({}),
      getAppState: () => ({ subscenes: {} }),
    } as unknown as ExcalidrawImperativeAPI;
    const onClose = vi.fn();
    render(
      createElement(StructuredExportDialog, {
        root,
        api,
        title: "Canvas",
        language: "en",
        defaultFormat: "json",
        includeInferredStructure: true,
        onClose,
      }),
      { container: root },
    );
    return { onClose, api, source, root };
  };

  it("waits for the save result, retains the captured snapshot and then closes on success", async () => {
    let finish!: (success: boolean) => void;
    const saveExport = vi.fn(
      (_request: Parameters<DesktopAPI["saveExport"]>[0]) =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { onClose, api, source } = setup(saveExport);
    expect(api.commitEditing).toHaveBeenCalledTimes(1);
    (source[0] as unknown as { originalText: string }).originalText =
      "Changed after preview";
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
    expect(
      JSON.parse(decode(saveExport.mock.calls[0][0].data)).nodes[0]
        .originalText,
    ).toBe("Captured original");
    await act(async () => finish(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview open when the save dialog is cancelled or an error occurs", async () => {
    const saveExport = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("Disk unavailable"));
    const { onClose } = setup(saveExport);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Export" })),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Export" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Disk unavailable");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("exports the selected format independently of the preview tab", async () => {
    const saveExport = vi.fn().mockResolvedValue(false);
    setup(saveExport);
    fireEvent.click(screen.getByRole("radio", { name: "Markdown" }));
    const preview = screen.getByRole("radiogroup", { name: "Preview" });
    fireEvent.click(
      preview.querySelector<HTMLInputElement>('input[value="json"]')!,
    );
    expect(screen.getByLabelText("Preview: JSON")).toHaveTextContent(
      '"format": "guzi-graph.semantic"',
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Export" })),
    );
    expect(saveExport.mock.calls[0][0].extension).toBe("md");
    expect(decode(saveExport.mock.calls[0][0].data)).toContain(
      "> Captured original",
    );
  });
});
