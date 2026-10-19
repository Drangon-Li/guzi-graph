import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";

import { Projects } from "./Projects";

import type { DesktopAPI, ProjectFile } from "./shared";
import type { Workspace } from "./workspace";

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
) => {
  const root = ownerDocument.createElement("div");
  root.className = "excalidraw desktop-shell theme--dark";
  ownerDocument.body.append(root);
  roots.push(root);
  const revealFile = vi.fn().mockResolvedValue(undefined);
  root.ownerDocument.defaultView!.desktop = {
    revealFile,
  } as unknown as DesktopAPI;
  const workspace = {
    index: { rootDirectory, folders: [], files, history: files },
    settings: { rootDirectory },
    drafts: [],
    projectsVisible: true,
    openProject: vi.fn(),
    openFiles: vi.fn(),
    newDocument: vi.fn(),
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
  };
  const view = render(<Projects {...props} />, { container: root });
  const trigger = (index = 0) =>
    view.getByRole("button", { name: `${files[index].name} 的操作` });
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

  it("shares open, rename, move and Finder actions between right-click and trigger", () => {
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
    fireEvent.click(view.getByRole("menuitem", { name: "在 Finder 中显示" }));
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
      view.getByRole("menuitem", { name: "在 Finder 中显示" }),
    ).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(view.getByRole("menuitem", { name: "打开" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(
      view.getByRole("menuitem", { name: "在 Finder 中显示" }),
    ).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(view.getByRole("menuitem", { name: "打开" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(
      view.getByRole("menuitem", { name: "在 Finder 中显示" }),
    ).toHaveFocus();
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
});
