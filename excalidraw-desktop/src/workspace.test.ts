import { createElement } from "react";

import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";

import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createSceneTracker } from "./document";
import { Projects } from "./Projects";
import { useWorkspace } from "./workspace";

import type { SceneSnapshot } from "./document";
import type {
  DesktopAPI,
  DesktopCommand,
  DiskDocument,
  RecentFile,
} from "./shared";
import type { CanvasDocument } from "./workspace";

const snapshot = (version = 1): SceneSnapshot => ({
  elements: [
    {
      type: "rectangle",
      id: "rectangle",
      x: version,
      y: 0,
      width: 100,
      height: 100,
      version,
      versionNonce: version,
      isDeleted: false,
    } as ExcalidrawElement,
  ],
  appState: {
    ...getDefaultAppState(),
    width: 1000,
    height: 700,
    offsetLeft: 0,
    offsetTop: 0,
  },
  files: {},
});

const disk = (path: string, content: string): DiskDocument => ({
  path,
  content,
  modifiedAt: 123,
  size: content.length,
});

describe("desktop persistent scene tracking", () => {
  it("ignores selection, zoom, scroll and pointer-only changes", () => {
    const track = createSceneTracker();
    const scene = snapshot();
    const content = track(scene);
    expect(
      track({
        ...scene,
        appState: {
          ...scene.appState,
          scrollX: 100,
          scrollY: -30,
          zoom: { value: 2 as any },
          selectedElementIds: { rectangle: true },
          cursorButton: "down",
        },
      }),
    ).toBe(content);
    expect(track(snapshot(2))).not.toBe(content);
  });

  it("keeps embedded images and detects replacement image bytes", () => {
    const track = createSceneTracker();
    const scene = snapshot();
    scene.elements = [
      {
        ...scene.elements[0],
        type: "image",
        fileId: "image",
      } as ExcalidrawElement,
    ];
    scene.files = {
      image: {
        id: "image" as any,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA" as any,
        created: 1,
      },
      unused: {
        id: "unused" as any,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,BBBB" as any,
        created: 1,
      },
    };
    const content = track(scene);
    expect(JSON.parse(content).files).toHaveProperty(
      "image.dataURL",
      "data:image/png;base64,AAAA",
    );
    expect(JSON.parse(content).files).not.toHaveProperty("unused");
    const next = track({
      ...scene,
      files: {
        image: {
          ...scene.files.image,
          dataURL: "data:image/png;base64,CCCC" as any,
        },
      },
    });
    expect(next).not.toBe(content);
    expect(JSON.parse(next).files.image.dataURL).toBe(
      "data:image/png;base64,CCCC",
    );
  });
});

