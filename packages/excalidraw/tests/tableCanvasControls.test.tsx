import {
  CaptureUpdateAction,
  isNonDeletedElement,
  newElementWith,
} from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
  getTableCellAt,
  isTableRoot,
  mergeTableCells,
  updateTableElements,
} from "@excalidraw/element/table";
import { KEYS } from "@excalidraw/common";

import type { TableData } from "@excalidraw/element/table";
import type { Radians } from "@excalidraw/math";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, fireEvent, render, screen, unmountComponent } from "./test-utils";

const { h } = window;
const table = () => h.elements.find(isTableRoot)!;
const setupTable = (data = createTableData(2, 2), angle = 0) => {
  const initial = createTableElements(data, 100, 100);
  const elements = updateTableElements(
    initial.elements,
    newElementWith(initial.root, { angle: angle as Radians }),
    (data) => data,
  );
  API.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  API.setSelectedElements(
    h.elements
      .filter(isNonDeletedElement)
      .filter((element) => element.type !== "text"),
  );
};
const columnBoundary = (index = 0) =>
  screen.getAllByRole("separator", { name: `调整第${index + 1}列宽` })[0];
const rowBoundaries = (index = 0) =>
  screen.getAllByRole("separator", { name: `调整第${index + 1}行高` });
const down = (
  target: Element,
  x = 244,
  y = 124,
  modifiers: Pick<PointerEventInit, "metaKey" | "ctrlKey"> = {},
) =>
  fireEvent.pointerDown(target, {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    ...modifiers,
  });
const move = (x: number, y = 124) =>
  fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y });
const up = () => fireEvent.pointerUp(window, { pointerId: 1 });
const undo = () =>
  fireEvent.keyDown(document.querySelector("canvas.interactive")!, {
    key: "z",
    code: "KeyZ",
    [KEYS.CTRL_OR_CMD]: true,
  });

beforeEach(async () => {
  unmountComponent();
  localStorage.clear();
  await render(
    <Excalidraw langCode="zh-CN" autoFocus handleKeyboardGlobally />,
  );
});

it("resizes one column across several frames with one undo and no canvas movement", () => {
  setupTable();
  const historySize = h.history.undoStack.length;
  down(columnBoundary());
  expect(h.state.cursorButton).toBe("down");
  move(264);
  move(284);
  expect(table().customData.table.columns).toEqual([184, 144]);
  expect(table()).toMatchObject({ x: 100, y: 100, width: 328 });
  expect(h.state.selectedElementsAreBeingDragged).toBe(false);
  expect(h.history.undoStack).toHaveLength(historySize);
  up();
  expect(h.state.cursorButton).toBe("up");
  expect(h.history.undoStack).toHaveLength(historySize + 1);
  undo();
  expect(table().customData.table.columns).toEqual([144, 144]);
  expect(table().width).toBe(288);
});

it.each(["ctrlKey", "metaKey"] as const)(
  "scales unequal columns with %s and keeps the grabbed internal border under the pointer",
  (modifier) => {
    const originalModifier = KEYS.CTRL_OR_CMD;
    Object.assign(KEYS, { CTRL_OR_CMD: modifier });
    try {
      const data = createTableData(2, 2);
      data.columns = [80, 160];
      setupTable(data);
      const historySize = h.history.undoStack.length;
      down(columnBoundary(), 180, 124, { [modifier]: true });
      move(200);
      move(220);
      expect(table()).toMatchObject({ x: 100, y: 100, width: 360, height: 96 });
      expect(columnBoundary().style.left).toBe("120px");
      expect(table().customData.table.columns).toEqual([120, 240]);
      expect(
        table().customData.table.cells.map((cell) => cell.fontSize),
      ).toEqual(data.cells.map((cell) => cell.fontSize));
      expect(h.history.undoStack).toHaveLength(historySize);
      up();
      expect(h.history.undoStack).toHaveLength(historySize + 1);
      undo();
      expect(table().customData.table.columns).toEqual([80, 160]);
    } finally {
      Object.assign(KEYS, { CTRL_OR_CMD: originalModifier });
    }
  },
);

