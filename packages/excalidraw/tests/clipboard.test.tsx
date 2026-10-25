import React from "react";
import { vi } from "vitest";

import { CaptureUpdateAction, getLineHeightInPx } from "@excalidraw/element";

import {
  KEYS,
  MIME_TYPES,
  TEXT_VIEWPORT_PADDING,
  TEXT_MAX_WRAP_WIDTH,
  arrayToMap,
  getLineHeight,
  EXPORT_DATA_TYPES,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import { getElementBounds } from "@excalidraw/element";

import type { ExcalidrawTextElement, FileId } from "@excalidraw/element/types";

import * as Clipboard from "../clipboard";
import { createPasteEvent, serializeAsClipboardJSON } from "../clipboard";
import { actionCopy, actionCut, actionPaste } from "../actions/actionClipboard";
import { getSubcanvasId } from "../features/subcanvas/model";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { mockMermaidToExcalidraw } from "./helpers/mocks";
import { Pointer, Keyboard } from "./helpers/ui";
import {
  render,
  waitFor,
  GlobalTestState,
  unmountComponent,
  act,
} from "./test-utils";

import type { BinaryFiles, NormalizedZoomValue } from "../types";

const { h } = window;

const mouse = new Pointer("mouse");

vi.mock("@excalidraw/common", async (importOriginal) => {
  const module = await importOriginal<typeof import("@excalidraw/common")>();
  const { mockThrottleRAF } = await import("./helpers/mocks");

  return {
    __esmodule: true,
    ...module,
    isDarwin: false,
    KEYS: {
      ...module.KEYS,
      CTRL_OR_CMD: "ctrlKey",
    },
    throttleRAF: mockThrottleRAF,
  };
});

const sendPasteEvent = (text: string) => {
  const clipboardEvent = createPasteEvent({
    types: {
      "text/plain": text,
    },
  });
  document.dispatchEvent(clipboardEvent);
};

const pasteWithCtrlCmdShiftV = (text: string) => {
  Keyboard.withModifierKeys({ ctrl: true, shift: true }, () => {
    //triggering keydown with an empty clipboard
    Keyboard.keyPress(KEYS.V);
    //triggering paste event with faked clipboard
    sendPasteEvent(text);
  });
};

const pasteWithCtrlCmdV = (text: string) => {
  Keyboard.withModifierKeys({ ctrl: true }, () => {
    //triggering keydown with an empty clipboard
    Keyboard.keyPress(KEYS.V);
    //triggering paste event with faked clipboard
    sendPasteEvent(text);
  });
};

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
};

beforeEach(async () => {
  unmountComponent();

  localStorage.clear();

  mouse.reset();

  await render(
    <Excalidraw
      autoFocus={true}
      handleKeyboardGlobally={true}
      initialData={{ appState: { zoom: { value: 1 as NormalizedZoomValue } } }}
    />,
  );
  Object.assign(document, {
    elementFromPoint: () => GlobalTestState.canvas,
  });
});

describe("general paste behavior", () => {
  it("pastes editable elements when the clipboard also contains their PNG preview", async () => {
    const rectangle = API.createElement({ type: "rectangle" });
    const json = serializeAsClipboardJSON({
      elements: [rectangle],
      files: null,
    });
    const insertImages = vi.spyOn(h.app, "insertImages");
    document.dispatchEvent(
      createPasteEvent({
        types: { [MIME_TYPES.excalidrawClipboard]: json },
        files: [new File(["preview"], "preview.png", { type: MIME_TYPES.png })],
      }),
    );
    await waitFor(() => expect(h.elements).toHaveLength(1));
    expect(h.elements[0].type).toBe("rectangle");
    expect(h.elements[0].id).not.toBe(rectangle.id);
    expect(insertImages).not.toHaveBeenCalled();
    insertImages.mockRestore();
  });

  it("does not delete cut elements when clipboard export fails", async () => {
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    const failure = {
      appState: { errorMessage: "Clipboard write failed" },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    } as const;
    const copy = vi.spyOn(actionCopy, "perform").mockResolvedValue(failure);
    try {
      const result = await actionCut.perform(
        h.app.scene.getElementsIncludingDeleted(),
        h.state,
        null,
        h.app,
      );
      expect(result).toEqual(failure);
      expect(h.elements[0].isDeleted).toBe(false);
    } finally {
      copy.mockRestore();
    }
  });

  it("should randomize seed on paste", async () => {
    const rectangle = API.createElement({ type: "rectangle" });
    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rectangle],
      files: null,
    });
    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(1);
      expect(h.elements[0].seed).not.toBe(rectangle.seed);
    });
  });

  it("should retain seed on shift-paste", async () => {
    const rectangle = API.createElement({ type: "rectangle" });
    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rectangle],
      files: null,
    });

    // assert we don't randomize seed on shift-paste
    pasteWithCtrlCmdShiftV(clipboardJSON);
    await waitFor(() => {
      expect(h.elements.length).toBe(1);
      expect(h.elements[0].seed).toBe(rectangle.seed);
    });
  });
});

