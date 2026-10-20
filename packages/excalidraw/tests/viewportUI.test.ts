import { vi } from "vitest";

import { TEXT_VIEWPORT_PADDING } from "@excalidraw/common";

import { AppText } from "../components/App.text";
import { AppViewport } from "../components/App.viewport";

import type App from "../components/App";

const setup = () => {
  const container = document.createElement("div");
  const rect = (left: number, width: number) =>
    new DOMRect(left, 50, width, 800);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(100, 1000));
  const app = {
    state: { width: 1000, scrollY: 0, zoom: { value: 1 } },
    editorInterface: { formFactor: "desktop" },
    isDefaultUIEnabled: () => true,
  } as unknown as App;
  const dependencies = {
    getContainer: () => container,
    getStylesPanelMode: () => "compact" as const,
    isGestureActive: () => false,
  };
  const viewport = new AppViewport(app, dependencies);
  app.viewport = viewport;
  const text = new AppText(app, dependencies);
  const addPanel = (name: string, left: number, width: number) => {
    const panel = container.ownerDocument.createElement("div");
    panel.dataset.viewportUi = "side";
    panel.dataset.viewportUiName = name;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(rect(left, width));
    container.append(panel);
    return panel;
  };
  return { viewport, text, addPanel };
};

describe("tool dock viewport offsets", () => {
  it.each([
    [100, { left: 80, right: 0 }],
    [1020, { left: 0, right: 80 }],
  ])("measures a dock at %s for sidebar and text offsets", (left, insets) => {
    const { viewport, text, addPanel } = setup();
    addPanel("toolDock", left, 80);
    expect(viewport.getSidebarInsets()).toEqual(insets);
    expect(text.getTextViewportOffsets()).toEqual({
      top: TEXT_VIEWPORT_PADDING,
      bottom: TEXT_VIEWPORT_PADDING,
      left: insets.left + TEXT_VIEWPORT_PADDING,
      right: insets.right + TEXT_VIEWPORT_PADDING,
    });
  });

  it("measures the dock independently of the sidebar without reserving it", () => {
    const { viewport, addPanel } = setup();
    addPanel("sidebar", 800, 300);
    const dock = addPanel("toolDock", 100, 80);
    expect(viewport.getSidebarInsets()).toEqual({ left: 80, right: 300 });
    dock.remove();
    expect(viewport.getSidebarInsets()).toEqual({ left: 0, right: 300 });
    expect(
      viewport.getSideInsets(["toolDock"], { reserve: { sidebar: true } }),
    ).toEqual({ left: 0, right: 0 });
  });
});
