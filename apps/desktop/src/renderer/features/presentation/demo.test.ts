import { readFileSync } from "fs";
import { resolve } from "path";

import { getCommonBounds } from "@excalidraw/element";
import {
  getTableMember,
  isTableRoot,
  readTableData,
  updateTableElements,
} from "@excalidraw/element/table";
import {
  collectSubcanvasScenes,
  getSubcanvasId,
} from "@excalidraw/excalidraw/subcanvas";

import { parsePresentation, serializePresentation } from "./model";
import { exportPresentationPdf, renderSlideSvg } from "./renderSlide";

import type { DesktopAPI } from "../../../shared/desktop-api";

const path = resolve(
  process.cwd(),
  "examples/guzi/presentation-demo.guzi-presentation",
);

const loadDemo = async () => {
  const deck = await parsePresentation(readFileSync(path, "utf8"), window);
  expect(deck).not.toBeNull();
  return deck!;
};

const titles = [
  "把想法讲清楚",
  "用证据建立共识",
  "让表达有层次",
  "让讨论变成行动",
];

describe("editable presentation demo file", () => {
  it("round trips every real page and keeps its content inside the 16:9 canvas", async () => {
    const original = await loadDemo();
    expect(original).toMatchObject({ width: 1280, height: 720, version: 1 });
    const deck = await parsePresentation(
      serializePresentation(original),
      window,
    );
    expect(deck?.slides.map((slide) => slide.title)).toEqual(titles);
    for (const [index, slide] of deck!.slides.entries()) {
      const before = original.slides[index];
      expect(slide.id).toBe(before.id);
      expect(slide.scene.elements?.map((element) => element.id)).toEqual(
        before.scene.elements?.map((element) => element.id),
      );
      expect(slide.scene.files).toEqual(before.scene.files);
      expect(slide.scene.appState?.subscenes).toEqual(
        before.scene.appState?.subscenes,
      );
      const [left, top, right, bottom] = getCommonBounds(
        slide.scene.elements!.filter((element) => !element.isDeleted),
      );
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(deck!.width);
      expect(bottom).toBeLessThanOrEqual(deck!.height);
    }
  });

  it("contains a native editable table whose cells survive a real edit and save", async () => {
    const deck = await loadDemo();
    const slide = deck.slides[1];
    const elements = slide.scene.elements!;
    const root = elements.find(isTableRoot)!;
    expect(root).toBeDefined();
    const table = readTableData(root, elements);
    expect(table.rows).toHaveLength(4);
    expect(table.columns).toHaveLength(4);
    expect(table.cells).toHaveLength(16);
    expect(
      elements.filter((element) => getTableMember(element)?.role === "text"),
    ).toHaveLength(16);
    expect(
      elements.filter(
        (element) => getTableMember(element)?.role === "background",
      ),
    ).toHaveLength(16);
    expect(table.cells[0].richText?.paragraphs[0].runs[0].bold).toBe(true);

    slide.scene = {
      ...slide.scene,
      elements: updateTableElements(elements, root, (data) => ({
        ...data,
        cells: data.cells.map((cell) =>
          cell.row === 1 && cell.column === 3
            ? { ...cell, text: "本周五做原型" }
            : cell,
        ),
      })),
    };
    const restored = (await parsePresentation(
      serializePresentation(deck),
      window,
    ))!;
    const editedElements = restored.slides[1].scene.elements!;
    const editedRoot = editedElements.find(isTableRoot)!;
    expect(
      readTableData(editedRoot, editedElements).cells.find(
        (cell) => cell.row === 1 && cell.column === 3,
      )?.text,
    ).toBe("本周五做原型");
    expect(
      editedElements.some(
        (element) =>
          element.type === "text" && element.originalText === "本周五做原型",
      ),
    ).toBe(true);
  });

  it("preserves real rich text, a reachable subcanvas and its embedded image", async () => {
    const deck = (await parsePresentation(
      serializePresentation(await loadDemo()),
      window,
    ))!;
    const rich = deck.slides[2].scene.elements?.find(
      (element) => element.id === "demo-rich-text",
    );
    expect(rich?.type).toBe("text");
    if (rich?.type !== "text") {
      throw new Error("Missing native rich text");
    }
    const paragraphs = rich.richText!.paragraphs;
    expect(
      paragraphs.filter((paragraph) => paragraph.list?.kind === "ordered"),
    ).toHaveLength(3);
    const runs = paragraphs.flatMap((paragraph) => paragraph.runs);
    expect(runs.some((run) => run.bold && run.underline)).toBe(true);
    expect(runs.some((run) => run.italic && run.background)).toBe(true);

    const action = deck.slides[3].scene;
    const pin = action.elements!.find((element) => getSubcanvasId(element))!;
    expect(pin.type).toBe("stickynote");
    const id = getSubcanvasId(pin)!;
    const reachable = collectSubcanvasScenes(
      action.elements!,
      action.appState!.subscenes,
    );
    expect(Object.keys(reachable)).toEqual([id]);
    const child = reachable[id];
    expect(child.title).toBe("细节工作台");
    expect(child.elements.some(isTableRoot)).toBe(true);
    expect(
      child.elements.some(
        (element) => element.type === "text" && element.richText,
      ),
    ).toBe(true);
    const childImage = child.elements.find(
      (element) => element.type === "image",
    )!;
    if (childImage.type !== "image" || !childImage.fileId) {
      throw new Error("Missing embedded child image");
    }
    const resource = action.files![childImage.fileId];
    expect(resource.mimeType).toBe("image/svg+xml");
    expect(resource.dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
    const childSvg = await renderSlideSvg(
      { id, title: child.title, scene: { ...child, files: action.files } },
      deck.width,
      deck.height,
      document,
    );
    expect(childSvg.outerHTML).toContain(resource.dataURL);
    expect(childSvg.textContent).toContain("细节工作台");
    expect(Object.values(deck.slides[0].scene.files!)[0].dataURL).toBe(
      resource.dataURL,
    );
  });

  it("renders every page using real SVG export, including rich text and images", async () => {
    const deck = await loadDemo();
    const visibleTitles = [
      "把想法",
      "让证据接住你的观点",
      "把重点写进句子，而不是堆在屏幕上",
      "把细节收起来，让行动走出去",
    ];
    for (const [index, slide] of deck.slides.entries()) {
      const svg = await renderSlideSvg(
        slide,
        deck.width,
        deck.height,
        document,
      );
      expect(svg.getAttribute("width")).toBe("1280");
      expect(svg.getAttribute("height")).toBe("720");
      expect(svg.getAttribute("viewBox")).toBe("0 0 1280 720");
      expect(svg.getAttribute("overflow")).toBe("hidden");
      expect(svg.textContent).toContain(visibleTitles[index]);
      if (index === 0) {
        expect(svg.querySelector("image")).not.toBeNull();
        expect(svg.outerHTML).toContain(
          Object.values(slide.scene.files!)[0].dataURL,
        );
      }
      if (index === 2) {
        expect(svg.querySelector('[font-weight="bold"]')).not.toBeNull();
        expect(svg.querySelector('[font-style="italic"]')).not.toBeNull();
      }
    }
  });

  it("passes all four PDF pages to the native API in document order", async () => {
    const deck = await loadDemo();
    const savePdf = vi.fn().mockResolvedValue(true);
    await expect(
      exportPresentationPdf(
        deck,
        "把想法讲清楚",
        { savePdf } as unknown as DesktopAPI,
        document,
      ),
    ).resolves.toBe(true);
    expect(savePdf).toHaveBeenCalledTimes(1);
    const request = savePdf.mock.calls[0][0];
    expect(request).toMatchObject({
      name: titles[0],
      width: 1280,
      height: 720,
    });
    expect(request.svg).toContain("把想法");
    expect(request.pages).toHaveLength(3);
    expect(request.pages.map((page: { title: string }) => page.title)).toEqual(
      titles.slice(1),
    );
    expect(request.pages[0].svg).toContain("让证据接住你的观点");
    expect(request.pages[1].svg).toContain("把重点写进句子");
    expect(request.pages[2].svg).toContain("把细节收起来");
    expect(
      request.pages.every(
        (page: { width: number; height: number }) =>
          page.width === 1280 && page.height === 720,
      ),
    ).toBe(true);
  });
});