describe("original element paste position", () => {
  const source = () =>
    API.createElement({
      type: "rectangle",
      x: 113.25,
      y: -79.5,
      width: 91,
      height: 63,
    });

  const enableOriginalPosition = async () => {
    unmountComponent();
    await render(
      <Excalidraw
        autoFocus
        handleKeyboardGlobally
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          elementPastePosition: "original",
        }}
      />,
    );
  };

  it.each([
    { scrollX: 0, scrollY: 0, zoom: 1, gridModeEnabled: false },
    { scrollX: 451, scrollY: -321, zoom: 0.5, gridModeEnabled: false },
    { scrollX: -219, scrollY: 752, zoom: 2, gridModeEnabled: true },
  ])("keeps page coordinates after switching pages: %o", async (viewport) => {
    await enableOriginalPosition();
    const rectangle = source();
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    const clipboardJSON = serializeAsClipboardJSON({
      elements: h.app.scene.getSelectedElements(h.state),
      files: null,
    });
    API.setElements([]);
    API.setAppState({
      ...viewport,
      gridSize: 20,
      zoom: { value: viewport.zoom as NormalizedZoomValue },
    });
    mouse.moveTo(421, 287);
    pasteWithCtrlCmdV(clipboardJSON);
    await waitFor(() => expect(h.elements).toHaveLength(1));
    expect(h.elements[0]).toMatchObject({
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
    });
    expect(h.elements[0].id).not.toBe(rectangle.id);
    pasteWithCtrlCmdV(clipboardJSON);
    await waitFor(() => expect(h.elements).toHaveLength(2));
    expect(h.elements[1]).toMatchObject({ x: rectangle.x, y: rectangle.y });
    expect(h.elements[1].id).not.toBe(h.elements[0].id);
  });

  it("uses the same original position for menu paste", async () => {
    await enableOriginalPosition();
    const rectangle = source();
    const read = vi.spyOn(Clipboard, "readSystemClipboard").mockResolvedValue({
      [MIME_TYPES.excalidrawClipboard]: serializeAsClipboardJSON({
        elements: [rectangle],
        files: null,
      }),
    });
    try {
      mouse.moveTo(421, 287);
      act(() => h.app.actionManager.executeAction(actionPaste, "contextMenu"));
      await waitFor(() => expect(h.elements).toHaveLength(1));
      expect(h.elements[0]).toMatchObject({ x: rectangle.x, y: rectangle.y });
    } finally {
      read.mockRestore();
    }
  });

  it("only bypasses canvas targeting for host-forwarded clipboard data", async () => {
    await enableOriginalPosition();
    const rectangle = source();
    const button = h.app.ownerDocument.createElement("button");
    h.app.ownerDocument.body.append(button);
    const elementFromPoint = h.app.ownerDocument.elementFromPoint;
    h.app.ownerDocument.elementFromPoint = () => button;
    try {
      button.focus();
      const event = createPasteEvent({
        types: {
          [MIME_TYPES.excalidrawClipboard]: serializeAsClipboardJSON({
            elements: [rectangle],
            files: null,
          }),
        },
      });
      h.app.clipboard.pasteFromClipboard(event);
      expect(h.elements).toHaveLength(0);
      expect(button).toHaveFocus();
      h.app.api.pasteFromClipboard(
        new h.app.ownerWindow.Event("paste") as ClipboardEvent,
      );
      expect(button).toHaveFocus();
      act(() => h.app.api.pasteFromClipboard(event));
      await waitFor(() => expect(h.elements).toHaveLength(1));
      expect(h.elements[0]).toMatchObject({ x: rectangle.x, y: rectangle.y });
    } finally {
      button.remove();
      h.app.ownerDocument.elementFromPoint = elementFromPoint;
    }
  });

  it.each([true, false])(
    "handles PNG-only host paste with native trust=%s",
    async (isTrusted) => {
      await enableOriginalPosition();
      const text = API.createElement({
        type: "text",
        text: "editable slide text",
        x: 113.25,
        y: 79.5,
      });
      const content = serializeAsClipboardJSON({
        elements: [text],
        files: null,
      });
      const customType = `web ${MIME_TYPES.excalidrawClipboard}`;
      const read = vi.fn().mockResolvedValue([
        {
          types: [customType],
          getType: vi.fn(async () => ({ text: async () => content })),
        },
      ]);
      const { navigator } = h.app.ownerWindow;
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { read },
      });
      const insertImages = vi
        .spyOn(h.app, "insertImages")
        .mockResolvedValue(undefined);
      const preview = new File(["preview"], "preview.png", {
        type: MIME_TYPES.png,
      });
      const event = new Proxy(createPasteEvent({ files: [preview] }), {
        get(target, property) {
          const value =
            property === "isTrusted"
              ? isTrusted
              : Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        act(() => h.app.api.pasteFromClipboard(event));
        if (isTrusted) {
          await waitFor(() => expect(h.elements).toHaveLength(1));
          expect(h.elements[0]).toMatchObject({
            type: "text",
            text: text.text,
            x: text.x,
            y: text.y,
          });
          expect(h.elements[0].id).not.toBe(text.id);
          expect(read).toHaveBeenCalledTimes(1);
          expect(insertImages).not.toHaveBeenCalled();
        } else {
          await waitFor(() => expect(insertImages).toHaveBeenCalledTimes(1));
          expect(read).not.toHaveBeenCalled();
          expect(h.elements).toHaveLength(0);
        }
      } finally {
        insertImages.mockRestore();
        if (clipboard) {
          Object.defineProperty(navigator, "clipboard", clipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    },
  );

  it("keeps ordinary canvas paste centered at the cursor", async () => {
    const rectangle = source();
    API.setAppState({
      scrollX: 451,
      scrollY: -321,
      zoom: { value: 0.5 as NormalizedZoomValue },
    });
    mouse.moveTo(421, 287);
    const position = viewportCoordsToSceneCoords(
      { clientX: 421, clientY: 287 },
      h.state,
    );
    pasteWithCtrlCmdV(
      serializeAsClipboardJSON({ elements: [rectangle], files: null }),
    );
    await waitFor(() => expect(h.elements).toHaveLength(1));
    expect(h.elements[0].x).toBe(position.x - rectangle.width / 2);
    expect(h.elements[0].y).toBe(position.y - rectangle.height / 2);
  });

  it("retains cursor placement for external text, API elements and library items", async () => {
    await enableOriginalPosition();
    mouse.moveTo(421, 287);
    const position = viewportCoordsToSceneCoords(
      { clientX: 421, clientY: 287 },
      h.state,
    );
    pasteWithCtrlCmdV("external text");
    await waitFor(() => expect(h.elements).toHaveLength(1));
    expect(h.elements[0].x + h.elements[0].width / 2).toBe(position.x);
    const rectangle = source();
    pasteWithCtrlCmdV(
      JSON.stringify({
        type: EXPORT_DATA_TYPES.excalidrawClipboardWithAPI,
        elements: [rectangle],
      }),
    );
    await waitFor(() => expect(h.elements).toHaveLength(2));
    expect(h.elements[1].x).toBe(position.x - rectangle.width / 2);
    act(() =>
      h.app.addElementsFromPasteOrLibrary({
        elements: [rectangle],
        files: null,
        position: "cursor",
      }),
    );
    expect(h.elements[2].x).toBe(position.x - rectangle.width / 2);
  });

  it("uses cursor placement when clipboard elements have no scene coordinates", async () => {
    await enableOriginalPosition();
    const rectangle = source();
    mouse.moveTo(421, 287);
    const position = viewportCoordsToSceneCoords(
      { clientX: 421, clientY: 287 },
      h.state,
    );
    pasteWithCtrlCmdV(
      JSON.stringify({
        type: EXPORT_DATA_TYPES.excalidrawClipboard,
        elements: [{ ...rectangle, x: undefined, y: undefined }],
      }),
    );
    await waitFor(() => expect(h.elements).toHaveLength(1));
    expect(h.elements[0].x).toBe(position.x - rectangle.width / 2);
    expect(h.elements[0].y).toBe(position.y - rectangle.height / 2);
  });

  it("keeps external image insertion at the cursor", async () => {
    await enableOriginalPosition();
    mouse.moveTo(421, 287);
    const position = viewportCoordsToSceneCoords(
      { clientX: 421, clientY: 287 },
      h.state,
    );
    const insertImages = vi
      .spyOn(h.app, "insertImages")
      .mockResolvedValue(undefined);
    const file = new File(["image"], "image.png", { type: MIME_TYPES.png });
    try {
      document.dispatchEvent(createPasteEvent({ files: [file] }));
      await waitFor(() =>
        expect(insertImages).toHaveBeenCalledWith(
          [file],
          position.x,
          position.y,
        ),
      );
    } finally {
      insertImages.mockRestore();
    }
  });

  it("preserves frames, bound text, image files and independent subscenes", async () => {
    await enableOriginalPosition();
    const frame = API.createElement({
      type: "frame",
      x: 113.25,
      y: -79.5,
      width: 500,
      height: 500,
    });
    const rectangle = {
      ...source(),
      frameId: frame.id,
      boundElements: [{ id: "label", type: "text" as const }],
    };
    const text = API.createElement({
      type: "text",
      id: "label",
      text: "label",
      containerId: rectangle.id,
      frameId: frame.id,
    });
    const image = API.createElement({
      type: "image",
      x: 250.5,
      y: 80.25,
      fileId: "original-paste-file" as FileId,
      status: "saved",
      frameId: frame.id,
    });
    const note = {
      ...API.createElement({
        type: "stickynote",
        x: 312.5,
        y: 210.75,
        frameId: frame.id,
      }),
      customData: { subcanvas: { sceneId: "source-child", title: "child" } },
    };
    const child = API.createElement({ type: "rectangle", x: 11, y: 17 });
    const files: BinaryFiles = {
      [image.fileId!]: {
        id: image.fileId!,
        mimeType: MIME_TYPES.png,
        dataURL:
          "data:image/png;base64,aW1hZ2U=" as BinaryFiles[string]["dataURL"],
        created: 1,
      },
    };
    pasteWithCtrlCmdV(
      serializeAsClipboardJSON({
        elements: [frame, rectangle, text, image, note],
        files,
        subscenes: {
          "source-child": {
            version: 1,
            title: "child",
            elements: [child],
            appState: {},
          },
        },
      }),
    );
    await waitFor(() => expect(h.elements).toHaveLength(5));
    const [pastedFrame, pastedRectangle, pastedText, pastedImage, pastedNote] =
      h.elements;
    expect(pastedRectangle.boundElements).toEqual([
      { id: pastedText.id, type: "text" },
    ]);
    expect((pastedText as ExcalidrawTextElement).containerId).toBe(
      pastedRectangle.id,
    );
    for (const element of h.elements.slice(1)) {
      expect(element.frameId).toBe(pastedFrame.id);
    }
    expect(pastedImage).toMatchObject({
      x: image.x,
      y: image.y,
      fileId: image.fileId,
    });
    expect(h.app.files[image.fileId!]).toEqual(files[image.fileId!]);
    const childId = getSubcanvasId(pastedNote)!;
    expect(childId).not.toBe("source-child");
    expect(h.state.subscenes[childId].elements[0]).toMatchObject({
      x: child.x,
      y: child.y,
    });
    expect(h.state.subscenes[childId].elements[0].id).not.toBe(child.id);
  });
});

describe("paste text as single lines", () => {
  it("should create an element for each line when copying with Ctrl/Cmd+V", async () => {
    const text = "sajgfakfn\naaksfnknas\nakefnkasf";
    pasteWithCtrlCmdV(text);
    await waitFor(() => {
      expect(h.elements.length).toEqual(text.split("\n").length);
    });
  });

  it("should ignore empty lines when creating an element for each line", async () => {
    const text = "\n\nsajgfakfn\n\n\naaksfnknas\n\nakefnkasf\n\n\n";
    pasteWithCtrlCmdV(text);
    await waitFor(() => {
      expect(h.elements.length).toEqual(3);
    });
  });

  it("should not create any element if clipboard has only new lines", async () => {
    const text = "\n\n\n\n\n";
    pasteWithCtrlCmdV(text);
    await waitFor(async () => {
      await sleep(50); // elements lenght will always be zero if we don't wait, since paste is async
      expect(h.elements.length).toEqual(0);
    });
  });

  it("should space items correctly", async () => {
    const elementsMap = arrayToMap(h.elements);

    const text = "hkhkjhki\njgkjhffjh\njgkjhffjh";
    const lineHeightPx =
      getLineHeightInPx(
        h.app.state.currentItemFontSize,
        getLineHeight(h.state.currentItemFontFamily),
      ) +
      10 / h.app.state.zoom.value;
    mouse.moveTo(100, 100);
    pasteWithCtrlCmdV(text);
    await waitFor(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [fx, firstElY] = getElementBounds(h.elements[0], elementsMap);
      for (let i = 1; i < h.elements.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [fx, elY] = getElementBounds(h.elements[i], elementsMap);
        expect(elY).toEqual(firstElY + lineHeightPx * i);
      }
    });
  });

  it("should leave a space for blank new lines", async () => {
    const elementsMap = arrayToMap(h.elements);
    const text = "hkhkjhki\n\njgkjhffjh";
    const lineHeightPx =
      getLineHeightInPx(
        h.app.state.currentItemFontSize,
        getLineHeight(h.state.currentItemFontFamily),
      ) +
      10 / h.app.state.zoom.value;
    mouse.moveTo(100, 100);
    pasteWithCtrlCmdV(text);

    await waitFor(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [fx, firstElY] = getElementBounds(h.elements[0], elementsMap);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [lx, lastElY] = getElementBounds(h.elements[1], elementsMap);
      expect(lastElY).toEqual(firstElY + lineHeightPx * 2);
    });
  });
});

