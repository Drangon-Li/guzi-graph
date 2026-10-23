import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";

import { KEYS, MIME_TYPES } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import {
  createPasteEvent,
  serializeAsClipboardJSON,
} from "@excalidraw/excalidraw/clipboard";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type {
  ExcalidrawImperativeAPI,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";

import { PresentationLayout } from "./PresentationLayout";
import { renderSlideSvg } from "./renderSlide";

import type { Presentation } from "./model";
import type { PresentationController } from "./control";

vi.mock("./renderSlide", () => ({ renderSlideSvg: vi.fn() }));

const PINNED_STORAGE_KEY = "guzi.presentation.filmstrip.pinned";

const makePresentation = (): Presentation => ({
  type: "guzi-presentation",
  version: 1,
  width: 1600,
  height: 900,
  slides: [
    { id: "first", title: "Introduction", scene: { elements: [] } },
    { id: "second", title: "Details", scene: { elements: [] } },
    { id: "third", title: "Summary", scene: { elements: [] } },
  ],
});

const svgFor = (title: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("data-preview-title", title);
  return svg;
};

const fireClipboard = (
  target: HTMLElement,
  type: "copy" | "paste",
  clipboardData: unknown,
) => {
  // The shared ClipboardEvent polyfill always constructs a paste event.
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  return fireEvent(target, event);
};

const firePointer = (
  target: HTMLElement,
  type: string,
  clientX: number,
  clientY = 50,
  metaKey = false,
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
    metaKey,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
};

const makeProps = () => ({
  presentation: makePresentation(),
  activeSlideId: "second",
  revision: 0,
  active: true,
  blocked: false,
  language: "en" as const,
  onSelect: vi.fn(),
  onAdd: vi.fn(),
  onCopy: vi.fn(() => "copied-slide"),
  onPaste: vi.fn(),
  onCanvasPaste: vi.fn(),
  onHistory: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onMove: vi.fn(),
  onExportPdf: vi.fn(),
  onFit: vi.fn(),
  onPresent: vi.fn(),
  beforePresent: vi.fn(),
  children: <div>Editor</div>,
});

beforeEach(() => {
  localStorage.removeItem(PINNED_STORAGE_KEY);
  vi.mocked(renderSlideSvg).mockImplementation(async (slide) =>
    svgFor(slide.title),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.removeItem(PINNED_STORAGE_KEY);
  Reflect.deleteProperty(document.documentElement, "requestFullscreen");
  Reflect.deleteProperty(document, "exitFullscreen");
  Reflect.deleteProperty(document, "fullscreenElement");
});

it("registers a controller whose results match the committed player and keyboard state", async () => {
  const props = makeProps();
  let controller!: PresentationController;
  const onController = vi.fn((value: PresentationController | null) => {
    if (value) {
      controller = value;
    }
  });
  const { unmount } = render(
    <PresentationLayout {...props} onController={onController} />,
  );
  expect(await controller.execute({ action: "status" })).toEqual({
    presenting: false,
    slideId: "second",
    index: 1,
    slideCount: 3,
    fullscreen: false,
  });
  let result;
  await act(async () => {
    result = await controller.execute({ action: "start" });
  });
  expect(result).toMatchObject({
    presenting: true,
    slideId: "second",
    index: 1,
  });
  const player = screen.getByRole("dialog", { name: "Slide show" });
  expect(within(player).getByText("2 / 3")).toBeInTheDocument();
  fireEvent.keyDown(player, { key: "Home" });
  expect(await controller.execute({ action: "status" })).toMatchObject({
    slideId: "first",
    index: 0,
  });
  await act(async () => {
    result = await controller.execute({ action: "next" });
  });
  expect(result).toMatchObject({ slideId: "second", index: 1 });
  expect(within(player).getByText("2 / 3")).toBeInTheDocument();
  await act(async () => {
    result = await controller.execute({ action: "goto", slideId: "third" });
  });
  expect(result).toMatchObject({ slideId: "third", index: 2 });
  expect(within(player).getByText("3 / 3")).toBeInTheDocument();
  await act(async () => {
    result = await controller.execute({ action: "next" });
    expect(result).toMatchObject({ index: 2 });
    result = await controller.execute({ action: "previous" });
  });
  expect(result).toMatchObject({ slideId: "second", index: 1 });
  await expect(controller.execute({ action: "goto" })).rejects.toThrow();
  await expect(
    controller.execute({ action: "goto", slideId: "missing" }),
  ).rejects.toThrow();
  fireEvent.keyDown(player, { key: "Escape" });
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
  });
  expect(props.presentation).toEqual(makePresentation());
  expect(props.onSelect).not.toHaveBeenCalled();
  unmount();
  expect(onController).toHaveBeenLastCalledWith(null);
  await expect(controller.execute({ action: "status" })).rejects.toThrow();
});

it.each([{ blocked: true }, { active: false }])(
  "rejects controls while unavailable but allows status and stop: %j",
  async (state) => {
    const props = makeProps();
    let controller!: PresentationController;
    const onController = (value: PresentationController | null) => {
      if (value) {
        controller = value;
      }
    };
    const { rerender } = render(
      <PresentationLayout {...props} onController={onController} />,
    );
    await expect(controller.execute({ action: "next" })).rejects.toThrow();
    await act(async () => {
      await controller.execute({ action: "start", slideId: "first" });
    });
    expect(
      within(screen.getByRole("dialog")).getByText("1 / 3"),
    ).toBeInTheDocument();
    rerender(
      <PresentationLayout {...props} {...state} onController={onController} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    for (const action of ["start", "next", "previous", "goto"] as const) {
      await expect(
        controller.execute({ action, slideId: "first" }),
      ).rejects.toThrow();
    }
    expect(await controller.execute({ action: "status" })).toMatchObject({
      presenting: false,
    });
    await act(async () => {
      expect(await controller.execute({ action: "stop" })).toMatchObject({
        presenting: false,
      });
    });
  },
);

it("waits for actual fullscreen entry and exit before resolving controller commands", async () => {
  let controller!: PresentationController;
  let fullscreenElement: Element | null = null;
  let enter!: () => void;
  let leave!: () => void;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          enter = () => {
            fullscreenElement = document.documentElement;
            resolve();
          };
        }),
    ),
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          leave = () => {
            fullscreenElement = null;
            resolve();
          };
        }),
    ),
  });
  render(
    <PresentationLayout
      {...makeProps()}
      onController={(value) => {
        if (value) {
          controller = value;
        }
      }}
    />,
  );
  let finished = false;
  let starting!: ReturnType<PresentationController["execute"]>;
  await act(async () => {
    starting = controller
      .execute({ action: "start", slideId: "first" })
      .then((state) => {
        finished = true;
        return state;
      });
    await Promise.resolve();
  });
  expect(finished).toBe(false);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(async () => {
    enter();
    await starting;
  });
  expect(await starting).toMatchObject({
    presenting: true,
    slideId: "first",
    fullscreen: true,
  });
  let stopping!: ReturnType<PresentationController["execute"]>;
  finished = false;
  await act(async () => {
    stopping = controller.execute({ action: "stop" }).then((state) => {
      finished = true;
      return state;
    });
    await Promise.resolve();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(finished).toBe(false);
  await act(async () => {
    leave();
    await stopping;
  });
  expect(await stopping).toMatchObject({
    presenting: false,
    fullscreen: false,
  });
});

