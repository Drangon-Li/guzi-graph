import { useEffect, useState } from "react";

import { KEYS, MIME_TYPES } from "@excalidraw/common";
import {
  createPasteEvent,
  serializeAsClipboardJSON,
} from "@excalidraw/excalidraw/clipboard";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  getTextEditor,
  updateTextEditor,
} from "@excalidraw/excalidraw/tests/queries/dom";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useWorkspace } from "../workspace/workspace";

import { PresentationEditor } from "./PresentationEditor";
import { createPresentation } from "./model";

import type { DesktopAPI } from "../../../shared/desktop-api";
import type { CanvasDocument, Workspace } from "../workspace/workspace";

const clipboardRouting = vi.hoisted(() => ({
  paste: null as ((event: ClipboardEvent) => void) | null,
}));

vi.mock("./PresentationLayout", async (importOriginal) => {
  const { PresentationLayout } = await importOriginal<
    typeof import("./PresentationLayout")
  >();
  return {
    PresentationLayout: (props: Parameters<typeof PresentationLayout>[0]) => {
      clipboardRouting.paste = props.onCanvasPaste;
      return <PresentationLayout {...props} />;
    },
  };
});

vi.mock("./renderSlide", () => ({
  renderSlideSvg: vi.fn(async () =>
    document.createElementNS("http://www.w3.org/2000/svg", "svg"),
  ),
  exportPresentationPdf: vi.fn(),
}));

