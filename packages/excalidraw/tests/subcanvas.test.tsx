import { isNonDeletedElement } from "@excalidraw/element";
import { getSubcanvasPinGeometry } from "@excalidraw/element/subcanvasPin";

import { Excalidraw } from "../index";
import { restoreElements, restoreAppState } from "../data/restore";
import { serializeAsJSON } from "../data/json";
import { getDefaultAppState } from "../appState";
import {
  collectSubcanvasScenes,
  getSubcanvasId,
} from "../features/subcanvas/model";
import {
  cloneSubcanvasScenes,
  convertStickyNoteToSubcanvas,
} from "../features/subcanvas/operations";
import { exportScene } from "../scene/export";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { getTextEditor } from "./queries/dom";
import {
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
} from "./test-utils";

const noteAndText = () => {
  const note = API.createElement({
    id: "note",
    type: "stickynote",
    boundElements: [{ id: "label", type: "text" }],
  });
  const text = API.createElement({
    id: "label",
    type: "text",
    text: "子概念\n详细解释",
    containerId: note.id,
  });
  return { note, text };
};

describe("subcanvas documents", () => {
  beforeEach(async () => {
    await render(<Excalidraw />);
  });

  it("moves original text into an independent scene and restores compact pin geometry", () => {
    const { note, text } = noteAndText();
    const converted = convertStickyNoteToSubcanvas([note, text], note.id, {})!;
    const pin = converted.elements[0];
    expect(getSubcanvasId(pin)).toBe(converted.sceneId);
    expect(converted.elements[1].isDeleted).toBe(true);
    expect(converted.scenes[converted.sceneId].elements[0]).toMatchObject({
      originalText: text.originalText,
      containerId: null,
      frameId: null,
      groupIds: [],
    });
    const serialized = serializeAsJSON(
      converted.elements,
      { ...getDefaultAppState(), subscenes: converted.scenes },
      {},
      "local",
    );
    const parsed = JSON.parse(serialized);
    const restored = {
      elements: restoreElements(parsed.elements, null, {
        refreshDimensions: true,
        repairBindings: true,
      }),
      appState: restoreAppState(parsed.appState, null),
    };
    expect(restored.elements[0]).toMatchObject({ width: 48, height: 56 });
    expect(
      restored.appState.subscenes?.[converted.sceneId].elements[0],
    ).toMatchObject({ originalText: text.originalText });
  });

  it("clones nested scene references and all element identities without altering originals", () => {
    const { note, text } = noteAndText();
    const first = convertStickyNoteToSubcanvas([note, text], note.id, {})!;
    const nested = convertStickyNoteToSubcanvas(
      [API.createElement({ type: "stickynote", id: "nested" })],
      "nested",
      first.scenes,
    )!;
    const scenes = {
      ...nested.scenes,
      [first.sceneId]: {
        ...first.scenes[first.sceneId],
        elements: [...first.scenes[first.sceneId].elements, ...nested.elements],
      },
    };
    const cloned = cloneSubcanvasScenes([first.elements[0]], scenes);
    const copyId = getSubcanvasId(cloned.elements[0])!;
    expect(copyId).not.toBe(first.sceneId);
    const copy = cloned.scenes[copyId];
    expect(copy.elements[0].id).not.toBe(text.id);
    expect(copy.elements[0].id).not.toBe(scenes[first.sceneId].elements[0].id);
    const nestedId = getSubcanvasId(copy.elements[1])!;
    expect(nestedId).not.toBe(nested.sceneId);
    expect(cloned.scenes[nestedId]).toBeDefined();
    expect(getSubcanvasId(scenes[first.sceneId].elements[1])).toBe(
      nested.sceneId,
    );
    expect(
      Object.keys(collectSubcanvasScenes(cloned.elements, cloned.scenes)),
    ).toHaveLength(2);
  });

  it("exports a paper and pin glyph while keeping child content out of the parent SVG", async () => {
    const { note, text } = noteAndText();
    const converted = convertStickyNoteToSubcanvas([note, text], note.id, {})!;
    const svg = await exportScene({
      type: "svg",
      data: {
        elements: converted.elements.filter(isNonDeletedElement),
        appState: getDefaultAppState(),
        files: {},
      },
    });
    const geometry = getSubcanvasPinGeometry(converted.elements[0]);
    const head = svg.querySelector("circle[r]")!;
    expect(head).not.toBeNull();
    expect(head.getAttribute("r")).toBe(`${geometry.radius}`);
    expect(head.getAttribute("fill")).toBe(geometry.headColor);
    expect(head.parentElement?.getAttribute("stroke-width")).toBe(
      `${geometry.lineWidth}`,
    );
    expect(head.parentElement?.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.querySelector("polygon")).not.toBeNull();
    expect(svg.querySelector("polygon")?.getAttribute("points")).toBe(
      geometry.paper.map((point) => point.join(",")).join(" "),
    );
    expect(svg.textContent).not.toContain("详细解释");
  });
});

