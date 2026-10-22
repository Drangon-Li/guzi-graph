import React from "react";
import { vi } from "vitest";

import { CANVAS_SEARCH_TAB, DEFAULT_SIDEBAR, KEYS } from "@excalidraw/common";

import { Excalidraw, MainMenu } from "../index";

import { API } from "./helpers/api";
import { Keyboard, UI } from "./helpers/ui";
import {
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
  waitFor,
} from "./test-utils";

type Dock = "floating" | "left" | "right";

const labels = {
  title: "Tool panel",
  canvas: "Canvas tools",
  properties: "Element properties",
  pin: "Pin tools",
  pinLeft: "Dock left",
  pinRight: "Dock right",
  unpin: "Unpin tools",
  collapse: "Collapse tools",
  expand: "Expand tools",
  resize: "Resize tools",
};

const Harness = ({
  initialDock = "floating",
  initialWidth = 280,
  initialPinned = true,
  onAction = () => {},
  onWidthChange = () => {},
}: {
  initialDock?: Dock;
  initialWidth?: number;
  initialPinned?: boolean;
  onAction?: () => void;
  onWidthChange?: (width: number) => void;
}) => {
  const [dock, setDock] = React.useState<Dock>(initialDock);
  const [width, setWidth] = React.useState(initialWidth);
  const [pinned, setPinned] = React.useState(initialPinned);
  return (
    <Excalidraw
      handleKeyboardGlobally
      desktopIntegration={{
        save: async () => true,
        open: async () => {},
        selectionToolbar: false,
        toolPanel: {
          pinned,
          onPinnedChange: setPinned,
          dock,
          onDockChange: setDock,
          width,
          onWidthChange: (nextWidth) => {
            onWidthChange(nextWidth);
            setWidth(nextWidth);
          },
          labels,
        },
      }}
    >
      <MainMenu>
        <MainMenu.Item onSelect={onAction}>Canvas action</MainMenu.Item>
        <MainMenu.DefaultItems.Preferences />
      </MainMenu>
    </Excalidraw>
  );
};

const { h } = window;

const getResizeHandle = () => {
  const handle = screen.getByRole("separator", { name: labels.resize });
  Object.defineProperties(handle, {
    releasePointerCapture: { value: vi.fn(), configurable: true },
    hasPointerCapture: { value: vi.fn(() => true), configurable: true },
  });
  return handle;
};

const expectUnshiftedCanvasControls = (panel: HTMLElement) => {
  const wrapper =
    panel.parentElement!.querySelector<HTMLElement>(".layer-ui__wrapper")!;
  expect(wrapper).toHaveStyle({
    left: "0px",
    width: "calc(100% - 0px - 0px)",
  });
};

