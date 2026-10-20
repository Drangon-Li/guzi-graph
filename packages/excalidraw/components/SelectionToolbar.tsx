import { useLayoutEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";

import { getCommonBounds } from "@excalidraw/element";
import { CLASSES, sceneCoordsToViewportCoords } from "@excalidraw/common";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { useAppStateValue } from "../hooks/useAppStateValue";
import { getSelectedElements, getTargetElements } from "../scene";
import { t } from "../i18n";
import { getSelectedTableRoot } from "../table";
import { actionTableProperties } from "../actions/actionTable";

import { IconButton } from "./IconButton";
import { PropertiesPopover } from "./PropertiesPopover";
import { TextSizeIcon, StrokeWidthBaseIcon, adjustmentsIcon } from "./icons";
import { getShapeActionPredicates } from "./shapeActionPredicates";
import { useExcalidrawContainer } from "./App";

import "./SelectionToolbar.scss";

import type { ActionName } from "../actions/types";
import type { ActionManager } from "../actions/manager";
import type { AppClassProperties, AppState, UIAppState } from "../types";

export const getSelectionToolbarPosition = (
  bounds: readonly [number, number, number, number],
  state: Pick<
    AppState,
    | "zoom"
    | "scrollX"
    | "scrollY"
    | "offsetLeft"
    | "offsetTop"
    | "width"
    | "height"
  >,
  size: { width: number; height: number },
  insets: { left: number; right: number; top?: number; bottom?: number },
) => {
  const start = sceneCoordsToViewportCoords(
    { sceneX: bounds[0], sceneY: bounds[1] },
    state,
  );
  const end = sceneCoordsToViewportCoords(
    { sceneX: bounds[2], sceneY: bounds[3] },
    state,
  );
  const topEdge = Math.max(76, insets.top ?? 0);
  const bottomEdge = state.height - Math.max(56, insets.bottom ?? 0);
  const leftEdge = insets.left;
  const rightEdge = state.width - insets.right;
  const x1 = start.x - state.offsetLeft;
  const y1 = start.y - state.offsetTop;
  const x2 = end.x - state.offsetLeft;
  const y2 = end.y - state.offsetTop;
  if (
    x2 < leftEdge ||
    x1 > rightEdge ||
    y2 < topEdge ||
    y1 > bottomEdge ||
    rightEdge - leftEdge < size.width
  ) {
    return null;
  }
  const above = y1 - size.height - 12;
  const below = y2 + 12;
  // Avoid covering a selection that fills the viewport when neither side fits.
  if (above < topEdge && below + size.height > bottomEdge) {
    return null;
  }
  return {
    left: Math.max(
      leftEdge,
      Math.min(rightEdge - size.width, (x1 + x2 - size.width) / 2),
    ),
    top:
      above >= topEdge
        ? Math.min(above, bottomEdge - size.height)
        : Math.max(topEdge, below),
  };
};

const SelectionProperty = ({
  name,
  label,
  icon,
  actionManager,
}: {
  name: ActionName;
  label: string;
  icon: React.ReactNode;
  actionManager: ActionManager;
}) => {
  const [open, setOpen] = useState(false);
  const { container } = useExcalidrawContainer();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton
          type="button"
          aria-label={label}
          title={label}
          icon={icon}
          onClick={() => setOpen(!open)}
        />
      </Popover.Trigger>
      <PropertiesPopover
        container={container}
        className={`${CLASSES.SHAPE_ACTIONS_THEME_SCOPE} properties-content selection-toolbar-popover`}
        onClose={() => setOpen(false)}
      >
        <div className="selected-shape-actions">
          {actionManager.renderAction(name)}
        </div>
      </PropertiesPopover>
    </Popover.Root>
  );
};

export const SelectionToolbar = ({
  app,
  appState,
  elements,
  actionManager,
  leftInset,
  rightInset,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  elements: readonly NonDeletedExcalidrawElement[];
  actionManager: ActionManager;
  leftInset: number;
  rightInset: number;
}) => {
  const viewport = useAppStateValue([
    "zoom",
    "scrollX",
    "scrollY",
    "cursorButton",
  ]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 44 });
  const selected = getSelectedElements(elements, appState);
  const selectionKey = selected.map((element) => element.id).join(",");
  const hidden = Boolean(
    !selected.length ||
      selected.some((element) => element.locked) ||
      appState.viewModeEnabled ||
      appState.zenModeEnabled ||
      appState.selectedElementsAreBeingDragged ||
      appState.resizingElement ||
      appState.isRotating ||
      appState.editingTextElement ||
      appState.newElement ||
      appState.selectedLinearElement?.isEditing ||
      viewport.cursorButton === "down",
  );
  const offsets = app.viewport.getOffsets();
  const position = hidden
    ? null
    : getSelectionToolbarPosition(
        getCommonBounds(selected),
        {
          ...appState,
          zoom: viewport.zoom,
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
        },
        size,
        {
          left: Math.max(leftInset, offsets.left ?? 0),
          right: Math.max(rightInset, offsets.right ?? 0),
          top: offsets.top,
          bottom: offsets.bottom,
        },
      );
  const visible = !!position;
  useLayoutEffect(() => {
    const node = toolbarRef.current;
    if (!node) {
      return;
    }
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width && rect.height) {
        setSize((previous) =>
          previous.width === rect.width && previous.height === rect.height
            ? previous
            : { width: rect.width, height: rect.height },
        );
      }
    };
    measure();
    const observer = new app.ownerWindow.ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [app, selectionKey, visible]);
  if (!position) {
    return null;
  }
  const elementsMap = app.scene.getNonDeletedElementsMap();
  const predicates = getShapeActionPredicates(
    appState,
    getTargetElements(elementsMap, appState),
    elementsMap,
    app,
  );
  const selectedTable = getSelectedTableRoot(
    elements,
    appState.selectedElementIds,
  );
  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      role="toolbar"
      aria-label={t("labels.actions")}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {selectedTable && (
        <IconButton
          type="button"
          aria-label={t("labels.tableProperties")}
          title={t("labels.tableProperties")}
          icon={adjustmentsIcon}
          onClick={() => actionManager.executeAction(actionTableProperties)}
        />
      )}
      {!selectedTable && predicates.strokeColor && (
        <div className="selection-toolbar__color">
          {actionManager.renderAction("changeStrokeColor")}
        </div>
      )}
      {!selectedTable && predicates.backgroundColor && (
        <div className="selection-toolbar__color">
          {actionManager.renderAction("changeBackgroundColor")}
        </div>
      )}
      {!selectedTable && predicates.strokeWidth && (
        <SelectionProperty
          name="changeStrokeWidth"
          label={t("labels.strokeWidth")}
          icon={StrokeWidthBaseIcon}
          actionManager={actionManager}
        />
      )}
      {!selectedTable && predicates.text && (
        <SelectionProperty
          name="changeFontSize"
          label={t("labels.fontSize")}
          icon={TextSizeIcon}
          actionManager={actionManager}
        />
      )}
      {predicates.cropEditor && actionManager.renderAction("cropEditor")}
      {predicates.lineEditor &&
        actionManager.renderAction("toggleLinearEditor")}
      {actionManager.renderAction("duplicateSelection")}
      {actionManager.renderAction("deleteSelectedElements")}
    </div>
  );
};