it("scales rows from a rotated leading edge and preserves the opposite edge", () => {
  const data = createTableData(2, 2);
  data.rows = [60, 100];
  setupTable(data, Math.PI / 2);
  API.setAppState({ zoom: { value: 2 as never } });
  const oppositeCorner = (root: ReturnType<typeof table>) => ({
    x: root.x + root.width / 2 - root.height / 2,
    y: root.y + root.height / 2 - root.width / 2,
  });
  const before = oppositeCorner(table());
  const boundaries = rowBoundaries();
  down(boundaries[boundaries.length - 1], 400, 350, {
    [KEYS.CTRL_OR_CMD]: true,
  });
  move(440, 350);
  up();
  expect(table().customData.table.rows).toEqual([67.5, 112.5]);
  // Proportional vertical resizing explicitly sets the minima for every row.
  expect(table().customData.table.rowMinHeights).toEqual([67.5, 112.5]);
  expect(oppositeCorner(table()).x).toBeCloseTo(before.x);
  expect(oppositeCorner(table()).y).toBeCloseTo(before.y);
  expect(table().width).toBe(288);
});

it("clamps a proportional column resize at the first column's minimum", () => {
  const data = createTableData(2, 2);
  data.columns = [80, 160];
  setupTable(data);
  down(columnBoundary(), 180, 124, { [KEYS.CTRL_OR_CMD]: true });
  move(100);
  up();
  expect(table().customData.table.columns).toEqual([40, 80]);
});

it("clamps a proportional row resize at the first cell's text height", () => {
  const data = createTableData(2, 2);
  data.rows = [96, 144];
  data.cells[0].text = "first\nsecond";
  setupTable(data);
  const label = h.elements.find((element) => element.type === "text")!;
  down(rowBoundaries()[0], 120, 196, { [KEYS.CTRL_OR_CMD]: true });
  move(120, 100);
  up();
  const [first, second] = table().customData.table.rows;
  expect(first).toBeCloseTo(label.height + 16);
  expect(second / first).toBeCloseTo(1.5);
});

it.each(["Escape", "pointercancel"])(
  "rolls back %s without creating history",
  (method) => {
    setupTable();
    const historySize = h.history.undoStack.length;
    const original = table();
    down(columnBoundary(), 244, 124, { [KEYS.CTRL_OR_CMD]: true });
    move(284);
    expect(table().customData.table.columns[1]).toBeGreaterThan(144);
    if (method === "Escape") {
      fireEvent.keyDown(window, { key: "Escape" });
    } else {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    }
    expect(table()).toEqual(original);
    expect(h.history.undoStack).toHaveLength(historySize);
    move(304);
    up();
    expect(table()).toEqual(original);
    expect(h.history.undoStack).toHaveLength(historySize);
  },
);

it("uses zoom and rotation and keeps the local top left anchored", () => {
  setupTable(createTableData(2, 2), Math.PI / 2);
  API.setAppState({ zoom: { value: 2 as never }, scrollX: 30, scrollY: -20 });
  const origin = (root: ReturnType<typeof table>) => ({
    x: root.x + root.width / 2 + root.height / 2,
    y: root.y + root.height / 2 - root.width / 2,
  });
  const before = origin(table());
  down(columnBoundary(), 300, 300);
  move(300, 380);
  up();
  expect(table().customData.table.columns).toEqual([184, 144]);
  expect(origin(table()).x).toBeCloseTo(before.x);
  expect(origin(table()).y).toBeCloseTo(before.y);
  expect(screen.getByTestId("table-canvas-controls").style.transform).toBe(
    `rotate(${Math.PI / 2}rad)`,
  );
  expect(columnBoundary().style.cursor).toBe("ns-resize");
});

it("resizes the leading outer edge while keeping the far edge fixed", () => {
  setupTable();
  const boundaries = screen.getAllByRole("separator", { name: "调整第1列宽" });
  down(boundaries[boundaries.length - 1], 100, 124);
  move(80);
  up();
  expect(table().customData.table.columns).toEqual([164, 144]);
  expect(table()).toMatchObject({ x: 80, width: 308 });
});