describe("desktop tool panel", () => {
  beforeEach(() => {
    mockBoundingClientRect({ width: 1600, height: 1000 });
  });

  afterEach(() => {
    restoreOriginalGetBoundingClientRect();
    localStorage.removeItem("excalidraw.desktopUIMode");
  });

  it.each([false, true])(
    "commits the initial collapse state before paint when pinned is %s, including after remount",
    async (pinned) => {
      const commits: { collapsed: boolean; width: string }[] = [];
      const onRender = () => {
        const panel = screen.queryByRole("complementary", {
          name: labels.title,
        });
        if (panel) {
          commits.push({
            collapsed: panel.classList.contains("tool-panel--collapsed"),
            width: panel.style.width,
          });
        }
      };
      const renderHarness = (key: number) => (
        <React.Profiler id="tool-panel" onRender={onRender}>
          <Harness key={key} initialDock="left" initialPinned={pinned} />
        </React.Profiler>
      );
      const expected = {
        collapsed: !pinned,
        width: pinned ? "280px" : "0px",
      };

      const { rerender } = await render(renderHarness(0));
      expect(commits[0]).toEqual(expected);

      commits.length = 0;
      rerender(renderHarness(1));
      await waitFor(() => expect(commits[0]).toEqual(expected));
    },
  );

  it("changes dock position independently from pinning and collapse", async () => {
    await render(<Harness initialDock="left" initialPinned={false} />);
    const panel = screen.getByRole("complementary", { name: labels.title });
    expect(panel).toHaveStyle({ width: "0px" });
    fireEvent.click(screen.getByRole("button", { name: labels.expand }));
    const pin = screen.getByRole("button", { name: labels.pin });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: labels.pinRight }));
    expect(panel).toHaveClass("tool-panel--right");
    expect(panel).toHaveStyle({ width: "280px" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: labels.pinRight }));
    expect(panel).toHaveStyle({ width: "280px" });
    fireEvent.click(pin);
    expect(screen.getByRole("button", { name: labels.unpin })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: labels.pinLeft }));
    expect(panel).toHaveClass("tool-panel--left");
    expect(screen.getByRole("button", { name: labels.unpin })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: labels.unpin }));
    expect(panel).toHaveStyle({ width: "0px" });
    expect(panel).toHaveClass("tool-panel--left");
  });

  it("switches to properties for selection and drawing tools, then back to canvas", async () => {
    await render(<Harness initialDock="left" />);
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    const canvasTab = screen.getByRole("tab", { name: labels.canvas });
    const propertiesTab = screen.getByRole("tab", { name: labels.properties });
    expect(canvasTab).toHaveAttribute("aria-selected", "true");
    expect(propertiesTab).toBeDisabled();

    API.setSelectedElements([rectangle]);
    expect(propertiesTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tabpanel", { name: labels.properties }),
    ).toBeVisible();
    API.setSelectedElements([]);
    expect(canvasTab).toHaveAttribute("aria-selected", "true");
    expect(propertiesTab).toBeDisabled();

    UI.clickTool("rectangle");
    expect(propertiesTab).toHaveAttribute("aria-selected", "true");
    UI.clickTool("selection");
    expect(canvasTab).toHaveAttribute("aria-selected", "true");
    expect(h.elements).toEqual([rectangle]);
  });

  it("keeps the chosen tab while the same selection updates", async () => {
    await render(<Harness initialDock="left" />);
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    const canvasTab = screen.getByRole("tab", { name: labels.canvas });
    const propertiesTab = screen.getByRole("tab", { name: labels.properties });

    fireEvent.click(canvasTab);
    API.setSelectedElements([rectangle]);
    API.setAppState({ cursorButton: "up" });
    expect(canvasTab).toHaveAttribute("aria-selected", "true");
    expect(h.state.selectedElementIds).toEqual({ [rectangle.id]: true });

    fireEvent.keyDown(canvasTab, { key: "ArrowRight" });
    expect(propertiesTab).toHaveAttribute("aria-selected", "true");
    expect(propertiesTab).toHaveFocus();
    fireEvent.keyDown(propertiesTab, { key: "Home" });
    expect(canvasTab).toHaveFocus();
    expect(canvasTab).toHaveAttribute("aria-selected", "true");
    expect(h.elements).toEqual([rectangle]);
  });

  it("temporarily hides a right panel for the library and search sidebars", async () => {
    const { container } = await render(<Harness initialDock="right" />);
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    const panel = screen.getByRole("complementary", { name: labels.title });
    const libraryTrigger =
      container.querySelector<HTMLElement>(".sidebar-trigger")!;
    fireEvent.click(libraryTrigger);
    await waitFor(() => expect(panel).toHaveClass("tool-panel--hidden"));
    expect(h.state.openSidebar?.name).toBe(DEFAULT_SIDEBAR.name);
    fireEvent.click(libraryTrigger);
    await waitFor(() => expect(panel).toBeVisible());

    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress(KEYS.F));
    expect(h.state.openSidebar?.tab).toBe(CANVAS_SEARCH_TAB);
    expect(panel).toHaveClass("tool-panel--hidden");
    Keyboard.keyPress(KEYS.ESCAPE);
    await waitFor(() => expect(panel).toBeVisible());
    expect(screen.queryByTestId("main-menu-trigger")).toBeNull();
    expect(h.elements).toEqual([rectangle]);
  });

  it.each([
    ["left", 80],
    ["right", -80],
  ] as const)(
    "resizes the %s panel and commits only on release",
    async (dock, delta) => {
      const onWidthChange = vi.fn();
      await render(
        <Harness
          initialDock={dock}
          initialWidth={320}
          onWidthChange={onWidthChange}
        />,
      );
      const rectangle = API.createElement({ type: "rectangle" });
      API.setElements([rectangle]);
      const undoSteps = h.history.undoStack.length;
      const redoSteps = h.history.redoStack.length;
      const panel = screen.getByRole("complementary", { name: labels.title });
      const handle = getResizeHandle();
      expectUnshiftedCanvasControls(panel);
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 700 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 + delta / 2 });
      expect(handle).toHaveAttribute("aria-valuenow", "360");
      expectUnshiftedCanvasControls(panel);
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 + delta });
      expect(handle).toHaveAttribute("aria-valuenow", "400");
      expectUnshiftedCanvasControls(panel);
      expect(onWidthChange).not.toHaveBeenCalled();
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700 + delta });
      expect(onWidthChange).toHaveBeenCalledTimes(1);
      expect(onWidthChange).toHaveBeenCalledWith(400);
      expect(handle).toHaveAttribute("aria-valuenow", "400");
      expectUnshiftedCanvasControls(panel);
      expect(h.elements).toEqual([rectangle]);
      expect(h.history.undoStack).toHaveLength(undoSteps);
      expect(h.history.redoStack).toHaveLength(redoSteps);
    },
  );

  it("cancels an active resize on Escape or pointer cancellation", async () => {
    const onWidthChange = vi.fn();
    await render(
      <Harness
        initialDock="left"
        initialWidth={320}
        onWidthChange={onWidthChange}
      />,
    );
    const handle = getResizeHandle();
    const undoSteps = h.history.undoStack.length;
    for (const cancel of [
      () => fireEvent.keyDown(handle, { key: "Escape" }),
      () => fireEvent.pointerCancel(handle, { pointerId: 1 }),
    ]) {
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 680 });
      expect(handle).toHaveAttribute("aria-valuenow", "400");
      cancel();
      expect(handle).toHaveAttribute("aria-valuenow", "320");
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 680 });
      expect(onWidthChange).not.toHaveBeenCalled();
    }
    expect(h.history.undoStack).toHaveLength(undoSteps);
  });

  it.each(["left", "right"] as const)(
    "auto-hides the unpinned %s panel and preserves manual collapse until the target changes",
    async (dock) => {
      await render(<Harness initialDock={dock} initialPinned={false} />);
      const rectangle = API.createElement({ type: "rectangle" });
      const ellipse = API.createElement({ type: "ellipse" });
      API.setElements([rectangle, ellipse]);
      const panel = screen.getByRole("complementary", { name: labels.title });
      const toggle = screen.getByRole("button", { name: labels.expand });
      expect(toggle.querySelector("svg path")).not.toBeNull();
      API.setSelectedElements([rectangle]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      toggle.focus();
      fireEvent.click(toggle);
      expect(toggle).toHaveFocus();
      API.setSelectedElements([rectangle]);
      API.setAppState({ cursorButton: "up" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      API.setSelectedElements([ellipse]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(panel).toHaveStyle({ width: "280px" });
      API.setSelectedElements([]);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(panel).not.toHaveAttribute("data-viewport-ui");
      expectUnshiftedCanvasControls(panel);
      const text = API.createElement({ type: "text", text: "Editing" });
      API.setElements([rectangle, ellipse, text]);
      API.setAppState({ editingTextElement: text });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      API.setAppState({ editingTextElement: null });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("keeps a pinned panel open when selection clears and preserves content across collapse", async () => {
    await render(<Harness initialDock="left" initialPinned />);
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    fireEvent.click(screen.getByRole("tab", { name: labels.canvas }));
    const menuAction = screen.getByRole("button", { name: "Canvas action" });
    const toggle = screen.getByRole("button", { name: labels.collapse });
    fireEvent.click(toggle);
    expect(menuAction).toBeInTheDocument();
    expect(menuAction.closest("[inert]")).not.toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Canvas action" })).toBe(
      menuAction,
    );
    API.setSelectedElements([]);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("supports keyboard resizing in both directions within the available canvas space", async () => {
    mockBoundingClientRect({ width: 1000, height: 1000 });
    const onWidthChange = vi.fn();
    await render(
      <Harness
        initialDock="left"
        initialWidth={320}
        onWidthChange={onWidthChange}
      />,
    );
    const handle = getResizeHandle();
    const undoSteps = h.history.undoStack.length;
    handle.focus();
    expect(handle).toHaveFocus();
    expect(handle).toHaveAttribute("aria-valuemin", "260");
    expect(handle).toHaveAttribute("aria-valuemax", "400");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "336");
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "400");
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    expect(onWidthChange).toHaveBeenLastCalledWith(280);

    fireEvent.click(screen.getByRole("button", { name: labels.pinRight }));
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "296");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    expect(h.history.undoStack).toHaveLength(undoSteps);
  });

  it("keeps note color and font shortcuts expanded inside a wide dock with compact desktop preferences", async () => {
    localStorage.setItem("excalidraw.desktopUIMode", "compact");
    await render(<Harness initialDock="left" />);
    const note = API.createElement({
      type: "stickynote",
      id: "full-note",
      boundElements: [{ type: "text", id: "full-note-label" }],
    });
    const text = API.createElement({
      type: "text",
      id: "full-note-label",
      containerId: note.id,
      text: "A note",
    });
    API.setElements([note, text]);
    API.setSelectedElements([note]);
    const panel = screen.getByRole("complementary", { name: labels.title });
    expect(panel.querySelector(".compact-shape-actions")).toBeNull();
    expect(
      panel.querySelector(".color-picker-container--no-top-picks"),
    ).toBeNull();
    expect(panel.querySelectorAll(".color-picker__top-picks")).toHaveLength(3);
    expect(
      panel.querySelectorAll(".FontPicker__top-picks .top-picks-dnd__pick"),
    ).toHaveLength(3);
    const fontPicker = panel.querySelector(".FontPicker__container")!;
    for (const colorPicker of panel.querySelectorAll(
      ".color-picker-container",
    )) {
      expect(
        colorPicker.compareDocumentPosition(fontPicker) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(panel.querySelector('input[name="sloppiness"]')).not.toBeNull();
    expect(panel.querySelector('input[name="edges"]')).not.toBeNull();
  });

  it("omits note-only appearance and typography controls for a collapsed subcanvas pin", async () => {
    await render(<Harness initialDock="right" />);
    const pin = {
      ...API.createElement({ type: "stickynote", id: "collapsed-pin" }),
      customData: { subcanvas: { sceneId: "child" } },
    };
    API.setElements([pin]);
    API.setSelectedElements([pin]);
    const panel = screen.getByRole("complementary", { name: labels.title });
    expect(panel.querySelectorAll(".color-picker__top-picks")).toHaveLength(2);
    expect(panel.querySelector('input[name="sloppiness"]')).toBeNull();
    expect(panel.querySelector('input[name="edges"]')).toBeNull();
    expect(panel.querySelector(".FontPicker__container")).toBeNull();
    expect(panel.querySelector(".rich-text-controls")).toBeNull();
  });
});