it("reports windowed presentation after fullscreen rejection", async () => {
  let controller!: PresentationController;
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn().mockRejectedValue(new Error("Denied")),
  });
  render(
    <PresentationLayout
      {...makeProps()}
      onController={(value) => {
        if (value) {
          controller = value;
        }
      }}
    />,
  );
  await act(async () => {
    expect(await controller.execute({ action: "start" })).toMatchObject({
      presenting: true,
      fullscreen: false,
    });
  });
  expect(
    screen.getByText("Fullscreen unavailable. Presenting in this window."),
  ).toBeInTheDocument();
});

it("returns a usable player after a pending fullscreen request and cleans up late entry after stop", async () => {
  vi.useFakeTimers();
  let controller!: PresentationController;
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn(() => new Promise<void>(() => {})),
  });
  const exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: exitFullscreen,
  });
  render(
    <PresentationLayout
      {...makeProps()}
      onController={(value) => {
        if (value) {
          controller = value;
        }
      }}
    />,
  );
  let starting!: ReturnType<PresentationController["execute"]>;
  await act(async () => {
    starting = controller.execute({ action: "start", slideId: "first" });
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(await starting).toMatchObject({
    presenting: true,
    slideId: "first",
    fullscreen: false,
  });
  const player = screen.getByRole("dialog", { name: "Slide show" });
  fireEvent.keyDown(player, { key: "ArrowRight" });
  expect(within(player).getByText("2 / 3")).toBeInTheDocument();
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: true,
    slideId: "second",
    fullscreen: false,
  });
  await act(async () => {
    expect(await controller.execute({ action: "next" })).toMatchObject({
      slideId: "third",
    });
    expect(await controller.execute({ action: "stop" })).toMatchObject({
      presenting: false,
      fullscreen: false,
    });
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fullscreenElement = document.documentElement;
  fireEvent(document, new Event("fullscreenchange"));
  expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
    fullscreen: false,
  });
});

it("accepts a real fullscreen event even when its request promise never settles", async () => {
  vi.useFakeTimers();
  let controller!: PresentationController;
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn(() => new Promise<void>(() => {})),
  });
  render(
    <PresentationLayout
      {...makeProps()}
      onController={(value) => {
        if (value) {
          controller = value;
        }
      }}
    />,
  );
  let starting!: ReturnType<PresentationController["execute"]>;
  await act(async () => {
    starting = controller.execute({ action: "start" });
    fullscreenElement = document.documentElement;
    fireEvent(document, new Event("fullscreenchange"));
    await starting;
  });
  expect(await starting).toMatchObject({ presenting: true, fullscreen: true });
  fullscreenElement = null;
  fireEvent(document, new Event("fullscreenchange"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
    fullscreen: false,
  });
});

it("bounds a pending fullscreen exit and keeps status responsive until the native exit arrives", async () => {
  vi.useFakeTimers();
  let controller!: PresentationController;
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn(async () => {
      fullscreenElement = document.documentElement;
    }),
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: vi.fn(() => new Promise<void>(() => {})),
  });
  render(
    <PresentationLayout
      {...makeProps()}
      onController={(value) => {
        if (value) {
          controller = value;
        }
      }}
    />,
  );
  await act(async () => {
    await controller.execute({ action: "start" });
  });
  await act(async () => {
    const stopping = controller.execute({ action: "stop" });
    const rejection = expect(stopping).rejects.toThrow("无法退出演示全屏");
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
    fullscreen: true,
  });
  fullscreenElement = null;
  fireEvent(document, new Event("fullscreenchange"));
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
    fullscreen: false,
  });
  await act(async () => {
    expect(await controller.execute({ action: "stop" })).toMatchObject({
      presenting: false,
      fullscreen: false,
    });
  });
});

it("tracks native fullscreen exit and rejects a failed controller fullscreen exit", async () => {
  let controller!: PresentationController;
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn(async () => {
      fullscreenElement = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    }),
  });
  const exitFullscreen = vi.fn().mockRejectedValue(new Error("Exit failed"));
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: exitFullscreen,
  });
  render(
    <PresentationLayout
      {...makeProps()}
      onController={(value) => {
        if (value) {
          controller = value;
        }
      }}
    />,
  );
  await act(async () => {
    await controller.execute({ action: "start" });
  });
  fireEvent(document, new Event("fullscreenchange"));
  fullscreenElement = null;
  fireEvent(document, new Event("fullscreenchange"));
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
    fullscreen: false,
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => {
    await controller.execute({ action: "start" });
  });
  await act(async () => {
    await expect(controller.execute({ action: "stop" })).rejects.toThrow(
      "无法退出演示全屏",
    );
  });
  expect(await controller.execute({ action: "status" })).toMatchObject({
    presenting: false,
    fullscreen: true,
  });
});

