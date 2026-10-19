import React from "react";
import { vi } from "vitest";

import { CANVAS_SEARCH_TAB, DEFAULT_SIDEBAR, KEYS } from "@excalidraw/common";

import { Excalidraw, MainMenu } from "../index";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import {
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
  waitFor,
  within,
} from "./test-utils";

type Dock = "floating" | "left" | "right";

const labels = {
  title: "Tool panel",
  canvas: "Canvas tools",
  properties: "Element properties",
  pinLeft: "Pin left",
  pinRight: "Pin right",
  unpin: "Unpin tools",
  collapse: "Collapse tools",
  expand: "Expand tools",
  resize: "Resize tools",
};

const Harness = ({
  initialDock = "floating",
  initialWidth = 280,
  onAction = () => {},
  onWidthChange = () => {},
}: {
  initialDock?: Dock;
  initialWidth?: number;
  onAction?: () => void;
  onWidthChange?: (width: number) => void;
}) => {
  const [dock, setDock] = React.useState<Dock>(initialDock);
  const [width, setWidth] = React.useState(initialWidth);
  return (
    <Excalidraw
      handleKeyboardGlobally
      desktopIntegration={{
        save: async () => true,
        open: async () => {},
        toolPanel: {
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
  });

  it.each([
    ["left", labels.pinLeft],
    ["right", labels.pinRight],
  ] as const)(
    "pins the floating menu to %s and unpins it",
    async (_, pinLabel) => {
      const onAction = vi.fn();
      await render(<Harness onAction={onAction} />);
      const rectangle = API.createElement({ type: "rectangle" });
      API.setElements([rectangle]);

      expect(
        screen.queryByRole("complementary", { name: labels.title }),
      ).toBeNull();
      fireEvent.click(screen.getByTestId("main-menu-trigger"));
      fireEvent.click(screen.getByRole("button", { name: pinLabel }));

      const panel = await screen.findByRole("complementary", {
        name: labels.title,
      });
      expect(
        within(panel).getByRole("button", { name: labels.collapse }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByTestId("main-menu-trigger")).toBeNull();
      expect(h.state.openMenu).toBeNull();

      fireEvent.click(
        within(panel).getByRole("button", { name: "Canvas action" }),
      );
      expect(onAction).toHaveBeenCalledTimes(1);
      new Pointer("mouse").clickAt(1200, 900);
      expect(panel).toBeVisible();
      expect(h.elements).toEqual([rectangle]);

      fireEvent.click(
        within(panel).getByRole("button", { name: labels.unpin }),
      );
      expect(
        screen.queryByRole("complementary", { name: labels.title }),
      ).toBeNull();
      fireEvent.click(screen.getByTestId("main-menu-trigger"));
      expect(
        screen.getByRole("menuitem", { name: "Canvas action" }),
      ).toBeVisible();
      expect(h.elements).toEqual([rectangle]);
    },
  );

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
    await waitFor(() => expect(panel).not.toBeVisible());
    expect(h.state.openSidebar?.name).toBe(DEFAULT_SIDEBAR.name);
    fireEvent.click(libraryTrigger);
    await waitFor(() => expect(panel).toBeVisible());

    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress(KEYS.F));
    expect(h.state.openSidebar?.tab).toBe(CANVAS_SEARCH_TAB);
    expect(panel).not.toBeVisible();
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
    "restores the %s panel width and manual tab after collapsing without unmounting the menu",
    async (dock) => {
      const onWidthChange = vi.fn();
      await render(
        <Harness
          initialDock={dock}
          initialWidth={368}
          onWidthChange={onWidthChange}
        />,
      );
      const rectangle = API.createElement({ type: "rectangle" });
      API.setElements([rectangle]);
      API.setSelectedElements([rectangle]);
      const undoSteps = h.history.undoStack.length;
      const canvasTab = screen.getByRole("tab", { name: labels.canvas });
      fireEvent.click(canvasTab);
      const menuAction = screen.getByRole("button", { name: "Canvas action" });
      const summary = screen.getByText("Preferences").closest("summary")!;
      fireEvent.click(summary);
      const submenu = summary.parentElement!;
      const panel = screen.getByRole("complementary", { name: labels.title });
      const toggle = screen.getByRole("button", { name: labels.collapse });
      const controls = toggle.closest<HTMLElement>(
        ".tool-panel-dock-controls",
      )!;
      expectUnshiftedCanvasControls(panel);
      expect(controls).not.toBeNull();
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(within(controls).getAllByRole("button")).toHaveLength(3);
      toggle.focus();
      fireEvent.click(toggle);

      expect(screen.getByRole("button", { name: labels.expand })).toBe(toggle);
      expect(toggle).toHaveFocus();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(within(controls).getAllByRole("button")).toEqual([toggle]);
      expect(toggle).toBeVisible();
      for (const button of controls.querySelectorAll("button")) {
        if (button !== toggle) {
          expect(button).not.toBeVisible();
        }
      }
      expect(panel).toHaveStyle({ width: "0px" });
      expect(panel).not.toHaveAttribute("data-viewport-ui");
      expectUnshiftedCanvasControls(panel);
      expect(menuAction).toBeInTheDocument();
      expect(menuAction.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(menuAction.closest("[inert]")).not.toBeNull();
      expect(submenu).toHaveAttribute("open");
      API.setSelectedElements([rectangle]);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);

      expect(toggle).toHaveFocus();
      expect(screen.getByRole("button", { name: labels.collapse })).toBe(
        toggle,
      );
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(within(controls).getAllByRole("button")).toHaveLength(3);
      expect(panel).toHaveStyle({ width: "368px" });
      expect(panel).toHaveAttribute("data-viewport-ui", "side");
      expectUnshiftedCanvasControls(panel);
      expect(canvasTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("button", { name: "Canvas action" })).toBe(
        menuAction,
      );
      expect(submenu).toHaveAttribute("open");
      expect(getResizeHandle()).toHaveAttribute("aria-valuenow", "368");
      fireEvent.click(toggle);
      API.setSelectedElements([]);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(onWidthChange).not.toHaveBeenCalled();
      expect(h.elements).toEqual([rectangle]);
      fireEvent.click(toggle);
      const oppositePinLabel =
        dock === "left" ? labels.pinRight : labels.pinLeft;
      fireEvent.click(
        within(controls).getByRole("button", { name: oppositePinLabel }),
      );
      const switchedToggle = within(controls).getByRole("button", {
        name: labels.collapse,
      });
      expectUnshiftedCanvasControls(panel);
      expect(switchedToggle).not.toBe(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(toggle).toHaveAttribute(
        "aria-label",
        dock === "left" ? labels.pinLeft : labels.pinRight,
      );
      expect(switchedToggle).toHaveAttribute("aria-pressed", "true");
      switchedToggle.focus();
      fireEvent.click(switchedToggle);
      expect(
        within(controls).getByRole("button", { name: labels.expand }),
      ).toBe(switchedToggle);
      expect(within(controls).getAllByRole("button")).toEqual([switchedToggle]);
      expect(switchedToggle).toHaveFocus();
      expect(switchedToggle).toHaveAttribute("aria-pressed", "true");
      expect(switchedToggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(switchedToggle);
      expect(switchedToggle).toHaveFocus();
      expect(switchedToggle).toHaveAttribute("aria-expanded", "true");
      expect(panel).toHaveStyle({ width: "368px" });
      expect(canvasTab).toHaveAttribute("aria-selected", "true");
      expect(h.history.undoStack).toHaveLength(undoSteps);
    },
  );

  it.each(["left", "right"] as const)(
    "temporarily expands the %s panel for new selections until manually expanded",
    async (dock) => {
      await render(<Harness initialDock={dock} />);
      const rectangle = API.createElement({ type: "rectangle" });
      const ellipse = API.createElement({ type: "ellipse" });
      API.setElements([rectangle, ellipse]);
      API.setSelectedElements([rectangle]);
      const panel = screen.getByRole("complementary", { name: labels.title });
      const toggle = screen.getByRole("button", { name: labels.collapse });

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
      API.setSelectedElements([rectangle]);
      API.setAppState({ cursorButton: "up" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);

      API.setSelectedElements([ellipse]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      expect(panel).toHaveStyle({ width: "280px" });
      expect(panel).toHaveAttribute("data-viewport-ui", "side");
      expect(
        screen.getByRole("tab", { name: labels.properties }),
      ).toHaveAttribute("aria-selected", "true");
      API.setSelectedElements([]);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
      expect(panel).toHaveStyle({ width: "0px" });
      expect(panel).not.toHaveAttribute("data-viewport-ui");

      API.setSelectedElements([rectangle]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      API.setSelectedElements([]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      API.setSelectedElements([ellipse]);
      API.setSelectedElements([]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      expect(panel).toHaveStyle({ width: "280px" });
    },
  );

  it.each(["left", "right"] as const)(
    "keeps the %s panel expanded while editing text and hides it when editing ends",
    async (dock) => {
      await render(<Harness initialDock={dock} />);
      const text = API.createElement({ type: "text", text: "First" });
      const otherText = API.createElement({ type: "text", text: "Second" });
      API.setElements([text, otherText]);
      const panel = screen.getByRole("complementary", { name: labels.title });
      const toggle = screen.getByRole("button", { name: labels.collapse });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);

      API.setAppState({ editingTextElement: text });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      expect(
        screen.getByRole("tab", { name: labels.properties }),
      ).toHaveAttribute("aria-selected", "true");
      API.setSelectedElements([text]);
      API.setSelectedElements([]);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      API.setAppState({ editingTextElement: null });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
      expect(panel).toHaveStyle({ width: "0px" });

      API.setAppState({ editingTextElement: text });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
      API.setAppState({ editingTextElement: { ...text } });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
      API.setAppState({ editingTextElement: otherText });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expectUnshiftedCanvasControls(panel);
      API.setAppState({ editingTextElement: null });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expectUnshiftedCanvasControls(panel);
    },
  );

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
});