describe("sticky note creation mode", () => {
  const { h } = window;
  const mouse = new Pointer("mouse");
  const onModeChange = vi.fn();
  const open = vi.fn();
  beforeEach(async () => {
    mouse.reset();
    onModeChange.mockClear();
    open.mockClear();
    mockBoundingClientRect({ width: 1600, height: 1000 });
    await render(
      <Excalidraw
        langCode="zh-CN"
        handleKeyboardGlobally
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          selectionToolbar: false,
          subcanvas: { open },
          onStickyNoteModeChange: onModeChange,
        }}
      />,
    );
  });
  afterEach(restoreOriginalGetBoundingClientRect);

  it("keeps ordinary creation, then remembers conversion for the N shortcut", async () => {
    UI.clickTool("stickynote");
    mouse.clickAt(500, 400);
    const note = h.elements
      .filter(isNonDeletedElement)
      .find((element) => element.type === "stickynote")!;
    expect(getSubcanvasId(note)).toBeNull();
    expect(h.state.editingTextElement).not.toBeNull();
    Keyboard.keyPress("Escape", await getTextEditor());
    API.setSelectedElements([note]);
    fireEvent.click(screen.getByRole("button", { name: "转为子画布" }));
    expect(h.state.currentItemStickyNoteMode).toBe("subcanvas");
    expect(onModeChange).toHaveBeenCalledWith("subcanvas");
    Keyboard.keyPress("n");
    mouse.clickAt(800, 500);
    const pin = h.elements.find(
      (element) => element.type === "stickynote" && element.id !== note.id,
    )!;
    expect(pin).toMatchObject({ x: 776, y: 472, width: 48, height: 56 });
    expect(h.state.subscenes[getSubcanvasId(pin)!].elements).toEqual([]);
    expect(h.state.editingTextElement).toBeNull();
    expect(open).not.toHaveBeenCalled();
    Keyboard.undo();
    expect(h.elements.find((element) => element.id === pin.id)?.isDeleted).toBe(
      true,
    );
    Keyboard.redo();
    const restored = h.elements.find((element) => element.id === pin.id)!;
    expect(restored.isDeleted).toBe(false);
    expect(h.state.subscenes[getSubcanvasId(restored)!]).toBeDefined();
  });

  it.each(["click", "contextmenu"])(
    "Control %s on the toolbar places a pin and ordinary clicks retain that mode",
    (event) => {
      const button = screen.getByTestId("toolbar-stickynote");
      if (event === "click") {
        fireEvent.click(button, { ctrlKey: true });
      } else {
        fireEvent.contextMenu(button, { ctrlKey: true, button: 2 });
      }
      expect(h.state.activeTool.type).toBe("stickynote");
      expect(onModeChange).toHaveBeenCalledWith("subcanvas");
      mouse.clickAt(600, 400);
      const pin = h.elements.find((element) => !element.isDeleted)!;
      expect(getSubcanvasId(pin)).toBeTruthy();
      expect(h.state.editingTextElement).toBeNull();
      UI.clickTool("stickynote");
      mouse.clickAt(800, 400);
      const notes = h.elements.filter((element) => !element.isDeleted);
      expect(notes).toHaveLength(2);
      expect(getSubcanvasId(notes[1])).not.toBe(getSubcanvasId(pin));
      expect(open).not.toHaveBeenCalled();
    },
  );
});