describe("desktop document workspace", () => {
  let root: HTMLDivElement;
  let desktop: DesktopAPI;
  let command: (command: DesktopCommand) => void;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    command = () => {};
    desktop = {
      getSettings: vi
        .fn()
        .mockResolvedValue({ rootDirectory: "/drawings", theme: "system" }),
      updateSettings: vi.fn(),
      chooseDirectory: vi.fn(),
      listProjects: vi.fn().mockResolvedValue({
        rootDirectory: "/drawings",
        files: [],
        folders: [],
        history: [],
      }),
      openFiles: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(),
      recordOpenedFile: vi.fn().mockResolvedValue(undefined),
      saveFile: vi.fn(),
      saveExport: vi.fn(),
      renameFile: vi.fn(),
      moveFile: vi.fn(),
      createFolder: vi.fn(),
      revealFile: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ paths: [], activePath: null }),
      setSession: vi.fn().mockResolvedValue(undefined),
      listDrafts: vi.fn().mockResolvedValue([]),
      writeDraft: vi.fn().mockResolvedValue(undefined),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
      takePendingFiles: vi.fn().mockResolvedValue([]),
      onCommand: vi.fn((callback) => {
        command = callback;
        return () => {};
      }),
      onFilesOpened: vi.fn(() => () => {}),
      confirmClose: vi.fn(),
      cancelClose: vi.fn(),
    };
    root.ownerDocument.defaultView!.desktop = desktop;
  });

  afterEach(() => {
    root.remove();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    const hook = renderHook(() => useWorkspace(root));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  };

  const addDocument = (hook: Awaited<ReturnType<typeof mount>>) => {
    let document!: CanvasDocument;
    let scene = snapshot();
    const api = {
      isDestroyed: false,
      getSceneElementsIncludingDeleted: () => scene.elements,
      getAppState: () => scene.appState,
      getFiles: () => scene.files,
      commitEditing: vi.fn(),
      desktopSave: (saveAs: boolean) =>
        hook.result.current.editorSave(document, scene, saveAs),
    } as unknown as ExcalidrawImperativeAPI;
    act(() => {
      document = hook.result.current.newDocument();
      hook.result.current.initialize(document, api);
    });
    const edit = (version: number) =>
      act(() => {
        scene = snapshot(version);
        hook.result.current.capture(document, scene);
      });
    return { document, api, edit };
  };

  it("binds an async save to its original document and preserves edits made during save", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.edit(2);
    let finish!: (file: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let saving!: Promise<boolean>;
    act(() => {
      saving = hook.result.current.requestSave(first.document);
    });
    const second = addDocument(hook);
    first.edit(3);
    const request = vi.mocked(desktop.saveFile).mock.calls[0][0];
    await act(async () => {
      finish(disk("/drawings/first.excalidraw", request.content));
      expect(await saving).toBe(true);
    });
    expect(first.document.path).toBe("/drawings/first.excalidraw");
    expect(first.document.dirty).toBe(true);
    expect(second.document.path).toBeNull();
    expect(second.document.dirty).toBe(false);
    expect(hook.result.current.activeId).toBe(second.document.id);
    expect(JSON.parse(request.content).elements[0].x).toBe(2);
  });

  it.each(["cancel", "failure"])(
    "retains dirty state when saving ends in %s",
    async (outcome) => {
      const hook = await mount();
      const first = addDocument(hook);
      first.edit(2);
      if (outcome === "cancel") {
        vi.mocked(desktop.saveFile).mockResolvedValue(null);
      } else {
        vi.mocked(desktop.saveFile).mockRejectedValue(
          new Error("disk unavailable"),
        );
      }
      await act(async () => {
        expect(await hook.result.current.requestSave(first.document)).toBe(
          false,
        );
      });
      expect(first.document.dirty).toBe(true);
      expect(first.document.path).toBeNull();
      expect(desktop.deleteDraft).not.toHaveBeenCalled();
      if (outcome === "failure") {
        expect(hook.result.current.error).toBe("disk unavailable");
      }
    },
  );

  it("restores the persisted active path instead of the last restored file", async () => {
    const firstPath = "/drawings/first.excalidraw";
    const secondPath = "/drawings/second.excalidraw";
    vi.mocked(desktop.getSession).mockResolvedValue({
      paths: [firstPath, secondPath],
      activePath: firstPath,
    });
    vi.mocked(desktop.readFile).mockImplementation(async (path) =>
      disk(path, createSceneTracker()(snapshot(path === firstPath ? 1 : 2))),
    );
    const hook = await mount();
    expect(hook.result.current.documents).toHaveLength(2);
    const active = hook.result.current.documents.find(
      (document) => document.id === hook.result.current.activeId,
    );
    expect(active?.path).toBe(firstPath);
    expect(hook.result.current.projectsVisible).toBe(false);
    expect(
      hook.result.current.documents.every(
        (document) => document.initialData.scrollToContent === true,
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(desktop.setSession).toHaveBeenLastCalledWith({
        paths: [firstPath, secondPath],
        activePath: firstPath,
      }),
    );
  });

  it("opens a saved path only once", async () => {
    const hook = await mount();
    const content = createSceneTracker()(snapshot());
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk("/drawings/a.excalidraw", content),
    ]);
    await act(async () => {
      await hook.result.current.openFiles();
    });
    const first = hook.result.current.documents[0];
    await act(async () => {
      await hook.result.current.openFiles();
    });
    expect(hook.result.current.documents).toEqual([first]);
    expect(hook.result.current.activeId).toBe(first.id);
    expect(desktop.recordOpenedFile).toHaveBeenCalledTimes(2);
    expect(desktop.recordOpenedFile).toHaveBeenLastCalledWith(first.path);
  });

  it("records successfully opened external files and refreshes history", async () => {
    const hook = await mount();
    const path = "/outside/external.excalidraw";
    const file: RecentFile = {
      path,
      relativePath: path,
      name: "external.excalidraw",
      category: "",
      modifiedAt: 123,
      size: 100,
      lastOpenedAt: 200,
    };
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk(path, createSceneTracker()(snapshot())),
      disk("/outside/invalid.excalidraw", "{"),
    ]);
    vi.mocked(desktop.listProjects).mockResolvedValue({
      rootDirectory: "/drawings",
      files: [],
      folders: [],
      history: [file],
    });
    await act(async () => {
      await hook.result.current.openFiles();
    });
    expect(desktop.recordOpenedFile).toHaveBeenCalledTimes(1);
    expect(desktop.recordOpenedFile).toHaveBeenCalledWith(path);
    expect(hook.result.current.documents).toHaveLength(1);
    expect(hook.result.current.index.history).toEqual([file]);
    await act(async () => {
      await hook.result.current.closeDocument(
        hook.result.current.documents[0].id,
      );
    });
    expect(hook.result.current.documents).toHaveLength(0);
    expect(hook.result.current.index.history).toEqual([file]);
  });

  it("updates history when opening a project already in a tab without reading it again", async () => {
    const hook = await mount();
    const path = "/outside/existing.excalidraw";
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk(path, createSceneTracker()(snapshot())),
    ]);
    await act(async () => {
      await hook.result.current.openFiles();
    });
    const opened = hook.result.current.documents[0];
    await act(async () => {
      await hook.result.current.openProject({
        path,
        relativePath: path,
        name: "existing.excalidraw",
        category: "",
        modifiedAt: 123,
        size: 100,
      });
    });
    expect(hook.result.current.documents).toEqual([opened]);
    expect(desktop.readFile).not.toHaveBeenCalled();
    expect(desktop.recordOpenedFile).toHaveBeenCalledTimes(2);
  });

  it("keeps an opened canvas usable when history registration fails", async () => {
    const hook = await mount();
    const path = "/outside/usable.excalidraw";
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk(path, createSceneTracker()(snapshot())),
    ]);
    vi.mocked(desktop.recordOpenedFile).mockRejectedValue(
      new Error("history unavailable"),
    );
    await act(async () => {
      await hook.result.current.openFiles();
    });
    expect(hook.result.current.documents).toHaveLength(1);
    expect(hook.result.current.documents[0].path).toBe(path);
    expect(hook.result.current.projectsVisible).toBe(false);
    expect(hook.result.current.error).toBe("history unavailable");
  });

  it("refreshes history after saving a new canvas outside the default folder", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    const path = "/outside/saved.excalidraw";
    vi.mocked(desktop.saveFile).mockResolvedValue(
      disk(path, first.document.content),
    );
    const history: RecentFile[] = [
      {
        path,
        relativePath: path,
        name: "saved.excalidraw",
        category: "",
        modifiedAt: 123,
        size: 100,
        lastOpenedAt: 200,
      },
    ];
    vi.mocked(desktop.listProjects).mockResolvedValue({
      rootDirectory: "/drawings",
      files: [],
      folders: [],
      history,
    });
    await act(async () => {
      expect(await hook.result.current.requestSave(first.document)).toBe(true);
    });
    expect(hook.result.current.index.history).toEqual(history);
    expect(desktop.recordOpenedFile).not.toHaveBeenCalled();
  });

  it("shows external history without a default folder and previews never register opens", async () => {
    const history: RecentFile[] = [
      {
        path: "/outside/older.excalidraw",
        relativePath: "/outside/older.excalidraw",
        name: "older.excalidraw",
        category: "",
        modifiedAt: 999,
        size: 100,
        lastOpenedAt: 100,
      },
      {
        path: "/another/latest.excalidraw",
        relativePath: "/another/latest.excalidraw",
        name: "latest.excalidraw",
        category: "",
        modifiedAt: 123,
        size: 100,
        lastOpenedAt: 200,
      },
    ];
    vi.mocked(desktop.getSettings).mockResolvedValue({
      rootDirectory: null,
      theme: "system",
    });
    vi.mocked(desktop.listProjects).mockResolvedValue({
      rootDirectory: null,
      files: [],
      folders: [],
      history,
    });
    vi.mocked(desktop.readFile).mockImplementation(async (path) =>
      disk(path, createSceneTracker()(snapshot())),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe() {
          this.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        disconnect() {}
      },
    );
    const hook = await mount();
    const onEdit = vi.fn();
    const view = render(
      createElement(Projects, {
        root,
        workspace: hook.result.current,
        theme: "light",
        onEdit,
        onSettings: vi.fn(),
        onRecovery: vi.fn(),
      }),
    );
    expect(view.getByRole("heading", { name: "历史画布" })).toBeInTheDocument();
    const cards = view.container.querySelectorAll(".desktop-file-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("latest");
    expect(cards[0]).toHaveTextContent("/another");
    expect(cards[1]).toHaveTextContent("/outside");
    fireEvent.click(
      view.getByRole("button", { name: "latest.excalidraw 的操作" }),
    );
    expect(
      (
        view.getByRole("menuitem", {
          name: "移入默认文件夹分类",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(view.getByRole("menuitem", { name: "重命名" }));
    expect(onEdit).toHaveBeenCalledWith({ kind: "rename", file: history[1] });
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(".desktop-file-preview img"),
      ).toHaveLength(2),
    );
    expect(desktop.readFile).toHaveBeenCalledTimes(2);
    expect(desktop.recordOpenedFile).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "全部画布 0" }));
    expect(
      view.getByRole("heading", { name: "设置默认文件夹以浏览画布" }),
    ).toBeInTheDocument();
    expect(view.container.querySelectorAll(".desktop-file-card")).toHaveLength(
      0,
    );
  });

  it("checks every dirty canvas before closing a window and cancels without losing tabs", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    const second = addDocument(hook);
    first.edit(2);
    second.edit(3);
    act(() => command("close-window"));
    await waitFor(() =>
      expect(hook.result.current.closePrompt?.title).toBe(first.document.title),
    );
    act(() => hook.result.current.closePrompt!.resolve("discard"));
    await waitFor(() =>
      expect(hook.result.current.activeId).toBe(second.document.id),
    );
    act(() => hook.result.current.closePrompt!.resolve("cancel"));
    await waitFor(() => expect(desktop.cancelClose).toHaveBeenCalledTimes(1));
    expect(desktop.confirmClose).not.toHaveBeenCalled();
    expect(hook.result.current.documents).toHaveLength(2);
    expect(desktop.deleteDraft).not.toHaveBeenCalled();
    expect(first.api.commitEditing).toHaveBeenCalled();
    expect(second.api.commitEditing).toHaveBeenCalled();
  });

  it("rechecks an earlier canvas edited while a later canvas is saving during window close", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    const second = addDocument(hook);
    second.edit(2);
    let finish!: (file: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => command("close-window"));
    await waitFor(() => expect(hook.result.current.closePrompt).not.toBeNull());
    expect(hook.result.current.closing).toBe(true);
    act(() => hook.result.current.closePrompt!.resolve("save"));
    await waitFor(() => expect(desktop.saveFile).toHaveBeenCalledTimes(1));
    act(() => command("new"));
    expect(hook.result.current.documents).toHaveLength(2);
    first.edit(3);
    const request = vi.mocked(desktop.saveFile).mock.calls[0][0];
    await act(async () => {
      finish(disk("/drawings/second.excalidraw", request.content));
    });
    await waitFor(() =>
      expect(hook.result.current.activeId).toBe(first.document.id),
    );
    expect(hook.result.current.closePrompt).not.toBeNull();
    expect(desktop.confirmClose).not.toHaveBeenCalled();
    act(() => hook.result.current.closePrompt!.resolve("cancel"));
    await waitFor(() => expect(desktop.cancelClose).toHaveBeenCalledTimes(1));
    expect(first.document.dirty).toBe(true);
    expect(hook.result.current.closing).toBe(false);
  });

  it("restores a recovery draft separately from its original disk path", async () => {
    const hook = await mount();
    const draft = {
      id: "recovery",
      path: "/drawings/a.excalidraw",
      title: "a",
      content: createSceneTracker()(snapshot()),
      modifiedAt: 100,
    };
    await act(async () => {
      expect(await hook.result.current.recover(draft)).toBe(true);
    });
    expect(hook.result.current.documents[0]).toMatchObject({
      id: "recovery",
      path: null,
      dirty: true,
      recovered: true,
    });
    expect(desktop.saveFile).not.toHaveBeenCalled();
  });

  it("deduplicates two concurrent recoveries of the same draft", async () => {
    const hook = await mount();
    const draft = {
      id: "recovery",
      path: "/drawings/a.excalidraw",
      title: "a",
      content: createSceneTracker()(snapshot()),
      modifiedAt: 100,
    };
    await act(async () => {
      expect(
        await Promise.all([
          hook.result.current.recover(draft),
          hook.result.current.recover(draft),
        ]),
      ).toEqual([true, true]);
    });
    expect(hook.result.current.documents).toHaveLength(1);
    expect(hook.result.current.documents[0].id).toBe(draft.id);
  });

  it.each(["rename", "move"] as const)(
    "preserves the original read timestamp after %s so external changes still conflict",
    async (operation) => {
      const hook = await mount();
      const first = addDocument(hook);
      first.document.path = "/drawings/original.excalidraw";
      first.document.modifiedAt = 123;
      first.edit(2);
      const file = {
        path: first.document.path,
        relativePath: "original.excalidraw",
        name: "original.excalidraw",
        category: "",
        modifiedAt: 123,
        size: 100,
      };
      const migrated = {
        path: "/drawings/renamed.excalidraw",
        content: createSceneTracker()(snapshot(10)),
        modifiedAt: 999,
        size: 200,
      };
      vi.mocked(desktop.renameFile).mockResolvedValue(migrated);
      vi.mocked(desktop.moveFile).mockResolvedValue(migrated);
      vi.mocked(desktop.saveFile).mockResolvedValue(null);
      await act(async () => {
        expect(
          await hook.result.current.mutateFile(operation, file, "renamed"),
        ).toBe(true);
      });
      expect(first.document.modifiedAt).toBe(123);
      expect(first.document.path).toBe(migrated.path);
      await act(async () => {
        await hook.result.current.requestSave(first.document);
      });
      expect(desktop.saveFile).toHaveBeenCalledWith(
        expect.objectContaining({
          path: migrated.path,
          expectedModifiedAt: 123,
        }),
      );
    },
  );

  it("renames an unsaved tab and uses the name for its first save", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    await act(async () => {
      expect(
        await hook.result.current.renameDocument(
          first.document.id,
          "草图.excalidraw",
        ),
      ).toBe(true);
    });
    expect(first.document.title).toBe("草图");
    expect(first.document.path).toBeNull();
    expect(first.document.dirty).toBe(false);
    expect(desktop.renameFile).not.toHaveBeenCalled();
    vi.mocked(desktop.saveFile).mockResolvedValue(null);
    await act(async () => {
      await hook.result.current.requestSave(first.document);
    });
    expect(desktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "草图", path: null }),
    );
  });

  it("renames a dirty saved tab without changing its content or conflict baseline", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/outside/original.excalidraw";
    first.document.modifiedAt = 123;
    first.edit(3);
    const content = first.document.content;
    const renamedPath = "/outside/新名称.excalidraw";
    vi.mocked(desktop.renameFile).mockResolvedValue({
      ...disk(renamedPath, "external content"),
      modifiedAt: 999,
    });
    await act(async () => {
      expect(
        await hook.result.current.renameDocument(first.document.id, "新名称"),
      ).toBe(true);
    });
    expect(desktop.renameFile).toHaveBeenCalledWith(
      "/outside/original.excalidraw",
      "新名称",
    );
    expect(first.document.path).toBe(renamedPath);
    expect(first.document.title).toBe("新名称");
    expect(first.document.modifiedAt).toBe(123);
    expect(first.document.content).toBe(content);
    expect(first.document.dirty).toBe(true);
    expect(first.api.commitEditing).toHaveBeenCalled();
    vi.mocked(desktop.saveFile).mockResolvedValue(null);
    await act(async () => {
      await hook.result.current.requestSave(first.document);
    });
    expect(desktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: renamedPath, expectedModifiedAt: 123 }),
    );
  });

  it("waits for an in-flight first save before renaming its resulting file", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    let finish!: (file: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(desktop.renameFile).mockResolvedValue(
      disk("/outside/after.excalidraw", first.document.content),
    );
    let saving!: Promise<boolean>;
    let renaming!: Promise<boolean>;
    act(() => {
      saving = hook.result.current.requestSave(first.document);
      renaming = hook.result.current.renameDocument(first.document.id, "after");
    });
    expect(desktop.renameFile).not.toHaveBeenCalled();
    await act(async () => {
      finish(disk("/outside/before.excalidraw", first.document.content));
      expect(await saving).toBe(true);
      expect(await renaming).toBe(true);
    });
    expect(desktop.renameFile).toHaveBeenCalledWith(
      "/outside/before.excalidraw",
      "after",
    );
    expect(first.document.path).toBe("/outside/after.excalidraw");
  });

  it("retains title and dirty content when disk renaming fails", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/drawings/original.excalidraw";
    first.edit(2);
    const title = first.document.title;
    const content = first.document.content;
    vi.mocked(desktop.renameFile).mockRejectedValue(new Error("已有同名文件"));
    await act(async () => {
      expect(
        await hook.result.current.renameDocument(first.document.id, "occupied"),
      ).toBe(false);
    });
    expect(first.document.title).toBe(title);
    expect(first.document.content).toBe(content);
    expect(first.document.dirty).toBe(true);
    expect(hook.result.current.error).toBe("已有同名文件");
  });

  it.each([
    "",
    ".",
    "..",
    ".excalidraw",
    "../outside",
    "bad/name",
    "bad\\name",
  ])("rejects invalid tab name %j before touching disk", async (name) => {
    const hook = await mount();
    const first = addDocument(hook);
    await act(async () => {
      expect(
        await hook.result.current.renameDocument(first.document.id, name),
      ).toBe(false);
    });
    expect(first.document.title).toBe("未命名");
    expect(desktop.renameFile).not.toHaveBeenCalled();
  });

  it("blocks native canvas commands while a desktop modal is open", async () => {
    const hook = renderHook(({ blocked }) => useWorkspace(root, blocked), {
      initialProps: { blocked: true },
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => {
      command("new");
      command("close-window");
    });
    expect(hook.result.current.documents).toHaveLength(0);
    expect(desktop.cancelClose).toHaveBeenCalledTimes(1);
    expect(desktop.confirmClose).not.toHaveBeenCalled();
    hook.rerender({ blocked: false });
    act(() => command("new"));
    expect(hook.result.current.documents).toHaveLength(1);
  });

  it("passes other open paths to native save so another tab cannot be overwritten", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    const second = addDocument(hook);
    second.document.path = "/drawings/second.excalidraw";
    first.edit(2);
    vi.mocked(desktop.saveFile).mockResolvedValue(null);
    await act(async () => {
      await hook.result.current.requestSave(first.document, true);
    });
    expect(desktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: first.document.id,
        occupiedPaths: ["/drawings/second.excalidraw"],
        saveAs: true,
      }),
    );
  });
});