describe("paste text as a single element", () => {
  it("should create single text element when copying text with Ctrl/Cmd+Shift+V", async () => {
    const text = "sajgfakfn\naaksfnknas\nakefnkasf";
    pasteWithCtrlCmdShiftV(text);
    await waitFor(() => {
      expect(h.elements.length).toEqual(1);
    });
  });
  it("should not make a pasted text wider than the view", async () => {
    API.setAppState({
      width: 1000,
      zoom: { value: 8 as NormalizedZoomValue },
    });
    // the view at 800%, less some room at each side
    const maxWidth = (1000 - 2 * TEXT_VIEWPORT_PADDING) / 8;

    pasteWithCtrlCmdShiftV(
      "Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams!",
    );
    await waitFor(() => {
      expect(h.elements.length).toEqual(1);
    });
    const text = h.elements[0] as ExcalidrawTextElement;
    expect(text.autoResize).toBe(false);
    expect(text.width).toBeLessThanOrEqual(maxWidth);
  });
  it("should wrap a pasted text as a typed one: at TEXT_MAX_WRAP_WIDTH, clear of the full styles panel", async () => {
    unmountComponent();
    await render(
      <Excalidraw
        autoFocus={true}
        handleKeyboardGlobally={true}
        UIOptions={{ getFormFactor: () => "desktop" }}
      />,
    );
    API.setAppState({ width: 1000 });
    // nothing's selected: the panel shows only once the text is in
    expect(
      document.querySelector('[data-viewport-ui-name="stylesPanel"]'),
    ).toBe(null);

    pasteWithCtrlCmdShiftV(
      "Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams! Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams!",
    );
    await waitFor(() => {
      expect(h.elements.length).toEqual(1);
    });
    const text = h.elements[0] as ExcalidrawTextElement;
    expect(text.autoResize).toBe(false);
    // not at half the view…
    expect(text.width).toBeGreaterThan(1000 / 2);
    // …but the view less the panel's room (216, approximately, while never
    // shown) and some room at each side
    expect(text.width).toBeLessThanOrEqual(
      Math.min(1000 - 216 - 2 * TEXT_VIEWPORT_PADDING, TEXT_MAX_WRAP_WIDTH),
    );
  });
  describe("next to the stats panel (desktop)", () => {
    const { getBoundingClientRect } = HTMLElement.prototype;
    /** the stats panel's bottom: it grows to show a selection's properties */
    let getStatsBottom = () => 200;

    beforeEach(async () => {
      unmountComponent();
      await render(
        <Excalidraw
          autoFocus={true}
          handleKeyboardGlobally={true}
          UIOptions={{ getFormFactor: () => "desktop" }}
        />,
      );
      API.setAppState({
        width: 1000,
        height: 800,
        stats: { ...h.state.stats, open: true },
      });
      // the styles panel up to 216px, the stats panel from 700px
      getStatsBottom = () => 200;
      HTMLElement.prototype.getBoundingClientRect = function (
        this: HTMLElement,
      ) {
        switch (this.dataset.viewportUiName) {
          case "stylesPanel":
            return {
              left: 16,
              right: 216,
              width: 200,
              top: 0,
              bottom: 400,
            } as DOMRect;
          case "stats":
            return {
              left: 700,
              right: 904,
              width: 204,
              top: 0,
              bottom: getStatsBottom(),
            } as DOMRect;
        }
        return getBoundingClientRect.call(this);
      };
    });

    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
    });

    const pasteAt = async (y: number) => {
      API.setSelectedElements([]);
      h.app.viewport.lastPosition.x = 500;
      h.app.viewport.lastPosition.y = y;
      const count = h.elements.length;
      pasteWithCtrlCmdShiftV(
        "Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams! Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams!",
      );
      await waitFor(() => {
        expect(h.elements.length).toEqual(count + 1);
      });
      return h.elements[count] as ExcalidrawTextElement;
    };
    const getRight = (text: ExcalidrawTextElement) =>
      (text.x + text.width + h.state.scrollX) * h.state.zoom.value;
    // the view less the styles panel's room, and some room at each side
    const maxWidth = 1000 - 216 - 2 * TEXT_VIEWPORT_PADDING;
    // and the stats panel's
    const maxWidthBesideStats = maxWidth - (1000 - 700);

    it("should keep a pasted text clear of the stats panel only where it lands beside it", async () => {
      // below it, it's wrapped past it
      let text = await pasteAt(600);
      expect(text.width).toBeGreaterThan(maxWidthBesideStats);
      expect(text.width).toBeLessThanOrEqual(maxWidth);

      // beside it, it's wrapped, and moved, clear of it
      text = await pasteAt(100);
      expect(text.width).toBeLessThanOrEqual(maxWidthBesideStats);
      expect(getRight(text)).toBeLessThanOrEqual(
        700 - TEXT_VIEWPORT_PADDING + 0.01,
      );
    });

    it("should keep a pasted text clear of the stats panel grown to show it, as one step", async () => {
      getStatsBottom = () =>
        Object.keys(h.state.selectedElementIds).length ? 500 : 200;
      const undoSteps = h.history.undoStack.length;

      // below it as it is before the paste, beside it as it is after
      const text = await pasteAt(350);
      expect(text.width).toBeLessThanOrEqual(maxWidthBesideStats);
      expect(getRight(text)).toBeLessThanOrEqual(
        700 - TEXT_VIEWPORT_PADDING + 0.01,
      );
      expect(h.history.undoStack.length).toBe(undoSteps + 1);
    });
  });
  it("should move a pasted text that wraps into view, not the view", async () => {
    API.setAppState({ width: 1000, height: 800 });
    const { scrollX, scrollY } = h.state;
    // pasted at the pointer, near the bottom-right corner
    h.app.viewport.lastPosition.x = 950;
    h.app.viewport.lastPosition.y = 780;

    pasteWithCtrlCmdShiftV(
      "Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams! Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams!",
    );
    await waitFor(() => {
      expect(h.elements.length).toEqual(1);
    });
    const text = h.elements[0] as ExcalidrawTextElement;
    expect(text.autoResize).toBe(false);
    expect(h.state.scrollX).toBe(scrollX);
    expect(h.state.scrollY).toBe(scrollY);
    // all of it within the view, with room at each side
    const zoom = h.state.zoom.value;
    expect((text.x + scrollX) * zoom).toBeGreaterThanOrEqual(
      TEXT_VIEWPORT_PADDING - 0.01,
    );
    expect((text.x + text.width + scrollX) * zoom).toBeLessThanOrEqual(
      1000 - TEXT_VIEWPORT_PADDING + 0.01,
    );
    expect((text.y + scrollY) * zoom).toBeGreaterThanOrEqual(
      TEXT_VIEWPORT_PADDING - 0.01,
    );
    expect((text.y + text.height + scrollY) * zoom).toBeLessThanOrEqual(
      800 - TEXT_VIEWPORT_PADDING + 0.01,
    );
  });
  it("should not create any element when only new lines in clipboard", async () => {
    const text = "\n\n\n\n";
    pasteWithCtrlCmdShiftV(text);
    await waitFor(async () => {
      await sleep(50);
      expect(h.elements.length).toEqual(0);
    });
  });
});

