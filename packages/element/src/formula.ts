import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { HTMLHandler } from "mathjax-full/js/handlers/html/HTMLHandler.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import { SVG } from "mathjax-full/js/output/svg.js";

import { SVG_NS } from "@excalidraw/common";

import { getCreatePath } from "./renderEnvironment";

import type { RenderEnvironment } from "./renderEnvironment";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import type TexError from "mathjax-full/js/input/tex/TexError.js";

export const MAX_FORMULA_SOURCE_LENGTH = 4096;

const SVG_UNITS_PER_EM = 1000;
// Keep small glyph overhangs inside the selection box and exported SVG.
const GLYPH_PADDING = 60;
const MAX_LAYOUT_CACHE_SIZE = 64;

type ViewBox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type Transform = [number, number, number, number, number, number];

type FormulaNode = {
  transform?: Transform;
} & (
  | {
      kind: "group";
      children: FormulaNode[];
      viewport?: ViewBox;
      viewBox?: ViewBox;
    }
  | {
      kind: "path";
      d: string;
      stroke?: { width: number; dash: number[]; round: boolean };
    }
);

export type FormulaLayout = Readonly<{
  /** Formula bounds in em; multiply by the element fontSize for scene pixels. */
  widthEm: number;
  heightEm: number;
  viewBox: ViewBox;
  nodes: readonly FormulaNode[];
}>;

const initializeTypesetter = () => {
  const input = new TeX({
    packages: ["base", "ams"],
    maxBuffer: MAX_FORMULA_SOURCE_LENGTH,
    formatError: (_jax: TeX<unknown, unknown, unknown>, error: TexError) => {
      throw new Error(error.message);
    },
  });
  const handler = new HTMLHandler(liteAdaptor());
  const throwError = (_document: unknown, _math: unknown, error: unknown) => {
    throw error;
  };
  const mathDocument = handler.create("", {
    InputJax: input,
    OutputJax: new SVG({ fontCache: "none" }),
    compileError: throwError,
    typesetError: throwError,
  });
  return { input, mathDocument };
};

let typesetter: ReturnType<typeof initializeTypesetter> | undefined;
const layoutCache = new Map<string, FormulaLayout | Error>();

const trimMathDelimiters = (source: string) => {
  const delimiters = [
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\(", "\\)"],
    ["$", "$"],
  ];
  for (const [open, close] of delimiters) {
    if (source.startsWith(open) && source.endsWith(close)) {
      return source.slice(open.length, -close.length).trim();
    }
  }
  return source;
};

const parseNumbers = (value: string) => {
  const numbers = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!numbers.every(Number.isFinite)) {
    throw new Error("The formula contains an invalid dimension.");
  }
  return numbers;
};

const getTransform = (value: string | undefined): Transform | undefined => {
  if (!value) {
    return;
  }
  const matrix: Transform = [1, 0, 0, 1, 0, 0];
  for (const [, type, parameters] of value.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const [a, b, c, d, e, f] = parseNumbers(parameters);
    const [A, B, C, D, E, F] = matrix;
    switch (type) {
      case "translate": {
        matrix[4] += A * a + C * (b ?? 0);
        matrix[5] += B * a + D * (b ?? 0);
        break;
      }
      case "scale": {
        matrix[0] *= a;
        matrix[1] *= a;
        matrix[2] *= b ?? a;
        matrix[3] *= b ?? a;
        break;
      }
      case "matrix": {
        matrix[0] = A * a + C * b;
        matrix[1] = B * a + D * b;
        matrix[2] = A * c + C * d;
        matrix[3] = B * c + D * d;
        matrix[4] = A * e + C * f + E;
        matrix[5] = B * e + D * f + F;
        break;
      }
      default:
        throw new Error("This formula uses an unsupported transform.");
    }
  }
  return matrix;
};

const getViewBox = (value: string | undefined): ViewBox => {
  if (!value) {
    throw new Error("This formula does not have a fixed size.");
  }
  const [x, y, width, height] = parseNumbers(value);
  if (!(width > 0 && height > 0)) {
    throw new Error("The formula has an invalid size.");
  }
  return { x, y, width, height };
};