it("focuses the new slide after adding it from the strip header", () => {
  const props = makeProps();
  const { rerender } = render(<PresentationLayout {...props} />);
  const initialItems = screen.getAllByRole("listitem");
  for (const item of initialItems) {
    expect(item).not.toHaveClass("is-new");
  }

  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  expect(props.onAdd).toHaveBeenCalledTimes(1);
  const presentation: Presentation = {
    ...props.presentation,
    slides: [
      ...props.presentation.slides,
      { id: "new", title: "New slide", scene: { elements: [] } },
    ],
  };
  rerender(
    <PresentationLayout
      {...props}
      presentation={presentation}
      activeSlideId="new"
    />,
  );
  const newSlide = screen.getByRole("button", {
    name: "Select slide 4: New slide",
  });
  expect(newSlide).toHaveFocus();
  expect(newSlide.closest("li")).toHaveClass("is-new");
  expect(screen.getAllByRole("listitem").slice(0, 3)).toEqual(initialItems);

  rerender(
    <PresentationLayout
      {...props}
      presentation={presentation}
      activeSlideId="new"
      revision={1}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Select slide 4: New slide" }),
  ).toBe(newSlide);
  expect(newSlide).toHaveFocus();
});

it("keeps thumbnails compact and provides rename and delete in the context menu", () => {
  const props = makeProps();
  const { rerender } = render(<PresentationLayout {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
  expect(props.onAdd).toHaveBeenCalledTimes(1);
  for (const item of screen.getAllByRole("listitem")) {
    expect(within(item).getAllByRole("button")).toHaveLength(2);
  }

  const second = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  fireEvent.contextMenu(second, { clientX: 50, clientY: 100 });
  expect(props.onSelect).toHaveBeenCalledWith("second");
  expect(
    screen.getByRole("menu", { name: "Slide actions" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "Slide title" });
  expect(input).toHaveFocus();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "  New title  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onRename).toHaveBeenCalledTimes(1);
  expect(props.onRename).toHaveBeenCalledWith("second", "New title");
  expect(second).toHaveFocus();
  fireEvent.contextMenu(second);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Cancelled" },
  });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(props.onRename).toHaveBeenCalledTimes(1);
  expect(second).toHaveFocus();

  fireEvent.contextMenu(second);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(second).toHaveFocus();
  fireEvent.contextMenu(second);
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(props.onDelete).toHaveBeenCalledWith("second");

  rerender(
    <PresentationLayout
      {...props}
      activeSlideId="first"
      presentation={{
        ...props.presentation,
        slides: [props.presentation.slides[0]],
      }}
    />,
  );
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Select slide 1: Introduction" }),
  );
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
});

it("offers creation and presentation on the blank strip while retaining page actions on thumbnails", () => {
  const props = makeProps();
  render(<PresentationLayout {...props} />);
  const strip = screen.getByRole("complementary", { name: "Slides" });
  expect(strip).toHaveClass("desktop-presentation-filmstrip");
  expect(strip.parentElement).toHaveClass("desktop-presentation-dock");
  fireEvent.contextMenu(strip, { clientX: 350, clientY: 100 });
  const blankMenu = screen.getByRole("menu", { name: "Slide actions" });
  expect(within(blankMenu).getAllByRole("menuitem")).toHaveLength(2);
  expect(
    within(blankMenu).queryByRole("menuitem", { name: "Rename" }),
  ).not.toBeInTheDocument();
  expect(
    within(blankMenu).queryByRole("menuitem", { name: "Delete" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(blankMenu).getByRole("menuitem", { name: "New slide" }),
  );
  expect(props.onAdd).toHaveBeenCalledTimes(1);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onRename).not.toHaveBeenCalled();
  expect(props.onDelete).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Add slide" })).toHaveFocus();

  fireEvent.contextMenu(strip);
  fireEvent.click(screen.getByRole("menuitem", { name: "Present from start" }));
  const player = screen.getByRole("dialog", { name: "Slide show" });
  expect(within(player).getByText("1 / 3")).toBeInTheDocument();
  expect(props.beforePresent).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(player, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Add slide" })).toHaveFocus();

  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Select slide 2: Details" }),
  );
  const pageMenu = screen.getByRole("menu", { name: "Slide actions" });
  expect(
    within(pageMenu).getByRole("menuitem", { name: "Rename" }),
  ).toBeEnabled();
  expect(
    within(pageMenu).getByRole("menuitem", { name: "Delete" }),
  ).toBeEnabled();
  expect(
    within(pageMenu).getByRole("menuitem", { name: "New slide" }),
  ).toBeEnabled();
  expect(
    within(pageMenu).queryByRole("menuitem", { name: "Present from start" }),
  ).not.toBeInTheDocument();
  expect(props.onSelect).toHaveBeenCalledWith("second");
});

it("automatically hides the unpinned strip and preserves access during menus and renaming", () => {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector,
  ) {
    return selector === ":focus-visible" ? false : matches.call(this, selector);
  });
  const props = makeProps();
  render(<PresentationLayout {...props} />);
  const strip = screen.getByRole("complementary", { name: "Slides" });
  const reveal = screen.getByRole("button", { name: "Slide strip" });
  const list = screen.getByRole("list");
  const pin = screen.getByRole("button", { name: "Pin slide strip" });
  expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(reveal).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(pin);
  expect(pin).toHaveAttribute("aria-pressed", "false");
  expect(reveal).toHaveAttribute("aria-expanded", "false");
  expect(list).toHaveAttribute("aria-hidden", "true");
  expect(list).toHaveAttribute("inert");
  expect(screen.queryByRole("list")).not.toBeInTheDocument();

  fireEvent.pointerEnter(strip);
  expect(reveal).toHaveAttribute("aria-expanded", "true");
  expect(list).not.toHaveAttribute("inert");
  fireEvent.pointerLeave(strip);
  expect(reveal).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(reveal);
  expect(reveal).toHaveAttribute("aria-expanded", "true");

  const second = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  fireEvent.contextMenu(second);
  fireEvent.pointerLeave(strip);
  expect(reveal).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "Slide title" });
  expect(input).toHaveFocus();
  expect(reveal).toHaveAttribute("aria-expanded", "true");
  fireEvent.change(input, { target: { value: "Renamed while unpinned" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onRename).toHaveBeenCalledWith(
    "second",
    "Renamed while unpinned",
  );
  expect(reveal).toHaveAttribute("aria-expanded", "false");

  fireEvent.contextMenu(strip);
  expect(reveal).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "New slide" }), {
    key: "Escape",
  });
  expect(screen.getByRole("button", { name: "Add slide" })).toHaveFocus();
  expect(reveal).toHaveAttribute("aria-expanded", "false");
});

