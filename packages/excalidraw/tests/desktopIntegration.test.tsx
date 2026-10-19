import React from "react";

import { KEYS } from "@excalidraw/common";

import { actionLoadScene, actionSaveFileToDisk } from "../actions";
import * as dataModule from "../data";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { getTextEditor, updateTextEditor } from "./queries/dom";
import { act, render, waitFor } from "./test-utils";

import type { ExcalidrawProps } from "../types";

const { h } = window;

describe("optional desktop integration", () => {
  const save =
    vi.fn<NonNullable<ExcalidrawProps["desktopIntegration"]>["save"]>();
  const open = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    save.mockReset().mockResolvedValue(true);
    open.mockReset().mockResolvedValue();
  });

  const mount = async (props: Partial<ExcalidrawProps> = {}) => {
    await render(
      <Excalidraw
        handleKeyboardGlobally
        desktopIntegration={{ save, open, localOnly: true }}
        {...props}
      />,
    );
  };

  const startTextEditing = async () => {
    const text = API.createElement({ type: "text", text: "before" });
    API.setElements([text]);
    API.setSelectedElements([text]);
    Keyboard.keyPress(KEYS.ENTER);
    const editor = await getTextEditor();
    updateTextEditor(editor, "latest text");
    return editor;
  };

  it.each([false, true])(
    "commits text before native menu save (saveAs=%s)",
    async (saveAs) => {
      await mount();
      await startTextEditing();
      let result = false;
      await act(async () => {
        result = await h.app.api.desktopSave(saveAs);
      });
      expect(result).toBe(true);
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          elements: [expect.objectContaining({ text: "latest text" })],
          appState: expect.objectContaining({ editingTextElement: null }),
          files: h.app.files,
        }),
        saveAs,
      );
      expect(await getTextEditor({ waitForEditor: false })).toBeNull();
    },
  );

  it.each([false, true])(
    "commits text before the save shortcut (saveAs=%s)",
    async (saveAs) => {
      await mount();
      const editor = await startTextEditing();
      Keyboard.withModifierKeys({ ctrl: true, shift: saveAs }, () => {
        Keyboard.keyPress(KEYS.S, editor);
      });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save.mock.calls[0][0].elements[0]).toMatchObject({
        text: "latest text",
      });
      expect(save.mock.calls[0][1]).toBe(saveAs);
    },
  );

  it("preserves cancellation without calling onExport or browser save", async () => {
    const onExport = vi.fn();
    const browserSave = vi.spyOn(dataModule, "saveAsJSON");
    save.mockResolvedValue(false);
    await mount({ onExport });
    API.setAppState({ openDialog: { name: "jsonExport" }, toast: null });
    await act(async () => {
      expect(await h.app.api.desktopSave(true)).toBe(false);
    });
    expect(h.state.openDialog).toEqual({ name: "jsonExport" });
    expect(h.state.toast).toBeNull();
    expect(onExport).not.toHaveBeenCalled();
    expect(browserSave).not.toHaveBeenCalled();
    browserSave.mockRestore();
  });

  it("uses native Open without replacing the current scene", async () => {
    await mount();
    const element = API.createElement({ type: "rectangle" });
    API.setElements([element]);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress(KEYS.O));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(h.elements).toEqual([element]);
    act(() => h.app.actionManager.executeAction(actionLoadScene));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });

  it("commits text before native Open from the text editor", async () => {
    await mount();
    const editor = await startTextEditing();
    let editingWhenOpened: unknown = "not opened";
    open.mockImplementation(async () => {
      editingWhenOpened = h.state.editingTextElement;
    });
    Keyboard.withModifierKeys({ ctrl: true }, () => {
      Keyboard.keyPress(KEYS.O, editor);
    });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(editingWhenOpened).toBeNull();
    expect(h.elements[0]).toMatchObject({ text: "latest text" });
  });

  it("routes Save As actions to native saving", async () => {
    await mount();
    act(() => h.app.actionManager.executeAction(actionSaveFileToDisk));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe(true);
  });

  it("ignores global save/open shortcuts for an inactive editor", async () => {
    await mount({ interaction: false });
    Keyboard.withModifierKeys({ ctrl: true }, () => {
      Keyboard.keyPress(KEYS.S);
      Keyboard.keyPress(KEYS.O);
    });
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps shortcut help while hiding online links and AI", async () => {
    await mount();
    API.setAppState({ openDialog: { name: "help" } });
    await waitFor(() => {
      const dialog = document.querySelector(".HelpDialog");
      expect(dialog).not.toBeNull();
      expect(dialog?.querySelectorAll("a").length).toBe(0);
      expect(dialog?.querySelectorAll("kbd").length).toBeGreaterThan(0);
    });
    expect(h.app.props.aiEnabled).toBe(false);
  });

  it("retains browser saving without the optional integration", async () => {
    const browserSave = vi
      .spyOn(dataModule, "saveAsJSON")
      .mockResolvedValue({ fileHandle: null });
    await render(<Excalidraw handleKeyboardGlobally />);
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.keyPress(KEYS.S));
    await waitFor(() => expect(browserSave).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
    browserSave.mockRestore();
  });
});
