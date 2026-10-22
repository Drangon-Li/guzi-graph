import { getSystemFontId } from "@excalidraw/common";
import { getCommonBounds, getRootElements } from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";
import * as sceneExport from "@excalidraw/excalidraw/scene/export";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import {
  rectangleFixture,
  textFixture,
} from "@excalidraw/excalidraw/tests/fixtures/elementFixture";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { createPresentation } from "./model";
import { exportPresentationPdf, renderSlideSvg } from "./renderSlide";

import type { DesktopAPI } from "../../../shared/desktop-api";

import type { PresentationSlide } from "./model";

const page = (
  elements: readonly ExcalidrawElement[] = [],
): PresentationSlide => ({ id: "page", title: "Page", scene: { elements } });

describe("presentation SVG", () => {
  it("renders a full fixed-size background for an empty page", async () => {
    const slide = page();
    slide.scene.appState = { viewBackgroundColor: "#123456" };
    const svg = await renderSlideSvg(slide, 1280, 720, document);
    expect(svg.getAttribute("width")).toBe("1280");
    expect(svg.getAttribute("height")).toBe("720");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1280 720");
    expect(svg.getAttribute("overflow")).toBe("hidden");
    expect(svg.children).toHaveLength(1);
    expect(svg.firstElementChild?.getAttribute("fill")).toBe("#123456");
  });

  it("keeps scene coordinates and frame contents inside a fixed clipping viewport", async () => {
    const frame = {
      ...rectangleFixture,
      type: "frame",
      id: "frame",
      name: "Frame",
      x: 150,
      y: 200,
      width: 400,
      height: 300,
    } as ExcalidrawElement;
    const slide = page([
      { ...rectangleFixture, id: "off-page", x: -200, y: -100 },
      frame,
      {
        ...rectangleFixture,
        id: "in-frame",
        x: 200,
        y: 250,
        frameId: frame.id,
        link: "https://example.com/in-frame",
      },
      { ...rectangleFixture, id: "far-away", x: 1800, y: 1000 },
    ]);
    const before = JSON.stringify(slide.scene);
    const svg = await renderSlideSvg(slide, 1280, 720, document);
    const content = svg.querySelector("svg")!;
    const [minX, minY] = getCommonBounds(
      getRootElements(restoreElements(slide.scene.elements, null)),
    );
    expect(content.getAttribute("x")).toBe(String(minX));
    expect(content.getAttribute("y")).toBe(String(minY));
    expect(content.getAttribute("overflow")).toBe("visible");
    expect(svg.outerHTML).toContain("https://example.com/in-frame");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1280 720");
    expect(content.getAttribute("width")).not.toBe("1280");
    expect(JSON.stringify(slide.scene)).toBe(before);
  });

  it("preserves image data and font declarations in the rendered SVG", async () => {
    const dataURL = "data:image/svg+xml;base64,PHN2Zy8+";
    const slide = page([
      {
        ...textFixture,
        id: "text",
        text: "Hello",
        originalText: "Hello",
      } as ExcalidrawElement,
      {
        ...rectangleFixture,
        id: "image",
        type: "image",
        fileId: "image",
        scale: [1, 1],
        crop: null,
        status: "saved",
      } as ExcalidrawElement,
    ]);
    slide.scene.files = {
      image: {
        id: "image" as any,
        mimeType: "image/svg+xml",
        dataURL: dataURL as any,
        created: 1,
      },
    };
    const svg = await renderSlideSvg(slide, 1280, 720, document);
    expect(svg.outerHTML).toContain(dataURL);
    expect(svg.querySelector("style.style-fonts")?.textContent).toContain(
      "@font-face",
    );
    expect(svg.outerHTML).toContain("Hello");
  });

  it("registers a page's custom font before exporting its text", async () => {
    const family = "Presentation Test System Font";
    const id = getSystemFontId(family);
    const slide = page([
      {
        ...textFixture,
        id: "custom-text",
        fontFamily: id,
      } as ExcalidrawElement,
    ]);
    slide.scene.appState = { fontRegistry: { [id]: family } };
    const svg = await renderSlideSvg(slide, 1280, 720, document);
    expect(svg.querySelector("text")?.getAttribute("font-family")).toContain(
      family,
    );
  });

  it("keeps a vertical line visible when content bounds have zero width", async () => {
    const slide = page([
      {
        ...rectangleFixture,
        type: "line",
        id: "vertical",
        x: 100,
        y: 100,
        width: 0,
        height: 200,
        roughness: 0,
        points: [pointFrom(0, 0), pointFrom(0, 200)],
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      } as ExcalidrawElement,
    ]);
    const svg = await renderSlideSvg(slide, 1280, 720, document);
    const content = svg.querySelector("svg")!;
    expect(content.getAttribute("x")).toBe("100");
    expect(content.getAttribute("y")).toBe("100");
    expect(content.getAttribute("width")).toBe("1");
    expect(content.getAttribute("viewBox")).toBe("0 0 1 200");
  });

  it("creates all nodes in the supplied document", async () => {
    const ownerDocument = document.implementation.createHTMLDocument("slide");
    const svg = await renderSlideSvg(
      page([rectangleFixture]),
      1280,
      720,
      ownerDocument,
    );
    expect(svg.ownerDocument).toBe(ownerDocument);
    expect(
      Array.from(svg.querySelectorAll("*")).every(
        (node) => node.ownerDocument === ownerDocument,
      ),
    ).toBe(true);
  });

  it("uses explicit negative scene bounds while retaining the fixed pixel dimensions", async () => {
    const slide = page([{ ...rectangleFixture, x: -800, y: -400 }]);
    slide.bounds = { x: -900, y: -500, width: 1600, height: 900 };
    const svg = await renderSlideSvg(slide, 1280, 720, document);
    expect(svg.getAttribute("width")).toBe("1280");
    expect(svg.getAttribute("height")).toBe("720");
    expect(svg.getAttribute("viewBox")).toBe("-900 -500 1600 900");
    expect(svg.firstElementChild?.getAttribute("x")).toBe("-900");
    expect(svg.firstElementChild?.getAttribute("y")).toBe("-500");
    expect(svg.firstElementChild?.getAttribute("width")).toBe("1600");
    expect(svg.firstElementChild?.getAttribute("height")).toBe("900");
    expect(svg.querySelector("svg")?.getAttribute("x")).toBe("-800");
    expect(svg.querySelector("svg")?.getAttribute("y")).toBe("-400");
    expect(slide.scene.elements?.[0]).toMatchObject({ x: -800, y: -400 });
  });

  it("isolates frame clip references between repeated previews of the same page", async () => {
    const frame = {
      ...rectangleFixture,
      type: "frame",
      id: "shared-frame",
      name: "Frame",
    } as ExcalidrawElement;
    const slide = page([
      frame,
      { ...rectangleFixture, id: "child", frameId: frame.id },
    ]);
    const first = await renderSlideSvg(slide, 1280, 720, document);
    const second = await renderSlideSvg(slide, 1280, 720, document);
    const firstId = first.querySelector("clipPath")!.id;
    const secondId = second.querySelector("clipPath")!.id;
    expect(firstId).not.toBe(secondId);
    expect(first.outerHTML).toContain(`url(#${firstId})`);
    expect(second.outerHTML).toContain(`url(#${secondId})`);
    expect(second.outerHTML).not.toContain(`url(#${firstId})`);
  });

  it("rejects invalid page dimensions", async () => {
    await expect(renderSlideSvg(page(), 0, 720, document)).rejects.toThrow();
    await expect(renderSlideSvg(page(), 100, 100, document)).rejects.toThrow();
  });
});

