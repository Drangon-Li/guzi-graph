import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";

import { Projects } from "./Projects";

import type { DesktopAPI, ProjectFile } from "../../../shared/desktop-api";
import type { Workspace } from "../workspace/workspace";

vi.mock("./FilePreview", () => ({
  FilePreview: () => <div className="desktop-file-preview" />,
}));

const files: ProjectFile[] = [
  {
    path: "/drawings/first.excalidraw",
    name: "first.excalidraw",
    relativePath: "first.excalidraw",
    category: "",
    modifiedAt: 200,
    size: 20,
  },
  {
    path: "/outside/second.excalidraw",
    name: "second.excalidraw",
    relativePath: "second.excalidraw",
    category: "",
    modifiedAt: 100,
    size: 10,
  },
];

const roots: HTMLElement[] = [];
const mount = (
  rootDirectory: string | null = "/drawings",
  ownerDocument = document,
  platform = "darwin",
  projectFiles = files,
) => {
  const root = ownerDocument.createElement("div");
  root.className = "excalidraw desktop-shell theme--dark";
  ownerDocument.body.append(root);
  roots.push(root);
  const revealFile = vi.fn().mockResolvedValue(undefined);
  root.ownerDocument.defaultView!.desktop = {
    platform,
    revealFile,
  } as unknown as DesktopAPI;
  const workspace = {
    index: {
      rootDirectory,
      folders: [],
      files: projectFiles,
      history: projectFiles,
    },
    settings: { rootDirectory },
    drafts: [],
    projectsVisible: true,
    openProject: vi.fn(),
    openFiles: vi.fn(),
    newDocument: vi.fn(),
    requestNewDocument: vi.fn(),
    requestPdfImport: vi.fn(),
    mutateFile: vi.fn().mockResolvedValue(true),
    moveFolder: vi.fn().mockResolvedValue(true),
    renameFolder: vi.fn().mockResolvedValue(true),
    setFolderPinned: vi.fn().mockResolvedValue(true),
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    changeDirectory: vi.fn(),
    reportError: vi.fn(),
  } as unknown as Workspace;
  const props = {
    root,
    theme: "dark" as const,
    workspace,
    onEdit: vi.fn(),
    onSettings: vi.fn(),
    onRecovery: vi.fn(),
    onRemove: vi.fn(),
  };
  const view = render(<Projects {...props} />, { container: root });
  const trigger = (index = 0) =>
    view.getByRole("button", { name: `${projectFiles[index].name} 的操作` });
  const card = (index = 0) =>
    root.querySelectorAll<HTMLElement>(".desktop-file-card")[index];
  return { ...view, root, props, workspace, revealFile, trigger, card };
};

