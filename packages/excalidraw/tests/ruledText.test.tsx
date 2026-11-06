import React from "react";

import {
  FONT_FAMILY,
  getLineHeight,
  getVerticalOffset,
} from "@excalidraw/common";
import { getRichTextFontSize, layoutRichText } from "@excalidraw/element";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import {
  actionChangeFontFamily,
  actionChangeFontSize,
} from "../actions/actionProperties";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, Pointer } from "./helpers/ui";
import { getTextEditor, updateTextEditor } from "./queries/dom";
import { act, fireEvent, GlobalTestState, render, waitFor } from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");

const baseline = (element: ExcalidrawTextElement) =>
  element.y +
  getVerticalOffset(
    element.fontFamily,
    element.fontSize,
    element.fontSize * element.lineHeight,
  );

const renderEditor = async (fontSize = 100) => {
  const getFreeTextPlacement = vi.fn(({ sceneX }: { sceneX: number }) =>
    sceneX < 300
      ? { x: 80, baselineY: 120, width: 180, lineSpacing: 32, fontSize }
      : null,
  );
  await render(
    <Excalidraw
      handleKeyboardGlobally
      desktopIntegration={{
        save: async () => false,
        open: async () => {},
        getFreeTextPlacement,
      }}
    />,
  );
  return getFreeTextPlacement;
};

it("uses the sheet width and baseline for hard and soft line breaks", async () => {
  const resolve = await renderEditor();
  const decoration = API.createElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 500,
    height: 500,
    locked: true,
    backgroundColor: "#ffffff",
  });
  API.setElements([decoration]);
  mouse.doubleClickAt(80, 115);
  expect(resolve).toHaveBeenCalledWith({
    sceneX: 80,
    sceneY: 115,
    elements: [expect.objectContaining({ id: decoration.id })],
  });
  const editor = await getTextEditor();
  const originalText = `first line\n${"long words ".repeat(12).trim()}`;
  updateTextEditor(editor, originalText);
  Keyboard.exitTextEditor(editor);

  const text = h.elements.find(
    (element): element is ExcalidrawTextElement => element.type === "text",
  )!;
  expect(text).toMatchObject({
    x: 80,
    width: 180,
    autoResize: false,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    frameId: null,
    originalText,
    customData: { guziRuledText: { version: 1, lineSpacing: 32 } },
  });
  expect(baseline(text)).toBeCloseTo(120);
  expect(text.fontSize).toBeCloseTo(32 / getLineHeight(text.fontFamily));
  const lines = text.text.split("\n");
  expect(lines[0]).toBe("first line");
  expect(lines.length).toBeGreaterThan(2);
  expect(text.height).toBeCloseTo(lines.length * 32);

  act(() => {
    h.app.actionManager.executeAction(actionChangeFontSize, "ui", 12);
    h.app.actionManager.executeAction(actionChangeFontFamily, "ui", {
      currentItemFontFamily: FONT_FAMILY.Nunito,
      currentHoveredFontFamily: null,
    });
  });
  const resized = h.elements.find(
    (element) => element.id === text.id,
  ) as ExcalidrawTextElement;
  expect(resized.fontFamily).toBe(FONT_FAMILY.Nunito);
  expect(resized.fontSize).toBe(12);
  expect(baseline(resized)).toBeCloseTo(120);
  expect(resized.fontSize * resized.lineHeight).toBeCloseTo(32);
});

it("keeps ordinary double-click, text-tool creation and existing text behavior", async () => {
  const resolve = await renderEditor();
  const existing = API.createElement({
    type: "text",
    text: "existing",
    x: 110,
    y: 100,
    width: 70,
    height: 30,
  });
  API.setElements([existing]);
  mouse.doubleClickAt(120, 115);
  expect(h.state.editingTextElement?.id).toBe(existing.id);
  expect(resolve).not.toHaveBeenCalled();
  Keyboard.exitTextEditor(await getTextEditor());

  mouse.clickAt(320, 120);
  mouse.doubleClickAt(320, 120);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(h.state.editingTextElement?.autoResize).toBe(true);
  expect(h.state.editingTextElement?.customData).toBeUndefined();
  Keyboard.exitTextEditor(await getTextEditor());

  fireEvent.doubleClick(GlobalTestState.interactiveCanvas, {
    clientX: 200,
    clientY: 120,
    altKey: true,
  });
  expect(h.state.editingTextElement).toBeNull();
  fireEvent.doubleClick(GlobalTestState.interactiveCanvas, {
    clientX: 200,
    clientY: 120,
    ctrlKey: true,
    metaKey: true,
  });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(h.state.editingTextElement?.autoResize).toBe(true);
  Keyboard.exitTextEditor(await getTextEditor());

  act(() => h.app.setActiveTool({ type: "text" }));
  mouse.clickAt(240, 150);
  await getTextEditor();
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(h.state.editingTextElement?.autoResize).toBe(true);
});

it("keeps oversized selection formatting local and fits rich runs into their row", async () => {
  await renderEditor(12);
  mouse.doubleClickAt(80, 115);
  const editor = await getTextEditor();
  updateTextEditor(editor, "abc\ndef");
  const id = h.state.editingTextElement!.id;
  editor.setSelectionRange(1, 2);
  act(() => h.app.actionManager.executeAction(actionChangeFontSize, "ui", 120));

  const current = () => h.app.scene.getElement<ExcalidrawTextElement>(id)!;
  await waitFor(() => {
    expect(current().richText?.paragraphs[0].runs).toMatchObject([
      { text: "a" },
      { text: "b", fontSizeScale: expect.any(Number) },
      { text: "c" },
    ]);
  });
  const richEditor = document.querySelector<HTMLElement>(
    ".excalidraw-rich-text[data-ruled-text]",
  )!;
  expect(richEditor.style.lineHeight).toBe("32px");
  expect(current().fontSize).toBe(12);
  const { lines, height } = layoutRichText(current(), current().width);
  expect(height).toBe(64);
  expect(lines.map(({ y }) => y)).toEqual([0, 32]);
  expect(
    lines[0].runs.map((run) => getRichTextFontSize(current(), run)),
  ).toEqual([12, expect.any(Number), 12]);
  expect(getRichTextFontSize(current(), lines[0].runs[1])).toBeGreaterThan(12);
  expect(getRichTextFontSize(current(), lines[0].runs[1])).toBeLessThan(32);
  for (const line of lines) {
    for (const run of line.runs) {
      expect(run.y + run.baseline).toBeCloseTo(line.y + line.baseline);
      expect(run.y + run.height).toBeLessThanOrEqual(
        line.y + line.height + 1e-6,
      );
    }
  }
  fireEvent.keyDown(richEditor, { key: "Escape" });
  expect(baseline(current())).toBeCloseTo(120);
});