it("keeps the unpinned strip expanded for keyboard focus until focus leaves", () => {
  localStorage.setItem(PINNED_STORAGE_KEY, "false");
  render(<PresentationLayout {...makeProps()} />);
  const strip = screen.getByRole("complementary", { name: "Slides" });
  const reveal = screen.getByRole("button", { name: "Slide strip" });
  vi.spyOn(reveal, "matches").mockImplementation(
    (selector) => selector === ":focus-visible",
  );
  fireEvent.focus(reveal);
  fireEvent.pointerLeave(strip);
  expect(reveal).toHaveAttribute("aria-expanded", "true");
  fireEvent.pointerDown(reveal);
  expect(reveal).toHaveAttribute("aria-expanded", "false");
  fireEvent.focus(reveal);
  fireEvent.blur(reveal, {
    relatedTarget: screen.getByRole("button", { name: "Fit page" }),
  });
  expect(reveal).toHaveAttribute("aria-expanded", "false");
});

it("remembers pinning locally without changing presentation content", () => {
  const props = makeProps();
  const { unmount } = render(<PresentationLayout {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Pin slide strip" }));
  expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe("false");
  unmount();
  render(<PresentationLayout {...props} />);
  const pin = screen.getByRole("button", { name: "Pin slide strip" });
  expect(pin).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "Slide strip" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  fireEvent.click(pin);
  expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBe("true");
  expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(props.presentation).toEqual(makePresentation());
  expect(props.onAdd).not.toHaveBeenCalled();
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onRename).not.toHaveBeenCalled();
  expect(props.onDelete).not.toHaveBeenCalled();
  expect(props.onMove).not.toHaveBeenCalled();
});

it("uses native clipboard events only for focused thumbnails, leaving title and canvas editing alone", () => {
  const props = makeProps();
  const backgroundCopy = vi.fn();
  const backgroundPaste = vi.fn();
  render(
    <div onCopy={backgroundCopy} onPaste={backgroundPaste}>
      <PresentationLayout {...props} />
    </div>,
  );
  const second = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  const clipboardData = {
    setData: vi.fn(),
    getData: vi.fn(() => JSON.stringify(props.presentation)),
  };
  second.focus();
  expect(fireClipboard(second, "copy", clipboardData)).toBe(false);
  expect(props.onCopy).toHaveBeenCalledWith("second");
  expect(clipboardData.setData).toHaveBeenCalledWith(
    "text/plain",
    "copied-slide",
  );
  expect(fireClipboard(second, "paste", clipboardData)).toBe(false);
  expect(props.onPaste).toHaveBeenCalledWith(
    JSON.stringify(props.presentation),
  );
  expect(backgroundCopy).not.toHaveBeenCalled();
  expect(backgroundPaste).not.toHaveBeenCalled();

  fireEvent.contextMenu(second);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox");
  expect(fireClipboard(input, "copy", clipboardData)).toBe(true);
  expect(fireClipboard(input, "paste", clipboardData)).toBe(true);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(props.onDelete).not.toHaveBeenCalled();
  expect(backgroundCopy).toHaveBeenCalledTimes(1);
  expect(backgroundPaste).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(fireClipboard(screen.getByText("Editor"), "copy", clipboardData)).toBe(
    true,
  );
  expect(
    fireClipboard(screen.getByText("Editor"), "paste", clipboardData),
  ).toBe(true);
  expect(props.onCopy).toHaveBeenCalledTimes(1);
  expect(props.onPaste).toHaveBeenCalledTimes(1);
});

it("keeps the thumbnail focused when copying commits canvas editing", () => {
  const props = makeProps();
  props.children = <div tabIndex={0}>Editor</div>;
  props.onCopy.mockImplementation(() => {
    screen.getByText("Editor").focus();
    return "copied-slide";
  });
  render(<PresentationLayout {...props} />);
  const thumbnail = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  thumbnail.focus();
  const clipboardData = { setData: vi.fn() };
  fireClipboard(document.activeElement as HTMLElement, "copy", clipboardData);
  expect(thumbnail).toHaveFocus();
  expect(clipboardData.setData).toHaveBeenCalledWith(
    "text/plain",
    "copied-slide",
  );
});

it("pastes copied canvas elements in place after selecting another thumbnail", async () => {
  const props = makeProps();
  const rectangle = API.createElement({
    type: "rectangle",
    x: 113.25,
    y: 79.5,
    width: 91,
    height: 63,
  });
  props.presentation.slides[0].scene = { elements: [rectangle] };
  let api!: ExcalidrawImperativeAPI;
  const Harness = () => {
    const [activeSlideId, select] = useState("first");
    return (
      <PresentationLayout
        {...props}
        activeSlideId={activeSlideId}
        onSelect={select}
        onCanvasPaste={(event) => api.pasteFromClipboard(event)}
      >
        <Excalidraw
          key={activeSlideId}
          autoFocus={false}
          handleKeyboardGlobally
          onExcalidrawAPI={(value) => {
            if (value) {
              api = value;
            }
          }}
          initialData={
            props.presentation.slides.find(
              (slide) => slide.id === activeSlideId,
            )!.scene
          }
          desktopIntegration={{
            open: async () => {},
            save: async () => true,
            elementPastePosition: "original",
          }}
        />
      </PresentationLayout>
    );
  };
  render(<Harness />);
  await waitFor(() => expect(api?.getAppState().isLoading).toBe(false));
  const sourceApi = api;
  const content = serializeAsClipboardJSON({
    elements: sourceApi.getSceneElements(),
    files: null,
  });
  const second = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  second.focus();
  fireEvent.click(second);
  await waitFor(() => {
    expect(api).not.toBe(sourceApi);
    expect(api.getAppState().isLoading).toBe(false);
  });
  act(() =>
    api.updateScene({
      appState: {
        scrollX: 451,
        scrollY: -321,
        zoom: { value: 0.5 as NormalizedZoomValue },
        gridModeEnabled: true,
        gridSize: 20,
      },
    }),
  );
  expect(second).toHaveFocus();
  const elementFromPoint = document.elementFromPoint;
  document.elementFromPoint = vi.fn(() => second);
  try {
    fireEvent(
      second,
      createPasteEvent({
        types: {
          [MIME_TYPES.excalidrawClipboard]: content,
          [MIME_TYPES.text]: content,
        },
      }),
    );
    await waitFor(() => expect(api.getSceneElements()).toHaveLength(1));
    expect(api.getSceneElements()[0]).toMatchObject({
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
    });
    expect(api.getSceneElements()[0].id).not.toBe(rectangle.id);
    expect(props.onPaste).not.toHaveBeenCalled();
    expect(props.presentation.slides).toHaveLength(3);
  } finally {
    document.elementFromPoint = elementFromPoint;
  }
});

it("moves thumbnail focus to the selected page and supports deletion without deleting the last page", () => {
  const props = makeProps();
  const { rerender } = render(<PresentationLayout {...props} />);
  screen.getByRole("button", { name: "Select slide 2: Details" }).focus();
  rerender(<PresentationLayout {...props} activeSlideId="third" />);
  const third = screen.getByRole("button", { name: "Select slide 3: Summary" });
  expect(third).toHaveFocus();
  fireEvent.keyDown(third, { key: "Backspace" });
  expect(props.onDelete).toHaveBeenCalledWith("third");
  rerender(
    <PresentationLayout
      {...props}
      activeSlideId="first"
      presentation={{
        ...props.presentation,
        slides: [props.presentation.slides[0]],
      }}
    />,
  );
  const first = screen.getByRole("button", {
    name: "Select slide 1: Introduction",
  });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "Delete" });
  expect(props.onDelete).toHaveBeenCalledTimes(1);
});