describe("Paste bound text container", () => {
  const container = {
    type: "ellipse",
    id: "container-id",
    x: 554.984375,
    y: 196.0234375,
    width: 166,
    height: 187.01953125,
    roundness: { type: 2 },
    boundElements: [{ type: "text", id: "text-id" }],
  };
  const textElement = {
    type: "text",
    id: "text-id",
    x: 560.51171875,
    y: 202.033203125,
    width: 154,
    height: 175,
    fontSize: 20,
    fontFamily: 1,
    text: "Excalidraw is a\nvirtual \nopensource \nwhiteboard for \nsketching \nhand-drawn like\ndiagrams",
    baseline: 168,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    originalText:
      "Excalidraw is a virtual opensource whiteboard for sketching hand-drawn like diagrams",
  };

  it("should fix ellipse bounding box", async () => {
    const data = JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [container, textElement],
    });
    pasteWithCtrlCmdShiftV(data);

    await waitFor(async () => {
      await sleep(1);
      expect(h.elements.length).toEqual(2);
      const container = h.elements[0];
      expect(container.height).toBe(368);
      expect(container.width).toBe(166);
    });
  });

  it("should fix diamond bounding box", async () => {
    const data = JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [
        {
          ...container,
          type: "diamond",
        },
        textElement,
      ],
    });
    pasteWithCtrlCmdShiftV(data);

    await waitFor(async () => {
      await sleep(1);
      expect(h.elements.length).toEqual(2);
      const container = h.elements[0];
      expect(container.height).toBe(770);
      expect(container.width).toBe(166);
    });
  });
});

