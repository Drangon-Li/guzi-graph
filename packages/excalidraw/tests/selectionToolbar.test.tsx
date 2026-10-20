import React from "react";

import { getSelectionToolbarPosition } from "../components/SelectionToolbar";
import { Excalidraw } from "../index";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  mockBoundingClientRect,
  restoreOriginalGetBoundingClientRect,
  within,
} from "./test-utils";
import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";

import type { AppState } from "../types";

const viewport = {
  zoom: { value: 2 as AppState["zoom"]["value"] },
  scrollX: -20,
  scrollY: -10,
  offsetLeft: 150,
  offsetTop: 75,
  width: 1200,
  height: 800,
};

describe("selection toolbar placement", () => {
  it("uses scene zoom and scroll and removes the editor page offset", () => {
    expect(
      getSelectionToolbarPosition(
        [200, 200, 400, 300],
        viewport,
        { width: 300, height: 44 },
        { left: 16, right: 16 },
      ),
    ).toEqual({ left: 410, top: 324 });
  });
  it("places below selections near the top and stays clear of docked panels", () => {
    expect(
      getSelectionToolbarPosition(
        [100, 50, 200, 100],
        viewport,
        { width: 300, height: 44 },
        { left: 320, right: 16 },
      ),
    ).toEqual({ left: 320, top: 192 });
    expect(
      getSelectionToolbarPosition(
        [400, 200, 490, 300],
        viewport,
        { width: 300, height: 44 },
        { left: 16, right: 320 },
      )?.left,
    ).toBe(580);
  });
  it("hides for offscreen, viewport-filling, and insufficient-space selections", () => {
    expect(
      getSelectionToolbarPosition(
        [-500, -500, -400, -400],
        viewport,
        { width: 300, height: 44 },
        { left: 16, right: 16 },
      ),
    ).toBeNull();
    expect(
      getSelectionToolbarPosition(
        [100, 0, 400, 600],
        viewport,
        { width: 300, height: 44 },
        { left: 16, right: 16 },
      ),
    ).toBeNull();
    expect(
      getSelectionToolbarPosition(
        [100, 100, 400, 300],
        viewport,
        { width: 300, height: 44 },
        { left: 600, right: 400 },
      ),
    ).toBeNull();
  });
});

describe("controlled toolbar tooltips", () => {
  const integration = { save: async () => true, open: async () => {} };
  it("shows tool name and shortcut on focus without a native title", async () => {
    await render(
      <Excalidraw
        desktopIntegration={{ ...integration, toolbarTooltips: true }}
      />,
    );
    const rectangle = screen.getByTestId("toolbar-rectangle");
    expect(rectangle).not.toHaveAttribute("title");
    fireEvent.focus(rectangle);
    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        "Rectangle — R or 2",
      ),
    );
    fireEvent.keyDown(rectangle, { key: "Escape" });
    expect(screen.getByRole("tooltip")).not.toHaveClass(
      "excalidraw-tooltip--visible",
    );
  });
  it("retains usable controls and shortcut semantics when tooltip preference is off", async () => {
    await render(
      <Excalidraw
        desktopIntegration={{ ...integration, toolbarTooltips: false }}
      />,
    );
    const rectangle = screen.getByTestId("toolbar-rectangle");
    expect(rectangle).not.toHaveAttribute("title");
    expect(rectangle).toHaveAttribute("aria-keyshortcuts", "R or 2");
    fireEvent.focus(rectangle);
    fireEvent.pointerEnter(rectangle);
    expect(
      screen
        .queryByRole("tooltip")
        ?.classList.contains("excalidraw-tooltip--visible"),
    ).toBeFalsy();
    fireEvent.click(rectangle);
    expect(window.h.state.activeTool.type).toBe("rectangle");
  });
});