describe("presentation PDF", () => {
  it("exports a stable snapshot while the live deck is edited and reordered", async () => {
    const deck = createPresentation("first", "First", {
      elements: [rectangleFixture],
      appState: { viewBackgroundColor: "#ff0000" },
    });
    deck.slides.push({
      id: "second",
      title: "Second",
      scene: { appState: { viewBackgroundColor: "#00ff00" } },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = sceneExport.exportToSvg;
    const exportSvg = vi
      .spyOn(sceneExport, "exportToSvg")
      .mockImplementationOnce(async (...args) => {
        await gate;
        return original(...args);
      });
    try {
      const savePdf = vi.fn().mockResolvedValue(true);
      const pending = exportPresentationPdf(
        deck,
        "Snapshot",
        { savePdf } as unknown as DesktopAPI,
        document,
      );
      expect(exportSvg).toHaveBeenCalledTimes(1);
      deck.slides[0].scene.appState = { viewBackgroundColor: "#0000ff" };
      deck.slides[1].title = "Changed";
      deck.slides[1].scene.appState = { viewBackgroundColor: "#111111" };
      deck.slides.reverse();
      release();
      await pending;
      expect(savePdf.mock.calls[0][0].svg).toContain("#ff0000");
      expect(savePdf.mock.calls[0][0].pages[0]).toMatchObject({
        title: "Second",
      });
      expect(savePdf.mock.calls[0][0].pages[0].svg).toContain("#00ff00");
    } finally {
      release();
      exportSvg.mockRestore();
    }
  });

  it("exports every page in order, including an empty page", async () => {
    const deck = createPresentation("first", "First", {
      appState: { viewBackgroundColor: "#ff0000" },
    });
    deck.slides.push(
      {
        id: "second",
        title: "Second",
        scene: { appState: { viewBackgroundColor: "#00ff00" } },
      },
      {
        id: "third",
        title: "Third",
        scene: { elements: [rectangleFixture] },
      },
    );
    const savePdf = vi.fn().mockResolvedValue(true);
    await expect(
      exportPresentationPdf(
        deck,
        "Deck",
        { savePdf } as unknown as DesktopAPI,
        document,
      ),
    ).resolves.toBe(true);
    const request = savePdf.mock.calls[0][0];
    expect(request).toMatchObject({ name: "Deck", width: 1280, height: 720 });
    expect(request.svg).toContain("#ff0000");
    expect(request.pages.map((item: { title: string }) => item.title)).toEqual([
      "Second",
      "Third",
    ]);
    expect(request.pages[0].svg).toContain("#00ff00");
    expect(
      request.pages.every(
        (item: { width: number; height: number }) =>
          item.width === 1280 && item.height === 720,
      ),
    ).toBe(true);
  });

  it("propagates cancel and does not save a deck without pages", async () => {
    const deck = createPresentation("first", "First");
    const savePdf = vi.fn().mockResolvedValue(false);
    const desktop = { savePdf } as unknown as DesktopAPI;
    expect(await exportPresentationPdf(deck, "Deck", desktop, document)).toBe(
      false,
    );
    expect(savePdf.mock.calls[0][0].pages).toBeUndefined();
    savePdf.mockClear();
    deck.slides = [];
    await expect(
      exportPresentationPdf(deck, "Deck", desktop, document),
    ).rejects.toThrow();
    expect(savePdf).not.toHaveBeenCalled();
  });
});
