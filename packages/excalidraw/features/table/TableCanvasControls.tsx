import { useEffect, useRef, useState } from "react";

import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  deepCopyElement,
  isArrowElement,
} from "@excalidraw/element";
import { readTableData } from "@excalidraw/element/table";

import type { TableRoot } from "@excalidraw/element/table";

import { useAppStateValue } from "../../hooks/useAppStateValue";
import { getLanguage } from "../../i18n";

import { applyTableChange, getSelectedTableRoot } from "./TableActions";

import "./TableCanvasControls.scss";

import type { AppClassProperties, UIAppState } from "../../types";

type Axis = "row" | "column";
type Header = { axis: Axis; index: number; x: number; y: number };

export const TableCanvasControls = ({
  app,
  appState,
}: {
  app: AppClassProperties;
  appState: UIAppState;
}) => {
  const viewport = useAppStateValue(["zoom", "scrollX", "scrollY"]);
  const [header, setHeader] = useState<Header | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const root = getSelectedTableRoot(app, appState);
  const hidden =
    !root ||
    root.locked ||
    app.scene
      .getSelectedElements(app.state)
      .some((element) => element.locked) ||
    appState.viewModeEnabled ||
    appState.zenModeEnabled ||
    appState.selectedElementsAreBeingDragged ||
    !!appState.resizingElement ||
    appState.isRotating ||
    !!appState.newElement ||
    appState.openDialog !== null;
  useEffect(() => {
    setHeader(null);
    return () => cancelDrag.current?.();
  }, [root?.id, hidden]);
  if (!root || hidden) {
    return null;
  }
  const data = readTableData(root, app.scene.getElementsIncludingDeleted());
  const zoom = viewport.zoom.value;
  const width = root.width * zoom;
  const height = root.height * zoom;
  const position = sceneCoordsToViewportCoords(
    { sceneX: root.x, sceneY: root.y },
    { ...appState, ...viewport },
  );
  const english = getLanguage().code === "en";
  const axisName = (axis: Axis) =>
    english ? axis : axis === "row" ? "行" : "列";
  const resizeLabel = (axis: Axis, index: number) =>
    english
      ? `Resize ${axis} ${index + 1}`
      : `调整第${index + 1}${axisName(axis)}${axis === "row" ? "高" : "宽"}`;
  const insertLabel = (axis: Axis, index: number) =>
    english
      ? `Insert ${axis} at ${index + 1}`
      : `在第${index + 1}${axisName(axis)}前插入${axisName(axis)}`;
  const updateStructure = (
    type: "insert" | "delete",
    axis: Axis,
    index: number,
  ) => {
    if (cancelDrag.current) {
      return;
    }
    applyTableChange(
      app,
      root,
      { type, axis, index },
      { preserveOrigin: true },
    );
    setHeader(null);
  };
  const beginResize = (
    event: React.PointerEvent<HTMLDivElement>,
    axis: Axis,
    index: number,
    leading = false,
  ) => {
    if (event.button !== 0 || cancelDrag.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setHeader(null);
    app.viewport.interruptSelectionReveal();
    const snapshot = app.scene
      .getElementsIncludingDeleted()
      .map(deepCopyElement);
    const initialRoot = snapshot.find(
      (element) => element.id === root.id,
    ) as TableRoot;
    const initialData = readTableData(initialRoot, snapshot);
    const tableIds = new Set(
      snapshot
        .filter((element) => element.groupIds[0] === root.groupIds[0])
        .map((element) => element.id),
    );
    const originals = new Map(
      snapshot
        .filter(
          (element) =>
            tableIds.has(element.id) ||
            (isArrowElement(element) &&
              ((element.startBinding &&
                tableIds.has(element.startBinding.elementId)) ||
                (element.endBinding &&
                  tableIds.has(element.endBinding.elementId)))),
        )
        .map((element) => [element.id, element]),
    );
    const restoreAffectedElements = () =>
      app.scene.getElementsIncludingDeleted().map((element) => {
        const original = originals.get(element.id);
        return original
          ? {
              ...deepCopyElement(original),
              locked: element.locked,
              isDeleted: element.isDeleted,
            }
          : element;
      });
    const initialSelection = app.state.selectedElementIds;
    app.syncActionResult({
      appState: {
        cursorButton: "down",
        viewModeEnabled: app.state.viewModeEnabled,
        zenModeEnabled: app.state.zenModeEnabled,
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    const initialSize = (
      axis === "row" ? initialData.rows : initialData.columns
    )[index];
    const startX = event.clientX;
    const startY = event.clientY;
    const cos = Math.cos(root.angle);
    const sin = Math.sin(root.angle);
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    let changed = false;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) {
        return;
      }
      next.preventDefault();
      next.stopPropagation();
      const dx = (next.clientX - startX) / zoom;
      const dy = (next.clientY - startY) / zoom;
      const delta =
        axis === "column" ? cos * dx + sin * dy : -sin * dx + cos * dy;
      const size = Math.max(
        axis === "column" ? 40 : 24,
        initialSize + (leading ? -delta : delta),
      );
      changed = size !== initialSize;
      applyTableChange(
        app,
        initialRoot,
        () => ({
          ...initialData,
          [axis === "row" ? "rows" : "columns"]: (axis === "row"
            ? initialData.rows
            : initialData.columns
          ).map((value, item) => (item === index ? size : value)),
        }),
        {
          previous: restoreAffectedElements(),
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
          preserveOrigin: true,
          preserveSelection: true,
          leadingAxis: leading ? axis : undefined,
        },
      );
    };
    const finish = (cancelled: boolean) => {
      app.ownerWindow.removeEventListener("pointermove", move, true);
      app.ownerWindow.removeEventListener("pointerup", up, true);
      app.ownerWindow.removeEventListener("pointercancel", cancel, true);
      app.ownerWindow.removeEventListener("keydown", key, true);
      app.ownerWindow.removeEventListener("wheel", stopGesture, true);
      app.ownerWindow.removeEventListener("pointerdown", stopGesture, true);
      target.removeEventListener("lostpointercapture", lostCapture);
      cancelDrag.current = null;
      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      app.syncActionResult({
        ...(cancelled || !changed
          ? { elements: restoreAffectedElements() }
          : {}),
        appState: {
          cursorButton: "up",
          viewModeEnabled: app.state.viewModeEnabled,
          zenModeEnabled: app.state.zenModeEnabled,
          ...(cancelled || !changed
            ? { selectedElementIds: initialSelection }
            : {}),
        },
        captureUpdate:
          cancelled || !changed
            ? CaptureUpdateAction.EVENTUALLY
            : CaptureUpdateAction.IMMEDIATELY,
      });
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId === pointerId) {
        next.preventDefault();
        next.stopPropagation();
        finish(false);
      }
    };
    const cancel = (next: PointerEvent) => {
      if (next.pointerId === pointerId) {
        finish(true);
      }
    };
    const stopGesture = (next: Event) => {
      next.preventDefault();
      next.stopPropagation();
    };
    const lostCapture = () => finish(true);
    const key = (next: KeyboardEvent) => {
      stopGesture(next);
      if (next.key === "Escape") {
        next.preventDefault();
        next.stopPropagation();
        finish(true);
      }
    };
    cancelDrag.current = () => finish(true);
    target.setPointerCapture?.(pointerId);
    target.addEventListener("lostpointercapture", lostCapture);
    app.ownerWindow.addEventListener("pointermove", move, true);
    app.ownerWindow.addEventListener("pointerup", up, true);
    app.ownerWindow.addEventListener("pointercancel", cancel, true);
    app.ownerWindow.addEventListener("keydown", key, true);
    app.ownerWindow.addEventListener("wheel", stopGesture, {
      capture: true,
      passive: false,
    });
    app.ownerWindow.addEventListener("pointerdown", stopGesture, true);
  };
  const edges = (sizes: number[]) =>
    sizes.reduce<number[]>(
      (result, size) => [...result, result[result.length - 1] + size * zoom],
      [0],
    );
  const xs = edges(data.columns);
  const ys = edges(data.rows);
  const resizeCursor = (axis: Axis) => {
    const angle =
      ((((root.angle * 180) / Math.PI + (axis === "row" ? 90 : 0)) % 180) +
        180) %
      180;
    return angle < 22.5 || angle >= 157.5
      ? "ew-resize"
      : angle < 67.5
      ? "nwse-resize"
      : angle < 112.5
      ? "ns-resize"
      : "nesw-resize";
  };
  const boundary = (
    axis: Axis,
    index: number,
    x: number,
    y: number,
    length: number,
    leading = false,
    key?: string,
  ) => (
    <div
      key={key ?? `${axis}-${index}-${leading}`}
      className={`table-canvas-controls__resize table-canvas-controls__resize--${axis}`}
      role="separator"
      aria-label={resizeLabel(axis, index)}
      aria-orientation={axis === "column" ? "vertical" : "horizontal"}
      style={{
        left: x,
        top: y,
        width: axis === "column" ? 7 : length,
        height: axis === "row" ? 7 : length,
        cursor: resizeCursor(axis),
      }}
      onPointerDown={(event) => beginResize(event, axis, index, leading)}
    />
  );
  const insert = (
    axis: Axis,
    index: number,
    x: number,
    y: number,
    side: string,
  ) => (
    <button
      key={`insert-${axis}-${index}-${side}`}
      type="button"
      className="table-canvas-controls__insert"
      aria-label={insertLabel(axis, index)}
      title={insertLabel(axis, index)}
      style={{ left: x, top: y }}
      onClick={() => updateStructure("insert", axis, index)}
    >
      +
    </button>
  );
  const handle = (axis: Axis, index: number, x: number, y: number) => (
    <button
      key={`header-${axis}-${index}`}
      type="button"
      className="table-canvas-controls__header"
      aria-label={
        english
          ? `Select ${axis} ${index + 1}`
          : `选择第${index + 1}${axisName(axis)}`
      }
      aria-expanded={header?.axis === axis && header.index === index}
      title={
        english
          ? `${axis} ${index + 1}: insert or delete`
          : `第${index + 1}${axisName(axis)}：插入或删除`
      }
      style={{ left: x, top: y }}
      onClick={() => setHeader({ axis, index, x, y })}
    >
      {index + 1}
    </button>
  );
  return (
    <div
      className={`table-canvas-controls${
        header ? " table-canvas-controls--menu-open" : ""
      }`}
      data-testid="table-canvas-controls"
      style={{
        left: position.x - appState.offsetLeft,
        top: position.y - appState.offsetTop,
        width,
        height,
        transform: `rotate(${root.angle}rad)`,
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {data.cells.flatMap((cell) => [
        boundary(
          "column",
          cell.column + cell.columnSpan - 1,
          xs[cell.column + cell.columnSpan],
          ys[cell.row],
          ys[cell.row + cell.rowSpan] - ys[cell.row],
          false,
          `column-${cell.row}-${cell.column}`,
        ),
        boundary(
          "row",
          cell.row + cell.rowSpan - 1,
          xs[cell.column],
          ys[cell.row + cell.rowSpan],
          xs[cell.column + cell.columnSpan] - xs[cell.column],
          false,
          `row-${cell.row}-${cell.column}`,
        ),
      ])}
      {boundary("column", 0, 0, 0, height, true)}
      {boundary("row", 0, 0, 0, width, true)}
      {xs.flatMap((x, index) => [
        insert("column", index, x, -12, "top"),
        insert("column", index, x, height + 12, "bottom"),
      ])}
      {ys.flatMap((y, index) => [
        insert("row", index, -12, y, "left"),
        insert("row", index, width + 12, y, "right"),
      ])}
      {data.columns.map((_, index) =>
        handle("column", index, (xs[index] + xs[index + 1]) / 2, -13),
      )}
      {data.rows.map((_, index) =>
        handle("row", index, -13, (ys[index] + ys[index + 1]) / 2),
      )}
      {header && (
        <div
          className="table-canvas-controls__menu"
          role="toolbar"
          aria-label={
            english ? `${header.axis} actions` : `${axisName(header.axis)}操作`
          }
          style={{
            left: header.x,
            top: header.y - 34,
            transform: `translate(-50%, -100%) rotate(${-root.angle}rad)`,
          }}
        >
          <button
            type="button"
            onClick={() => updateStructure("insert", header.axis, header.index)}
          >
            {english
              ? "Insert before"
              : header.axis === "row"
              ? "上方插入"
              : "左侧插入"}
          </button>
          <button
            type="button"
            onClick={() =>
              updateStructure("insert", header.axis, header.index + 1)
            }
          >
            {english
              ? "Insert after"
              : header.axis === "row"
              ? "下方插入"
              : "右侧插入"}
          </button>
          <button
            type="button"
            disabled={
              (header.axis === "row" ? data.rows : data.columns).length <= 1
            }
            onClick={() => updateStructure("delete", header.axis, header.index)}
          >
            {english ? `Delete ${header.axis}` : `删除${axisName(header.axis)}`}
          </button>
          <button
            type="button"
            aria-label={english ? "Close" : "关闭"}
            onClick={() => setHeader(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};