describe("selection toolbar actions", () => {
  afterEach(() => restoreOriginalGetBoundingClientRect());
  beforeEach(() => {
    mockBoundingClientRect({ width: 1600, height: 1000 });
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const original = HTMLDivElement.prototype.getBoundingClientRect;
    HTMLDivElement.prototype.getBoundingClientRect = function () {
      const rect = original.call(this);
      return this.classList.contains("selection-toolbar")
        ? { ...rect, width: 280, height: 44 }
        : rect;
    };
  });

  it("uses existing actions and hides while dragging or editing text", async () => {
    await render(
      <Excalidraw
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          selectionToolbar: true,
        }}
      />,
    );
    vi.spyOn(window.h.app.viewport, "getOffsets").mockReturnValue({
      top: 76,
      bottom: 56,
      left: 16,
      right: 16,
    });
    const rectangle = API.createElement({
      type: "rectangle",
      x: 300,
      y: 300,
      width: 100,
      height: 100,
    });
    const text = API.createElement({
      type: "text",
      text: "Editor",
      x: 600,
      y: 300,
    });
    API.setElements([rectangle, text]);
    API.setSelectedElements([rectangle]);
    const toolbar = screen.getByRole("toolbar", { name: "Actions" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Duplicate" }));
    expect(
      window.h.elements.filter((element) => !element.isDeleted),
    ).toHaveLength(3);
    API.setAppState({ selectedElementsAreBeingDragged: true });
    expect(screen.queryByRole("toolbar", { name: "Actions" })).toBeNull();
    API.setAppState({ selectedElementsAreBeingDragged: false });
    expect(screen.getByRole("toolbar", { name: "Actions" })).toBeVisible();
    API.setAppState({ editingTextElement: text });
    expect(screen.queryByRole("toolbar", { name: "Actions" })).toBeNull();
  });

  it("opens colors only at the clicked trigger and preserves keyboard access", async () => {
    await render(
      <Excalidraw
        handleKeyboardGlobally
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          selectionToolbar: true,
        }}
      />,
    );
    vi.spyOn(window.h.app.viewport, "getOffsets").mockReturnValue({
      top: 76,
      bottom: 56,
      left: 16,
      right: 16,
    });
    const rectangle = API.createElement({
      type: "rectangle",
      x: 500,
      y: 300,
      width: 100,
      height: 100,
    });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    const toolbar = screen.getByRole("toolbar", { name: "Actions" });
    const floatingTrigger = within(toolbar).getByRole("button", {
      name: "Stroke",
    });
    const sidebarTrigger = screen
      .getAllByRole("button", { name: "Stroke" })
      .find((button) => button !== floatingTrigger)!;
    const openPopups = () =>
      document.querySelectorAll("[data-radix-popper-content-wrapper]");

    fireEvent.click(floatingTrigger);
    expect(openPopups()).toHaveLength(1);
    expect(floatingTrigger).toHaveAttribute("aria-expanded", "true");
    expect(sidebarTrigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(sidebarTrigger);
    await waitFor(() => {
      expect(openPopups()).toHaveLength(1);
      expect(sidebarTrigger).toHaveAttribute("aria-expanded", "true");
      expect(floatingTrigger).toHaveAttribute("aria-expanded", "false");
    });
    fireEvent.click(sidebarTrigger);
    expect(openPopups()).toHaveLength(0);
    expect(window.h.state.openPopup).toBeNull();

    Keyboard.keyPress("s");
    await waitFor(() => expect(openPopups()).toHaveLength(1));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(openPopups()).toHaveLength(0));
  });

  it("renders floating property options inside the native property style scope", async () => {
    await render(
      <Excalidraw
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          selectionToolbar: true,
        }}
      />,
    );
    vi.spyOn(window.h.app.viewport, "getOffsets").mockReturnValue({
      top: 76,
      bottom: 56,
      left: 16,
      right: 16,
    });
    const line = API.createElement({
      type: "line",
      x: 500,
      y: 300,
      width: 100,
      height: 100,
    });
    API.setElements([line]);
    API.setSelectedElements([line]);
    const toolbar = screen.getByRole("toolbar", { name: "Actions" });
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Stroke width" }),
    );
    const popup = document.querySelector(".selection-toolbar-popover")!;
    expect(
      popup.querySelector(".selected-shape-actions fieldset"),
    ).not.toBeNull();
    fireEvent.click(
      within(popup as HTMLElement).getByTestId("strokeWidth-bold"),
    );
    expect(window.h.elements[0].strokeWidth).toBe(4);
  });
});