const readPaths = (element: LiteElement): FormulaNode[] => {
  const attributes = element.attributes;
  const transform = getTransform(attributes.transform);
  const num = (key: string) => {
    const value = Number(attributes[key] ?? 0);
    if (!Number.isFinite(value)) {
      throw new Error("The formula contains an invalid dimension.");
    }
    return value;
  };

  switch (element.kind) {
    case "g":
    case "svg": {
      const children = element.children.flatMap((child) =>
        readPaths(child as LiteElement),
      );
      if (!children.length) {
        return [];
      }
      if (element.kind === "svg") {
        const viewport = {
          x: num("x"),
          y: num("y"),
          width: num("width"),
          height: num("height"),
        };
        if (!(viewport.width > 0 && viewport.height > 0)) {
          throw new Error("This formula does not have a fixed size.");
        }
        return [
          {
            kind: "group",
            transform,
            children,
            viewport,
            viewBox: getViewBox(attributes.viewBox),
          },
        ];
      }
      return transform ? [{ kind: "group", transform, children }] : children;
    }
    case "path":
      return [{ kind: "path", transform, d: attributes.d }];
    case "polygon":
      return [{ kind: "path", transform, d: `M${attributes.points}Z` }];
    case "rect":
    case "line": {
      const d =
        element.kind === "rect"
          ? `M${num("x")} ${num("y")}h${num("width")}v${num("height")}h${-num(
              "width",
            )}Z`
          : `M${num("x1")} ${num("y1")}L${num("x2")} ${num("y2")}`;
      // MathJax gives ruled arrays their line styles through CSS classes.
      // Inline those values so the layout does not depend on a style sheet.
      const isTableRule = attributes["data-line"] || attributes["data-frame"];
      const width = isTableRule
        ? num("stroke-thickness") || 70
        : num("stroke-width");
      if (width > 0) {
        const round = attributes.class === "mjx-dotted";
        const dash = attributes["stroke-dasharray"]
          ? parseNumbers(attributes["stroke-dasharray"])
          : round
          ? [0, 2 * width]
          : attributes.class === "mjx-dashed"
          ? [2 * width]
          : [];
        return [{ kind: "path", transform, d, stroke: { width, dash, round } }];
      }
      return [{ kind: "path", transform, d }];
    }
    case "text":
      throw new Error(
        "The built-in math font cannot draw a character in this formula.",
      );
    default:
      throw new Error("This formula uses unsupported content.");
  }
};

const layoutFormula = (source: string): FormulaLayout => {
  typesetter ??= initializeTypesetter();
  const { input, mathDocument } = typesetter;
  input.reset();
  const math = mathDocument.convert(source, { display: true }) as LiteElement;
  const svg = math.children.find(
    (node): node is LiteElement => node.kind === "svg",
  );
  if (!svg) {
    throw new Error("This formula does not have a fixed size.");
  }
  const bounds = getViewBox(svg.attributes.viewBox);
  if (Math.max(bounds.width, bounds.height) > 2000 * SVG_UNITS_PER_EM) {
    throw new Error("The formula is too large to display.");
  }
  const nodes = svg.children.flatMap((node) => readPaths(node as LiteElement));
  if (!nodes.length) {
    throw new Error("Enter a visible LaTeX expression.");
  }
  const viewBox = {
    x: bounds.x - GLYPH_PADDING,
    y: bounds.y - GLYPH_PADDING,
    width: bounds.width + GLYPH_PADDING * 2,
    height: bounds.height + GLYPH_PADDING * 2,
  };
  return {
    widthEm: viewBox.width / SVG_UNITS_PER_EM,
    heightEm: viewBox.height / SVG_UNITS_PER_EM,
    viewBox,
    nodes,
  };
};

export const getFormulaLayout = (latex: string): FormulaLayout => {
  if (latex.length > MAX_FORMULA_SOURCE_LENGTH) {
    throw new Error("The LaTeX source is too long.");
  }
  const source = trimMathDelimiters(latex.trim());
  if (!source) {
    throw new Error("Enter a LaTeX expression.");
  }
  let result = layoutCache.get(source);
  if (!result) {
    try {
      result = layoutFormula(source);
    } catch (error) {
      result = error instanceof Error ? error : new Error("Invalid LaTeX.");
    }
    if (layoutCache.size >= MAX_LAYOUT_CACHE_SIZE) {
      layoutCache.delete(layoutCache.keys().next().value!);
    }
    layoutCache.set(source, result);
  }
  if (result instanceof Error) {
    throw result;
  }
  return result;
};

