import { useCallback, useSyncExternalStore } from "react";

import {
  getBoundTextElement,
  getBaseFontSize,
  getBaseFontSizeUpdate,
  redrawTextBoundingBox,
} from "@excalidraw/element";
import { hasBoundTextElement, isTextElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import type { Scene } from "@excalidraw/element";

import { fontSizeIcon } from "../icons";
import { useApp } from "../App";
import {
  executeRichTextCommand,
  getRichTextSelectionState,
  subscribeRichTextSelection,
} from "../../features/rich-text/editorBridge";

import StatsDragInput from "./DragInput";
import { getStepSizedValue } from "./utils";

import type { DragInputCallbackType } from "./DragInput";
import type { AppState } from "../../types";

interface FontSizeProps {
  element: ExcalidrawElement;
  scene: Scene;
  appState: AppState;
  property: "fontSize";
}

const MIN_FONT_SIZE = 4;
const STEP_SIZE = 4;

const handleFontSizeChange = (
  {
    accumulatedChange,
    originalElements,
    shouldChangeByStepSize,
    nextValue,
    scene,
    app,
  }: Parameters<
    DragInputCallbackType<FontSizeProps["property"], ExcalidrawTextElement>
  >[0],
  selectionFontSize?: number | null,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();

  const origElement = originalElements[0];
  if (origElement) {
    const latestElement = elementsMap.get(origElement.id);
    if (!latestElement || !isTextElement(latestElement)) {
      return;
    }

    let nextFontSize;

    if (nextValue !== undefined) {
      nextFontSize = Math.max(Math.round(nextValue), MIN_FONT_SIZE);
    } else if (origElement.type === "text") {
      const originalFontSize = Math.round(
        selectionFontSize ?? getBaseFontSize(origElement, elementsMap),
      );
      const changeInFontSize = Math.round(accumulatedChange);
      nextFontSize = Math.max(
        originalFontSize + changeInFontSize,
        MIN_FONT_SIZE,
      );
      if (shouldChangeByStepSize) {
        nextFontSize = getStepSizedValue(nextFontSize, STEP_SIZE);
      }
    }

    if (nextFontSize) {
      if (
        executeRichTextCommand(
          app.ownerDocument,
          {
            type: "fontSize",
            value: nextFontSize,
            baseFontSize: getBaseFontSize(latestElement, elementsMap),
          },
          latestElement.id,
        )
      ) {
        return;
      }
      scene.mutateElement(
        latestElement,
        getBaseFontSizeUpdate(latestElement, nextFontSize, elementsMap),
      );
      redrawTextBoundingBox(
        latestElement,
        scene.getContainerElement(latestElement),
        scene,
        app.renderEnvironment,
      );
    }
  }
};

const FontSize = ({ element, scene, appState, property }: FontSizeProps) => {
  const app = useApp();
  const selection = useSyncExternalStore(
    useCallback(
      (listener) => subscribeRichTextSelection(app.ownerDocument, listener),
      [app.ownerDocument],
    ),
    useCallback(
      () => getRichTextSelectionState(app.ownerDocument),
      [app.ownerDocument],
    ),
    () => null,
  );
  const _element = isTextElement(element)
    ? element
    : hasBoundTextElement(element)
    ? getBoundTextElement(element, scene.getNonDeletedElementsMap())
    : null;

  if (!_element) {
    return null;
  }

  const selectedText =
    selection?.hasSelection && selection.elementId === _element.id
      ? selection
      : null;
  return (
    <StatsDragInput
      label="F"
      value={
        selectedText && selectedText.fontSize == null
          ? "Mixed"
          : Math.round(
              (selectedText?.fontSize ??
                getBaseFontSize(_element, scene.getNonDeletedElementsMap())) *
                10,
            ) / 10
      }
      elements={[_element]}
      dragInputCallback={(props) =>
        handleFontSizeChange(props, selectedText?.fontSize)
      }
      icon={fontSizeIcon}
      appState={appState}
      scene={scene}
      property={property}
    />
  );
};

export default FontSize;
