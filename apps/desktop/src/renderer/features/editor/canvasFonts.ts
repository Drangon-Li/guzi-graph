import {
  getFontString,
  getLineHeight,
  getSystemFontFamily,
} from "@excalidraw/common";
import {
  deepCopyElement,
  isTextElement,
  newElementWith,
  redrawTextBoundingBox,
  StoreSnapshot,
} from "@excalidraw/element";
import { Scene } from "@excalidraw/element/Scene";
import {
  getTableRoot,
  isTableRoot,
  syncTableData,
  updateTableElements,
} from "@excalidraw/element/table";
import { charWidth } from "@excalidraw/element/textMeasurements";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import { HistoryDelta } from "@excalidraw/excalidraw/history";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
  SceneElementsMap,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { HistoryCheckpoint } from "@excalidraw/excalidraw/history";

const canReplace = (
  element: ExcalidrawElement,
  fontFamily: FontFamilyValues,
  restoreKnownElement = false,
): element is ExcalidrawTextElement =>
  isTextElement(element) &&
  (restoreKnownElement || (!element.isDeleted && !element.locked)) &&
  element.fontFamily !== fontFamily;

export const loadReplacementFont = async (
  elements: readonly ExcalidrawElement[],
  fontFamily: FontFamilyValues,
  ownerDocument: Document,
) => {
  const texts = elements
    .filter((element) => canReplace(element, fontFamily))
    .map((element) => ({ ...element, fontFamily }));
  await Fonts.loadElementsFonts(texts, ownerDocument);
  if (texts.length) {
    // The shared font loader tolerates failed faces; replacement must fail before editing.
    await ownerDocument.fonts.load(
      getFontString({ fontFamily, fontSize: 20 }),
      [
        ...new Set(
          texts.flatMap((element) =>
            isTextElement(element) ? Array.from(element.originalText) : [],
          ),
        ),
      ].join(""),
    );
  }
  texts.forEach((element) => {
    if (isTextElement(element)) {
      charWidth.clearCache(getFontString(element));
    }
  });
};

export const replaceLayerFont = (
  elements: readonly ExcalidrawElement[],
  fontFamily: FontFamilyValues,
  elementIds?: ReadonlySet<string>,
): readonly ExcalidrawElement[] => {
  const elementsMap = new Map(elements.map((element) => [element.id, element]));
  const replaceIds = new Set(
    elements
      .filter(
        (element) =>
          canReplace(element, fontFamily, !!elementIds) &&
          (!elementIds || elementIds.has(element.id)) &&
          (elementIds ||
            (!elementsMap.get(element.containerId ?? "")?.locked &&
              !getTableRoot(element, elements)?.locked)),
      )
      .map((element) => element.id),
  );
  if (!replaceIds.size) {
    return elements;
  }
  // Bounding-box updates can resize a text container, so isolate the whole layer.
  const scene = new Scene(
    elements.map((element) =>
      replaceIds.has(element.id) && isTextElement(element)
        ? newElementWith(element, {
            fontFamily,
            lineHeight: getLineHeight(fontFamily),
          })
        : deepCopyElement(element),
    ),
    { skipValidation: true },
  );
  const baseline = scene.getElementsIncludingDeleted().map((element) => ({
    version: element.version,
    customData: element.customData,
  }));
  try {
    for (const previous of elements) {
      if (
        !replaceIds.has(previous.id) ||
        !isTextElement(previous) ||
        previous.isDeleted
      ) {
        continue;
      }
      const text = scene.getElement(previous.id)!;
      if (!isTextElement(text)) {
        continue;
      }
      const container = text.containerId
        ? scene.getElement(text.containerId)
        : null;
      if (getTableRoot(previous, elements)) {
        continue;
      }
      redrawTextBoundingBox(text, container, scene);
      if (
        !container &&
        text.autoResize &&
        (text.textAlign === "center" || text.textAlign === "right")
      ) {
        scene.mutateElement(text, {
          x:
            previous.x +
            (previous.width - text.width) *
              (text.textAlign === "center" ? 0.5 : 1),
        });
      }
    }
    let next: readonly ExcalidrawElement[] =
      scene.getElementsIncludingDeleted();
    for (const root of elements.filter(isTableRoot)) {
      if (
        !elements.some(
          (element) =>
            replaceIds.has(element.id) &&
            getTableRoot(element, elements)?.id === root.id,
        )
      ) {
        continue;
      }
      const current = next;
      const previous = new Map(current.map((element) => [element.id, element]));
      next = updateTableElements(
        current,
        previous.get(root.id) as typeof root,
        (data) => data,
      )
        .filter((element) => previous.has(element.id))
        .map((element) => {
          const original = previous.get(element.id)!;
          if (
            original.isDeleted ||
            getTableRoot(element, current)?.id !== root.id
          ) {
            return original;
          }
          return newElementWith(original, {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
            ...(isTableRoot(element) ? { customData: element.customData } : {}),
            ...(isTextElement(element)
              ? {
                  fontFamily: element.fontFamily,
                  lineHeight: element.lineHeight,
                  text: element.text,
                }
              : {}),
          });
        });
    }
    next = syncTableData(next);
    return next.map((element, index) =>
      !replaceIds.has(elements[index].id) &&
      element.version === baseline[index].version &&
      element.customData === baseline[index].customData
        ? elements[index]
        : element,
    );
  } finally {
    scene.destroy();
  }
};

