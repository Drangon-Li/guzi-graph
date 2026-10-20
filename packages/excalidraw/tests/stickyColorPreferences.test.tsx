import {
  DEFAULT_ELEMENT_BACKGROUND_PICKS,
  DEFAULT_ELEMENT_STROKE_PICKS,
  STICKY_NOTE_BACKGROUND_PICKS,
} from "@excalidraw/common";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import {
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
} from "./test-utils";

import type { PreferenceSection } from "../types";

const { h } = window;
const renderNote = async (onConfigurePreferences = vi.fn()) => {
  await render(
    <Excalidraw
      langCode="zh-CN"
      desktopIntegration={{
        save: async () => true,
        open: async () => {},
        selectionToolbar: false,
        onConfigurePreferences,
        toolPanel: {
          dock: "left",
          pinned: true,
          onDockChange: () => {},
          labels: {
            title: "工具栏",
            canvas: "画布",
            properties: "属性",
            pinLeft: "左侧",
            pinRight: "右侧",
            unpin: "取消固定",
            collapse: "收起",
            expand: "展开",
            resize: "调整大小",
          },
        },
      }}
    />,
  );
  const note = API.createElement({ type: "stickynote", id: "note" });
  API.setElements([note]);
  API.setSelectedElements([note]);
  return note;
};

const picker = (label: string) =>
  screen
    .getByRole("button", { name: label })
    .closest(".color-picker-container")!;
const colors = (element: Element) =>
  Array.from(element.querySelectorAll('[data-testid^="color-top-pick-"]')).map(
    (button) =>
      button.getAttribute("data-testid")!.slice("color-top-pick-".length),
  );

beforeEach(() => mockBoundingClientRect({ width: 1600, height: 1000 }));
afterEach(() => restoreOriginalGetBoundingClientRect());

it("labels ordinary note ink in Chinese and collapsed pin ink as stroke", async () => {
  const note = await renderNote();
  expect(picker("文字颜色")).toBeInTheDocument();
  expect(screen.queryByText("Text color")).toBeNull();
  API.setElements([
    { ...note, customData: { subcanvas: { sceneId: "child" } } },
  ]);
  expect(picker("描边")).toBeInTheDocument();
  expect(screen.queryByText("文字颜色")).toBeNull();
});

it("opens existing color preferences and applies shared picks while keeping note defaults opaque", async () => {
  const onConfigurePreferences = vi.fn((section: PreferenceSection) => {
    API.setAppState({
      colorTopPicks: {
        ...h.state.colorTopPicks,
        [section === "elementStroke" ? "elementStroke" : "elementBackground"]: [
          "transparent",
          section === "elementStroke" ? "#123456" : "#abcdef",
        ],
      },
    });
  });
  await renderNote(onConfigurePreferences);
  API.setAppState({
    colorTopPicks: {
      ...h.state.colorTopPicks,
      elementStroke: DEFAULT_ELEMENT_STROKE_PICKS,
      elementBackground: DEFAULT_ELEMENT_BACKGROUND_PICKS,
    },
  });
  expect(colors(picker("背景"))).toEqual(STICKY_NOTE_BACKGROUND_PICKS);
  fireEvent.click(screen.getByRole("button", { name: "配置描边颜色" }));
  expect(onConfigurePreferences).toHaveBeenLastCalledWith("elementStroke");
  expect(colors(picker("文字颜色"))).toEqual(["#123456"]);
  fireEvent.click(screen.getByRole("button", { name: "配置填充颜色" }));
  expect(onConfigurePreferences).toHaveBeenLastCalledWith("elementBackground");
  expect(colors(picker("背景"))).toEqual(["#abcdef"]);
});

it("preserves independent note shortcuts over shared color preferences", async () => {
  await renderNote();
  API.setAppState({
    colorTopPicks: {
      ...h.state.colorTopPicks,
      elementStroke: ["#123456"],
      elementBackground: ["#abcdef"],
      stickyNoteStroke: ["#654321"],
      stickyNoteBackground: ["#fedcba"],
    },
  });
  expect(colors(picker("文字颜色"))).toEqual(["#654321"]);
  expect(colors(picker("背景"))).toEqual(["#fedcba"]);
});
