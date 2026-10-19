import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { App } from "./App";
import { useWorkspace } from "./workspace";

import type { CanvasDocument, Workspace } from "./workspace";

vi.mock("./workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("@excalidraw/excalidraw", async (original) => {
  const actual = await original<typeof import("@excalidraw/excalidraw")>();
  return { ...actual, Excalidraw: () => null, useHandleLibrary: vi.fn() };
});

describe("desktop inline tab rename interaction", () => {
  let root: HTMLDivElement;
  let workspace: Workspace;
  let canvas: CanvasDocument;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
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
      settings: { theme: "dark", rootDirectory: "/drawings" },
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
      newDocument: vi.fn(),
      closeDocument: vi.fn(),
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
});