it.each([
  { key: "z", code: "KeyZ", shiftKey: false, direction: "undo" },
  { key: "z", code: "KeyZ", shiftKey: true, direction: "redo" },
  { key: "y", code: "KeyY", shiftKey: false, direction: "redo" },
  { key: "я", code: "KeyZ", shiftKey: false, direction: "undo" },
])("routes thumbnail history shortcuts to the deck: %o", (shortcut) => {
  const props = makeProps();
  const onKeyDown = vi.fn();
  render(
    <div onKeyDown={onKeyDown}>
      <PresentationLayout {...props} />
    </div>,
  );
  const thumbnail = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  thumbnail.focus();
  expect(
    fireEvent.keyDown(thumbnail, {
      ...shortcut,
      [KEYS.CTRL_OR_CMD]: true,
    }),
  ).toBe(false);
  expect(props.onHistory).toHaveBeenCalledTimes(1);
  expect(props.onHistory).toHaveBeenCalledWith(shortcut.direction);
  expect(onKeyDown).not.toHaveBeenCalled();
});

it("leaves title input undo and composing shortcuts to their editor", () => {
  const props = makeProps();
  render(<PresentationLayout {...props} />);
  const thumbnail = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  thumbnail.focus();
  fireEvent.keyDown(thumbnail, {
    key: "z",
    [KEYS.CTRL_OR_CMD]: true,
    isComposing: true,
  });
  fireEvent.contextMenu(thumbnail);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox");
  expect(input).toHaveFocus();
  expect(fireEvent.keyDown(input, { key: "z", [KEYS.CTRL_OR_CMD]: true })).toBe(
    true,
  );
  expect(props.onHistory).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(thumbnail).toHaveFocus();
});

it.each([{ blocked: true }, { active: false }])(
  "does not reopen a slide context menu after recovering from %j",
  (state) => {
    const props = makeProps();
    const { rerender } = render(<PresentationLayout {...props} />);
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Select slide 2: Details" }),
    );
    expect(
      screen.getByRole("menu", { name: "Slide actions" }),
    ).toBeInTheDocument();
    rerender(<PresentationLayout {...props} {...state} />);
    expect(
      screen.queryByRole("menu", { name: "Slide actions" }),
    ).not.toBeInTheDocument();
    rerender(<PresentationLayout {...props} />);
    expect(
      screen.queryByRole("menu", { name: "Slide actions" }),
    ).not.toBeInTheDocument();
  },
);

