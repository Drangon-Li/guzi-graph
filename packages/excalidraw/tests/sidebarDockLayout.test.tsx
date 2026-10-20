import { viewportCoordsToSceneCoords } from "@excalidraw/common";

import { Excalidraw, Sidebar } from "../index";
import { RIGHT_SIDEBAR_WIDTH } from "../components/App.viewport";

import { act, fireEvent, render, screen, waitFor } from "./test-utils";
import { API } from "./helpers/api";

import type { ExcalidrawProps } from "../types";

const { h } = window;
const dockWidth = RIGHT_SIDEBAR_WIDTH - 8;
let editorWidth = 1600;
let measuredDockWidth: number | null = null;
let resizeViewport: () => void;
let restoreBounds: () => void;

beforeEach(() => {
  editorWidth = 1600;
  measuredDockWidth = null;
  const boundsSpy = vi
    .spyOn(HTMLDivElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLDivElement) {
      const dock = this.classList.contains("excalidraw-canvas-surface")
        ? this.nextElementSibling
        : this.classList.contains("excalidraw-sidebar-dock")
        ? this
        : this.closest(".excalidraw-sidebar-dock");
      const openWidth =
        editorWidth === 0
          ? 0
          : measuredDockWidth ??
            (dock?.getAttribute("data-open") === "true" ? dockWidth : 0);
      if (this.classList.contains("excalidraw-container")) {
        return new DOMRect(150, 75, editorWidth, 900);
      }
      if (this.classList.contains("excalidraw-canvas-surface")) {
        return new DOMRect(150, 75, editorWidth - openWidth, 900);
      }
      if (dock) {
        return new DOMRect(150 + editorWidth - openWidth, 75, openWidth, 900);
      }
      return new DOMRect();
    });
  restoreBounds = () => boundsSpy.mockRestore();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        if (target.classList.contains("excalidraw-canvas-surface")) {
          resizeViewport = this.callback;
        }
      }
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  restoreBounds();
  vi.unstubAllGlobals();
});

const mount = async (
  desktop = true,
  initialData?: ExcalidrawProps["initialData"],
) => {
  const result = await render(
    <Excalidraw
      initialData={initialData}
      desktopIntegration={
        desktop ? { save: async () => true, open: async () => {} } : undefined
      }
    >
      <Sidebar name="custom">
        <Sidebar.Header />
        Dock content
      </Sidebar>
    </Excalidraw>,
  );
  act(resizeViewport);
  return result;
};

const getSceneCenter = () =>
  viewportCoordsToSceneCoords(
    {
      clientX: h.state.offsetLeft + h.state.width / 2,
      clientY: h.state.offsetTop + h.state.height / 2,
    },
    h.state,
  );

const expectSceneCenter = (center: ReturnType<typeof getSceneCenter>) => {
  const current = getSceneCenter();
  expect(current.x).toBeCloseTo(center.x, 10);
  expect(current.y).toBeCloseTo(center.y, 10);
};

it("reserves a real sibling dock and measures the reduced canvas without double-counting sidebar space", async () => {
  const { container } = await mount();
  expect(h.state.width).toBe(editorWidth);
  API.setAppState({
    scrollX: 35,
    scrollY: -10,
    zoom: { value: 1.5 as typeof h.state.zoom.value },
  });
  const centerBefore = getSceneCenter();
  const surface = container.querySelector(".excalidraw-canvas-surface")!;
  const dock = container.querySelector(".excalidraw-sidebar-dock")!;
  await act(async () => {
    h.app.api.toggleSidebar({ name: "custom" });
  });
  expect(dock).toHaveAttribute("data-open", "true");
  expect(dock.querySelector(".sidebar")).not.toBeNull();
  expect(surface.querySelector(".sidebar")).toBeNull();
  expect(dock.querySelector(".sidebar")).not.toHaveAttribute(
    "data-viewport-ui",
  );
  act(resizeViewport);
  expect(h.state.width).toBe(editorWidth - dockWidth);
  expect(h.state.offsetLeft).toBe(150);
  expect(h.state.offsetTop).toBe(75);
  expect(surface.querySelector("canvas.interactive")).toHaveStyle({
    width: `${editorWidth - dockWidth}px`,
  });
  expectSceneCenter(centerBefore);
  expect(h.state.scrollX).toBe(35 - dockWidth / (2 * 1.5));
  expect(h.state.scrollY).toBe(-10);
  expect(h.state.zoom.value).toBe(1.5);
  expect(
    h.app.viewport.getOffsets({ padding: 0, reserve: { sidebar: true } }).right,
  ).toBe(0);
  expect(h.app.viewport.getSidebarInsets()).toEqual({ left: 0, right: 0 });
  expect(surface.querySelector(".layer-ui__wrapper")).toHaveStyle({
    width: "calc(100% - 0px - 0px)",
  });

  fireEvent.click(screen.getByTestId("sidebar-close"));
  expect(dock).toHaveAttribute("data-open", "false");
  expect(container.querySelector(".excalidraw-container")).toHaveFocus();
  expect(dock).toHaveAttribute("inert");
  expect(dock.querySelector(".sidebar--closing")).not.toBeNull();
  act(resizeViewport);
  expect(h.state.width).toBe(editorWidth);
  expectSceneCenter(centerBefore);
  expect(h.state.scrollX).toBe(35);
  await waitFor(() => expect(dock.querySelector(".sidebar")).toBeNull());
});

