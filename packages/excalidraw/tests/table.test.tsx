import "@excalidraw/element";
import { isNonDeletedElement, newElementWith } from "@excalidraw/element";
import { FONT_FAMILY, KEYS } from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";

import {
  createTableData,
  createTableElements,
  isTableRoot,
  getTableMember,
  mergeTableCells,
  updateTableElements,
} from "@excalidraw/element/table";

import type { Radians } from "@excalidraw/math";

import { actionUngroup } from "../actions/actionGroup";
import { actionTableProperties } from "../actions/actionTable";

import { Excalidraw } from "../index";
import { createPasteEvent, serializeAsClipboardJSON } from "../clipboard";

import { API } from "./helpers/api";
import { Pointer } from "./helpers/ui";
import {
  act,
  fireEvent,
  render,
  screen,
  unmountComponent,
  waitFor,
} from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(async () => {
  unmountComponent();
  localStorage.clear();
  mouse.reset();
  await render(
    <Excalidraw
      langCode="zh-CN"
      autoFocus={true}
      handleKeyboardGlobally={true}
    />,
  );
  Object.assign(document, {
    elementFromPoint: () => document.querySelector("canvas.interactive"),
  });
});

it("inserts a persistent table from the toolbar and edits rows, merged cells and labels", () => {
  fireEvent.click(screen.getByTestId("toolbar-table"));
  expect(h.elements.find(isTableRoot)?.customData.table.rows).toHaveLength(3);
  expect(h.elements.filter((element) => element.type === "text")).toHaveLength(
    9,
  );
  fireEvent.click(screen.getByRole("button", { name: "添加行" }));
  expect(h.elements.find(isTableRoot)?.customData.table.rows).toHaveLength(4);
  const grid = screen.getByLabelText("选择单元格（Shift 多选）");
  const cells = grid.querySelectorAll("button");
  fireEvent.click(cells[0]);
  fireEvent.click(cells[4], { shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "合并单元格" }));
  expect(
    h.elements
      .find(isTableRoot)
      ?.customData.table.cells.some(
        (cell) => cell.rowSpan === 2 && cell.columnSpan === 2,
      ),
  ).toBe(true);
  expect(screen.queryByLabelText("单元格文字")).toBeNull();
  act(() => h.app.actionManager.executeAction(actionTableProperties, "ui"));
  fireEvent.change(screen.getByLabelText("单元格文字"), {
    target: { value: "可编辑" },
  });
  expect(
    h.elements.some(
      (element) =>
        element.type === "text" &&
        !element.isDeleted &&
        element.originalText === "可编辑",
    ),
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "表格详细设置" }), {
    key: "Escape",
  });
  fireEvent.click(screen.getByRole("button", { name: "拆分单元格" }));
  expect(h.elements.find(isTableRoot)?.customData.table.cells).toHaveLength(12);
});

it("command-clicks an unselected line and drags the new anchor in the same gesture", () => {
  const line = API.createElement({
    type: "line",
    x: 100,
    y: 100,
    width: 200,
    height: 0,
    points: [pointFrom(0, 0), pointFrom(200, 0)],
    roundness: null,
  });
  API.setElements([line]);
  const canvas = document.querySelector("canvas.interactive")!;
  fireEvent.pointerDown(canvas, {
    clientX: 160,
    clientY: 100,
    [KEYS.CTRL_OR_CMD]: true,
    button: 0,
  });
  expect(line.points).toHaveLength(3);
  fireEvent.pointerMove(canvas, {
    clientX: 170,
    clientY: 140,
    [KEYS.CTRL_OR_CMD]: true,
    buttons: 1,
  });
  fireEvent.pointerUp(canvas, { clientX: 170, clientY: 140 });
  expect(line.points[1]).toEqual(pointFrom(70, 40));
});