export const tryGetFormulaLayout = (latex: string): FormulaLayout | null => {
  try {
    return getFormulaLayout(latex);
  } catch {
    return null;
  }
};

export const getFormulaDimensions = (
  layout: FormulaLayout,
  fontSize: number,
) => ({
  width: layout.widthEm * fontSize,
  height: layout.heightEm * fontSize,
});

const viewBoxToString = ({ x, y, width, height }: ViewBox) =>
  `${x} ${y} ${width} ${height}`;

const appendSvgNodes = (parent: SVGElement, nodes: readonly FormulaNode[]) => {
  const { ownerDocument } = parent;
  for (const node of nodes) {
    const shape = ownerDocument.createElementNS(
      SVG_NS,
      node.kind === "path" ? "path" : node.viewport ? "svg" : "g",
    );
    if (node.transform) {
      shape.setAttribute("transform", `matrix(${node.transform.join(" ")})`);
    }
    if (node.kind === "path") {
      shape.setAttribute("d", node.d);
      if (node.stroke) {
        shape.setAttribute("fill", "none");
        shape.setAttribute("stroke", "currentColor");
        shape.setAttribute("stroke-width", String(node.stroke.width));
        if (node.stroke.dash.length) {
          shape.setAttribute("stroke-dasharray", node.stroke.dash.join(" "));
        }
        if (node.stroke.round) {
          shape.setAttribute("stroke-linecap", "round");
        }
      }
    } else {
      if (node.viewport && node.viewBox) {
        for (const [name, value] of Object.entries(node.viewport)) {
          shape.setAttribute(name, String(value));
        }
        shape.setAttribute("viewBox", viewBoxToString(node.viewBox));
      }
      appendSvgNodes(shape, node.children);
    }
    parent.appendChild(shape);
  }
};

export const createFormulaSvg = (
  layout: FormulaLayout,
  ownerDocument: Document,
  width: number,
  height: number,
  color: string,
): SVGSVGElement => {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", viewBoxToString(layout.viewBox));
  svg.setAttribute("color", color);
  svg.setAttribute("fill", "currentColor");
  appendSvgNodes(svg, layout.nodes);
  return svg;
};

const drawInViewBox = (
  context: CanvasRenderingContext2D,
  viewport: ViewBox,
  viewBox: ViewBox,
) => {
  const scale = Math.min(
    viewport.width / viewBox.width,
    viewport.height / viewBox.height,
  );
  context.beginPath();
  context.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  context.clip();
  context.translate(
    viewport.x + (viewport.width - viewBox.width * scale) / 2,
    viewport.y + (viewport.height - viewBox.height * scale) / 2,
  );
  context.scale(scale, scale);
  context.translate(-viewBox.x, -viewBox.y);
};

const drawNodes = (
  context: CanvasRenderingContext2D,
  nodes: readonly FormulaNode[],
  createPath: (path: string) => Path2D,
) => {
  for (const node of nodes) {
    context.save();
    try {
      if (node.transform) {
        context.transform(...node.transform);
      }
      if (node.kind === "path") {
        const path = createPath(node.d);
        if (node.stroke) {
          context.lineWidth = node.stroke.width;
          context.lineCap = node.stroke.round ? "round" : "butt";
          context.setLineDash(node.stroke.dash);
          context.stroke(path);
        } else {
          context.fill(path);
        }
      } else {
        if (node.viewport && node.viewBox) {
          drawInViewBox(context, node.viewport, node.viewBox);
        }
        drawNodes(context, node.children, createPath);
      }
    } finally {
      context.restore();
    }
  }
};

export const drawFormulaOnCanvas = (
  context: CanvasRenderingContext2D,
  layout: FormulaLayout,
  width: number,
  height: number,
  color: string,
  environment?: RenderEnvironment,
) => {
  const createPath = getCreatePath(environment);
  context.save();
  try {
    context.fillStyle = color;
    context.strokeStyle = color;
    drawInViewBox(context, { x: 0, y: 0, width, height }, layout.viewBox);
    drawNodes(context, layout.nodes, createPath);
  } finally {
    context.restore();
  }
};
