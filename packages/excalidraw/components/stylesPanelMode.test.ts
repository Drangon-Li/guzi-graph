import type { EditorInterface } from "@excalidraw/common";

import { getEditorStylesPanelMode } from "./stylesPanelMode";

import type { ExcalidrawProps, UIAppState } from "../types";

const editorInterface: EditorInterface = {
  formFactor: "desktop",
  desktopUIMode: "compact",
  userAgent: { isMobileDevice: false, platform: "other" },
  isTouchScreen: false,
  canFitSidebar: true,
  isLandscape: true,
};
const state = { width: 1600, zenModeEnabled: false } as UIAppState;
const toolPanel: NonNullable<
  NonNullable<ExcalidrawProps["desktopIntegration"]>["toolPanel"]
> = {
  dock: "left",
  onDockChange: () => {},
  labels: {
    title: "Tools",
    canvas: "Canvas",
    properties: "Properties",
    pinLeft: "Left",
    pinRight: "Right",
    unpin: "Unpin",
    collapse: "Collapse",
    expand: "Expand",
    resize: "Resize",
  },
};

it.each(["desktop", "tablet"] as const)(
  "uses full controls in a real wide dock on %s",
  (formFactor) => {
    expect(
      getEditorStylesPanelMode(
        { ...editorInterface, formFactor },
        state,
        toolPanel,
      ),
    ).toBe("full");
    expect(
      getEditorStylesPanelMode({ ...editorInterface, formFactor }, state, {
        ...toolPanel,
        dock: "right",
      }),
    ).toBe("full");
  },
);

it("retains native floating, narrow, zen, and phone modes", () => {
  expect(getEditorStylesPanelMode(editorInterface, state)).toBe("compact");
  expect(
    getEditorStylesPanelMode(editorInterface, state, {
      ...toolPanel,
      dock: "floating",
    }),
  ).toBe("compact");
  expect(
    getEditorStylesPanelMode(
      editorInterface,
      { ...state, width: 899 },
      toolPanel,
    ),
  ).toBe("compact");
  expect(
    getEditorStylesPanelMode(
      editorInterface,
      { ...state, zenModeEnabled: true },
      toolPanel,
    ),
  ).toBe("compact");
  expect(
    getEditorStylesPanelMode(
      { ...editorInterface, formFactor: "phone" },
      state,
      toolPanel,
    ),
  ).toBe("mobile");
});