it.each([0, Math.PI / 3])(
  "directly edits an empty selected table cell outside its text bounds at angle %s",
  (angle) => {
    const table = createTableElements(createTableData(2, 2), 100, 100);
    const elements = updateTableElements(
      table.elements,
      newElementWith(table.root, { angle: angle as Radians }),
      (data) => data,
    );
    API.setElements(elements);
    API.setSelectedElements(
      h.elements
        .filter(isNonDeletedElement)
        .filter((element) => element.type !== "text"),
    );
    expect(h.state.selectedGroupIds[table.root.groupIds[0]]).toBe(true);
    const background = h.elements.find(
      (element) =>
        getTableMember(element)?.role === "background" &&
        getTableMember(element)?.row === 1 &&
        getTableMember(element)?.column === 1,
    )!;
    const point = pointRotateRads(
      pointFrom(
        background.x + background.width - 3,
        background.y + background.height - 3,
      ),
      pointFrom(
        background.x + background.width / 2,
        background.y + background.height / 2,
      ),
      background.angle,
    );
    const labelId = background.boundElements?.find(
      (element) => element.type === "text",
    )?.id;
    mouse.doubleClickAt(point[0], point[1]);
    expect(h.state.editingTextElement?.id).toBe(labelId);
    expect(h.state.editingTextElement?.originalText).toBe("");
    expect(
      document.querySelector(
        '[contenteditable="true"],textarea[data-type="wysiwyg"]',
      ),
    ).not.toBeNull();
    act(() => h.app.text.textWysiwygSubmitHandler?.());
  },
);

it("directly edits the existing text of a merged cell and keeps typing H inside the editor", () => {
  const initial = createTableData(2, 2);
  initial.cells[0].text = "Merged";
  const data = mergeTableCells(initial, {
    row: 0,
    column: 0,
    endRow: 1,
    endColumn: 1,
  });
  const table = createTableElements(data, 100, 100);
  API.setElements(table.elements);
  API.setSelectedElements(
    table.elements.filter((element) => element.type !== "text"),
  );
  mouse.doubleClickAt(380, 190);
  expect(h.state.editingTextElement?.originalText).toBe("Merged");
  const editor = document.querySelector<HTMLElement>('[data-type="wysiwyg"]')!;
  fireEvent.keyDown(editor, { key: "h", code: "KeyH" });
  expect(h.elements.filter(isTableRoot)).toHaveLength(1);
  expect(h.state.activeTool.type).not.toBe("hand");
  act(() => h.app.text.textWysiwygSubmitHandler?.());
});

it("pastes an HTML table as editable cells with merge data and preserves chart choices for TSV", async () => {
  await act(async () => {
    document.dispatchEvent(
      createPasteEvent({
        types: {
          "text/html":
            '<table><tr><td colspan="2"><b>格式</b></td></tr><tr><td>A</td><td>B</td></tr></table>',
          "text/plain": "格式\nA\tB",
        },
      }),
    );
  });
  await waitFor(() => expect(h.elements.some(isTableRoot)).toBe(true));
  expect(
    h.elements.find(isTableRoot)?.customData.table.cells[0].columnSpan,
  ).toBe(2);
  expect(
    h.elements.find(isTableRoot)?.customData.table.cells[0].richText
      ?.paragraphs[0].runs[0].bold,
  ).toBe(true);
  await act(async () => {
    document.dispatchEvent(
      createPasteEvent({
        types: { "text/plain": "Month\tValue\nJan\t10\nFeb\t20" },
      }),
    );
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "可编辑表格" })).toBeTruthy(),
  );
});

it("clones a copied nested subcanvas tree for each paste", async () => {
  const note = {
    ...API.createElement({ type: "stickynote" }),
    customData: { subcanvas: { sceneId: "source-child" } },
  };
  const nested = {
    ...API.createElement({ type: "stickynote" }),
    customData: { subcanvas: { sceneId: "source-grandchild" } },
  };
  const scenes: import("../features/subcanvas/model").SubcanvasScenes = {
    "source-child": {
      version: 1,
      title: "Child",
      elements: [nested],
      appState: {},
    },
    "source-grandchild": {
      version: 1,
      title: "Grandchild",
      elements: [API.createElement({ type: "rectangle" })],
      appState: {},
    },
  };
  const json = serializeAsClipboardJSON({
    elements: [note],
    files: null,
    subscenes: scenes,
  });
  const paste = async () => {
    await act(async () => {
      document.dispatchEvent(
        createPasteEvent({ types: { "text/plain": json } }),
      );
    });
  };
  await paste();
  await waitFor(() =>
    expect(
      h.elements.filter((element) => element.type === "stickynote"),
    ).toHaveLength(1),
  );
  const firstId = h.elements[0].customData?.subcanvas.sceneId;
  expect(firstId).not.toBe("source-child");
  expect(
    h.state.subscenes[firstId].elements[0].customData?.subcanvas.sceneId,
  ).not.toBe("source-grandchild");
  const firstGrandchild =
    h.state.subscenes[firstId].elements[0].customData?.subcanvas.sceneId;
  expect(h.state.subscenes[firstGrandchild].elements).toHaveLength(1);
  await paste();
  await waitFor(() =>
    expect(
      h.elements.filter((element) => element.type === "stickynote"),
    ).toHaveLength(2),
  );
  const secondId = h.elements[1].customData?.subcanvas.sceneId;
  expect(secondId).not.toBe(firstId);
  expect(
    h.state.subscenes[secondId].elements[0].customData?.subcanvas.sceneId,
  ).not.toBe(firstGrandchild);
});