it("does not handle page operations while inactive or blocked", () => {
  const props = makeProps();
  const { rerender } = render(<PresentationLayout {...props} blocked />);
  const second = screen.getByRole("button", {
    name: "Select slide 2: Details",
  });
  const clipboardData = {
    setData: vi.fn(),
    getData: vi.fn(() => "copied-slide"),
  };
  for (const state of [{ blocked: true }, { active: false }]) {
    rerender(<PresentationLayout {...props} {...state} />);
    fireEvent.contextMenu(
      screen.getByRole("complementary", { name: "Slides" }),
    );
    fireEvent.contextMenu(second);
    fireClipboard(second, "copy", clipboardData);
    fireClipboard(second, "paste", clipboardData);
    fireEvent.keyDown(second, { key: "Delete" });
    fireEvent.keyDown(second, { key: "z", [KEYS.CTRL_OR_CMD]: true });
    fireEvent.click(second);
    fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin slide strip" }));
    fireEvent.click(screen.getByRole("button", { name: "Slide strip" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  }
  expect(props.onCopy).not.toHaveBeenCalled();
  expect(props.onPaste).not.toHaveBeenCalled();
  expect(props.onDelete).not.toHaveBeenCalled();
  expect(props.onHistory).not.toHaveBeenCalled();
  expect(props.onAdd).not.toHaveBeenCalled();
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(localStorage.getItem(PINNED_STORAGE_KEY)).toBeNull();
});

it("follows the pointer with the existing thumbnail and reorders slides at the destination", async () => {
  const props = makeProps();
  render(<PresentationLayout {...props} />);
  const items = screen.getAllByRole("listitem");
  const list = screen.getByRole("list");
  const rect = (left: number, width: number) => ({
    x: left,
    y: 0,
    top: 0,
    left,
    right: left + width,
    bottom: 200,
    width,
    height: 200,
    toJSON: () => ({}),
  });
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 300));
  items.forEach((item, index) => {
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
      rect(index * 100, 100),
    );
  });
  const thumbnail = within(items[2]).getByRole("button", {
    name: "Select slide 3: Summary",
  });
  const title = within(items[2]).getByRole("button", { name: "Summary" });
  await waitFor(() =>
    expect(thumbnail.querySelector("svg")).toHaveAttribute(
      "data-preview-title",
      "Summary",
    ),
  );
  const preview = document.querySelector<HTMLElement>(
    ".desktop-slide-drag-preview",
  )!;
  expect(preview).toHaveAttribute("aria-hidden", "true");
  expect(preview).toHaveAttribute("inert");
  expect(preview).not.toBeVisible();
  vi.mocked(renderSlideSvg).mockClear();
  for (const target of [thumbnail, title]) {
    Object.assign(target, { setPointerCapture: vi.fn() });
    firePointer(target, "pointerdown", 250);
    expect(preview).not.toBeVisible();
    expect(items[2]).not.toHaveClass("is-dragging");
    firePointer(target, "pointermove", 50);
    expect(preview).toBeVisible();
    expect(preview.querySelector("svg")).toHaveAttribute(
      "data-preview-title",
      "Summary",
    );
    expect(preview.querySelector("svg")).not.toBe(
      thumbnail.querySelector("svg"),
    );
    expect(preview).toHaveTextContent("Summary");
    expect(preview.style.transform).toBe("translate3d(0px, -6px, 0)");
    expect(items[2]).toHaveClass("is-dragging");
    firePointer(target, "pointermove", 60, 80);
    expect(preview.style.transform).toBe("translate3d(10px, 24px, 0)");
    expect(items[0]).toHaveClass("is-drop-target");
    firePointer(target, "pointerup", 50);
    const focusBeforeClick = document.activeElement;
    fireEvent.click(target);
    expect(document.activeElement).toBe(focusBeforeClick);
    expect(items[0]).not.toHaveClass("is-drop-target");
    expect(items[2]).not.toHaveClass("is-dragging");
    expect(preview).not.toBeVisible();
    expect(preview).toBeEmptyDOMElement();
  }
  expect(props.onMove.mock.calls).toEqual([
    ["third", 0],
    ["third", 0],
  ]);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(renderSlideSvg).not.toHaveBeenCalled();

  list.scrollLeft = 32;
  firePointer(thumbnail, "pointerdown", 250);
  firePointer(thumbnail, "pointermove", 10);
  expect(list.scrollLeft).toBe(16);
  firePointer(thumbnail, "pointermove", 290);
  expect(list.scrollLeft).toBe(32);
  expect(list.scrollTop).toBe(0);
  firePointer(thumbnail, "pointercancel", 290);

  firePointer(thumbnail, "pointerdown", 250);
  firePointer(thumbnail, "pointermove", 251);
  expect(preview).not.toBeVisible();
  expect(items[2]).not.toHaveClass("is-dragging");
  firePointer(thumbnail, "pointerup", 251);
  fireEvent.click(thumbnail);
  expect(props.onSelect).toHaveBeenCalledWith("third");

  firePointer(thumbnail, "pointerdown", 250);
  firePointer(thumbnail, "pointermove", 50);
  firePointer(thumbnail, "pointercancel", 50);
  firePointer(thumbnail, "pointerup", 50);
  expect(items[0]).not.toHaveClass("is-drop-target");

  firePointer(thumbnail, "pointerdown", 250);
  firePointer(thumbnail, "pointermove", 50, 500);
  firePointer(thumbnail, "pointerup", 50, 500);
  expect(props.onMove).toHaveBeenCalledTimes(2);

  const first = within(items[0]).getByRole("button", {
    name: "Select slide 1: Introduction",
  });
  Object.assign(first, { setPointerCapture: vi.fn() });
  firePointer(first, "pointerdown", 50, 50, true);
  firePointer(first, "pointermove", 250, 50, true);
  expect(preview).toBeVisible();
  expect(items[0]).toHaveClass("is-dragging");
  expect(items[2]).toHaveClass("is-drop-target", "is-drop-after");
  firePointer(first, "pointerup", 250, 50, true);
  expect(props.onMove).toHaveBeenLastCalledWith("first", 2);
  expect(items[2]).not.toHaveClass("is-drop-target", "is-drop-after");
  expect(preview).not.toBeVisible();
});