export const restoreLayerFontChanges = (
  current: readonly ExcalidrawElement[],
  source: readonly ExcalidrawElement[],
  target: readonly ExcalidrawElement[],
) => {
  const sourceById = new Map(source.map((element) => [element.id, element]));
  const replacements = new Map<FontFamilyValues, Set<string>>();
  for (const element of target) {
    const previous = sourceById.get(element.id);
    if (
      !isTextElement(element) ||
      !previous ||
      !isTextElement(previous) ||
      previous.fontFamily === element.fontFamily
    ) {
      continue;
    }
    let ids = replacements.get(element.fontFamily);
    if (!ids) {
      ids = new Set();
      replacements.set(element.fontFamily, ids);
    }
    ids.add(element.id);
  }
  let elements = current;
  for (const [fontFamily, ids] of replacements) {
    // Reflow current text so child edits made after the font action survive.
    elements = replaceLayerFont(elements, fontFamily, ids);
  }
  return elements;
};

export const replaceSnapshotFonts = <T extends ExcalidrawInitialDataState>(
  snapshot: T,
  fontFamily: FontFamilyValues,
): T => {
  const previousElements = snapshot.elements ?? [];
  const elements = replaceLayerFont(previousElements, fontFamily);
  let subscenes = snapshot.appState?.subscenes;
  for (const [id, child] of Object.entries(subscenes ?? {})) {
    const next = replaceLayerFont(child.elements, fontFamily);
    if (next !== child.elements) {
      subscenes = {
        ...subscenes,
        [id]: {
          ...child,
          elements: next,
          appState: {
            ...child.appState,
            fontRegistry: replacementFontRegistry(
              child.appState.fontRegistry,
              fontFamily,
            ),
          },
        },
      };
    }
  }
  if (
    elements === previousElements &&
    subscenes === snapshot.appState?.subscenes &&
    snapshot.appState?.currentItemFontFamily === fontFamily
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    elements,
    appState: {
      ...snapshot.appState,
      currentItemFontFamily: fontFamily,
      subscenes,
      fontRegistry: replacementFontRegistry(
        snapshot.appState?.fontRegistry,
        fontFamily,
      ),
    },
  };
};

export const replacementFontRegistry = (
  registry: AppState["fontRegistry"] | undefined,
  fontFamily: FontFamilyValues,
) => {
  const family = getSystemFontFamily(fontFamily);
  return family ? { ...registry, [fontFamily]: family } : registry ?? {};
};

export const appendFontReplacementHistory = (
  checkpoint: HistoryCheckpoint | undefined,
  previous: ExcalidrawInitialDataState,
  next: ExcalidrawInitialDataState,
): HistoryCheckpoint | undefined => {
  if (previous.elements === next.elements) {
    return checkpoint;
  }
  const state = { ...getDefaultAppState(), ...previous.appState };
  const delta = HistoryDelta.calculate(
    StoreSnapshot.create(
      new Map(
        (previous.elements ?? []).map((element) => [element.id, element]),
      ) as SceneElementsMap,
      state,
    ),
    StoreSnapshot.create(
      new Map(
        (next.elements ?? []).map((element) => [element.id, element]),
      ) as SceneElementsMap,
      state,
      { didElementsChange: true, didAppStateChange: false },
    ),
  );
  return delta.isEmpty()
    ? checkpoint
    : {
        undo: [...(checkpoint?.undo ?? []), HistoryDelta.inverse(delta)].slice(
          -200,
        ),
        redo: [],
      };
};