describe("pasting & frames", () => {
  it("should add pasted elements to frame under cursor", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const rect = API.createElement({ type: "rectangle" });

    API.setElements([frame]);

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rect],
      files: null,
    });

    mouse.moveTo(50, 50);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(2);
      expect(h.elements[0].type).toBe(rect.type);
      expect(h.elements[0].frameId).toBe(frame.id);
      expect(h.elements[1].id).toBe(frame.id);
      expect(h.elements[0].index! < frame.index!).toBe(true);
    });
  });

  it("should layer pasted elements above the highest frame child", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const frameChild = API.createElement({
      id: "frameChild",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      frameId: frame.id,
    });
    const rect = API.createElement({ type: "rectangle" });

    API.setElements([frameChild, frame]);

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rect],
      files: null,
    });

    mouse.moveTo(50, 50);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(3);
      expect(h.elements[1].type).toBe(rect.type);
      expect(h.elements[1].frameId).toBe(frame.id);
      expect(h.elements.map((element) => element.id)).toEqual([
        frameChild.id,
        h.elements[1].id,
        frame.id,
      ]);
      expect(h.elements[1].index! > frameChild.index!).toBe(true);
      expect(h.elements[1].index! < frame.index!).toBe(true);
    });
  });

  it("should preserve denormalized pasted frame child order", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const frameChild = API.createElement({
      type: "rectangle",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      frameId: frame.id,
    });

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [frame, frameChild],
      files: null,
    });

    mouse.moveTo(200, 200);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(2);
      expect(h.elements[0].type).toBe(frame.type);
      expect(h.elements[1].type).toBe(frameChild.type);
      expect(h.elements[1].frameId).toBe(h.elements[0].id);
    });
  });

  it("should remove element from frame when pasted outside", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const rect = API.createElement({
      type: "rectangle",
      frameId: frame.id,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
    });

    API.setElements([frame]);

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rect],
      files: null,
    });

    mouse.moveTo(150, 150);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(2);
      expect(h.elements[1].type).toBe(rect.type);
      expect(h.elements[1].frameId).toBe(null);
    });
  });

  it("should filter out elements not overlapping frame", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const rect = API.createElement({
      type: "rectangle",
      width: 50,
      height: 50,
    });
    const rect2 = API.createElement({
      type: "rectangle",
      width: 50,
      height: 50,
      x: 100,
      y: 100,
    });

    API.setElements([frame]);

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rect, rect2],
      files: null,
    });

    mouse.moveTo(90, 90);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(3);
      expect(h.elements[0].type).toBe(rect.type);
      expect(h.elements[0].frameId).toBe(frame.id);
      expect(h.elements[1].id).toBe(frame.id);
      expect(h.elements[2].type).toBe(rect2.type);
      expect(h.elements[2].frameId).toBe(null);
    });
  });

  it("should not filter out elements not overlapping frame if part of group", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const rect = API.createElement({
      type: "rectangle",
      width: 50,
      height: 50,
      groupIds: ["g1"],
    });
    const rect2 = API.createElement({
      type: "rectangle",
      width: 50,
      height: 50,
      x: 100,
      y: 100,
      groupIds: ["g1"],
    });

    API.setElements([frame]);

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rect, rect2],
      files: null,
    });

    mouse.moveTo(90, 90);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(3);
      expect(h.elements[0].type).toBe(rect.type);
      expect(h.elements[0].frameId).toBe(frame.id);
      expect(h.elements[1].type).toBe(rect2.type);
      expect(h.elements[1].frameId).toBe(frame.id);
      expect(h.elements[2].id).toBe(frame.id);
    });
  });

  it("should not filter out other frames and their children", async () => {
    const frame = API.createElement({
      type: "frame",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
    });
    const rect = API.createElement({
      type: "rectangle",
      width: 50,
      height: 50,
      groupIds: ["g1"],
    });

    const frame2 = API.createElement({
      type: "frame",
      width: 75,
      height: 75,
      x: 0,
      y: 0,
    });
    const rect2 = API.createElement({
      type: "rectangle",
      width: 50,
      height: 50,
      x: 55,
      y: 55,
      frameId: frame2.id,
    });

    API.setElements([frame]);

    const clipboardJSON = await serializeAsClipboardJSON({
      elements: [rect, rect2, frame2],
      files: null,
    });

    mouse.moveTo(90, 90);

    pasteWithCtrlCmdV(clipboardJSON);

    await waitFor(() => {
      expect(h.elements.length).toBe(4);
      expect(h.elements[0].type).toBe(rect.type);
      expect(h.elements[0].frameId).toBe(frame.id);
      expect(h.elements[1].id).toBe(frame.id);
      expect(h.elements[2].type).toBe(rect2.type);
      expect(h.elements[2].frameId).toBe(h.elements[3].id);
      expect(h.elements[3].type).toBe(frame2.type);
      expect(h.elements[3].frameId).toBe(null);
    });
  });
});

