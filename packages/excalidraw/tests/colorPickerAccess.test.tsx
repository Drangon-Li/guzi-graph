import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import {
  act,
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
  waitFor,
  within,
} from "./test-utils";

const { h } = window;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mockBoundingClientRect({ width: 1600, height: 1000 });
  localStorage.setItem("excalidraw.desktopUIMode", "compact");
});
afterEach(() => {
  vi.unstubAllGlobals();
  restoreOriginalGetBoundingClientRect();
  localStorage.removeItem("excalidraw.desktopUIMode");
});

it.each([
  ["Stroke", "elementStroke", "strokeColor"],
  ["Background", "elementBackground", "backgroundColor"],
] as const)(
  "shows saved %s shortcuts inside the compact palette and applies them",
  async (label, slot, property) => {
    await render(
      <Excalidraw
        langCode="en"
        UIOptions={{ getFormFactor: () => "tablet" }}
        desktopIntegration={{
          save: async () => true,
          open: async () => {},
          selectionToolbar: false,
        }}
      />,
    );
    act(() => h.app.refreshEditorInterface());
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([rectangle]);
    API.setSelectedElements([rectangle]);
    API.setAppState({
      colorTopPicks: {
        ...h.state.colorTopPicks,
        [slot]: ["#123456", "#abcdef"],
      },
    });
    const trigger = screen
      .getAllByRole("button", { name: label })
      .find((button) => button.hasAttribute("data-openpopup"))!;
    expect(
      trigger.querySelector(".color-picker__expand-indicator"),
    ).not.toBeNull();
    expect(
      trigger
        .closest(".color-picker-container")!
        .querySelector(".color-picker__top-picks"),
    ).toBeNull();
    fireEvent.click(trigger);
    const strip = document.querySelector<HTMLElement>(
      ".color-picker__compact-top-picks",
    )!;
    expect(within(strip).getAllByRole("button")).toHaveLength(2);
    expect(strip.closest(".properties-content")).not.toBeNull();
    fireEvent.click(within(strip).getByRole("button", { name: "#abcdef" }));
    await waitFor(() => expect(h.elements[0][property]).toBe("#abcdef"));
    expect(h.state.colorTopPicks[slot]).toEqual(["#123456", "#abcdef"]);
  },
);
