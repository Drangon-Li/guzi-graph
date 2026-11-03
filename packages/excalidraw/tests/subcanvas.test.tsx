import {
  CaptureUpdateAction,
  getElementBounds,
  isNonDeletedElement,
} from "@excalidraw/element";
import {
  getSubcanvasPinGeometry,
  getSubcanvasPinTitle,
} from "@excalidraw/element/subcanvasPin";

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
import { actionSubcanvasTitle } from "../actions/actionSubcanvas";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { getTextEditor } from "./queries/dom";
import {
  fireEvent,
  act,
  waitFor,
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
    await render(<Excalidraw langCode="en" handleKeyboardGlobally />);
  });

  it("opens the rename dialog from the menu action and applies the entered name", async () => {
    const { h } = window;
    const { note, text } = noteAndText();
    const converted = convertStickyNoteToSubcanvas([note, text], note.id, {})!;
    API.updateScene({
      elements: converted.elements,
      appState: {
        subscenes: converted.scenes,
        selectedElementIds: { [note.id]: true },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.executeAction(actionSubcanvasTitle);
    expect(
      screen.getByRole("heading", { name: "Rename subcanvas…" }),
    ).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "Renamed child" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Rename subcanvas…" }),
      ).toBeNull(),
    );
    expect(h.elements[0].customData?.subcanvas.title).toBe("Renamed child");
    expect(h.state.subscenes[converted.sceneId].title).toBe("Renamed child");
  });

  it("renames and clears the pin and scene together, including undo, redo and reopening saved data", async () => {
    const { h } = window;
    const { note, text } = noteAndText();
    const converted = convertStickyNoteToSubcanvas([note, text], note.id, {})!;
    API.updateScene({
      elements: converted.elements,
      appState: {
        subscenes: converted.scenes,
        selectedElementIds: { [note.id]: true },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    const rename = async (title: string) => {
      await act(async () => {
        const result = await actionSubcanvasTitle.perform(
          h.app.scene.getElementsIncludingDeleted(),
          h.state,
          title,
          h.app,
        );
        h.app.syncActionResult(result);
      });
    };
    await rename("新的子画布名称");
    expect(h.elements[0].customData?.subcanvas.title).toBe("新的子画布名称");
    expect(h.state.subscenes[converted.sceneId].title).toBe("新的子画布名称");
    Keyboard.undo();
    expect(h.elements[0].customData?.subcanvas.title).toBe("子概念");
    expect(h.state.subscenes[converted.sceneId].title).toBe("子概念");
    Keyboard.redo();
    expect(h.state.subscenes[converted.sceneId].title).toBe("新的子画布名称");
    const saved = JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local"));
    expect(
      restoreElements(saved.elements, null)[0].customData?.subcanvas.title,
    ).toBe("新的子画布名称");
    expect(
      restoreAppState(saved.appState, null).subscenes[converted.sceneId].title,
    ).toBe("新的子画布名称");
    await rename("");
    expect(h.state.subscenes[converted.sceneId].title).toBe("");
    expect(getSubcanvasPinTitle(h.elements[0])).toBeNull();
  });

  it("includes the full wrapped title in rotated bounds and SVG export", async () => {
    const { note, text } = noteAndText();
    const converted = convertStickyNoteToSubcanvas([note, text], note.id, {})!;
    const pin = {
      ...converted.elements[0],
      isDeleted: false as const,
      customData: {
        subcanvas: {
          sceneId: converted.sceneId,
          title: "完整的长标题需要合理换行 and preserve its complete name",
        },
      },
    };
    const title = getSubcanvasPinTitle(pin)!;
    expect(title.lines.length).toBeGreaterThan(1);
    const bounds = getElementBounds(pin, new Map([[pin.id, pin]]));
    expect(bounds[1]).toBe(pin.y);
    expect(bounds[3]).toBeCloseTo(pin.y + title.y + title.height);
    const rotated = { ...pin, angle: (Math.PI / 2) as typeof pin.angle };
    const rotatedBounds = getElementBounds(
      rotated,
      new Map([[pin.id, { ...rotated, isDeleted: false as const }]]),
    );
    expect(rotatedBounds[2] - rotatedBounds[0]).toBeCloseTo(
      bounds[3] - bounds[1],
    );
    expect(rotatedBounds[3] - rotatedBounds[1]).toBeCloseTo(
      bounds[2] - bounds[0],
    );
    const svg = await exportScene({
      type: "svg",
      data: { elements: [rotated], appState: getDefaultAppState(), files: {} },
    });
    const label = svg.querySelector("text")!;
    expect(
      [...label.querySelectorAll("tspan")]
        .map((span) => span.textContent)
        .join(""),
    ).toBe(title.lines.join(""));
    expect(Number(svg.getAttribute("width"))).toBeGreaterThanOrEqual(
      rotatedBounds[2] - rotatedBounds[0],
    );
    expect(Number(svg.getAttribute("height"))).toBeGreaterThanOrEqual(
      rotatedBounds[3] - rotatedBounds[1],
    );
    const drawn: string[] = [];
    try {
      const exported = await exportScene({
        type: "canvas",
        data: {
          elements: [rotated],
          appState: getDefaultAppState(),
          files: {},
        },
        config: {
          environment: {
            createCanvas: () => {
              const canvas = window.h.app.ownerDocument.createElement("canvas");
              vi.spyOn(canvas.getContext("2d")!, "fillText").mockImplementation(
                (line) => {
                  drawn.push(line);
                },
              );
              return canvas;
            },
            loadFonts: async () => {},
          },
          scale: 2,
        },
      });
      expect(drawn).toEqual(title.lines);
      expect(exported.width).toBeGreaterThanOrEqual(
        (rotatedBounds[2] - rotatedBounds[0]) * 2,
      );
      expect(exported.height).toBeGreaterThanOrEqual(
        (rotatedBounds[3] - rotatedBounds[1]) * 2,
      );
    } finally {
      vi.restoreAllMocks();
    }
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
    expect(cloned.elements[0].customData?.subcanvas.title).toBe(
      first.elements[0].customData?.subcanvas.title,
    );
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