it("undoes table structure as one operation and preserves the managed group when ungrouping", () => {
  fireEvent.click(screen.getByTestId("toolbar-table"));
  const grid = screen.getByLabelText("选择单元格（Shift 多选）");
  fireEvent.click(grid.querySelectorAll("button")[0]);
  fireEvent.click(grid.querySelectorAll("button")[4], { shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "合并单元格" }));
  expect(h.elements.find(isTableRoot)?.customData.table.cells).toHaveLength(6);
  const canvas = document.querySelector("canvas.interactive")!;
  fireEvent.keyDown(canvas, {
    key: "z",
    code: "KeyZ",
    [KEYS.CTRL_OR_CMD]: true,
  });
  expect(h.elements.find(isTableRoot)?.customData.table.cells).toHaveLength(9);
  expect(
    h.elements.filter(
      (element) => !element.isDeleted && element.type === "text",
    ),
  ).toHaveLength(9);
  fireEvent.keyDown(canvas, {
    key: "z",
    code: "KeyZ",
    [KEYS.CTRL_OR_CMD]: true,
    shiftKey: true,
  });
  expect(h.elements.find(isTableRoot)?.customData.table.cells).toHaveLength(6);
  const group = h.elements.find(isTableRoot)!.groupIds[0];
  act(() => h.app.actionManager.executeAction(actionUngroup, "ui"));
  expect(
    h.elements
      .filter((element) => !element.isDeleted)
      .every((element) => element.groupIds[0] === group),
  ).toBe(true);
});

it("shows table and image-border controls in English", async () => {
  unmountComponent();
  await render(
    <Excalidraw langCode="en" autoFocus={true} handleKeyboardGlobally={true} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
  expect(screen.getByRole("button", { name: "Add row" })).toBeTruthy();
  expect(screen.queryByLabelText("Cell text")).toBeNull();
  expect(
    screen.getByLabelText("Select cells (Shift for multiple)"),
  ).toBeTruthy();
  expect(screen.getByTitle("Row 1, column 1")).toBeTruthy();
  const image = API.createElement({ type: "image", width: 100, height: 100 });
  API.setElements([image]);
  API.setSelectedElements([image]);
  expect(screen.getByText("Image border")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Solid border" }));
  expect(screen.getByLabelText("Border color")).toBeTruthy();
  expect(screen.getByText("Stroke width")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Long dashed border" }),
  ).toBeTruthy();
});

it("inserts with H using canvas defaults, retains styles through structure edits and exposes details in the context menu", () => {
  act(() =>
    h.setState({
      currentItemFontFamily: FONT_FAMILY.Excalifont,
      currentItemFontSize: 28,
      currentItemStrokeColor: "#123456",
      currentItemBackgroundColor: "#ffffaa",
      currentItemRoughness: 2,
      currentItemStrokeStyle: "dashed",
      currentItemStrokeWidthKey: "bold",
    }),
  );
  const canvas = document.querySelector("canvas.interactive")!;
  fireEvent.keyDown(canvas, { key: "h", code: "KeyH" });
  expect(h.state.activeTool.type).toBe("selection");
  expect(screen.getByTestId("toolbar-table")).toHaveAttribute(
    "aria-keyshortcuts",
    "H",
  );
  expect(
    screen.getByTestId("toolbar-table").querySelector(".ToolIcon__keybinding")
      ?.textContent,
  ).toBe("H");
  expect(screen.getByTestId("toolbar-hand")).not.toHaveAttribute(
    "aria-keyshortcuts",
    "H",
  );
  expect(screen.getByTestId("toolbar-hand")).toHaveAttribute(
    "aria-keyshortcuts",
    "Space",
  );
  let root = h.elements.find(isTableRoot)!;
  expect(root).toBeTruthy();
  expect(root.roughness).toBe(2);
  expect(root.customData.table.cells[0]).toMatchObject({
    fontFamily: FONT_FAMILY.Excalifont,
    fontSize: 28,
    strokeColor: "#123456",
    textColor: "#123456",
    backgroundColor: "#ffffaa",
    strokeStyle: "dashed",
  });
  expect(screen.queryByLabelText("行高")).toBeNull();
  expect(screen.queryByText("描边宽度")).toBeNull();
  expect(screen.queryByText("边框样式")).toBeNull();
  expect(screen.queryByText("线条风格")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "添加行" }));
  root = h.elements.find(isTableRoot)!;
  expect(
    root.customData.table.cells.find((cell) => cell.row === 1),
  ).toMatchObject({
    fontFamily: FONT_FAMILY.Excalifont,
    fontSize: 28,
    strokeStyle: "dashed",
  });
  const background = h.elements.find(
    (element) =>
      !element.isDeleted && getTableMember(element)?.role === "background",
  )!;
  fireEvent.contextMenu(canvas, {
    clientX: background.x + 10,
    clientY: background.y + 10,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "表格详细设置…" }));
  expect(screen.getByRole("dialog", { name: "表格详细设置" })).toBeTruthy();
  expect(screen.getByText("描边宽度")).toBeTruthy();
  expect(screen.getByText("边框样式")).toBeTruthy();
  expect(screen.getByText("线条风格")).toBeTruthy();
  fireEvent.click(screen.getByTitle("朴素"));
  expect(h.elements.find(isTableRoot)?.roughness).toBe(0);
  fireEvent.change(screen.getByLabelText("列宽"), { target: { value: "200" } });
  expect(h.elements.find(isTableRoot)?.customData.table.columns[0]).toBe(200);
  fireEvent.change(screen.getByLabelText("行高"), { target: { value: "100" } });
  expect(h.elements.find(isTableRoot)?.customData.table.rows[0]).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "删除行" }));
  expect(h.elements.find(isTableRoot)?.customData.table.rows).toHaveLength(3);
  expect(
    h.elements
      .filter(
        (element) =>
          !element.isDeleted && getTableMember(element)?.role === "background",
      )
      .every((element) => element.roughness === 0),
  ).toBe(true);
});

