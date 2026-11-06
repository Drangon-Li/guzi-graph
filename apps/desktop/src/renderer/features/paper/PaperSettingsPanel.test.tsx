import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  GlobalTestState,
  render,
  screen,
  waitFor,
  within,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "../editor/SubcanvasEditor";

import {
  A4,
  createPaperPage,
  DEFAULT_PAPER_SETTINGS,
  getPaperPages,
  getPaperSettings,
  paperScene,
  PAPER_GAP,
} from "./paper";

import type { CanvasDocument } from "../workspace/workspace";

describe("paper settings panel", () => {
  let api: ExcalidrawImperativeAPI;
  const toggle = () => screen.getByRole("button", { name: "纸张设置" });
  const panel = () => within(screen.getByRole("dialog", { name: "纸张设置" }));
  const field = (name: string) => panel().getByRole("spinbutton", { name });
  const button = (name: string) => panel().getByRole("button", { name });
  const settings = () =>
    getPaperPages(api.getSceneElements()).map(getPaperSettings);
  const start = async (template: "blank" | "ruled" = "ruled") => {
    await render(
      <SubcanvasEditor
        document={{ title: "Paper" } as CanvasDocument}
        initialData={paperScene(
          [0, 1].flatMap((index) =>
            createPaperPage({
              ...A4,
              template,
              y: index * (A4.height + PAPER_GAP),
              name: String(index + 1),
            }),
          ),
        )}
        onExcalidrawAPI={(value) => {
          if (value) {
            api = value;
          }
        }}
      />,
    );
    await waitFor(() => expect(api.getAppState().isLoading).toBe(false));
  };

  it("applies one settings transaction to all ruled pages", async () => {
    await start();
    fireEvent.click(toggle());
    fireEvent.change(field("横线间距"), { target: { value: "44.5" } });
    fireEvent.change(field("默认字号"), { target: { value: "28" } });
    expect(settings()).toEqual(Array(2).fill(DEFAULT_PAPER_SETTINGS));
    fireEvent.click(button("应用"));

    expect(toggle()).toHaveFocus();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() =>
      expect(settings()).toEqual(
        Array(2).fill({ lineSpacing: 44.5, fontSize: 28 }),
      ),
    );
    act(() => api.history.undo!());
    expect(settings()).toEqual(Array(2).fill(DEFAULT_PAPER_SETTINGS));
  });

  it("discards invalid, restored, and dismissed drafts without consuming canvas input", async () => {
    await start();
    fireEvent.click(toggle());
    fireEvent.change(field("横线间距"), { target: { value: "100" } });
    expect(button("应用")).toBeDisabled();
    fireEvent.click(button("恢复默认"));
    expect(field("横线间距")).toHaveValue(DEFAULT_PAPER_SETTINGS.lineSpacing);
    fireEvent.change(field("默认字号"), { target: { value: "36" } });
    fireEvent.keyDown(field("默认字号"), { key: "Escape" });
    expect(toggle()).toHaveFocus();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle());
    expect(field("默认字号")).toHaveValue(DEFAULT_PAPER_SETTINGS.fontSize);
    fireEvent.change(field("默认字号"), { target: { value: "36" } });
    const canvas = GlobalTestState.interactiveCanvas;
    const onPointerDown = vi.fn((event: Event) =>
      expect(event.defaultPrevented).toBe(false),
    );
    canvas.addEventListener("pointerdown", onPointerDown, { once: true });
    fireEvent.pointerDown(canvas);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(toggle()).not.toHaveFocus();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(settings()).toEqual(Array(2).fill(DEFAULT_PAPER_SETTINGS));
  });

  it("disables changes in view mode", async () => {
    await start();
    act(() => API.setAppState({ viewModeEnabled: true }));
    fireEvent.click(toggle());
    expect(field("横线间距")).toHaveAttribute("readonly");
    expect(field("默认字号")).toHaveAttribute("readonly");
    expect(panel().queryByRole("button", { name: "应用" })).toBeNull();
    fireEvent.submit(screen.getByRole("dialog", { name: "纸张设置" }));
    expect(settings()).toEqual(Array(2).fill(DEFAULT_PAPER_SETTINGS));
  });

  it("hides settings when the document has no ruled pages", async () => {
    await start("blank");
    expect(screen.queryByRole("button", { name: "纸张设置" })).toBeNull();
  });
});