describe("clipboard - pasting mermaid definition", () => {
  beforeAll(() => {
    mockMermaidToExcalidraw({
      parseMermaidToExcalidraw: async (definition) => {
        const lines = definition.split("\n");
        return new Promise((resolve, reject) => {
          if (lines.some((line) => line === "flowchart TD")) {
            resolve({
              elements: [
                {
                  id: "rect1",
                  type: "rectangle",
                  groupIds: [],
                  x: 0,
                  y: 0,
                  width: 69.703125,
                  height: 44,
                  strokeWidth: 2,
                  label: {
                    groupIds: [],
                    text: "A",
                    fontSize: 20,
                  },
                  link: null,
                },
              ],
            });
          } else {
            reject(new Error("ERROR"));
          }
        });
      },
    });
  });

  it("should detect and paste as mermaid", async () => {
    const text = "flowchart TD\nA";

    pasteWithCtrlCmdV(text);
    await waitFor(() => {
      expect(h.elements.length).toEqual(2);
      expect(h.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "rectangle" }),
          expect.objectContaining({ type: "text", text: "A" }),
        ]),
      );
    });
  });

  it("should support directives", async () => {
    const text = "%%{init: { **config** } }%%\nflowchart TD\nA";

    pasteWithCtrlCmdV(text);
    await waitFor(() => {
      expect(h.elements.length).toEqual(2);
      expect(h.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "rectangle" }),
          expect.objectContaining({ type: "text", text: "A" }),
        ]),
      );
    });
  });

  it("should paste as normal text if invalid mermaid", async () => {
    const text = "flowchart TD xx\nA";
    pasteWithCtrlCmdV(text);
    await waitFor(() => {
      expect(h.elements.length).toEqual(2);
      expect(h.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "flowchart TD xx" }),
          expect.objectContaining({ type: "text", text: "A" }),
        ]),
      );
    });
  });
});

