import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Children, isValidElement } from "react";

import { Excalidraw } from "@excalidraw/excalidraw";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useWorkspace } from "../features/workspace/workspace";
import * as structuredExport from "../features/export/structuredExport";

import { App } from "./App";

import type {
  CanvasDocument,
  Workspace,
} from "../features/workspace/workspace";
import type { DesktopAPI } from "../../shared/desktop-api";
import type { ReactElement, ReactNode } from "react";

vi.mock("../features/projects/FilePreview", () => ({
  FilePreview: () => <div />,
}));
vi.mock("../features/workspace/workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("@excalidraw/excalidraw", async (original) => {
  const actual = await original<typeof import("@excalidraw/excalidraw")>();
  return {
    ...actual,
    Excalidraw: vi.fn(() => null),
    useHandleLibrary: vi.fn(),
  };
});

describe("desktop inline tab rename interaction", () => {
  let root: HTMLDivElement;
  let workspace: Workspace;
  let canvas: CanvasDocument;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    root.ownerDocument.defaultView!.desktop = {
      platform: "darwin",
    } as DesktopAPI;
    canvas = {
      id: "canvas-id",
      title: "原名称",
      path: "/drawings/原名称.excalidraw",
      modifiedAt: 123,
      dirty: false,
      saving: null,
      api: null,
    } as CanvasDocument;
    workspace = {
      documents: [canvas],
      activeId: canvas.id,
      projectsVisible: false,
      settings: {
        theme: "dark",
        rootDirectory: "/drawings",
        language: "zh-CN",
        structuredExportFormat: "json",
        includeInferredStructure: true,
        skipRemoveConfirmation: false,
        skipTrashConfirmation: false,
      },
      index: {
        rootDirectory: "/drawings",
        files: [],
        folders: [],
        history: [],
      },
      loading: false,
      closing: false,
      drafts: [],
      error: null,
      closePrompt: null,
      activate: vi.fn(),
      openFiles: vi.fn().mockResolvedValue(undefined),
      newDocument: vi.fn(),
      closeDocument: vi.fn(),
      removeFile: vi.fn().mockResolvedValue(true),
      updateSettings: vi.fn().mockResolvedValue(null),
      reportError: vi.fn(),
      renameDocument: vi.fn().mockImplementation(async (_id, title) => {
        canvas.title = title;
        return true;
      }),
    } as unknown as Workspace;
    vi.mocked(useWorkspace).mockReturnValue(workspace);
  });

  afterEach(() => {
    cleanup();
    root.remove();
    vi.clearAllMocks();
  });

  it.each([
    ["导出 PDF…", false],
    ["导出 PDF（包含子画布）…", true],
  ] as const)(
    "passes the mounted document to %s",
    (label, includeSubcanvases) => {
      const ownerWindow = root.ownerDocument.defaultView!;
      const frame = root.ownerDocument.createElement("iframe");
      root.ownerDocument.body.append(frame);
      root.remove();
      const ownerDocument = frame.contentDocument!;
      ownerDocument.defaultView!.matchMedia = ownerWindow.matchMedia;
      ownerDocument.defaultView!.desktop = { platform: "win32" } as DesktopAPI;
      root = ownerDocument.createElement("div");
      ownerDocument.body.append(root);
      canvas.api = {} as ExcalidrawImperativeAPI;
      const snapshot = {
        elements: [],
        appState: {
          ...getDefaultAppState(),
          width: ownerDocument.defaultView!.innerWidth,
          height: ownerDocument.defaultView!.innerHeight,
          offsetLeft: 0,
          offsetTop: 0,
        },
        files: {},
      };
      const exportPdf = vi
        .spyOn(structuredExport, "exportCanvasPdf")
        .mockResolvedValue(true);
      try {
        render(<App root={root} />, { container: root });
        canvas.flushEditing = vi.fn();
        canvas.getSnapshot = () => snapshot;
        const menu = vi.mocked(Excalidraw).mock.lastCall![0]
          .children as ReactElement<{ children: ReactNode }>;
        const item = Children.toArray(menu.props.children).find(
          (node) =>
            isValidElement<{ children: ReactNode }>(node) &&
            node.props.children === label,
        ) as ReactElement<{ onSelect: () => void }>;
        act(() => item.props.onSelect());
        expect(canvas.flushEditing).toHaveBeenCalledTimes(1);
        expect(exportPdf).toHaveBeenCalledWith(
          canvas.api,
          canvas.title,
          ownerDocument.defaultView!.desktop,
          includeSubcanvases
            ? { includeSubcanvases: true, ownerDocument }
            : { snapshot, ownerDocument },
        );
      } finally {
        cleanup();
        exportPdf.mockRestore();
        frame.remove();
      }
    },
  );

  it("routes style shortcuts to the active child editor and leaves text inputs alone", () => {
    render(<App root={root} />);
    const api = {
      getAppState: () => getDefaultAppState(),
      getSceneElements: () => [],
      updateScene: vi.fn(),
      setActiveTool: vi.fn(),
    } as unknown as ExcalidrawImperativeAPI;
    canvas.activeEditor = () => api;
    fireEvent.keyDown(root, { key: "™", code: "Digit2", altKey: true });
    expect(api.setActiveTool).toHaveBeenCalledWith({ type: "arrow" });
    expect(api.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({ currentItemStrokeStyle: "dashed" }),
      }),
    );
    vi.mocked(api.setActiveTool).mockClear();
    const input = document.createElement("input");
    root.append(input);
    fireEvent.keyDown(input, { key: "1", code: "Digit1", altKey: true });
    expect(api.setActiveTool).not.toHaveBeenCalled();
  });

  it.each([
    "desktop-presentation-toolbar",
    "desktop-presentation-filmstrip",
    "desktop-project-context-menu",
  ])(
    "ignores style shortcuts within %s while retaining editor shortcuts",
    (className) => {
      render(<App root={root} />);
      const api = {
        getAppState: () => getDefaultAppState(),
        getSceneElements: () => [],
        updateScene: vi.fn(),
        setActiveTool: vi.fn(),
      } as unknown as ExcalidrawImperativeAPI;
      canvas.activeEditor = () => api;
      const ownerDocument = root.ownerDocument;
      const container = ownerDocument.createElement("div");
      container.className = className;
      const button = ownerDocument.createElement("button");
      container.append(button);
      root.append(container);
      fireEvent.keyDown(button, { key: "™", code: "Digit2", altKey: true });
      expect(api.updateScene).not.toHaveBeenCalled();
      expect(api.setActiveTool).not.toHaveBeenCalled();

      const editor = ownerDocument.createElement("div");
      editor.className = "desktop-presentation-editor";
      root.append(editor);
      for (const target of [editor, root]) {
        fireEvent.keyDown(target, { key: "™", code: "Digit2", altKey: true });
        expect(api.setActiveTool).toHaveBeenCalledWith({ type: "arrow" });
        expect(api.updateScene).toHaveBeenCalledWith(
          expect.objectContaining({
            appState: expect.objectContaining({
              currentItemStrokeStyle: "dashed",
            }),
          }),
        );
        vi.mocked(api.setActiveTool).mockClear();
        vi.mocked(api.updateScene).mockClear();
      }
    },
  );

  it("edits in place with focus and selection, commits Enter once without a dialog", async () => {
    const view = render(<App root={root} />);
    const tab = view.getByRole("tab", { name: "原名称" });
    fireEvent.click(tab);
    expect(workspace.activate).toHaveBeenCalledWith(canvas.id);
    fireEvent.doubleClick(tab);
    const input = view.getByRole("textbox", { name: "画布名称" });
    expect(input).toHaveValue("原名称");
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(3);
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(useWorkspace).mock.lastCall?.[1]).toBe(false);
    fireEvent.change(input, { target: { value: " 新名称 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(workspace.renameDocument).toHaveBeenCalledTimes(1);
    expect(workspace.renameDocument).toHaveBeenCalledWith(canvas.id, "新名称");
    await waitFor(() =>
      expect(view.queryByRole("textbox")).not.toBeInTheDocument(),
    );
    expect(view.getByRole("tab", { name: "新名称" })).toBeInTheDocument();
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels an unsaved name with Escape and never submits the resulting blur", () => {
    canvas.path = null;
    const view = render(<App root={root} />);
    fireEvent.doubleClick(view.getByRole("tab", { name: "原名称" }));
    const input = view.getByRole("textbox", { name: "画布名称" });
    fireEvent.change(input, { target: { value: "取消名称" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(view.queryByRole("textbox")).not.toBeInTheDocument();
    expect(view.getByRole("tab", { name: "原名称" })).toHaveFocus();
    expect(workspace.renameDocument).not.toHaveBeenCalled();
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["close", "new", "switch"] as const)(
    "submits the original tab on blur before %s, without renaming another tab",
    async (action) => {
      const second = { ...canvas, id: "second-id", title: "另一个画布" };
      workspace.documents = [canvas, second];
      const view = render(<App root={root} />);
      fireEvent.doubleClick(view.getByRole("tab", { name: "原名称" }));
      const input = view.getByRole("textbox", { name: "画布名称" });
      fireEvent.change(input, { target: { value: "失焦名称" } });
      const target =
        action === "close"
          ? view.getByRole("button", { name: "关闭 原名称" })
          : action === "new"
          ? view.getByRole("button", { name: "新建画布" })
          : view.getByRole("tab", { name: "另一个画布" });
      act(() => target.focus());
      fireEvent.click(target);
      expect(workspace.renameDocument).toHaveBeenCalledTimes(1);
      expect(workspace.renameDocument).toHaveBeenCalledWith(
        "canvas-id",
        "失焦名称",
      );
      expect(second.title).toBe("另一个画布");
      await waitFor(() =>
        expect(view.queryByRole("textbox")).not.toBeInTheDocument(),
      );
      expect(target).toHaveFocus();
      if (action === "close") {
        expect(workspace.closeDocument).toHaveBeenCalledWith("canvas-id");
      } else if (action === "new") {
        expect(workspace.newDocument).toHaveBeenCalledTimes(1);
      } else {
        expect(workspace.activate).toHaveBeenCalledWith("second-id");
      }
    },
  );

  it("lets Chinese composition finish before Enter submits", async () => {
    const view = render(<App root={root} />);
    fireEvent.doubleClick(view.getByRole("tab", { name: "原名称" }));
    const input = view.getByRole("textbox", { name: "画布名称" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文画布" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(workspace.renameDocument).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(workspace.renameDocument).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(view.queryByRole("textbox")).not.toBeInTheDocument(),
    );
    expect(workspace.renameDocument).toHaveBeenCalledWith(
      canvas.id,
      "中文画布",
    );
  });

  it("prevents duplicate pending submits and restores the original name on failure", async () => {
    let finish!: (result: boolean) => void;
    vi.mocked(workspace.renameDocument).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<App root={root} />);
    fireEvent.doubleClick(view.getByRole("tab", { name: "原名称" }));
    const input = view.getByRole("textbox", { name: "画布名称" });
    fireEvent.change(input, { target: { value: "占用名称" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveAttribute("aria-busy", "true");
    expect(input).toHaveAttribute("readonly");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(workspace.renameDocument).toHaveBeenCalledTimes(1);
    workspace.error = "已有同名文件";
    await act(async () => finish(false));
    view.rerender(<App root={root} />);
    expect(view.queryByRole("textbox")).not.toBeInTheDocument();
    expect(view.getByRole("tab", { name: "原名称" })).toBeInTheDocument();
    expect(view.getByRole("alert")).toHaveTextContent("已有同名文件");
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps unchanged names without a filesystem rename", () => {
    const view = render(<App root={root} />);
    fireEvent.doubleClick(view.getByRole("tab", { name: "原名称" }));
    fireEvent.keyDown(view.getByRole("textbox", { name: "画布名称" }), {
      key: "Enter",
    });
    expect(view.getByRole("tab", { name: "原名称" })).toHaveFocus();
    expect(workspace.renameDocument).not.toHaveBeenCalled();
  });

  it("stops input keydown and keyup events from reaching the canvas document", () => {
    const view = render(<App root={root} />);
    fireEvent.doubleClick(view.getByRole("tab", { name: "原名称" }));
    const input = view.getByRole("textbox", { name: "画布名称" });
    const handler = vi.fn();
    root.ownerDocument.addEventListener("keydown", handler);
    root.ownerDocument.addEventListener("keyup", handler);
    try {
      fireEvent.keyDown(input, { key: "a", metaKey: true });
      fireEvent.keyUp(input, { key: "a", metaKey: true });
      fireEvent.keyDown(input, { key: "z", metaKey: true });
      fireEvent.keyDown(input, { key: "s", metaKey: true });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      root.ownerDocument.removeEventListener("keydown", handler);
      root.ownerDocument.removeEventListener("keyup", handler);
    }
  });
  const showProject = () => {
    workspace.projectsVisible = true;
    const file = {
      path: canvas.path!,
      name: "原名称.excalidraw",
      relativePath: "原名称.excalidraw",
      category: "",
      modifiedAt: 123,
      size: 100,
      lastOpenedAt: 123,
    };
    workspace.index.history = [file];
    workspace.index.files = [file];
    return file;
  };

  it.each([
    { platform: "darwin", modifier: "metaKey", shortcut: "⌘" },
    { platform: "win32", modifier: "ctrlKey", shortcut: "Ctrl+" },
  ])(
    "uses the $platform platform for project shortcuts and labels",
    ({ platform, modifier, shortcut }) => {
      root.ownerDocument.defaultView!.desktop = { platform } as DesktopAPI;
      showProject();
      const view = render(<App root={root} />);
      expect(view.container.querySelector(".desktop-shell")).toHaveAttribute(
        "data-platform",
        platform,
      );
      expect(view.getByTitle(`新建画布 · ${shortcut}N`)).toBeInTheDocument();
      expect(
        view.getByTitle(
          `项目页 · ${platform === "darwin" ? "⌘⇧P" : "Ctrl+Shift+P"}`,
        ),
      ).toBeInTheDocument();
      expect(view.getByText(`${shortcut}O`, { selector: "kbd" })).toBeVisible();
      const menu = vi.mocked(Excalidraw).mock.lastCall![0]
        .children as ReactElement<{ children: ReactNode }>;
      const menuShortcuts = Children.toArray(menu.props.children)
        .filter((node) => isValidElement<{ shortcut?: string }>(node))
        .map(
          (node) =>
            (node as ReactElement<{ shortcut?: string }>).props.shortcut,
        )
        .filter(Boolean);
      expect(menuShortcuts).toEqual([
        `${shortcut}N`,
        `${shortcut}O`,
        platform === "darwin" ? "⌘⇧S" : "Ctrl+Shift+S",
      ]);
      const ownerDocument = root.ownerDocument;
      const valid = { key: "o", [modifier]: true };
      fireEvent.keyDown(ownerDocument, valid);
      expect(workspace.openFiles).toHaveBeenCalledTimes(1);
      vi.mocked(workspace.openFiles).mockClear();
      for (const invalid of [
        { key: "o" },
        { key: "o", [platform === "darwin" ? "ctrlKey" : "metaKey"]: true },
        { ...valid, metaKey: true, ctrlKey: true },
        { ...valid, altKey: true },
        { ...valid, shiftKey: true },
        { ...valid, repeat: true },
        { ...valid, isComposing: true },
      ]) {
        fireEvent.keyDown(ownerDocument, invalid);
      }
      expect(workspace.openFiles).not.toHaveBeenCalled();
      fireEvent.keyDown(ownerDocument, { ...valid, key: "O" });
      expect(workspace.openFiles).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps Windows project opening blocked by modals, closing and the editor", () => {
    root.ownerDocument.defaultView!.desktop = {
      platform: "win32",
    } as DesktopAPI;
    showProject();
    const view = render(<App root={root} />);
    fireEvent.click(view.getByRole("button", { name: "设置" }));
    fireEvent.keyDown(root.ownerDocument, { key: "o", ctrlKey: true });
    expect(workspace.openFiles).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "完成" }));
    workspace.closing = true;
    view.rerender(<App root={root} />);
    fireEvent.keyDown(root.ownerDocument, { key: "o", ctrlKey: true });
    expect(workspace.openFiles).not.toHaveBeenCalled();
    workspace.closing = false;
    workspace.projectsVisible = false;
    view.rerender(<App root={root} />);
    fireEvent.keyDown(root.ownerDocument, { key: "o", ctrlKey: true });
    expect(workspace.openFiles).not.toHaveBeenCalled();
    workspace.projectsVisible = true;
    view.rerender(<App root={root} />);
    fireEvent.keyDown(root.ownerDocument, { key: "o", ctrlKey: true });
    expect(workspace.openFiles).toHaveBeenCalledTimes(1);
  });
  it.each(["ctrlKey", "metaKey"] as const)(
    "opens projects with %s+O only when the page can handle the shortcut",
    (modifier) => {
      root.ownerDocument.defaultView!.desktop = {
        platform: modifier === "metaKey" ? "darwin" : "win32",
      } as DesktopAPI;
      showProject();
      const view = render(<App root={root} />);
      const key = { key: "o", [modifier]: true };
      fireEvent.keyDown(root, key);
      expect(workspace.openFiles).toHaveBeenCalledTimes(1);
      vi.mocked(workspace.openFiles).mockClear();
      fireEvent.keyDown(root, {
        key: "o",
        [modifier === "ctrlKey" ? "metaKey" : "ctrlKey"]: true,
      });
      fireEvent.keyDown(root, { ...key, repeat: true });
      fireEvent.keyDown(root, { ...key, isComposing: true });
      fireEvent.keyDown(root, { ...key, altKey: true });
      fireEvent.keyDown(root, { ...key, shiftKey: true });
      const handled = new root.ownerDocument.defaultView!.KeyboardEvent(
        "keydown",
        {
          ...key,
          bubbles: true,
          cancelable: true,
        },
      );
      handled.preventDefault();
      root.dispatchEvent(handled);
      fireEvent.keyDown(view.getByRole("searchbox"), key);
      const menu = root.ownerDocument.createElement("div");
      menu.setAttribute("role", "menu");
      root.append(menu);
      fireEvent.keyDown(menu, key);
      expect(workspace.openFiles).not.toHaveBeenCalled();
      fireEvent.click(view.getByRole("button", { name: "设置" }));
      fireEvent.keyDown(root, key);
      fireEvent.keyDown(view.getByRole("dialog"), key);
      expect(workspace.openFiles).not.toHaveBeenCalled();
    },
  );

  it.each(["darwin", "win32"])(
    "uses the %s titlebar layout and deletion wording",
    (platform) => {
      root.ownerDocument.defaultView!.desktop = { platform } as DesktopAPI;
      showProject();
      const view = render(<App root={root} />);
      expect(
        view.container
          .querySelector(".desktop-shell")!
          .classList.contains("desktop-shell--mac"),
      ).toBe(platform === "darwin");
      fireEvent.click(
        view.getByRole("button", { name: "原名称.excalidraw 的操作" }),
      );
      fireEvent.click(
        view.getByRole("menuitem", {
          name: platform === "win32" ? "移到回收站" : "彻底删除",
        }),
      );
      expect(view.getByRole("dialog")).toHaveTextContent(
        platform === "win32" ? "将移到回收站" : "将移到废纸篓",
      );
      expect(
        view.getByRole("button", {
          name: platform === "win32" ? "移到回收站" : "移到废纸篓",
        }),
      ).toBeInTheDocument();
    },
  );

  it.each(["remove", "trash"] as const)(
    "explains %s and cancels without persisting a checked skip option",
    (mode) => {
      showProject();
      const view = render(<App root={root} />);
      fireEvent.click(
        view.getByRole("button", { name: "原名称.excalidraw 的操作" }),
      );
      fireEvent.click(
        view.getByRole("menuitem", {
          name: mode === "remove" ? "删除" : "彻底删除",
        }),
      );
      expect(view.getByRole("dialog")).toHaveAccessibleName(
        mode === "remove" ? "删除画布？" : "彻底删除画布？",
      );
      expect(view.getByRole("dialog")).toHaveTextContent(
        mode === "remove" ? "原文件会保留在当前位置" : "可从废纸篓恢复",
      );
      fireEvent.click(view.getByRole("checkbox", { name: "不再提示此操作" }));
      fireEvent.click(view.getByRole("button", { name: "取消" }));
      expect(view.queryByRole("dialog")).not.toBeInTheDocument();
      expect(workspace.removeFile).not.toHaveBeenCalled();
      expect(workspace.updateSettings).not.toHaveBeenCalled();
    },
  );

  it.each(["remove", "trash"] as const)(
    "persists only the matching skip preference after %s succeeds",
    async (mode) => {
      const file = showProject();
      const view = render(<App root={root} />);
      fireEvent.click(
        view.getByRole("button", { name: "原名称.excalidraw 的操作" }),
      );
      fireEvent.click(
        view.getByRole("menuitem", {
          name: mode === "remove" ? "删除" : "彻底删除",
        }),
      );
      fireEvent.click(view.getByRole("checkbox", { name: "不再提示此操作" }));
      fireEvent.click(
        view.getByRole("button", {
          name: mode === "remove" ? "删除" : "移到废纸篓",
        }),
      );
      await waitFor(() =>
        expect(workspace.updateSettings).toHaveBeenCalledWith(
          mode === "remove"
            ? { skipRemoveConfirmation: true }
            : { skipTrashConfirmation: true },
        ),
      );
      expect(workspace.removeFile).toHaveBeenCalledWith(file, mode);
    },
  );

  it("does not persist skip preferences when deletion fails or a dirty-document guard is cancelled", async () => {
    showProject();
    vi.mocked(workspace.removeFile).mockResolvedValue(false);
    const view = render(<App root={root} />);
    fireEvent.click(
      view.getByRole("button", { name: "原名称.excalidraw 的操作" }),
    );
    fireEvent.click(view.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(view.getByRole("checkbox", { name: "不再提示此操作" }));
    fireEvent.click(view.getByRole("button", { name: "删除" }));
    await act(async () => {});
    expect(workspace.removeFile).toHaveBeenCalledTimes(1);
    expect(workspace.updateSettings).not.toHaveBeenCalled();
  });

  it("skips remove confirmation independently while retaining the Trash confirmation", async () => {
    showProject();
    workspace.settings.skipRemoveConfirmation = true;
    const view = render(<App root={root} />);
    fireEvent.click(
      view.getByRole("button", { name: "原名称.excalidraw 的操作" }),
    );
    fireEvent.click(view.getByRole("menuitem", { name: "删除" }));
    await waitFor(() => expect(workspace.removeFile).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(
      view.getByRole("button", { name: "原名称.excalidraw 的操作" }),
    );
    fireEvent.click(view.getByRole("menuitem", { name: "彻底删除" }));
    expect(view.getByRole("dialog")).toHaveAccessibleName("彻底删除画布？");
    expect(workspace.removeFile).toHaveBeenCalledTimes(1);
  });

  it("updates language and export defaults without changing user titles or remounting a canvas", () => {
    showProject();
    const view = render(<App root={root} />);
    fireEvent.click(view.getByRole("button", { name: "设置" }));
    fireEvent.click(view.getByRole("radio", { name: "English" }));
    expect(workspace.updateSettings).toHaveBeenCalledWith({ language: "en" });
    workspace.settings.language = "en";
    view.rerender(<App root={root} />);
    expect(view.getByRole("dialog")).toHaveAccessibleName("Desktop settings");
    expect(view.getByRole("tab", { name: "原名称" })).toBeInTheDocument();
    expect(vi.mocked(Excalidraw).mock.lastCall?.[0].langCode).toBe("en");
    fireEvent.click(view.getByRole("tab", { name: "Files & export" }));
    fireEvent.click(view.getByRole("radio", { name: "Markdown" }));
    expect(workspace.updateSettings).toHaveBeenCalledWith({
      structuredExportFormat: "md",
    });
    fireEvent.click(
      view.getByRole("switch", { name: "Organize information by layout" }),
    );
    expect(workspace.updateSettings).toHaveBeenCalledWith({
      includeInferredStructure: false,
    });
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    fireEvent.click(
      view.getByRole("button", { name: "Actions for 原名称.excalidraw" }),
    );
    expect(view.getByRole("menuitem", { name: "Remove" })).toBeInTheDocument();
    expect(
      view.getByRole("menuitem", { name: "Move to Trash" }),
    ).toBeInTheDocument();
    expect(workspace.documents[0]).toBe(canvas);
  });
});
