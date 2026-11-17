import { describe, expect, it, vi } from "vitest";

import {
  createFormulaSvg,
  drawFormulaOnCanvas,
  getFormulaDimensions,
  getFormulaLayout,
  MAX_FORMULA_SOURCE_LENGTH,
  tryGetFormulaLayout,
} from "../src/formula";

describe("LaTeX formulas", () => {
  it("uses font-independent paths and scales the bounds by font size", () => {
    const layout = getFormulaLayout(
      String.raw`\[\boxed{x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}}\]`,
    );
    const normal = getFormulaDimensions(layout, 20);
    expect(getFormulaDimensions(layout, 40)).toEqual({
      width: normal.width * 2,
      height: normal.height * 2,
    });
    expect(normal.width).toBeGreaterThan(60);
    expect(normal.height).toBeGreaterThan(20);

    const previewDocument = document.implementation.createHTMLDocument();
    const svg = createFormulaSvg(
      layout,
      previewDocument,
      normal.width,
      normal.height,
      "#427dff",
    );
    expect(svg.ownerDocument).toBe(previewDocument);
    expect(svg.getAttribute("color")).toBe("#427dff");
    expect(svg.getAttribute("width")).toBe(String(normal.width));
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(10);
    expect(svg.querySelector("path[stroke]")?.getAttribute("fill")).toBe(
      "none",
    );
    expect(svg.querySelector("image, use, text, foreignObject")).toBeNull();
  });

  it("preserves stretched delimiters and array rules in Canvas and SVG", () => {
    const layout = getFormulaLayout(
      String.raw`\left\lbrace\begin{array}{|c|c|}\hline a&b\\\hline c&d\\e&f\\g&h\\i&j\end{array}\right.`,
    );
    const { width, height } = getFormulaDimensions(layout, 20);
    const svg = createFormulaSvg(layout, document, width, height, "#000");
    const rules = svg.querySelectorAll("path[stroke]");
    const delimiters = svg.querySelectorAll("svg");
    expect(rules.length).toBeGreaterThan(0);
    expect(delimiters.length).toBeGreaterThan(0);

    const context = document.createElement("canvas").getContext("2d")!;
    const fill = vi.spyOn(context, "fill");
    const stroke = vi.spyOn(context, "stroke");
    const clip = vi.spyOn(context, "clip");
    const createPath = vi.fn((d: string) => new Path2D(d));
    drawFormulaOnCanvas(context, layout, width, height, "#000", {
      createCanvas: () => document.createElement("canvas"),
      createImage: () => document.createElement("img"),
      createPath,
    });
    expect(createPath.mock.calls.map(([d]) => d)).toEqual(
      [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d")),
    );
    expect(fill).toHaveBeenCalled();
    expect(stroke).toHaveBeenCalledTimes(rules.length);
    expect(clip).toHaveBeenCalledTimes(delimiters.length + 1);
  });

  it("reports syntax errors and rejects unsupported or oversized input", () => {
    expect(() => getFormulaLayout(String.raw`\frac{a}`)).toThrow(
      "Missing argument",
    );
    expect(
      tryGetFormulaLayout(String.raw`\href{https://example.com}{x}`),
    ).toBeNull();
    expect(
      tryGetFormulaLayout("x".repeat(MAX_FORMULA_SOURCE_LENGTH + 1)),
    ).toBeNull();
    expect(tryGetFormulaLayout("$$ $$")).toBeNull();
    expect(tryGetFormulaLayout("\\quad")).toBeNull();
    expect(tryGetFormulaLayout("x+1")).not.toBeNull();
  });
});