it("resizes a row and respects content height and minimum column width", () => {
  const data = createTableData(2, 2);
  data.cells[0].text = "a long cell value that will wrap into multiple lines";
  setupTable(data);
  down(columnBoundary());
  move(-500);
  up();
  expect(table().customData.table.columns).toEqual([40, 144]);
  const minimumTextHeight = table().customData.table.rows[0];
  down(
    screen.getAllByRole("separator", { name: "调整第1行高" })[0],
    120,
    minimumTextHeight + 100,
  );
  move(120, -500);
  up();
  expect(table().customData.table.rows[0]).toBeGreaterThanOrEqual(
    minimumTextHeight,
  );
  expect(table().customData.table.rows[1]).toBeCloseTo(48);
  expect(table().customData.table.rowMinHeights).toEqual([24, 48]);
  down(columnBoundary(), 140, 124);
  move(700);
  up();
  expect(table().customData.table.rows[0]).toBeLessThan(48);
  expect(table().customData.table.rowMinHeights).toEqual([24, 48]);
});

it("keeps untouched legacy rows at their current heights until column reflow", () => {
  const data = createTableData(3, 2);
  data.rows = [72, 130, 96];
  setupTable(data);
  const root = table();
  const legacy = { ...root.customData.table };
  delete legacy.rowMinHeights;
  API.updateScene({
    elements: h.elements.map((element) =>
      element.id === root.id
        ? newElementWith(root, { customData: { table: legacy } })
        : element,
    ),
  });

  down(rowBoundaries()[0], 120, 172);
  move(120, 192);
  up();
  expect(table().customData.table.rows).toEqual([92, 130, 96]);
  expect(table().customData.table.rowMinHeights).toEqual([92, 24, 24]);

  down(columnBoundary());
  move(500);
  up();
  const [first, second, third] = table().customData.table.rows;
  expect(first).toBe(92);
  expect(second).toBeLessThan(130);
  expect(third).toBeLessThan(96);
});

it("offers insertions on four sides and safe row and column deletion", () => {
  setupTable(createTableData(1, 1));
  expect(
    screen.getAllByRole("button", { name: "在第1行前插入行" }),
  ).toHaveLength(2);
  expect(
    screen.getAllByRole("button", { name: "在第1列前插入列" }),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "选择第1行" }));
  expect(screen.getByRole("button", { name: "删除行" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "下方插入" }));
  expect(table().customData.table.rows).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "选择第2行" }));
  fireEvent.click(screen.getByRole("button", { name: "删除行" }));
  expect(table().customData.table.rows).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "选择第1列" }));
  fireEvent.click(screen.getByRole("button", { name: "右侧插入" }));
  expect(table().customData.table.columns).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "选择第2列" }));
  fireEvent.click(screen.getByRole("button", { name: "删除列" }));
  expect(table().customData.table.columns).toHaveLength(1);
});

it("selects the color range from canvas row and column menus", () => {
  setupTable(createTableData(2, 2));
  fireEvent.click(screen.getByRole("button", { name: "选择第2行" }));
  const rowMenu = screen.getByRole("toolbar", { name: "行操作" });
  fireEvent.click(rowMenu.querySelector("button")!);
  expect(screen.getByText("着色范围 · 第2行")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "选择第2列" }));
  const columnMenu = screen.getByRole("toolbar", { name: "列操作" });
  fireEvent.click(columnMenu.querySelector("button")!);
  expect(screen.getByText("着色范围 · 第2列")).toBeTruthy();
});

it("exposes only visible merged boundaries and keeps a complete grid after insertion", () => {
  setupTable(
    mergeTableCells(createTableData(2, 2), {
      row: 0,
      column: 0,
      endRow: 1,
      endColumn: 1,
    }),
  );
  expect(screen.getAllByRole("separator")).toHaveLength(4);
  expect(columnBoundary().style.left).toBe("0px");
  down(columnBoundary(1), 388, 124);
  move(408);
  up();
  expect(table().customData.table.columns).toEqual([144, 164]);
  fireEvent.click(
    screen.getAllByRole("button", { name: "在第2列前插入列" })[0],
  );
  const data = table().customData.table as TableData;
  expect(data.columns).toHaveLength(3);
  expect(data.cells[0].columnSpan).toBe(3);
  data.rows.forEach((_, row) =>
    data.columns.forEach((_, column) =>
      expect(getTableCellAt(data, row, column)).toBeTruthy(),
    ),
  );
});