describe("copy and cut events", () => {
  const dispatchClipboardEvent = (type: "copy" | "cut") => {
    const clipboardData = new DataTransfer();
    document.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        clipboardData,
      }),
    );
    return clipboardData;
  };

  it("should copy the selection on a copy event, and cut it on a cut event", async () => {
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);

    const copied = dispatchClipboardEvent("copy");
    await waitFor(() => {
      expect(JSON.parse(copied.getData("text/plain")).elements).toEqual([
        expect.objectContaining({ id: rectangle.id }),
      ]);
    });
    expect(h.elements[0].isDeleted).toBe(false);

    const cut = dispatchClipboardEvent("cut");
    await waitFor(() => {
      expect(h.elements[0].isDeleted).toBe(true);
    });
    expect(JSON.parse(cut.getData("text/plain")).elements).toEqual([
      expect.objectContaining({ id: rectangle.id }),
    ]);
  });
});

describe("paste routing", () => {
  it("should paste embed code with its loader <script> on a separate line as an embeddable", async () => {
    pasteWithCtrlCmdV(
      `<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/BsOGulcndj-/?utm_source=ig_embed&amp;utm_campaign=loading" data-instgrm-version="14"><div style="padding:16px;"> <a href="https://www.instagram.com/p/BsOGulcndj-/?utm_source=ig_embed&amp;utm_campaign=loading" target="_blank">View this post on Instagram</a></div></blockquote>
<script async src="//www.instagram.com/embed.js"></script>`,
    );
    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({
          type: "embeddable",
          link: "https://www.instagram.com/p/BsOGulcndj-/?utm_source=ig_embed&amp;utm_campaign=loading",
        }),
      ]);
    });
  });

  it("should leave a paste to the host when its onPaste returns false", async () => {
    unmountComponent();
    const onPaste = vi.fn(() => false);
    await render(
      <Excalidraw
        autoFocus={true}
        handleKeyboardGlobally={true}
        onPaste={onPaste}
      />,
    );

    pasteWithCtrlCmdV("hello");
    await waitFor(() => {
      expect(onPaste).toHaveBeenCalledWith(
        expect.objectContaining({ text: "hello" }),
        expect.anything(),
      );
    });
    await sleep(50);
    expect(h.elements.length).toBe(0);
  });

  it("should open the charts dialog for a pasted spreadsheet", async () => {
    pasteWithCtrlCmdV("time\tvalue\n1\t10\n2\t20\n3\t30");
    await waitFor(() => {
      expect(h.state.openDialog?.name).toBe("charts");
    });
    expect(h.elements.length).toBe(0);
  });

  it("should paste the text of mixed content when images can't be inserted", async () => {
    unmountComponent();
    await render(
      <Excalidraw
        autoFocus={true}
        handleKeyboardGlobally={true}
        UIOptions={{ tools: { image: false } }}
      />,
    );

    document.dispatchEvent(
      createPasteEvent({
        types: {
          "text/html":
            '<p>hello</p><img src="https://example.com/a.png" /><p>world</p>',
        },
      }),
    );
    await waitFor(() => {
      expect(h.elements.map((element) => (element as any).text)).toEqual([
        "hello",
        "world",
      ]);
    });
  });
});