it.each([
  "pointercancel",
  "lostpointercapture",
  "blocked",
  "inactive",
  "escape",
  "blur",
])("cleans up the drag preview when %s interrupts dragging", (interruption) => {
  const props = makeProps();
  const { rerender } = render(<PresentationLayout {...props} />);
  const items = screen.getAllByRole("listitem");
  const thumbnail = within(items[0]).getByRole("button", {
    name: "Select slide 1: Introduction",
  });
  Object.assign(thumbnail, { setPointerCapture: vi.fn() });
  vi.spyOn(items[1], "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 0,
    top: 0,
    left: 100,
    right: 200,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
  const preview = document.querySelector<HTMLElement>(
    ".desktop-slide-drag-preview",
  )!;
  firePointer(thumbnail, "pointerdown", 0, 0);
  firePointer(thumbnail, "pointermove", 120, 20);
  expect(preview).toBeVisible();
  expect(items[0]).toHaveClass("is-dragging");
  expect(items[1]).toHaveClass("is-drop-target", "is-drop-after");

  if (interruption === "blocked" || interruption === "inactive") {
    rerender(
      <PresentationLayout
        {...props}
        blocked={interruption === "blocked"}
        active={interruption !== "inactive"}
      />,
    );
  } else if (interruption === "escape") {
    fireEvent.keyDown(thumbnail, { key: "Escape" });
  } else if (interruption === "blur") {
    fireEvent.blur(thumbnail.ownerDocument.defaultView!);
  } else {
    firePointer(thumbnail, interruption, 120, 20);
  }
  expect(preview).not.toBeVisible();
  expect(preview).toBeEmptyDOMElement();
  expect(items[0]).not.toHaveClass("is-dragging");
  for (const item of items) {
    expect(item).not.toHaveClass("is-drop-target", "is-drop-after");
  }
  firePointer(thumbnail, "pointerup", 120, 20);
  expect(props.onMove).not.toHaveBeenCalled();
});

it.each([
  { language: "en" as const, fitLabel: "Fit page", exportLabel: "Export PDF" },
  { language: "zh-CN" as const, fitLabel: "适应页面", exportLabel: "导出 PDF" },
])(
  "keeps compact toolbar actions accessible in $language",
  ({ language, fitLabel, exportLabel }) => {
    const props = makeProps();
    render(<PresentationLayout {...props} language={language} />);
    const fit = screen.getByRole("button", { name: fitLabel });
    const exportPdf = screen.getByRole("button", { name: exportLabel });
    expect(fit).toHaveAttribute("title", fitLabel);
    expect(fit).toHaveTextContent(/^$/);
    expect(exportPdf).toHaveTextContent(/^PDF$/);
    fireEvent.click(fit);
    fireEvent.click(exportPdf);
    expect(props.onFit).toHaveBeenCalledTimes(1);
    expect(props.onExportPdf).toHaveBeenCalledTimes(1);
  },
);

it("opens the presentation menu with keyboard navigation and restores focus on Escape", () => {
  const props = makeProps();
  render(<PresentationLayout {...props} />);
  const trigger = screen.getByRole("button", { name: "Presentation options" });
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = screen.getByRole("menu", { name: "Present" });
  const fromStart = within(menu).getByRole("menuitem", {
    name: "Present from start",
  });
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
  expect(fromStart).toHaveFocus();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(props.beforePresent).not.toHaveBeenCalled();
  fireEvent.keyDown(fromStart, { key: "ArrowDown" });
  expect(fromStart).toHaveFocus();
  fireEvent.keyDown(fromStart, { key: "Escape" });
  expect(
    screen.queryByRole("menu", { name: "Present" }),
  ).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();

  fireEvent.click(trigger);
  expect(screen.getByRole("menu", { name: "Present" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.pointerDown(screen.getByText("Editor"));
  expect(
    screen.queryByRole("menu", { name: "Present" }),
  ).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(props.beforePresent).not.toHaveBeenCalled();
});

it.each([{ blocked: true }, { active: false }])(
  "closes the presentation menu and disables toolbar actions when %j",
  (state) => {
    const props = makeProps();
    const { rerender } = render(<PresentationLayout {...props} />);
    const present = screen.getByRole("button", { name: "Present" });
    const trigger = screen.getByRole("button", {
      name: "Presentation options",
    });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Present" })).toBeInTheDocument();
    rerender(<PresentationLayout {...props} {...state} />);
    expect(
      screen.queryByRole("menu", { name: "Present" }),
    ).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(present).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    const fit = screen.getByRole("button", { name: "Fit page" });
    const exportPdf = screen.getByRole("button", { name: "Export PDF" });
    expect(fit).toBeDisabled();
    expect(exportPdf).toBeDisabled();
    fireEvent.click(trigger);
    fireEvent.click(present);
    fireEvent.click(fit);
    fireEvent.click(exportPdf);
    expect(props.beforePresent).not.toHaveBeenCalled();
    expect(props.onFit).not.toHaveBeenCalled();
    expect(props.onExportPdf).not.toHaveBeenCalled();
    rerender(<PresentationLayout {...props} />);
    expect(trigger).toBeEnabled();
    expect(present).toBeEnabled();
    expect(
      screen.queryByRole("menu", { name: "Present" }),
    ).not.toBeInTheDocument();
  },
);

it("uses the converted canvas bounds in thumbnails and slide shows", async () => {
  const props = makeProps();
  const slide = props.presentation.slides[0];
  slide.bounds = { x: -3200, y: 900, width: 3200, height: 1800 };
  const { rerender } = render(<PresentationLayout {...props} />);
  await waitFor(() =>
    expect(renderSlideSvg).toHaveBeenCalledWith(
      expect.objectContaining({ id: slide.id, bounds: slide.bounds }),
      1600,
      900,
      document,
      false,
    ),
  );

  vi.mocked(renderSlideSvg).mockClear();
  slide.bounds = { x: -1600, y: 450, width: 1600, height: 900 };
  rerender(<PresentationLayout {...props} />);
  await waitFor(() =>
    expect(renderSlideSvg).toHaveBeenCalledWith(
      expect.objectContaining({ id: slide.id, bounds: slide.bounds }),
      1600,
      900,
      document,
      false,
    ),
  );

  vi.mocked(renderSlideSvg).mockClear();
  const options = screen.getByRole("button", { name: "Presentation options" });
  fireEvent.click(options);
  fireEvent.click(screen.getByRole("menuitem", { name: "Present from start" }));
  const player = screen.getByRole("dialog", { name: "Slide show" });
  expect(within(player).getByText("1 / 3")).toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(renderSlideSvg).toHaveBeenCalledWith(
      expect.objectContaining({ id: slide.id, bounds: slide.bounds }),
      1600,
      900,
      document,
      false,
    ),
  );
  fireEvent.keyDown(player, { key: "Escape" });
  expect(options).toHaveFocus();
});

it("refreshes every thumbnail when the theme changes while keeping slide shows in document colors", async () => {
  vi.mocked(renderSlideSvg).mockImplementation(
    async (slide, _width, _height, _document, darkMode) => {
      const svg = svgFor(slide.title);
      svg.setAttribute("data-preview-theme", darkMode ? "dark" : "light");
      return svg;
    },
  );
  const props = makeProps();
  const { container, rerender } = render(
    <PresentationLayout {...props} theme="light" />,
  );
  await waitFor(() =>
    expect(
      container.querySelectorAll('[data-preview-theme="light"]'),
    ).toHaveLength(3),
  );
  rerender(<PresentationLayout {...props} theme="dark" />);
  await waitFor(() =>
    expect(
      container.querySelectorAll('[data-preview-theme="dark"]'),
    ).toHaveLength(3),
  );
  fireEvent.click(screen.getByRole("button", { name: "Present" }));
  const player = screen.getByRole("dialog", { name: "Slide show" });
  await waitFor(() =>
    expect(
      player.querySelector('[data-preview-theme="light"]'),
    ).toBeInTheDocument(),
  );
  fireEvent.keyDown(player, { key: "Escape" });
  rerender(<PresentationLayout {...props} theme="light" />);
  await waitFor(() =>
    expect(
      container.querySelectorAll('[data-preview-theme="light"]'),
    ).toHaveLength(3),
  );
});

it("presents from the current slide, clamps keyboard navigation, and restores editing focus", async () => {
  const props = makeProps();
  const backgroundKey = vi.fn();
  render(
    <div onKeyDown={backgroundKey}>
      <PresentationLayout {...props} />
    </div>,
  );
  const start = screen.getByRole("button", { name: "Present" });
  start.focus();
  fireEvent.click(start);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  const player = screen.getByRole("dialog", { name: "Slide show" });
  expect(props.beforePresent).toHaveBeenCalledTimes(1);
  expect(props.onPresent).toHaveBeenCalledWith(true);
  expect(within(player).getByText("2 / 3")).toBeInTheDocument();
  fireEvent.keyDown(player, { key: "End" });
  fireEvent.keyDown(player, { key: "ArrowRight" });
  fireEvent.keyDown(player, { key: " " });
  expect(within(player).getByText("3 / 3")).toBeInTheDocument();
  expect(
    within(player).getByRole("button", { name: "Next slide" }),
  ).toBeDisabled();
  fireEvent.keyDown(player, { key: "Home" });
  fireEvent.keyDown(player, { key: "PageUp" });
  fireEvent.keyDown(player, { key: "ArrowUp" });
  expect(within(player).getByText("1 / 3")).toBeInTheDocument();
  fireEvent.keyDown(player, { key: "PageDown" });
  expect(within(player).getByText("2 / 3")).toBeInTheDocument();
  const exit = within(player).getByRole("button", { name: "Exit slide show" });
  exit.focus();
  fireEvent.keyDown(exit, { key: "Tab" });
  expect(
    within(player).getByRole("button", { name: "Previous slide" }),
  ).toHaveFocus();
  fireEvent.keyDown(
    within(player).getByRole("button", { name: "Previous slide" }),
    { key: "Tab", shiftKey: true },
  );
  expect(exit).toHaveFocus();
  fireEvent.keyDown(player, { key: "Delete" });
  fireEvent.keyDown(player, { key: "Escape" });
  expect(backgroundKey).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(props.onPresent.mock.calls).toEqual([[true], [false]]);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Select slide 2: Details" }),
  ).toHaveAttribute("aria-current", "page");
  expect(start).toHaveFocus();
});

it("requests fullscreen in the click gesture and keeps presenting after rejection", async () => {
  const props = makeProps();
  const order: string[] = [];
  props.beforePresent.mockImplementation(() => {
    order.push("flush");
    props.presentation.slides[0].title = "Flushed scene";
  });
  const requestFullscreen = vi.fn(() => {
    order.push("fullscreen");
    return Promise.reject(new Error("Denied"));
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: requestFullscreen,
  });
  render(<PresentationLayout {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Presentation options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Present from start" }));
  expect(order).toEqual(["flush", "fullscreen"]);
  const player = screen.getByRole("dialog");
  expect(within(player).getByText("1 / 3")).toBeInTheDocument();
  expect(
    await within(player).findByText(
      "Fullscreen unavailable. Presenting in this window.",
    ),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      player.querySelector('[data-preview-title="Flushed scene"]'),
    ).toBeInTheDocument(),
  );
  props.presentation.slides[0].title = "Later edit";
  fireEvent.click(within(player).getByRole("button", { name: "Next slide" }));
  fireEvent.click(
    within(player).getByRole("button", { name: "Previous slide" }),
  );
  await waitFor(() =>
    expect(
      player.querySelector('[data-preview-title="Flushed scene"]'),
    ).toBeInTheDocument(),
  );
});

it("exits fullscreen and removes keyboard interception when the document becomes inactive", async () => {
  const props = makeProps();
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: vi.fn(() => {
      fullscreenElement = document.documentElement;
      return Promise.resolve();
    }),
  });
  const exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: exitFullscreen,
  });
  const backgroundKey = vi.fn();
  const { rerender } = render(
    <div onKeyDown={backgroundKey}>
      <PresentationLayout {...props} />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Present" }));
  rerender(
    <div onKeyDown={backgroundKey}>
      <PresentationLayout {...props} active={false} />
    </div>,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(props.onPresent.mock.calls).toEqual([[true], [false]]);
  fireEvent.keyDown(screen.getByText("Editor"), { key: "Delete" });
  expect(backgroundKey).toHaveBeenCalledTimes(1);
  rerender(
    <div onKeyDown={backgroundKey}>
      <PresentationLayout {...props} />
    </div>,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("ignores obsolete asynchronous thumbnail results", async () => {
  vi.useFakeTimers();
  const props = makeProps();
  props.presentation.slides = [props.presentation.slides[0]];
  props.activeSlideId = "first";
  let resolveOld!: (svg: SVGSVGElement) => void;
  let resolveNew!: (svg: SVGSVGElement) => void;
  vi.mocked(renderSlideSvg)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
  const { container, rerender } = render(<PresentationLayout {...props} />);
  await act(async () => {
    vi.advanceTimersByTime(180);
  });
  rerender(<PresentationLayout {...props} revision={1} />);
  await act(async () => {
    vi.advanceTimersByTime(180);
  });
  await act(async () => {
    resolveNew(svgFor("Fresh"));
  });
  await act(async () => {
    resolveOld(svgFor("Stale"));
  });
  expect(
    container.querySelector('[data-preview-title="Fresh"]'),
  ).toBeInTheDocument();
  expect(
    container.querySelector('[data-preview-title="Stale"]'),
  ).not.toBeInTheDocument();
});

it("keeps existing thumbnails and only refreshes the edited slide", async () => {
  vi.useFakeTimers();
  const props = makeProps();
  const { container, rerender } = render(<PresentationLayout {...props} />);
  await act(async () => {
    vi.advanceTimersByTime(180);
  });
  expect(container.querySelectorAll("[data-preview-title]")).toHaveLength(3);
  vi.mocked(renderSlideSvg).mockClear();
  let resolvePreview!: (svg: SVGSVGElement) => void;
  vi.mocked(renderSlideSvg).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
  );
  props.presentation.slides[1].scene = { elements: [], appState: {} };
  rerender(<PresentationLayout {...props} revision={1} />);
  await act(async () => {
    vi.advanceTimersByTime(180);
  });
  expect(renderSlideSvg).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("[data-preview-title]")).toHaveLength(3);
  await act(async () => {
    resolvePreview(svgFor("Edited"));
  });
  expect(
    container.querySelector('[data-preview-title="Edited"]'),
  ).toBeInTheDocument();
});