it.each(["web", "phone"])(
  "keeps the sidebar as an overlay for %s",
  async (mode) => {
    if (mode === "phone") {
      editorWidth = 500;
    }
    const { container } = await mount(mode !== "web");
    await act(async () => {
      h.app.api.toggleSidebar({ name: "custom" });
    });
    act(resizeViewport);
    expect(container.querySelector(".excalidraw-sidebar-dock")).toHaveAttribute(
      "data-open",
      "false",
    );
    expect(
      container.querySelector(".excalidraw-canvas-surface .sidebar"),
    ).not.toBeNull();
    expect(h.state.width).toBe(editorWidth);
  },
);

it.each([0.5, 1, 1.5, 2.75])(
  "keeps a panned scene centered through animated dock cycles at zoom %s",
  async (zoom) => {
    await mount();
    API.setElements([
      API.createElement({ type: "rectangle", x: -220, y: 385 }),
    ]);
    const elements = h.elements;
    API.setAppState({
      scrollX: 438.75,
      scrollY: -192.5,
      zoom: { value: zoom as typeof h.state.zoom.value },
    });
    const centerBefore = getSceneCenter();
    for (let cycle = 0; cycle < 5; cycle++) {
      measuredDockWidth = 0;
      await act(async () => {
        h.app.api.toggleSidebar({ name: "custom" });
      });
      for (const width of [17.3, 83.45, 206.1, dockWidth]) {
        measuredDockWidth = width;
        act(resizeViewport);
        expectSceneCenter(centerBefore);
      }
      await act(async () => {
        h.app.api.toggleSidebar({ name: "custom", force: false });
      });
      for (const width of [221.4, 153.65, 41.2, 0]) {
        measuredDockWidth = width;
        act(resizeViewport);
        expectSceneCenter(centerBefore);
      }
      expect(h.state.scrollX).toBeCloseTo(438.75, 10);
      expect(h.state.scrollY).toBe(-192.5);
      expect(h.state.zoom.value).toBe(zoom);
      expect(h.elements).toEqual(elements);
    }
  },
);

it("uses the current camera when panning and zooming during the dock animation", async () => {
  await mount();
  measuredDockWidth = 0;
  await act(async () => {
    h.app.api.toggleSidebar({ name: "custom" });
  });
  measuredDockWidth = 80;
  act(resizeViewport);
  API.setAppState({
    scrollX: -275.3,
    scrollY: 85,
    zoom: { value: 1.7 as typeof h.state.zoom.value },
  });
  const centerAfterPan = getSceneCenter();
  for (const width of [160.2, dockWidth]) {
    measuredDockWidth = width;
    act(resizeViewport);
    expectSceneCenter(centerAfterPan);
  }
  await act(async () => {
    h.app.api.toggleSidebar({ name: "custom", force: false });
  });
  for (const width of [130.4, 0]) {
    measuredDockWidth = width;
    act(resizeViewport);
    expectSceneCenter(centerAfterPan);
  }
  expect(h.state.zoom.value).toBe(1.7);
});

it("does not compensate the camera for root resizes or a hidden editor", async () => {
  await mount();
  await act(async () => {
    h.app.api.toggleSidebar({ name: "custom" });
  });
  act(resizeViewport);
  const { scrollX, scrollY, zoom } = h.state;
  for (const width of [1400, 1800, 0, 1600]) {
    editorWidth = width;
    act(resizeViewport);
    expect(h.state.scrollX).toBe(scrollX);
    expect(h.state.scrollY).toBe(scrollY);
    expect(h.state.zoom).toEqual(zoom);
  }
});

it("preserves the restored camera while an initially open sidebar settles", async () => {
  measuredDockWidth = 0;
  await mount(true, {
    appState: {
      openSidebar: { name: "custom" },
      scrollX: 215,
      scrollY: -70,
      zoom: { value: 1.5 as typeof h.state.zoom.value },
    },
  });
  for (const width of [80.4, 190.2, dockWidth]) {
    measuredDockWidth = width;
    act(resizeViewport);
    expect(h.state.scrollX).toBe(215);
    expect(h.state.scrollY).toBe(-70);
    expect(h.state.zoom.value).toBe(1.5);
  }
  const centerBeforeClose = getSceneCenter();
  await act(async () => {
    h.app.api.toggleSidebar({ name: "custom", force: false });
  });
  measuredDockWidth = 0;
  act(resizeViewport);
  expectSceneCenter(centerBeforeClose);
});

it("uses the original root size for responsive decisions as the dock narrows the canvas", async () => {
  editorWidth = 1000;
  const { container } = await mount();
  const formFactor = h.app.editorInterface.formFactor;
  await act(async () => {
    h.app.api.toggleSidebar({ name: "custom" });
  });
  act(resizeViewport);
  act(resizeViewport);
  expect(h.state.width).toBe(editorWidth - dockWidth);
  expect(h.app.editorInterface.formFactor).toBe(formFactor);
  expect(h.app.editorInterface.formFactor).not.toBe("phone");
  expect(container.querySelector(".excalidraw-sidebar-dock")).toHaveAttribute(
    "data-open",
    "true",
  );
});
