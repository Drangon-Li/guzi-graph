import {
  isTextElement,
  deepCopyElement,
  newElementWith,
  redrawTextBoundingBox,
  Scene,
  syncInvalidIndicesImmutable,
  updateBoundElements,
} from "@excalidraw/element";
import {
  getRuledTextBaseline,
  getRuledTextLineSpacing,
  getRuledTextTypography,
} from "@excalidraw/element/ruledText";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  createPaperRules,
  getPaperPages,
  getPaperSettings,
  isPaperRule,
  PAPER_WRITING_TOP,
} from "./paper";

import type { PaperSettings } from "./paper";

export const getPaperTextPlacement = ({
  sceneX,
  sceneY,
  elements,
}: {
  sceneX: number;
  sceneY: number;
  elements: readonly ExcalidrawElement[];
}) => {
  const pages = getPaperPages(elements).filter(
    (page) =>
      page.customData?.guziPaper?.kind === "ruled" &&
      !page.angle &&
      sceneX >= page.x &&
      sceneX <= page.x + page.width &&
      sceneY >= page.y &&
      sceneY <= page.y + page.height,
  );
  if (pages.length !== 1) {
    return null;
  }
  const page = pages[0];
  const rules = elements
    .filter((element) => isPaperRule(element, page))
    .sort((a, b) => a.y - b.y);
  const settings = getPaperSettings(page);
  const lineSpacing = settings.lineSpacing;
  if (!rules.length || sceneY < page.y + PAPER_WRITING_TOP) {
    return null;
  }
  const rule = rules.find((element) => element.y >= sceneY - 0.001);
  if (
    !rule ||
    sceneY < rule.y - lineSpacing ||
    sceneX < rule.x ||
    sceneX > rule.x + rule.width
  ) {
    return null;
  }
  const right = rule.x + rule.width;
  const x = Math.max(rule.x, Math.min(sceneX, right - settings.fontSize));
  return {
    x,
    baselineY: rule.y,
    width: right - x,
    lineSpacing,
    fontSize: settings.fontSize,
  };
};

export const applyPaperSettings = (
  elements: readonly ExcalidrawElement[],
  settings: PaperSettings,
): ExcalidrawElement[] => {
  const pages = getPaperPages(elements).filter(
    (page) => page.customData?.guziPaper?.kind !== "pdf",
  );
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const changedRuling = pages.filter(
    (page) =>
      page.customData?.guziPaper?.kind === "ruled" &&
      getPaperSettings(page).lineSpacing !== settings.lineSpacing,
  );
  const rules = changedRuling.flatMap((page) =>
    createPaperRules(page, settings),
  );
  const reflow = new Set<string>();
  const next = elements.map((element) => {
    if (element.isDeleted) {
      return element;
    }
    if (pagesById.has(element.id)) {
      return newElementWith(element, {
        customData: {
          ...element.customData,
          guziPaper: {
            ...element.customData?.guziPaper,
            settings: { ...settings },
            ...(changedRuling.some((page) => page.id === element.id)
              ? { rulingVersion: 1 }
              : {}),
          },
        },
      });
    }
    if (changedRuling.some((page) => isPaperRule(element, page))) {
      return newElementWith(element, { isDeleted: true });
    }
    if (
      !isTextElement(element) ||
      !getRuledTextLineSpacing(element) ||
      element.angle
    ) {
      return element;
    }
    const baseline = getRuledTextBaseline(element);
    const page = changedRuling.find(
      (page) =>
        element.x >= page.x + 48 - 0.001 &&
        element.x < page.x + page.width - 48 &&
        baseline >= page.y &&
        baseline < page.y + page.height,
    );
    if (!page) {
      return element;
    }
    const pageRules = rules.filter((rule) => rule.frameId === page.id);
    if (!pageRules.length) {
      return element;
    }
    const nearest = pageRules.reduce((best, rule) =>
      Math.abs(rule.y - baseline) < Math.abs(best.y - baseline) ? rule : best,
    );
    reflow.add(element.id);
    return newElementWith(element, {
      ...getRuledTextTypography(
        element.fontFamily,
        element.fontSize,
        nearest.y,
        settings.lineSpacing,
      ),
      paragraphSpacing: 0,
      customData: {
        ...element.customData,
        guziRuledText: { version: 1, lineSpacing: settings.lineSpacing },
      },
    });
  });
  const insertBefore = new Map<string, ExcalidrawElement[]>();
  for (const page of changedRuling) {
    const firstRule = elements.find((element) => isPaperRule(element, page));
    insertBefore.set(
      firstRule?.id ?? page.id,
      rules.filter((rule) => rule.frameId === page.id),
    );
  }
  const ordered = next.flatMap((element) => [
    ...(insertBefore.get(element.id) ?? []),
    element,
  ]);
  const synced = syncInvalidIndicesImmutable(ordered);
  const indexed = synced ? [...synced.values()] : ordered;
  if (!reflow.size) {
    return indexed;
  }
  const scene = new Scene(indexed.map((element) => deepCopyElement(element)));
  try {
    for (const element of scene.getNonDeletedElements()) {
      if (reflow.has(element.id) && isTextElement(element)) {
        redrawTextBoundingBox(element, null, scene);
      }
    }
    for (const element of scene.getNonDeletedElements()) {
      if (reflow.has(element.id)) {
        updateBoundElements(element, scene);
      }
    }
    return [...scene.getElementsIncludingDeleted()];
  } finally {
    scene.destroy();
  }
};