afterEach(() => {
  cleanup();
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

describe("desktop project menus", () => {
  it("recognizes nested Windows history files as movable categories", () => {
    const nestedFile = {
      ...files[0],
      path: "C:\\Drawings\\work\\nested\\first.excalidraw",
      relativePath: "work/nested/first.excalidraw",
      category: "work/nested",
    };
    const outsideFile = {
      ...files[1],
      path: "C:\\Drawings-other\\nested\\second.excalidraw",
    };
    const view = mount("c:\\drawings\\", document, "win32", [
      nestedFile,
      outsideFile,
    ]);
    expect(view.getByText("Ctrl+O", { selector: "kbd" })).toBeVisible();
    expect(
      view.card().querySelector(".desktop-file-category"),
    ).toHaveTextContent("work/nested");
    expect(
      view.card(1).querySelector(".desktop-file-category"),
    ).toHaveTextContent("C:\\Drawings-other\\nested");
    fireEvent.click(view.trigger());
    const move = view.getByRole("menuitem", { name: "移动到分类" });
    expect(move).toBeEnabled();
    fireEvent.click(move);
    expect(view.props.onEdit).toHaveBeenCalledWith({
      kind: "move",
      file: nestedFile,
    });
    fireEvent.click(view.trigger(1));
    expect(
      view.getByRole("menuitem", { name: "移入默认文件夹分类" }),
    ).toBeEnabled();
    fireEvent.change(view.getByRole("searchbox"), {
      target: { value: "Drawings-other\\nested" },
    });
    expect(view.root.querySelectorAll(".desktop-file-card")).toHaveLength(1);
  });

  it("preserves backslashes in POSIX file names when classifying history", () => {
    const outsideFile = {
      ...files[0],
      path: "/drawings\\nested/first.excalidraw",
    };
    const view = mount("/drawings", document, "darwin", [outsideFile]);
    expect(view.getByText("⌘O", { selector: "kbd" })).toBeVisible();
    expect(
      view.card().querySelector(".desktop-file-category"),
    ).toHaveTextContent("/drawings\\nested");
    fireEvent.click(view.trigger());
    expect(
      view.getByRole("menuitem", { name: "移入默认文件夹分类" }),
    ).toBeEnabled();
  });

  it("closes on outside pointer, Escape and repeated trigger, preserving focus", () => {
    const view = mount();
    fireEvent.click(view.trigger());
    expect(view.getByRole("menu")).toBeInTheDocument();
    expect(view.getByRole("menuitem", { name: "打开" })).toHaveFocus();
    fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(view.trigger()).toHaveFocus();

    fireEvent.click(view.trigger());
    fireEvent.click(view.trigger());
    expect(view.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(view.trigger());
    const search = view.getByRole("searchbox");
    fireEvent.pointerDown(search);
    search.focus();
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(search).toHaveFocus();
  });

  it("keeps one menu when switching cards and closes when changing views", () => {
    const view = mount();
    fireEvent.click(view.trigger());
    fireEvent.click(view.trigger(1));
    expect(view.getAllByRole("menu")).toHaveLength(1);
    expect(view.getByRole("menu")).toHaveAccessibleName(
      "second.excalidraw 的操作",
    );
    expect(view.trigger()).toHaveAttribute("aria-expanded", "false");
    expect(view.trigger(1)).toHaveAttribute("aria-expanded", "true");
    fireEvent.contextMenu(view.card(), { clientX: 40, clientY: 50 });
    expect(view.getAllByRole("menu")).toHaveLength(1);
    expect(view.getByRole("menu")).toHaveAccessibleName(
      "first.excalidraw 的操作",
    );
    fireEvent.click(view.getByRole("button", { name: "全部画布 2" }));
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(view.card());
    view.rerender(<Projects {...view.props} active={false} />);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    view.rerender(<Projects {...view.props} active />);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shares open, rename, move and file manager actions between right-click and trigger", () => {
    const view = mount();
    fireEvent.contextMenu(view.card());
    const contextLabels = within(view.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    fireEvent.click(view.getByRole("menuitem", { name: "打开" }));
    expect(view.workspace.openProject).toHaveBeenCalledWith(files[0]);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(view.trigger());
    expect(
      within(view.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(contextLabels);
    fireEvent.click(view.getByRole("menuitem", { name: "重命名" }));
    expect(view.props.onEdit).toHaveBeenCalledWith({
      kind: "rename",
      file: files[0],
    });
    fireEvent.contextMenu(view.card());
    fireEvent.click(view.getByRole("menuitem", { name: "移动到分类" }));
    expect(view.props.onEdit).toHaveBeenCalledWith({
      kind: "move",
      file: files[0],
    });
    fireEvent.contextMenu(view.card(1));
    expect(
      view.getByRole("menuitem", { name: "移入默认文件夹分类" }),
    ).toBeEnabled();
    fireEvent.click(view.getByRole("menuitem", { name: "在文件管理器中显示" }));
    expect(view.revealFile).toHaveBeenCalledWith(files[1].path);
  });

  it("navigates enabled items with arrows, Home and End and supports keyboard context menus", () => {
    const view = mount(null);
    const open = view
      .card()
      .querySelector<HTMLButtonElement>(".desktop-file-open")!;
    open.focus();
    fireEvent.keyDown(open, { key: "F10", shiftKey: true });
    expect(
      view.getByRole("menuitem", { name: "移入默认文件夹分类" }),
    ).toBeDisabled();
    const menu = view.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(view.getByRole("menuitem", { name: "重命名" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(
      view.getByRole("menuitem", { name: "在文件管理器中显示" }),
    ).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(view.getByRole("menuitem", { name: "删除" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(view.getByRole("menuitem", { name: "彻底删除" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(view.getByRole("menuitem", { name: "打开" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(view.getByRole("menuitem", { name: "彻底删除" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(view.getByRole("menuitem", { name: "打开" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(view.getByRole("menuitem", { name: "彻底删除" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("clamps pointer position and retains the theme container", () => {
    const view = mount();
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "menu"
          ? { ...original.call(this), width: 220, height: 160 }
          : original.call(this);
      },
    );
    fireEvent.contextMenu(view.card(), { clientX: 2000, clientY: 2000 });
    const menu = view.getByRole("menu");
    expect(menu.style.left).toBe(
      `${view.root.ownerDocument.defaultView!.innerWidth - 228}px`,
    );
    expect(menu.style.top).toBe(
      `${view.root.ownerDocument.defaultView!.innerHeight - 168}px`,
    );
    expect(menu.parentElement).toBe(view.root);
    expect(menu.closest(".theme--dark")).toBe(view.root);
    fireEvent.contextMenu(view.card(), { clientX: -100, clientY: -100 });
    expect(view.getByRole("menu")).toHaveStyle({ left: "8px", top: "8px" });
  });

  it("binds dismissal to the mounted root's owner document and window", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    roots.push(frame);
    const view = mount("/drawings", frame.contentDocument!);
    fireEvent.contextMenu(view.card());
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.resize(window);
    expect(view.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(frame.contentDocument!, { key: "Escape" });
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(view.card().querySelector(".desktop-file-open")).toHaveFocus();
  });

  it("closes on external scrolling, resizing and focus leaving, but allows menu scrolling", () => {
    const view = mount();
    fireEvent.contextMenu(view.card());
    fireEvent.scroll(view.getByRole("menu"));
    expect(view.getByRole("menu")).toBeInTheDocument();
    fireEvent.scroll(view.root.querySelector(".desktop-project-content")!);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(view.trigger());
    fireEvent.resize(view.root.ownerDocument.defaultView!);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(view.trigger());
    act(() => view.getByRole("searchbox").focus());
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("groups destructive actions with icons and invokes the separate removal modes", () => {
    const view = mount();
    fireEvent.click(view.trigger());
    const remove = view.getByRole("menuitem", { name: "删除" });
    expect(remove).toHaveClass("is-danger", "has-separator");
    expect(remove.querySelector("svg")).not.toBeNull();
    fireEvent.click(remove);
    expect(view.props.onRemove).toHaveBeenCalledWith(files[0], "remove");
    fireEvent.contextMenu(view.card(1));
    fireEvent.click(view.getByRole("menuitem", { name: "彻底删除" }));
    expect(view.props.onRemove).toHaveBeenCalledWith(files[1], "trash");
  });
});

it("shows the example slot without a default directory and can return to local history", () => {
  const view = mount(null);
  view.rerender(
    <Projects {...view.props} examples={<p>Bundled Transformer example</p>} />,
  );
  fireEvent.click(view.getByRole("button", { name: "示例库" }));
  expect(view.getByText("Bundled Transformer example")).toBeVisible();
  expect(
    view.queryByPlaceholderText("搜索画布、分类或文件夹"),
  ).not.toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: /历史画布/ }));
  expect(
    view.queryByText("Bundled Transformer example"),
  ).not.toBeInTheDocument();
  expect(view.getByPlaceholderText("搜索画布、分类或文件夹")).toBeVisible();
});

it("keeps market, examples and file navigation mutually exclusive", () => {
  const view = mount();
  view.rerender(
    <Projects
      {...view.props}
      examples={<p>Example content</p>}
      market={<p>Market content</p>}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "插件市场" }));
  expect(view.getByText("Market content")).toBeInTheDocument();
  expect(view.queryByText("Example content")).not.toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "示例库" }));
  expect(view.queryByText("Market content")).not.toBeInTheDocument();
  expect(view.getByText("Example content")).toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: /全部画布/ }));
  expect(view.queryByText("Market content")).not.toBeInTheDocument();
  expect(view.queryByText("Example content")).not.toBeInTheDocument();
  expect(view.root.querySelectorAll(".desktop-file-card")).toHaveLength(2);
});

describe("desktop category tree", () => {
  const mountTree = () => {
    const nested = {
      ...files[0],
      path: "/drawings/work/nested/nested.excalidraw",
      name: "nested.excalidraw",
      category: "work/nested",
    };
    const direct = {
      ...files[0],
      path: "/drawings/work/direct.excalidraw",
      name: "direct.excalidraw",
      category: "work",
    };
    const view = mount("/drawings", document, "darwin", [
      direct,
      nested,
      files[1],
    ]);
    view.workspace.index.folders = [
      "archive",
      "work",
      "work/nested",
      "work/nested/empty",
    ];
    view.rerender(<Projects {...view.props} />);
    return {
      ...view,
      folder: (name: string) =>
        view.root.querySelector<HTMLButtonElement>(
          `.desktop-category-row > button[title="${name}"]`,
        )!,
    };
  };
  const transfer = () => ({ setData: vi.fn(), setDragImage: vi.fn() });

  it("keeps previews inside the mounted theme when the renderer root is outside the shell", () => {
    const view = mountTree();
    view.root.className = "renderer-root";
    const shell = view.card().closest(".desktop-projects")!;
    shell.classList.add("excalidraw", "desktop-shell", "theme--dark");
    const dataTransfer = transfer();
    fireEvent.dragStart(view.card(), { dataTransfer });
    expect(dataTransfer.setDragImage.mock.calls[0][0].parentElement).toBe(
      shell,
    );
    fireEvent.dragEnd(view.card());
  });

  it("uses a small themed preview of the loaded image and cleans it on drag end, drop and unmount", async () => {
    const view = mountTree();
    const image = view.root.ownerDocument.createElement("img");
    image.src = "data:image/svg+xml,<svg/>";
    view.card().querySelector(".desktop-file-preview")!.append(image);
    const dataTransfer = transfer();
    fireEvent.dragStart(view.card(), { dataTransfer });
    const [host, x, y] = dataTransfer.setDragImage.mock.calls[0];
    expect(host.parentElement).toBe(view.root);
    expect(host).toHaveAttribute("aria-hidden", "true");
    expect(host.querySelector("img")).not.toBe(image);
    expect(host.querySelector("img").src).toBe(image.src);
    expect(host.querySelector(".desktop-file-card")).toBeNull();
    expect(host.querySelector(".desktop-drag-preview-title")).toHaveTextContent(
      "direct",
    );
    expect(host.querySelector(".desktop-drag-preview-label")).toHaveTextContent(
      "移动中",
    );
    expect([x, y]).toEqual([0, 0]);
    fireEvent.dragEnd(view.card());
    expect(host.isConnected).toBe(false);
    fireEvent.dragStart(view.card(), { dataTransfer });
    const dropHost = dataTransfer.setDragImage.mock.calls[1][0];
    await act(async () => {
      fireEvent.drop(view.folder("archive").parentElement!, { dataTransfer });
    });
    expect(dropHost.isConnected).toBe(false);
    fireEvent.dragStart(view.card(), { dataTransfer });
    const unmountHost = dataTransfer.setDragImage.mock.calls[2][0];
    view.unmount();
    expect(unmountHost.isConnected).toBe(false);
  });

  it("reuses placeholders, delays preview removal, and leaves folder drag feedback native", () => {
    vi.useFakeTimers();
    try {
      const view = mountTree();
      const dataTransfer = transfer();
      fireEvent.dragStart(view.card(), { dataTransfer });
      const host = dataTransfer.setDragImage.mock.calls[0][0];
      expect(host.querySelector(".desktop-file-preview")).toBeTruthy();
      expect(host.isConnected).toBe(true);
      fireEvent.dragStart(view.card(), { dataTransfer });
      const replacement = dataTransfer.setDragImage.mock.calls[1][0];
      expect(host.isConnected).toBe(false);
      expect(replacement.isConnected).toBe(true);
      expect(
        view.root.querySelectorAll(".desktop-drag-preview-host"),
      ).toHaveLength(1);
      act(() => vi.advanceTimersByTime(150));
      expect(replacement.isConnected).toBe(false);
      fireEvent.dragEnd(view.card());
      fireEvent.dragStart(view.folder("work").parentElement!, { dataTransfer });
      expect(dataTransfer.setDragImage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nested folders, collapses branches and filters only direct files", () => {
    const view = mountTree();
    expect(view.folder("work/nested/empty")).toHaveTextContent("empty");
    fireEvent.click(view.folder("work"));
    expect(view.root.querySelectorAll(".desktop-file-card")).toHaveLength(1);
    expect(view.card()).toHaveTextContent("direct");
    fireEvent.click(view.getByRole("button", { name: "收起 work" }));
    expect(view.folder("work/nested")).not.toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "展开 work" }));
    expect(view.folder("work/nested")).toBeInTheDocument();
    fireEvent.click(view.folder("work/nested"));
    expect(view.root.querySelectorAll(".desktop-file-card")).toHaveLength(1);
    expect(view.card()).toHaveTextContent("nested");
  });

  it("starts a new canvas in the selected nested category from either creation button", () => {
    const view = mountTree();
    fireEvent.click(view.folder("work/nested/empty"));
    const buttons = view.getAllByRole("button", { name: "新建画布" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      fireEvent.click(button);
    }
    const selection = {
      rootDirectory: "/drawings",
      category: "work/nested/empty",
    };
    expect(view.workspace.requestNewDocument).toHaveBeenNthCalledWith(
      1,
      selection,
    );
    expect(view.workspace.requestNewDocument).toHaveBeenNthCalledWith(
      2,
      selection,
    );
    fireEvent.click(view.getByRole("button", { name: /历史画布/ }));
    fireEvent.click(view.getByRole("button", { name: "新建画布" }));
    expect(view.workspace.requestNewDocument).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it("moves external history files and complete folders by dragging, including back to root", async () => {
    const view = mountTree();
    let dataTransfer = transfer();
    fireEvent.dragStart(view.card(2), { dataTransfer });
    fireEvent.dragOver(view.folder("work").parentElement!, { dataTransfer });
    expect(view.folder("work").parentElement).toHaveClass(
      "desktop-drop-target",
    );
    await act(async () => {
      fireEvent.drop(view.folder("work").parentElement!, { dataTransfer });
    });
    expect(view.workspace.mutateFile).toHaveBeenCalledWith(
      "move",
      files[1],
      "work",
    );
    dataTransfer = transfer();
    fireEvent.dragStart(view.folder("work").parentElement!, { dataTransfer });
    await act(async () => {
      fireEvent.drop(view.folder("archive").parentElement!, { dataTransfer });
    });
    expect(view.workspace.moveFolder).toHaveBeenCalledWith("work", "archive");
    dataTransfer = transfer();
    fireEvent.dragStart(view.folder("work/nested").parentElement!, {
      dataTransfer,
    });
    await act(async () => {
      fireEvent.drop(view.getByRole("button", { name: /未分类/ }), {
        dataTransfer,
      });
    });
    expect(view.workspace.moveFolder).toHaveBeenCalledWith("work/nested", "");
  });

  it("rejects drops into a folder's own descendants and provides keyboard menu alternatives", async () => {
    const view = mountTree();
    const dataTransfer = transfer();
    fireEvent.dragStart(view.folder("work").parentElement!, { dataTransfer });
    await act(async () => {
      fireEvent.drop(view.folder("work/nested").parentElement!, {
        dataTransfer,
      });
    });
    expect(view.workspace.moveFolder).not.toHaveBeenCalled();
    fireEvent.dragEnd(view.folder("work").parentElement!);
    const trigger = view.getByRole("button", { name: "work 的分类操作" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    fireEvent.click(view.getByRole("menuitem", { name: "新建子分类" }));
    expect(view.props.onEdit).toHaveBeenCalledWith({
      kind: "folder",
      parent: "work",
    });
    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("menuitem", { name: "移动到分类" }));
    expect(view.props.onEdit).toHaveBeenCalledWith({
      kind: "moveFolder",
      folder: "work",
    });
  });

  it("positions folder right-clicks at the pointer and keeps them open across equal index refreshes", () => {
    const view = mountTree();
    fireEvent.contextMenu(view.folder("work").parentElement!, {
      clientX: 81,
      clientY: 93,
    });
    expect(view.getByRole("menu")).toHaveStyle({ left: "81px", top: "93px" });
    view.workspace.index = {
      ...view.workspace.index,
      folders: [...view.workspace.index.folders],
    };
    view.rerender(<Projects {...view.props} />);
    expect(view.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(view.getByRole("menu"), { key: "End" });
    expect(view.getByRole("menuitem", { name: "移动到分类" })).toHaveFocus();
    fireEvent.keyDown(view.getByRole("menu"), { key: "Home" });
    expect(view.getByRole("menuitem", { name: "重命名" })).toHaveFocus();
    fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(view.getByRole("button", { name: "work 的分类操作" })).toHaveFocus();
  });

  it("uses anchor coordinates for folder keyboard menus and dismisses on disappearance or root change", () => {
    const view = mountTree();
    const trigger = view.getByRole("button", { name: "work 的分类操作" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      right: 145,
      bottom: 62,
    } as DOMRect);
    fireEvent.keyDown(trigger, { key: "ContextMenu" });
    expect(view.getByRole("menu")).toHaveStyle({ left: "145px", top: "70px" });
    fireEvent.pointerDown(view.getByRole("searchbox"));
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    view.workspace.index = { ...view.workspace.index, folders: ["archive"] };
    view.rerender(<Projects {...view.props} />);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "archive 的分类操作" }));
    view.workspace.index = { ...view.workspace.index, rootDirectory: "/other" };
    view.rerender(<Projects {...view.props} />);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renames a leaf inline once when Enter is followed by blur and prevents folder dragging", async () => {
    const view = mountTree();
    fireEvent.doubleClick(view.folder("work/nested"));
    const input = view.getByRole("textbox", {
      name: "分类名称",
    }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.value).toBe("nested");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
    const row = input.closest(".desktop-category-row")!;
    expect(row).toHaveAttribute("draggable", "false");
    const dataTransfer = transfer();
    fireEvent.dragStart(row, { dataTransfer });
    expect(dataTransfer.setData).not.toHaveBeenCalled();
    let complete!: (value: boolean) => void;
    vi.mocked(view.workspace.renameFolder).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(view.workspace.renameFolder).toHaveBeenCalledTimes(1);
    expect(view.workspace.renameFolder).toHaveBeenCalledWith(
      "work/nested",
      "renamed",
    );
    expect(input).toHaveAttribute("readonly");
    await act(async () => complete(true));
    expect(
      view.queryByRole("textbox", { name: "分类名称" }),
    ).not.toBeInTheDocument();
  });

  it("supports menu rename and F2, cancels Escape and ignores IME Enter", async () => {
    const view = mountTree();
    fireEvent.click(view.getByRole("button", { name: "work 的分类操作" }));
    fireEvent.click(view.getByRole("menuitem", { name: "重命名" }));
    let input = view.getByRole("textbox", { name: "分类名称" });
    fireEvent.change(input, { target: { value: "取消" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.workspace.renameFolder).not.toHaveBeenCalled();
    expect(view.folder("work")).toBeInTheDocument();
    fireEvent.keyDown(view.folder("work"), { key: "F2" });
    input = view.getByRole("textbox", { name: "分类名称" });
    fireEvent.change(input, { target: { value: "中文" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(view.workspace.renameFolder).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(view.workspace.renameFolder).toHaveBeenCalledTimes(1);
    expect(view.workspace.renameFolder).toHaveBeenCalledWith("work", "中文");
  });

  it("keeps rejected duplicate names editable and preserves the old folder and selection", async () => {
    const view = mountTree();
    fireEvent.click(view.folder("work"));
    vi.mocked(view.workspace.renameFolder).mockResolvedValue(false);
    fireEvent.doubleClick(view.folder("work"));
    const input = view.getByRole("textbox", { name: "分类名称" });
    fireEvent.change(input, { target: { value: "archive" } });
    await act(async () => fireEvent.blur(input));
    expect(input).toHaveValue("archive");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(view.getByRole("alert")).toHaveTextContent("重命名失败");
    expect(view.getByRole("heading", { level: 1 })).toHaveTextContent("work");
    expect(view.card()).toHaveTextContent("direct");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.folder("work")).toBeInTheDocument();
    expect(view.workspace.renameFolder).toHaveBeenCalledTimes(1);
  });

  it("sorts pinned folders among siblings and switches pin state without leaking it across roots", async () => {
    const view = mountTree();
    const topFolders = () =>
      Array.from(
        view.root.querySelectorAll(
          ".desktop-categories > ul > li > .desktop-category-row > button[title]",
        ),
      ).map((button) => button.getAttribute("title"));
    view.workspace.settings.pinnedFoldersByRoot = {
      "/drawings": ["work", "work/nested/empty"],
      "/other": ["archive"],
    };
    view.rerender(<Projects {...view.props} />);
    expect(topFolders()).toEqual(["work", "archive"]);
    expect(
      view.folder("work").querySelector(".desktop-category-pin"),
    ).toHaveAccessibleName("已置顶");
    expect(
      view
        .folder("work/nested/empty")
        .closest("li")
        ?.parentElement?.closest("li")
        ?.querySelector("button[title]"),
    ).toHaveAttribute("title", "work/nested");
    fireEvent.click(view.getByRole("button", { name: "work 的分类操作" }));
    await act(async () =>
      fireEvent.click(view.getByRole("menuitem", { name: "取消置顶" })),
    );
    expect(view.workspace.setFolderPinned).toHaveBeenCalledTimes(1);
    expect(view.workspace.setFolderPinned).toHaveBeenCalledWith("work", false);
    view.workspace.settings.pinnedFoldersByRoot["/drawings"] = [];
    view.rerender(<Projects {...view.props} />);
    expect(topFolders()).toEqual(["archive", "work"]);
    fireEvent.click(view.getByRole("button", { name: "work 的分类操作" }));
    await act(async () =>
      fireEvent.click(view.getByRole("menuitem", { name: "置顶" })),
    );
    expect(view.workspace.setFolderPinned).toHaveBeenLastCalledWith(
      "work",
      true,
    );
    view.workspace.index = { ...view.workspace.index, rootDirectory: "/other" };
    view.rerender(<Projects {...view.props} />);
    expect(topFolders()).toEqual(["archive", "work"]);
    expect(
      view.folder("work").querySelector(".desktop-category-pin"),
    ).toBeNull();
    expect(
      view.folder("archive").querySelector(".desktop-category-pin"),
    ).not.toBeNull();
  });

  it.each(["renamed", "archive/work"])(
    "remaps selected and collapsed descendants atomically after relocation to %s",
    (destination) => {
      const view = mountTree();
      fireEvent.click(view.folder("work/nested"));
      fireEvent.click(view.getByRole("button", { name: "收起 work/nested" }));
      const remap = (path: string) =>
        path === "work" || path.startsWith("work/")
          ? destination + path.slice(4)
          : path;
      view.workspace.index = {
        ...view.workspace.index,
        folders: view.workspace.index.folders.map(remap),
        files: view.workspace.index.files.map((file) => ({
          ...file,
          category: remap(file.category),
        })),
      };
      view.workspace.folderRelocation = {
        id: 1,
        rootDirectory: "/drawings",
        source: "work",
        destination,
      };
      view.rerender(<Projects {...view.props} />);
      expect(view.getByRole("heading", { level: 1 })).toHaveTextContent(
        `${destination}/nested`,
      );
      expect(view.folder(`${destination}/nested`)).toHaveClass("selected");
      expect(
        view.folder(`${destination}/nested/empty`),
      ).not.toBeInTheDocument();
      expect(
        view.getByRole("button", { name: `展开 ${destination}/nested` }),
      ).toBeInTheDocument();
      expect(view.card()).toHaveTextContent("nested");
      view.workspace.index = { ...view.workspace.index };
      view.rerender(<Projects {...view.props} />);
      expect(view.folder(`${destination}/nested`)).toHaveClass("selected");
    },
  );
});
