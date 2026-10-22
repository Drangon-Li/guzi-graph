import { registerCustomFontRegistry, SVG_NS } from "@excalidraw/common";
import {
  getCommonBounds,
  getNonDeletedElements,
  getRootElements,
} from "@excalidraw/element";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { exportToSvg } from "@excalidraw/excalidraw/scene/export";

import { getSlideBounds, serializePresentation } from "./model";

import type { DesktopAPI } from "../../../shared/desktop-api";

import type { Presentation, PresentationSlide } from "./model";

let nextSvgId = 0;

const isolateSvgIds = (svg: SVGSVGElement) => {
  const prefix = `presentation-${nextSvgId++}-`;
  const ids = new Map<string, string>();
  for (const node of svg.querySelectorAll("[id]")) {
    const id = node.getAttribute("id")!;
    ids.set(id, `${prefix}${id}`);
    node.setAttribute("id", `${prefix}${id}`);
  }
  for (const node of svg.querySelectorAll("*")) {
    for (const attribute of Array.from(node.attributes)) {
      let value = attribute.value.replace(
        /url\(#([^)]*)\)/g,
        (original, id: string) =>
          ids.has(id) ? `url(#${ids.get(id)})` : original,
      );
      if (
        attribute.localName === "href" &&
        value.startsWith("#") &&
        ids.has(value.slice(1))
      ) {
        value = `#${ids.get(value.slice(1))}`;
      }
      if (value !== attribute.value) {
        node.setAttributeNS(attribute.namespaceURI, attribute.name, value);
      }
    }
  }
};

export const renderSlideSvg = async (
  slide: PresentationSlide,
  width: number,
  height: number,
  ownerDocument: Document,
): Promise<SVGSVGElement> => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    Math.abs(width * 9 - height * 16) > Math.max(width * 9, height * 16) * 1e-9
  ) {
    throw new Error("演示页面尺寸无效。");
  }
  const appState = restoreAppState(slide.scene.appState, null);
  const bounds = getSlideBounds(slide, width, height);
  registerCustomFontRegistry(appState.fontRegistry ?? {});
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute(
    "viewBox",
    `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`,
  );
  svg.setAttribute("overflow", "hidden");
  const background = ownerDocument.createElementNS(SVG_NS, "rect");
  background.setAttribute("x", String(bounds.x));
  background.setAttribute("y", String(bounds.y));
  background.setAttribute("width", String(bounds.width));
  background.setAttribute("height", String(bounds.height));
  background.setAttribute("fill", appState.viewBackgroundColor);
  svg.appendChild(background);

  const elements = getNonDeletedElements(
    restoreElements(slide.scene.elements, null, {
      deleteInvisibleElements: true,
    }),
  );
  if (elements.length) {
    // Core SVG export normalizes to content bounds; undo that translation so
    // the fixed outer viewport retains the slide's editing coordinates.
    const [minX, minY] = getCommonBounds(getRootElements(elements));
    const content = await exportToSvg(
      elements,
      {
        ...appState,
        exportBackground: false,
        exportPadding: 0,
        exportScale: 1,
        exportEmbedScene: false,
        exportWithDarkMode: false,
        frameRendering: { ...appState.frameRendering, name: false },
      },
      slide.scene.files ?? {},
      { reuseImages: true },
    );
    const imported = ownerDocument.importNode(content, true);
    const contentWidth = Math.max(1, Number(imported.getAttribute("width")));
    const contentHeight = Math.max(1, Number(imported.getAttribute("height")));
    imported.setAttribute("width", String(contentWidth));
    imported.setAttribute("height", String(contentHeight));
    imported.setAttribute("viewBox", `0 0 ${contentWidth} ${contentHeight}`);
    imported.setAttribute("x", String(minX));
    imported.setAttribute("y", String(minY));
    imported.setAttribute("overflow", "visible");
    svg.appendChild(imported);
    isolateSvgIds(svg);
  }
  return svg;
};

export const exportPresentationPdf = async (
  deck: Presentation,
  title: string,
  desktop: DesktopAPI,
  ownerDocument: Document,
): Promise<boolean> => {
  if (!deck.slides.length) {
    throw new Error("演示文稿至少需要一页。");
  }
  const snapshot: Presentation = JSON.parse(serializePresentation(deck));
  const pages: NonNullable<Parameters<DesktopAPI["savePdf"]>[0]["pages"]> = [];
  for (const slide of snapshot.slides) {
    const svg = await renderSlideSvg(
      slide,
      snapshot.width,
      snapshot.height,
      ownerDocument,
    );
    pages.push({
      title: slide.title,
      svg: svg.outerHTML,
      width: snapshot.width,
      height: snapshot.height,
    });
  }
  const [first, ...remaining] = pages;
  return desktop.savePdf({
    name: title,
    svg: first.svg,
    width: snapshot.width,
    height: snapshot.height,
    ...(remaining.length ? { pages: remaining } : {}),
  });
};