describe("presentation thumbnail clipboard and history", () => {
  let root: HTMLDivElement;
  let workspace: Workspace;
  let canvasDocument: CanvasDocument;
  let nativeCommand: Parameters<DesktopAPI["onCommand"]>[0];
  let setInteraction: (active: boolean) => void;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    root = document.createElement("div");
    document.body.append(root);
    root.ownerDocument.defaultView!.desktop = {
      getSettings: vi.fn().mockResolvedValue({
        rootDirectory: "/drawings",
        language: "en",
        theme: "light",
      }),
      listProjects: vi.fn().mockResolvedValue({
        rootDirectory: "/drawings",
        files: [],
        folders: [],
        history: [],
      }),
      getSession: vi.fn().mockResolvedValue({ paths: [], activePath: null }),
      setSession: vi.fn().mockResolvedValue(undefined),
      listDrafts: vi.fn().mockResolvedValue([]),
      takePendingFiles: vi.fn().mockResolvedValue([]),
      onCommand: vi.fn((callback: Parameters<DesktopAPI["onCommand"]>[0]) => {
        nativeCommand = callback;
        return () => {};
      }),
      onFilesOpened: vi.fn(() => () => {}),
      writeDraft: vi.fn().mockResolvedValue(undefined),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
      editText: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopAPI;
  });

  afterEach(() => {
    root.remove();
    vi.unstubAllGlobals();
  });

  const mount = async (onApi?: (api: ExcalidrawImperativeAPI) => void) => {
    const deck = createPresentation("first", "First");
    deck.slides[0].scene = {
      elements: [
        API.createElement({ type: "rectangle", id: "source", x: 113, y: 79 }),
      ],
    };
    deck.slides.push({ id: "second", title: "Second", scene: {} });
    const Harness = () => {
      const [active, setActive] = useState(true);
      setInteraction = setActive;
      workspace = useWorkspace(root);
      useEffect(() => {
        if (!workspace.loading && !workspace.documents.length) {
          const created = workspace.newPresentation()!;
          created.presentation = deck;
          created.activeSlideId = "first";
          created.initialData = deck.slides[0].scene;
        }
      });
      const current = workspace.documents[0];
      if (!current) {
        return null;
      }
      canvasDocument = current;
      return (
        <section className={`desktop-editor-pane${active ? " is-active" : ""}`}>
          <PresentationEditor
            document={current}
            workspace={workspace}
            ownerDocument={root.ownerDocument}
            onExcalidrawAPI={(api) => {
              current.api = api;
              if (api) {
                onApi?.(api);
              }
            }}
            onInitialize={(api) => workspace.initialize(current, api)}
            onChange={(elements, appState, files) =>
              workspace.capture(current, { elements, appState, files })
            }
            desktopIntegration={{
              localOnly: true,
              elementPastePosition: "original",
              open: async () => {},
              save: (snapshot, saveAs) =>
                workspace.editorSave(current, snapshot, saveAs),
            }}
            interaction={active}
            handleKeyboardGlobally={active}
            langCode="en"
          />
        </section>
      );
    };
    const view = await render(<Harness />, { container: root });
    await waitFor(() =>
      expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
    );
    return view;
  };

  const historyKey = (target: HTMLElement, redo = false) =>
    fireEvent.keyDown(target, {
      key: "z",
      code: "KeyZ",
      [KEYS.CTRL_OR_CMD]: true,
      shiftKey: redo,
    });

  const copySource = async (canvas: HTMLElement) => {
    act(() =>
      canvasDocument.api!.updateScene({
        appState: { selectedElementIds: { source: true } },
      }),
    );
    canvas.focus();
    const clipboardData = new DataTransfer();
    fireEvent(
      canvas,
      Object.assign(new Event("copy", { bubbles: true, cancelable: true }), {
        clipboardData,
      }),
    );
    await waitFor(() =>
      expect(
        JSON.parse(clipboardData.getData(MIME_TYPES.text)).elements,
      ).toEqual([expect.objectContaining({ id: "source" })]),
    );
    return clipboardData.getData(MIME_TYPES.text);
  };

  const expectSeparatedCopies = (count: number) => {
    const api = canvasDocument.api!;
    const elements = api.getSceneElements();
    expect(elements).toHaveLength(count);
    const ordered = [...elements].sort((left, right) => left.x - right.x);
    for (let index = 1; index < ordered.length; index++) {
      const gap =
        ordered[index].x - ordered[index - 1].x - ordered[index - 1].width;
      expect(gap * api.getAppState().zoom.value).toBeGreaterThanOrEqual(8);
    }
    const selected = elements.filter(
      (element) => api.getAppState().selectedElementIds[element.id],
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(elements[elements.length - 1].id);
    expect(selected[0].id).not.toBe("source");
  };

  it("places repeated element pastes beside the originals and restores them through history", async () => {
    const view = await mount();
    const canvas = view.container.querySelector<HTMLElement>(".excalidraw")!;
    const source = { ...canvasDocument.api!.getSceneElements()[0] };
    const content = await copySource(canvas);
    const first = view.getByRole("button", { name: "Select slide 1: First" });
    for (const count of [2, 3]) {
      first.focus();
      fireEvent.keyDown(first, { key: "v", [KEYS.CTRL_OR_CMD]: true });
      fireEvent(
        first,
        createPasteEvent({ types: { [MIME_TYPES.text]: content } }),
      );
      await waitFor(() => expectSeparatedCopies(count));
      expect(canvasDocument.api!.getSceneElements()[0]).toEqual(source);
    }
    const pasted = [...canvasDocument.api!.getSceneElements()];
    const expectElementCount = (count: number) =>
      waitFor(() =>
        expect(canvasDocument.api!.getSceneElements()).toHaveLength(count),
      );
    for (const count of [2, 1]) {
      first.focus();
      historyKey(first);
      await expectElementCount(count);
      expect(canvasDocument.api!.getSceneElements()[0]).toMatchObject(source);
    }
    for (const count of [2, 3]) {
      first.focus();
      historyKey(first, true);
      await expectElementCount(count);
      expect(canvasDocument.api!.getSceneElements()).toEqual(
        pasted.slice(0, count).map((element) =>
          expect.objectContaining({
            id: element.id,
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
            type: element.type,
          }),
        ),
      );
    }
  });

  it("preserves the first paste on an empty slide and separates later copies across page history", async () => {
    const view = await mount();
    const content = await copySource(
      view.container.querySelector<HTMLElement>(".excalidraw")!,
    );
    const source = { ...canvasDocument.api!.getSceneElements()[0] };
    const first = view.getByRole("button", { name: "Select slide 1: First" });
    const second = view.getByRole("button", { name: "Select slide 2: Second" });
    second.focus();
    fireEvent.click(second);
    expect(canvasDocument.api).toBeNull();
    fireEvent(
      second,
      createPasteEvent({ types: { [MIME_TYPES.text]: content } }),
    );
    await waitFor(() =>
      expect(canvasDocument.api?.getSceneElements()).toHaveLength(1),
    );
    const firstPaste = canvasDocument.api!.getSceneElements()[0];
    expect(firstPaste).toMatchObject({
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
      type: source.type,
    });
    await waitFor(() =>
      expect(canvasDocument.api!.getAppState().selectedElementIds).toEqual({
        [firstPaste.id]: true,
      }),
    );
    second.focus();
    fireEvent(
      second,
      createPasteEvent({ types: { [MIME_TYPES.text]: content } }),
    );
    await waitFor(() => expectSeparatedCopies(2));
    const secondPaste = canvasDocument.api!.getSceneElements()[1];
    first.focus();
    fireEvent.click(first);
    await waitFor(() => {
      expect(canvasDocument.activeSlideId).toBe("first");
      expect(canvasDocument.api?.getAppState().isLoading).toBe(false);
      expect(canvasDocument.api?.getSceneElements()).toEqual([
        expect.objectContaining(source),
      ]);
    });
    historyKey(first);
    await waitFor(() => {
      expect(canvasDocument.activeSlideId).toBe("second");
      expect(canvasDocument.api?.getSceneElements()).toHaveLength(1);
    });
    expect(canvasDocument.api!.getSceneElements()[0]).toMatchObject({
      id: firstPaste.id,
      x: source.x,
      y: source.y,
    });
    historyKey(second, true);
    await waitFor(() =>
      expect(canvasDocument.api?.getSceneElements()).toHaveLength(2),
    );
    expect(canvasDocument.api!.getSceneElements()[1]).toMatchObject({
      id: secondPaste.id,
      x: secondPaste.x,
      y: secondPaste.y,
    });
    expect(canvasDocument.presentation!.slides[0].scene.elements).toEqual([
      expect.objectContaining(source),
    ]);
  });

  it.each([
    { page: "first", entry: "thumbnail" },
    { page: "second", entry: "thumbnail" },
    { page: "first", entry: "title" },
  ])(
    "copies pages from actual focus after editing text and clicking $page $entry",
    async ({ page, entry }) => {
      const view = await mount();
      const text = API.createElement({
        type: "text",
        text: "before",
        x: 400,
        y: 200,
      });
      act(() =>
        canvasDocument.api!.updateScene({
          elements: [...canvasDocument.api!.getSceneElements(), text],
          appState: { selectedElementIds: { [text.id]: true } },
        }),
      );
      fireEvent.keyDown(view.container.querySelector(".excalidraw")!, {
        key: "Enter",
      });
      const editor = await getTextEditor();
      updateTextEditor(editor, "committed page text");
      expect(editor).toHaveFocus();
      const target =
        entry === "thumbnail"
          ? view.getByRole("button", {
              name:
                page === "first"
                  ? "Select slide 1: First"
                  : "Select slide 2: Second",
            })
          : view.container.querySelector<HTMLButtonElement>(
              ".desktop-slide-item.is-active .desktop-slide-title",
            )!;
      fireEvent.click(target);
      expect(target).toHaveFocus();
      const clipboardData = new DataTransfer();
      fireEvent.keyDown(document.activeElement!, {
        key: "c",
        [KEYS.CTRL_OR_CMD]: true,
      });
      const copy = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(copy, "clipboardData", { value: clipboardData });
      fireEvent(document.activeElement!, copy);
      const content = clipboardData.getData(MIME_TYPES.text);
      expect(JSON.parse(content)).toMatchObject({
        type: "guzi-presentation",
        slides: [{ title: page === "first" ? "First" : "Second" }],
      });
      expect(document.activeElement).toBe(target);
      const currentDocument = canvasDocument;
      const issueNativeCommand = nativeCommand;
      for (const count of [3, 4]) {
        fireEvent.keyDown(document.activeElement!, {
          key: "v",
          [KEYS.CTRL_OR_CMD]: true,
        });
        fireEvent(
          document.activeElement!,
          createPasteEvent({ types: { [MIME_TYPES.text]: content } }),
        );
        await waitFor(() => {
          expect(currentDocument.presentation!.slides).toHaveLength(count);
          expect(currentDocument.api?.getAppState().isLoading).toBe(false);
          expect(
            view.container.querySelector(
              ".desktop-slide-item.is-active .desktop-slide-select",
            ),
          ).toHaveFocus();
        });
      }
      expect(canvasDocument.api!.getSceneElements()).toHaveLength(
        page === "first" ? 2 : 0,
      );
      expect(canvasDocument.presentation!.slides[0].scene.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "committed page text",
          }),
        ]),
      );
      for (const command of ["undo", "undo", "redo", "redo"] as const) {
        const count =
          currentDocument.presentation!.slides.length +
          (command === "undo" ? -1 : 1);
        act(() => issueNativeCommand(command));
        await waitFor(() => {
          expect(currentDocument.presentation!.slides).toHaveLength(count);
          expect(currentDocument.api?.getAppState().isLoading).toBe(false);
          expect(
            view.container.querySelector(
              ".desktop-slide-item.is-active .desktop-slide-select",
            ),
          ).toHaveFocus();
        });
      }
    },
  );

  it("undoes thumbnail element paste, page paste and deletion in order and redoes them", async () => {
    const view = await mount();
    const thumbnail = () =>
      view.container.querySelector<HTMLButtonElement>(
        ".desktop-slide-item.is-active .desktop-slide-select",
      )!;
    const expectPage = async (count: number, id: string, elements: number) => {
      await waitFor(() => {
        expect(canvasDocument.presentation!.slides).toHaveLength(count);
        expect(canvasDocument.activeSlideId).toBe(id);
        expect(canvasDocument.api?.getAppState().isLoading).toBe(false);
        expect(canvasDocument.api?.getSceneElements()).toHaveLength(elements);
        expect(thumbnail()).toHaveFocus();
      });
    };
    const first = thumbnail();
    first.focus();
    let pageContent = "";
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", {
      value: {
        setData: (type: string, content: string) => {
          if (type === "text/plain") {
            pageContent = content;
          }
        },
      },
    });
    fireEvent(first, copy);
    expect(JSON.parse(pageContent).slides).toHaveLength(1);
    const elementContent = serializeAsClipboardJSON({
      elements: canvasDocument.api!.getSceneElements(),
      files: null,
    });
    const second = view.getByRole("button", { name: "Select slide 2: Second" });
    second.focus();
    fireEvent.click(second);
    expect(canvasDocument.activeSlideId).toBe("second");
    expect(second).toHaveFocus();
    expect(canvasDocument.api).toBeNull();
    fireEvent(
      second,
      createPasteEvent({ types: { [MIME_TYPES.text]: elementContent } }),
    );
    await waitFor(() =>
      expect(canvasDocument.api?.getSceneElements()).toHaveLength(1),
    );
    expect(canvasDocument.api!.getSceneElements()[0]).toMatchObject({
      x: 113,
      y: 79,
    });
    second.focus();
    fireEvent(
      second,
      createPasteEvent({ types: { [MIME_TYPES.text]: pageContent } }),
    );
    await waitFor(() =>
      expect(canvasDocument.presentation!.slides).toHaveLength(3),
    );
    const pastedId = canvasDocument.activeSlideId!;
    await expectPage(3, pastedId, 1);
    expect(canvasDocument.api!.getSceneElements()[0].id).toBe("source");
    fireEvent.keyDown(thumbnail(), { key: "Delete" });
    await expectPage(2, "second", 1);
    historyKey(thumbnail());
    await expectPage(3, pastedId, 1);
    historyKey(thumbnail());
    await expectPage(2, "second", 1);
    first.focus();
    fireEvent.click(first);
    await expectPage(2, "first", 1);
    historyKey(thumbnail());
    await expectPage(2, "second", 0);
    historyKey(thumbnail(), true);
    await expectPage(2, "second", 1);
    historyKey(thumbnail(), true);
    await expectPage(3, pastedId, 1);
    historyKey(thumbnail(), true);
    await expectPage(2, "second", 1);
    act(() => nativeCommand("undo"));
    await expectPage(3, pastedId, 1);
    act(() => nativeCommand("redo"));
    await expectPage(2, "second", 1);
    act(() => nativeCommand("undo"));
    await expectPage(3, pastedId, 1);
  });

  it("returns focus from title and context menu operations before thumbnail undo", async () => {
    const view = await mount();
    const first = view.getByRole("button", { name: "Select slide 1: First" });
    first.focus();
    fireEvent.contextMenu(first);
    fireEvent.click(view.getByRole("menuitem", { name: "Rename" }));
    const input = view.getByRole("textbox", { name: "Slide title" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Renamed" } });
    expect(historyKey(input)).toBe(true);
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(first).toHaveFocus());
    expect(canvasDocument.presentation!.slides[0].title).toBe("Renamed");
    historyKey(first);
    expect(canvasDocument.presentation!.slides[0].title).toBe("First");
    fireEvent.contextMenu(first);
    fireEvent.keyDown(view.getByRole("menuitem", { name: "Rename" }), {
      key: "Escape",
    });
    expect(first).toHaveFocus();
    historyKey(first, true);
    expect(canvasDocument.presentation!.slides[0].title).toBe("Renamed");
    fireEvent.contextMenu(first);
    fireEvent.click(view.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() =>
      expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
    );
    const second = view.getByRole("button", { name: "Select slide 1: Second" });
    expect(second).toHaveFocus();
    historyKey(second);
    await waitFor(() => {
      expect(canvasDocument.presentation!.slides).toHaveLength(2);
      expect(canvasDocument.activeSlideId).toBe("first");
      expect(canvasDocument.api?.getAppState().isLoading).toBe(false);
    });
    expect(
      view.getByRole("button", { name: "Select slide 1: Renamed" }),
    ).toHaveFocus();
  });

  it("captures trusted PNG custom data immediately and pastes after the target initializes", async () => {
    const view = await mount();
    const text = API.createElement({
      type: "text",
      text: "editable text",
      x: 113,
      y: 79,
    });
    const content = serializeAsClipboardJSON({ elements: [text], files: null });
    let resolveRead!: (items: ClipboardItems) => void;
    const read = vi.fn(
      () =>
        new Promise<ClipboardItems>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read },
    });
    try {
      const second = view.getByRole("button", {
        name: "Select slide 2: Second",
      });
      second.focus();
      fireEvent.click(second);
      expect(canvasDocument.api).toBeNull();
      const event = new Proxy(
        createPasteEvent({
          files: [
            new File(["preview"], "preview.png", { type: MIME_TYPES.png }),
          ],
        }),
        {
          get(target, property) {
            const value =
              property === "isTrusted"
                ? true
                : Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        },
      );
      // DOM dispatch cannot preserve a synthetic event's native trust in jsdom.
      clipboardRouting.paste!(event);
      expect(read).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
      );
      expect(canvasDocument.api!.getSceneElements()).toHaveLength(0);
      const first = view.getByRole("button", { name: "Select slide 1: First" });
      first.focus();
      fireEvent.click(first);
      await waitFor(() =>
        expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
      );
      await act(async () =>
        resolveRead([
          {
            types: [`web ${MIME_TYPES.excalidrawClipboard}`],
            getType: async () => ({ text: async () => content }),
          } as unknown as ClipboardItem,
        ]),
      );
      expect(canvasDocument.activeSlideId).toBe("first");
      expect(canvasDocument.api!.getSceneElements()).toHaveLength(1);
      expect(canvasDocument.api!.getSceneElements()[0].type).toBe("rectangle");
      second.focus();
      fireEvent.click(second);
      await waitFor(() =>
        expect(canvasDocument.api!.getSceneElements()).toHaveLength(1),
      );
      expect(canvasDocument.api!.getSceneElements()[0]).toMatchObject({
        type: "text",
        text: "editable text",
        x: 113,
        y: 79,
      });
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      if (clipboard) {
        Object.defineProperty(navigator, "clipboard", clipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("waits for initialization when the target API has already been published", async () => {
    const text = API.createElement({
      type: "text",
      text: "during mount",
      x: 113,
      y: 79,
    });
    const content = serializeAsClipboardJSON({ elements: [text], files: null });
    let pastedWhileLoading = false;
    const view = await mount((api) => {
      if (canvasDocument.activeSlideId === "second") {
        expect(api.getAppState().isLoading).toBe(true);
        pastedWhileLoading = true;
        clipboardRouting.paste!(
          createPasteEvent({ types: { [MIME_TYPES.text]: content } }),
        );
      }
    });
    const second = view.getByRole("button", { name: "Select slide 2: Second" });
    second.focus();
    fireEvent.click(second);
    await waitFor(() =>
      expect(canvasDocument.api?.getSceneElements()).toHaveLength(1),
    );
    expect(pastedWhileLoading).toBe(true);
    expect(canvasDocument.api!.getSceneElements()[0]).toMatchObject({
      type: "text",
      text: "during mount",
      x: 113,
      y: 79,
    });
  });

  it.each(["missing", "loading"] as const)(
    "resumes native canvas undo once after a fast page switch with a %s API",
    async (availability) => {
      let undoOnMount = false;
      let undoDuringMount = false;
      const view = await mount((api) => {
        if (undoOnMount && canvasDocument.activeSlideId === "second") {
          expect(api.getAppState().isLoading).toBe(true);
          undoDuringMount = true;
          nativeCommand("undo");
          nativeCommand("undo");
          expect(canvasDocument.presentationHistory!.pending).toBeTruthy();
        }
      });
      const second = view.getByRole("button", {
        name: "Select slide 2: Second",
      });
      second.focus();
      fireEvent.click(second);
      await waitFor(() =>
        expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
      );
      const text = API.createElement({
        type: "text",
        text: "undo target",
        x: 113,
        y: 79,
      });
      fireEvent(
        second,
        createPasteEvent({
          types: {
            [MIME_TYPES.text]: serializeAsClipboardJSON({
              elements: [text],
              files: null,
            }),
          },
        }),
      );
      await waitFor(() =>
        expect(canvasDocument.api?.getSceneElements()).toHaveLength(1),
      );
      const first = view.getByRole("button", { name: "Select slide 1: First" });
      first.focus();
      fireEvent.click(first);
      await waitFor(() =>
        expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
      );
      undoOnMount = availability === "loading";
      second.focus();
      fireEvent.click(second);
      if (availability === "missing") {
        expect(canvasDocument.api).toBeNull();
        act(() => {
          nativeCommand("undo");
          nativeCommand("undo");
        });
        expect(canvasDocument.presentationHistory!.pending).toBeTruthy();
      }
      await waitFor(() => {
        expect(canvasDocument.api?.getAppState().isLoading).toBe(false);
        expect(canvasDocument.api?.getSceneElements()).toHaveLength(0);
        expect(canvasDocument.presentationHistory!.pending).toBeUndefined();
      });
      expect(undoDuringMount).toBe(availability === "loading");
      expect(canvasDocument.presentationHistory!.undo).toHaveLength(0);
      expect(canvasDocument.presentationHistory!.redo).toHaveLength(1);
      act(() => nativeCommand("redo"));
      await waitFor(() =>
        expect(canvasDocument.api?.getSceneElements()).toHaveLength(1),
      );
      expect(canvasDocument.presentationHistory!.undo).toHaveLength(1);
      expect(canvasDocument.presentationHistory!.redo).toHaveLength(0);
    },
  );

  it("retains a pending paste while another document or the projects page is active", async () => {
    const view = await mount();
    const second = view.getByRole("button", { name: "Select slide 2: Second" });
    const text = API.createElement({
      type: "text",
      text: "return to this document",
      x: 113,
      y: 79,
    });
    second.focus();
    fireEvent.click(second);
    expect(canvasDocument.api).toBeNull();
    fireEvent(
      second,
      createPasteEvent({
        types: {
          [MIME_TYPES.text]: serializeAsClipboardJSON({
            elements: [text],
            files: null,
          }),
        },
      }),
    );
    act(() => setInteraction(false));
    await waitFor(() =>
      expect(canvasDocument.api?.getAppState().isLoading).toBe(false),
    );
    expect(canvasDocument.api!.getSceneElements()).toHaveLength(0);
    act(() => setInteraction(true));
    await waitFor(() =>
      expect(canvasDocument.api?.getSceneElements()).toHaveLength(1),
    );
    act(() => setInteraction(false));
    act(() => setInteraction(true));
    expect(canvasDocument.api!.getSceneElements()).toHaveLength(1);
    expect(canvasDocument.api!.getSceneElements()[0]).toMatchObject({
      type: "text",
      text: "return to this document",
      x: 113,
      y: 79,
    });
    expect(canvasDocument.presentationHistory!.undo).toHaveLength(1);
  });
});