it("keeps Space drag panning after assigning H to tables", () => {
  const canvas = document.querySelector("canvas.interactive")!;
  const previousX = h.state.scrollX;
  const previousY = h.state.scrollY;
  fireEvent.keyDown(canvas, { key: " ", code: "Space" });
  mouse.downAt(400, 300);
  mouse.moveTo(460, 340);
  mouse.up();
  fireEvent.keyUp(canvas, { key: " ", code: "Space" });
  expect(h.state.scrollX).toBeGreaterThan(previousX);
  expect(h.state.scrollY).toBeGreaterThan(previousY);
  expect(h.elements.some(isTableRoot)).toBe(false);
});

it("uses configurable table size presets and isolates text and border color popovers", async () => {
  unmountComponent();
  const onConfigurePreferences = vi.fn();
  await render(
    <Excalidraw
      langCode="en"
      desktopIntegration={{
        save: async () => false,
        open: async () => {},
        onConfigurePreferences,
        fontSizePresets: { sm: 14, md: 22, lg: 30, xl: 40 },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
  fireEvent.click(screen.getByRole("button", { name: "Configure font sizes" }));
  expect(onConfigurePreferences).toHaveBeenCalledWith("fontSizes");
  fireEvent.click(screen.getByTitle("XL (40)"));
  expect(h.elements.find(isTableRoot)?.customData.table.cells[0].fontSize).toBe(
    40,
  );
  expect(
    h.elements.find(isTableRoot)?.customData.table.cells[1].fontSize,
  ).not.toBe(40);
  fireEvent.click(screen.getByRole("button", { name: "Text color" }));
  expect(h.state.openPopup).toBe("tableText");
  expect(
    document.querySelectorAll("[data-radix-popper-content-wrapper]"),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Border color" }));
  expect(h.state.openPopup).toBe("elementStroke");
  expect(
    document.querySelectorAll("[data-radix-popper-content-wrapper]"),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Border color" }));
  const grid = screen.getByLabelText("Select cells (Shift for multiple)");
  fireEvent.click(grid.querySelectorAll("button")[1]);
  const colors = screen.getByText("Text color", { selector: "legend" })
    .parentElement!;
  const swatch = colors.querySelectorAll<HTMLButtonElement>(
    ".color-picker__top-picks button",
  )[1];
  fireEvent.click(swatch);
  const cells = h.elements.find(isTableRoot)!.customData.table.cells;
  expect(cells[1].textColor).toBe(swatch.title);
  expect(cells[0].textColor).not.toBe(swatch.title);
  expect(cells[1].strokeColor).not.toBe(swatch.title);
});