it("hides controls for locked tables, read only mode, and mixed selections", () => {
  setupTable();
  API.updateScene({
    elements: h.elements.map((element) =>
      element.id === table().id
        ? newElementWith(element, { locked: true })
        : element,
    ),
  });
  expect(screen.queryByTestId("table-canvas-controls")).toBeNull();
  API.updateScene({
    elements: h.elements.map((element) =>
      newElementWith(element, { locked: false }),
    ),
  });
  API.setAppState({ viewModeEnabled: true });
  expect(screen.queryByTestId("table-canvas-controls")).toBeNull();
  API.setAppState({ viewModeEnabled: false });
  const rectangle = API.createElement({ type: "rectangle", x: 500, y: 500 });
  API.setElements([...h.elements, rectangle]);
  API.setSelectedElements([table(), rectangle]);
  expect(screen.queryByTestId("table-canvas-controls")).toBeNull();
});

it.each([false, true])(
  "preserves non table additions during drag (cancel=%s)",
  (cancel) => {
    setupTable();
    down(columnBoundary());
    move(264);
    const rectangle = API.createElement({ type: "rectangle", x: 500, y: 500 });
    API.updateScene({
      elements: [...h.elements, rectangle],
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    move(284);
    expect(h.elements.some((element) => element.id === rectangle.id)).toBe(
      true,
    );
    if (cancel) {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    } else {
      up();
    }
    expect(h.elements.find((element) => element.id === rectangle.id)).toEqual(
      rectangle,
    );
    expect(table().customData.table.columns).toEqual(
      cancel ? [144, 144] : [184, 144],
    );
    expect(h.state.cursorButton).toBe("up");
  },
);

it("blocks wheel camera changes while dragging and restores wheel handling afterwards", () => {
  setupTable();
  down(columnBoundary());
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 100,
    ctrlKey: true,
  });
  act(() => h.app.ownerWindow.dispatchEvent(wheel));
  expect(wheel.defaultPrevented).toBe(true);
  expect(h.state.zoom.value).toBe(1);
  fireEvent.pointerCancel(window, { pointerId: 1 });
  const after = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 100,
  });
  act(() => h.app.ownerWindow.dispatchEvent(after));
  expect(after.defaultPrevented).toBe(false);
});

it.each(["readonly", "locked"])(
  "cancels safely when the table becomes %s during a drag",
  (mode) => {
    setupTable();
    down(columnBoundary());
    move(284);
    if (mode === "readonly") {
      API.setAppState({ viewModeEnabled: true });
      expect(h.state.viewModeEnabled).toBe(true);
    } else {
      API.updateScene({
        elements: h.elements.map((element) =>
          element.id === table().id
            ? newElementWith(element, { locked: true })
            : element,
        ),
      });
      expect(table().locked).toBe(true);
    }
    expect(table().customData.table.columns).toEqual([144, 144]);
    expect(h.state.cursorButton).toBe("up");
    expect(screen.queryByTestId("table-canvas-controls")).toBeNull();
    move(304);
    up();
    expect(table().customData.table.columns).toEqual([144, 144]);
  },
);

it("keeps selection identity and interrupts panel reveal during resize previews", () => {
  setupTable();
  const selection = h.state.selectedElementIds;
  const interrupt = vi.spyOn(h.app.viewport, "interruptSelectionReveal");
  const reveal = vi.spyOn(h.app.viewport, "revealSelection");
  down(columnBoundary());
  move(264);
  move(284);
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(h.state.selectedElementIds).toBe(selection);
  expect(reveal).not.toHaveBeenCalled();
  up();
  expect(h.state.selectedElementIds).toBe(selection);
  expect(reveal).not.toHaveBeenCalled();
  interrupt.mockRestore();
  reveal.mockRestore();
});
