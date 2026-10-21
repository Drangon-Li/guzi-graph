import { createElement } from "react";

import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";

import { loadFromBlob } from "@excalidraw/excalidraw";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import { getSystemFontId } from "@excalidraw/common";
import {
  createTableData,
  createTableElements,
  syncTableData,
} from "@excalidraw/element/table";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createSceneTracker } from "../../shared/model/document";
import { DEFAULT_EDITOR_PREFERENCES } from "../../shared/config/editorPreferences";
import { Projects } from "../projects/Projects";

import { bundledExamples } from "../examples/catalog";

import { useWorkspace } from "./workspace";

import type { SceneSnapshot } from "../../shared/model/document";
import type {
  DesktopAPI,
  DesktopCommand,
  DiskDocument,
  DesktopSettings,
  ProjectFile,
  RecentFile,
} from "../../../shared/desktop-api";
import type { CanvasDocument } from "./workspace";

vi.mock("@excalidraw/excalidraw", async (original) => {
  const actual = await original<typeof import("@excalidraw/excalidraw")>();
  return { ...actual, loadFromBlob: vi.fn(actual.loadFromBlob) };
});

const settings: DesktopSettings = {
  rootDirectory: "/drawings",
  theme: "system",
  toolPanelDock: "floating",
  toolPanelWidth: 280,
  language: "zh-CN",
  structuredExportFormat: "json",
  includeInferredStructure: true,
  skipRemoveConfirmation: false,
  skipTrashConfirmation: false,
};

const projectFile = (path: string): ProjectFile => ({
  path,
  name: path.split("/").pop()!,
  relativePath: path,
  category: "",
  modifiedAt: 123,
  size: 100,
});

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
      getSettings: vi.fn().mockResolvedValue(settings),
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
      savePdf: vi.fn(),
      editText: vi.fn().mockResolvedValue(undefined),
      removeFile: vi.fn().mockResolvedValue(undefined),
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

  it("opens a complete unsaved copy, drafts its subscenes and saves only to the chosen location", async () => {
    const hook = await mount();
    const source = bundledExamples[0].content;
    let copy!: CanvasDocument;
    await act(async () => {
      copy = (await hook.result.current.openUnsavedCopy(
        "Transformer",
        source,
      ))!;
    });
    expect(copy.path).toBeNull();
    expect(copy.savedContent).toBeNull();
    expect(copy.recovered).toBe(false);
    expect(copy.title).toBe("Transformer");
    expect(copy.initialData.scrollToContent).toBe(true);
    expect(copy.initialData.elements).toHaveLength(114);
    expect(Object.keys(copy.initialData.appState!.subscenes!)).toHaveLength(5);
    const scene: SceneSnapshot = {
      elements: copy.initialData.elements!,
      appState: { ...snapshot().appState, ...copy.initialData.appState },
      files: copy.initialData.files || {},
    };
    const api = {
      isDestroyed: false,
      getSceneElementsIncludingDeleted: () => scene.elements,
      getAppState: () => scene.appState,
      getFiles: () => scene.files,
    } as unknown as ExcalidrawImperativeAPI;
    act(() => hook.result.current.initialize(copy, api));
    expect(copy.savedContent).toBeNull();
    expect(copy.dirty).toBe(true);
    await waitFor(() => expect(desktop.writeDraft).toHaveBeenCalled());
    const draft = vi.mocked(desktop.writeDraft).mock.calls.at(-1)![0];
    expect(draft.path).toBeNull();
    expect(
      Object.keys(JSON.parse(draft.content).appState.subscenes),
    ).toHaveLength(5);
    scene.elements = scene.elements.map((element, index) =>
      index === 0
        ? { ...element, x: element.x + 20, version: element.version + 1 }
        : element,
    );
    const destination = "/drawings/My Transformer.excalidraw";
    vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
      disk(destination, request.content),
    );
    await act(async () => {
      expect(await hook.result.current.editorSave(copy, scene, false)).toBe(
        true,
      );
    });
    expect(desktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: null,
        name: "Transformer",
        saveAs: false,
      }),
    );
    expect(copy.path).toBe(destination);
    expect(copy.dirty).toBe(false);
    expect(
      Object.keys(JSON.parse(copy.savedContent!).appState.subscenes),
    ).toHaveLength(5);
    expect(desktop.readFile).not.toHaveBeenCalled();
    expect(bundledExamples[0].content).toBe(source);
    expect(JSON.parse(source).elements[0].x).not.toBe(scene.elements[0].x);
    hook.unmount();
  });

  it("updates font and color shortcuts in root and active child editors without duplicate API updates", async () => {
    const hook = await mount();
    const { document, api } = addDocument(hook);
    api.updateScene = vi.fn();
    const child = {
      updateScene: vi.fn(),
      getAppState: () => ({
        ...getDefaultAppState(),
        colorTopPicks: {
          ...getDefaultAppState().colorTopPicks,
          bucketFill: ["#abcdef"],
        },
      }),
    } as unknown as ExcalidrawImperativeAPI;
    document.activeEditor = () => child;
    const editorPreferences = {
      ...DEFAULT_EDITOR_PREFERENCES,
      fontTopPicks: [2, 3],
      elementStrokeTopPicks: ["transparent", "#112233"],
      elementBackgroundTopPicks: ["#445566"],
    };
    vi.mocked(desktop.updateSettings).mockResolvedValue({
      ...settings,
      editorPreferences,
    });
    await act(async () => {
      await hook.result.current.updateSettings({ editorPreferences });
    });
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(child.updateScene).toHaveBeenCalledTimes(1);
    expect(api.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          fontTopPicks: [2, 3],
          colorTopPicks: expect.objectContaining({
            elementStroke: ["transparent", "#112233"],
            elementBackground: ["#445566"],
          }),
        }),
      }),
    );
    expect(child.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          fontTopPicks: [2, 3],
          colorTopPicks: expect.objectContaining({
            elementStroke: ["transparent", "#112233"],
            elementBackground: ["#445566"],
          }),
        }),
      }),
    );
    expect(child.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        appState: expect.objectContaining({
          colorTopPicks: expect.objectContaining({ bucketFill: ["#abcdef"] }),
        }),
      }),
    );
    vi.mocked(api.updateScene).mockClear();
    vi.mocked(child.updateScene).mockClear();
    document.activeEditor = () => api;
    await act(async () => {
      await hook.result.current.updateSettings({ editorPreferences });
    });
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(child.updateScene).not.toHaveBeenCalled();
  });

  it("remembers sticky mode in new drawings and synchronizes open root and child editors", async () => {
    vi.mocked(desktop.getSettings).mockResolvedValue({
      ...settings,
      stickyNoteMode: "subcanvas",
    });
    const hook = await mount();
    const { document, api } = addDocument(hook);
    expect(document.initialData?.appState?.currentItemStickyNoteMode).toBe(
      "subcanvas",
    );
    api.updateScene = vi.fn();
    const child = {
      updateScene: vi.fn(),
    } as unknown as ExcalidrawImperativeAPI;
    document.activeEditor = () => child;
    vi.mocked(desktop.updateSettings).mockResolvedValue({
      ...settings,
      stickyNoteMode: "note",
    });
    await act(async () => {
      await hook.result.current.updateSettings({ stickyNoteMode: "note" });
    });
    for (const editor of [api, child]) {
      expect(editor.updateScene).toHaveBeenCalledTimes(1);
      expect(editor.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({
          appState: { currentItemStickyNoteMode: "note" },
        }),
      );
    }
    let next!: CanvasDocument;
    act(() => {
      next = hook.result.current.newDocument();
    });
    expect(next.initialData?.appState?.currentItemStickyNoteMode).toBe("note");
  });

  it("loads named default fonts and background preferences into new drawings", async () => {
    const family = "Workspace installed font";
    const id = getSystemFontId(family);
    vi.mocked(desktop.getSettings).mockResolvedValue({
      ...settings,
      editorPreferences: {
        ...DEFAULT_EDITOR_PREFERENCES,
        defaultFontFamily: id,
        defaultFontName: family,
        defaultBackground: "#ddeeff",
        defaultStrokeColor: "#123456",
        defaultElementBackground: "transparent",
        elementStrokeTopPicks: ["#123456"],
        elementBackgroundTopPicks: ["transparent", "#abcdef"],
        systemFonts: [{ id, family }],
        fontTopPicks: [id, 5],
      },
    });
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newDocument();
    });
    expect(document.initialData.appState).toMatchObject({
      currentItemFontFamily: id,
      viewBackgroundColor: "#ddeeff",
      currentItemStrokeColor: "#123456",
      currentItemBackgroundColor: "transparent",
      colorTopPicks: {
        elementStroke: ["#123456"],
        elementBackground: ["transparent", "#abcdef"],
      },
      fontTopPicks: [id, 5],
      fontRegistry: { [id]: family },
    });
  });

  it("flushes the active editor and captures its aggregate snapshot when renaming", async () => {
    const hook = await mount();
    const { document, api } = addDocument(hook);
    const aggregate = snapshot(7);
    document.flushEditing = vi.fn();
    document.getSnapshot = () => aggregate;
    await act(async () => {
      await hook.result.current.renameDocument(document.id, "Renamed");
    });
    expect(document.flushEditing).toHaveBeenCalledTimes(1);
    expect(api.commitEditing).not.toHaveBeenCalled();
    expect(JSON.parse(document.content).elements[0].x).toBe(7);
  });

  it("saves the active child editor and persists its latest aggregate snapshot", async () => {
    const hook = await mount();
    const { document, api } = addDocument(hook);
    const aggregate = snapshot(4);
    aggregate.elements = [
      {
        ...aggregate.elements[0],
        type: "stickynote",
        customData: { subcanvas: { sceneId: "child" } },
      } as ExcalidrawElement,
    ];
    aggregate.appState.subscenes = {
      child: {
        version: 1,
        title: "Nested",
        elements: [{ ...snapshot(7).elements[0], id: "latest-child-shape" }],
        appState: {},
      },
    };
    document.getSnapshot = () => aggregate;
    const childSave = vi.fn((saveAs: boolean) =>
      hook.result.current.editorSave(document, document.getSnapshot!(), saveAs),
    );
    document.activeEditor = () =>
      ({ desktopSave: childSave } as unknown as ExcalidrawImperativeAPI);
    vi.spyOn(api, "desktopSave");
    vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
      disk("/drawings/nested.excalidraw", request.content),
    );
    await act(async () => {
      expect(await hook.result.current.requestSave(document)).toBe(true);
    });
    expect(childSave).toHaveBeenCalledWith(false);
    expect(api.desktopSave).not.toHaveBeenCalled();
    const saved = JSON.parse(
      vi.mocked(desktop.saveFile).mock.calls[0][0].content,
    );
    expect(saved.appState.subscenes.child.elements[0]).toMatchObject({
      id: "latest-child-shape",
      x: 7,
    });
  });

  it("stays clean after saving native table edits and closes without another save prompt", async () => {
    const hook = await mount();
    const { document, api } = addDocument(hook);
    const table = createTableElements(createTableData(1, 1), 0, 0);
    const scene: SceneSnapshot = {
      ...snapshot(),
      elements: table.elements.map((element) =>
        element.type === "text"
          ? {
              ...element,
              text: "Saved table cell",
              originalText: "Saved table cell",
              version: element.version + 1,
            }
          : element,
      ),
    };
    api.getSceneElementsIncludingDeleted = () =>
      scene.elements as ReturnType<
        ExcalidrawImperativeAPI["getSceneElementsIncludingDeleted"]
      >;
    api.getAppState = () => scene.appState;
    api.desktopSave = (saveAs = false) =>
      hook.result.current.editorSave(document, scene, saveAs);
    vi.mocked(desktop.saveFile).mockImplementation(async (request) => {
      hook.result.current.capture(document, {
        ...scene,
        elements: syncTableData(scene.elements),
      });
      return disk("/drawings/table.excalidraw", request.content);
    });
    await act(async () => {
      expect(await hook.result.current.requestSave(document)).toBe(true);
    });
    expect(document.dirty).toBe(false);
    act(() =>
      hook.result.current.capture(document, {
        ...scene,
        elements: syncTableData(scene.elements),
      }),
    );
    expect(document.dirty).toBe(false);
    expect(document.content).toBe(document.savedContent);
    expect(document.content).toContain("Saved table cell");
    await act(async () => {
      expect(await hook.result.current.closeDocument(document.id)).toBe(true);
    });
    expect(hook.result.current.closePrompt).toBeNull();
    expect(hook.result.current.documents).toHaveLength(0);
  });

  it("discards native table edits once when closing the window without reopening the prompt", async () => {
    const hook = await mount();
    const { document, api } = addDocument(hook);
    const table = createTableElements(createTableData(1, 1), 0, 0);
    const scene: SceneSnapshot = {
      ...snapshot(),
      elements: table.elements.map((element) =>
        element.type === "text"
          ? {
              ...element,
              text: "Discarded cell edit",
              originalText: "Discarded cell edit",
              version: element.version + 1,
            }
          : element,
      ),
    };
    api.getSceneElementsIncludingDeleted = () =>
      scene.elements as ReturnType<
        ExcalidrawImperativeAPI["getSceneElementsIncludingDeleted"]
      >;
    api.getAppState = () => scene.appState;
    vi.mocked(api.commitEditing).mockImplementation(() =>
      hook.result.current.capture(document, {
        ...scene,
        elements: syncTableData(scene.elements),
      }),
    );
    act(() =>
      hook.result.current.capture(document, {
        ...scene,
        elements: syncTableData(scene.elements),
      }),
    );
    act(() => command("close-window"));
    await waitFor(() => expect(hook.result.current.closePrompt).not.toBeNull());
    const revision = document.revision;
    act(() => hook.result.current.closePrompt!.resolve("discard"));
    await waitFor(() => expect(desktop.confirmClose).toHaveBeenCalledTimes(1));
    expect(hook.result.current.closePrompt).toBeNull();
    expect(document.revision).toBe(revision);
    expect(desktop.saveFile).not.toHaveBeenCalled();
  });

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
      ...settings,
      rootDirectory: null,
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
        onRemove: vi.fn(),
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
  it.each(["remove", "trash"] as const)(
    "locks a canvas until %s succeeds, then clears its tab and draft",
    async (mode) => {
      const hook = await mount();
      const first = addDocument(hook);
      first.document.path = "/drawings/original.excalidraw";
      let finish!: () => void;
      vi.mocked(desktop.removeFile).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let removing!: Promise<boolean>;
      act(() => {
        removing = hook.result.current.removeFile(
          projectFile(first.document.path!),
          mode,
        );
      });
      await waitFor(() =>
        expect(desktop.removeFile).toHaveBeenCalledWith(
          first.document.path,
          mode,
        ),
      );
      expect(first.api.commitEditing).toHaveBeenCalled();
      expect(hook.result.current.closing).toBe(true);
      expect(hook.result.current.documents).toContain(first.document);
      expect(desktop.deleteDraft).not.toHaveBeenCalled();
      await act(async () => {
        expect(await hook.result.current.requestSave(first.document)).toBe(
          false,
        );
        expect(
          await hook.result.current.editorSave(
            first.document,
            snapshot(5),
            false,
          ),
        ).toBe(false);
      });
      expect(desktop.saveFile).not.toHaveBeenCalled();
      await act(async () => {
        finish();
        expect(await removing).toBe(true);
      });
      expect(hook.result.current.documents).toHaveLength(0);
      expect(desktop.deleteDraft).toHaveBeenCalledWith(first.document.id);
      expect(hook.result.current.closing).toBe(false);
    },
  );

  it("cancels dirty removal without changing the active view, native file, or draft", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/drawings/original.excalidraw";
    first.edit(2);
    act(() => hook.result.current.showProjects());
    let removing!: Promise<boolean>;
    act(() => {
      removing = hook.result.current.removeFile(
        projectFile(first.document.path!),
        "remove",
      );
    });
    await waitFor(() => expect(hook.result.current.closePrompt).not.toBeNull());
    expect(hook.result.current.projectsVisible).toBe(true);
    await act(async () => {
      hook.result.current.closePrompt!.resolve("cancel");
      expect(await removing).toBe(false);
    });
    expect(desktop.removeFile).not.toHaveBeenCalled();
    expect(desktop.deleteDraft).not.toHaveBeenCalled();
    expect(hook.result.current.documents).toContain(first.document);
    expect(first.document.dirty).toBe(true);
    expect(first.document.removalPhase).toBeUndefined();
    expect(hook.result.current.projectsVisible).toBe(true);
  });

  it("keeps discarded dirty content and the tab when moving to Trash fails", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/drawings/original.excalidraw";
    first.edit(2);
    const content = first.document.content;
    vi.mocked(desktop.removeFile).mockRejectedValue(
      new Error("Trash unavailable"),
    );
    let removing!: Promise<boolean>;
    act(() => {
      removing = hook.result.current.removeFile(
        projectFile(first.document.path!),
        "trash",
      );
    });
    await waitFor(() => expect(hook.result.current.closePrompt).not.toBeNull());
    await act(async () => {
      hook.result.current.closePrompt!.resolve("discard");
      expect(await removing).toBe(false);
    });
    expect(hook.result.current.documents).toContain(first.document);
    expect(first.document.content).toBe(content);
    expect(first.document.dirty).toBe(true);
    expect(desktop.deleteDraft).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("Trash unavailable");
  });

  it("saves committed text before removing a dirty canvas and rejects competing saves", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/drawings/original.excalidraw";
    vi.mocked(first.api.commitEditing).mockImplementation(() => first.edit(3));
    let finish!: (value: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let removing!: Promise<boolean>;
    act(() => {
      removing = hook.result.current.removeFile(
        projectFile(first.document.path!),
        "trash",
      );
    });
    await waitFor(() => expect(hook.result.current.closePrompt).not.toBeNull());
    act(() => hook.result.current.closePrompt!.resolve("save"));
    await waitFor(() => expect(desktop.saveFile).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(vi.mocked(desktop.saveFile).mock.calls[0][0].content)
        .elements[0].x,
    ).toBe(3);
    expect(desktop.removeFile).not.toHaveBeenCalled();
    await act(async () => {
      expect(await hook.result.current.requestSave(first.document, true)).toBe(
        false,
      );
    });
    await act(async () => {
      finish(disk(first.document.path!, first.document.content));
      expect(await removing).toBe(true);
    });
    expect(desktop.removeFile).toHaveBeenCalledWith(
      "/drawings/original.excalidraw",
      "trash",
    );
    expect(hook.result.current.documents).toHaveLength(0);
  });

  it("waits for an ongoing Save As and preserves the tab rebound to its new path", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/drawings/original.excalidraw";
    const originalPath = first.document.path;
    let finish!: (value: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let saving!: Promise<boolean>;
    let removing!: Promise<boolean>;
    act(() => {
      saving = hook.result.current.requestSave(first.document, true);
      removing = hook.result.current.removeFile(
        projectFile(originalPath),
        "remove",
      );
    });
    expect(desktop.removeFile).not.toHaveBeenCalled();
    await act(async () => {
      finish(disk("/drawings/copy.excalidraw", first.document.content));
      expect(await saving).toBe(true);
      expect(await removing).toBe(true);
    });
    expect(desktop.removeFile).toHaveBeenCalledWith(originalPath, "remove");
    expect(hook.result.current.documents).toContain(first.document);
    expect(first.document.path).toBe("/drawings/copy.excalidraw");
  });

  it.each(["remove", "trash"] as const)(
    "preserves an unrecovered startup draft after %s of its clean disk document",
    async (mode) => {
      const draft = {
        id: "recovery",
        path: "/drawings/original.excalidraw",
        title: "Original title",
        content: createSceneTracker()(snapshot(2)),
        modifiedAt: 100,
      };
      vi.mocked(desktop.listDrafts).mockResolvedValue([draft]);
      vi.mocked(desktop.getSession).mockResolvedValue({
        paths: [draft.path],
        activePath: draft.path,
      });
      vi.mocked(desktop.readFile).mockResolvedValue(
        disk(draft.path, createSceneTracker()(snapshot())),
      );
      const hook = await mount();
      const original = hook.result.current.documents[0];
      expect(original).toMatchObject({
        path: draft.path,
        dirty: false,
        initialData: { elements: [{ id: "rectangle", x: 1 }] },
      });
      expect(hook.result.current.drafts).toEqual([draft]);
      await act(async () => {
        expect(
          await hook.result.current.removeFile(projectFile(draft.path), mode),
        ).toBe(true);
      });
      expect(hook.result.current.documents).toHaveLength(0);
      expect(hook.result.current.closePrompt).toBeNull();
      expect(hook.result.current.drafts).toEqual([draft]);
      expect(desktop.deleteDraft).toHaveBeenCalledWith(original.id);
      expect(desktop.deleteDraft).not.toHaveBeenCalledWith(draft.id);
      await act(async () => {
        expect(
          await hook.result.current.recover(hook.result.current.drafts[0]),
        ).toBe(true);
      });
      expect(desktop.writeDraft).toHaveBeenCalledWith({ ...draft, path: null });
      expect(hook.result.current.documents[0]).toMatchObject({
        id: draft.id,
        path: null,
        title: draft.title,
        initialData: { elements: [{ id: "rectangle", x: 2 }] },
        dirty: true,
        recovered: true,
      });
      expect(hook.result.current.drafts).toHaveLength(0);
    },
  );

  it("persists recovery as an independent draft and never closes it when removing its original file", async () => {
    const hook = await mount();
    const draft = {
      id: "recovery",
      path: "/drawings/original.excalidraw",
      title: "Original title",
      content: createSceneTracker()(snapshot()),
      modifiedAt: 100,
    };
    await act(async () => {
      expect(await hook.result.current.recover(draft)).toBe(true);
    });
    expect(desktop.writeDraft).toHaveBeenCalledWith({ ...draft, path: null });
    const recovered = hook.result.current.documents[0];
    await act(async () => {
      expect(
        await hook.result.current.removeFile(projectFile(draft.path), "trash"),
      ).toBe(true);
    });
    expect(hook.result.current.documents).toEqual([recovered]);
    expect(recovered.path).toBeNull();
    expect(recovered.title).toBe(draft.title);
    expect(desktop.deleteDraft).not.toHaveBeenCalled();
  });

  it("keeps recovery available when detaching its stored path fails", async () => {
    const hook = await mount();
    vi.mocked(desktop.writeDraft).mockRejectedValue(
      new Error("draft write failed"),
    );
    await act(async () => {
      expect(
        await hook.result.current.recover({
          id: "recovery",
          path: "/drawings/a.excalidraw",
          title: "a",
          content: createSceneTracker()(snapshot()),
          modifiedAt: 100,
        }),
      ).toBe(false);
    });
    expect(hook.result.current.documents).toHaveLength(0);
    expect(desktop.deleteDraft).not.toHaveBeenCalled();
  });

  it("changes the UI language without replacing existing documents or their names", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    vi.mocked(desktop.updateSettings).mockResolvedValue({
      ...settings,
      language: "en",
    });
    await act(async () => {
      await hook.result.current.updateSettings({ language: "en" });
    });
    expect(root.ownerDocument.documentElement.lang).toBe("en");
    expect(hook.result.current.documents[0]).toBe(first.document);
    expect(first.document.title).toBe("未命名");
    let newCanvas!: CanvasDocument;
    act(() => {
      newCanvas = hook.result.current.newDocument();
    });
    expect(newCanvas.title).toBe("Untitled");
  });

  it("routes native text undo while a desktop modal blocks canvas commands", async () => {
    const hook = renderHook(() => useWorkspace(root, true));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const input = root.ownerDocument.createElement("input");
    root.append(input);
    input.focus();
    await act(async () => {
      command("undo");
    });
    expect(desktop.editText).toHaveBeenCalledWith("undo");
  });
  it.each(["remove", "trash"] as const)(
    "ignores a delayed project read after %s succeeds, but permits an explicit later reopen",
    async (mode) => {
      const hook = await mount();
      const file = projectFile("/drawings/delayed.excalidraw");
      const source = disk(file.path, createSceneTracker()(snapshot()));
      let finishRead!: (value: DiskDocument) => void;
      vi.mocked(desktop.readFile).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      let opening!: Promise<void>;
      act(() => {
        opening = hook.result.current.openProject(file);
      });
      await waitFor(() =>
        expect(desktop.readFile).toHaveBeenCalledWith(file.path),
      );
      await act(async () => {
        expect(await hook.result.current.removeFile(file, mode)).toBe(true);
      });
      await act(async () => {
        finishRead(source);
        await opening;
      });
      expect(hook.result.current.documents).toHaveLength(0);
      expect(desktop.recordOpenedFile).not.toHaveBeenCalled();
      vi.mocked(desktop.readFile).mockResolvedValue(source);
      await act(async () => {
        await hook.result.current.openProject(file);
      });
      expect(hook.result.current.documents).toHaveLength(1);
      expect(desktop.recordOpenedFile).toHaveBeenCalledWith(file.path);
    },
  );

  it("ignores a scene parse begun before removal instead of recreating its tab and project history", async () => {
    const hook = await mount();
    const file = projectFile("/drawings/parsed.excalidraw");
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk(file.path, createSceneTracker()(snapshot())),
    ]);
    let finishParse!: (value: Awaited<ReturnType<typeof loadFromBlob>>) => void;
    vi.mocked(loadFromBlob).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishParse = resolve;
        }),
    );
    let opening!: Promise<void>;
    act(() => {
      opening = hook.result.current.openFiles();
    });
    await waitFor(() => expect(finishParse).toBeDefined());
    await act(async () => {
      expect(await hook.result.current.removeFile(file, "remove")).toBe(true);
    });
    await act(async () => {
      finishParse({ elements: [], appState: snapshot().appState, files: {} });
      await opening;
    });
    expect(hook.result.current.documents).toHaveLength(0);
    expect(desktop.recordOpenedFile).not.toHaveBeenCalled();
  });

  it("waits for a removal guard and resumes an existing open request when removal is cancelled", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    first.document.path = "/drawings/original.excalidraw";
    first.edit(2);
    const file = projectFile(first.document.path);
    let removing!: Promise<boolean>;
    let opening!: Promise<void>;
    act(() => {
      removing = hook.result.current.removeFile(file, "remove");
    });
    await waitFor(() => expect(hook.result.current.closePrompt).not.toBeNull());
    act(() => {
      opening = hook.result.current.openProject(file);
    });
    await act(async () => {});
    expect(desktop.recordOpenedFile).not.toHaveBeenCalled();
    await act(async () => {
      hook.result.current.closePrompt!.resolve("cancel");
      expect(await removing).toBe(false);
      await opening;
    });
    expect(hook.result.current.documents).toEqual([first.document]);
    expect(desktop.recordOpenedFile).toHaveBeenCalledWith(file.path);
    expect(desktop.removeFile).not.toHaveBeenCalled();
  });

  it("cancels a native window-close request during removal so the next close request can run", async () => {
    const hook = await mount();
    const file = projectFile("/drawings/removing.excalidraw");
    let finishRemoval!: () => void;
    vi.mocked(desktop.removeFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRemoval = resolve;
        }),
    );
    let removing!: Promise<boolean>;
    act(() => {
      removing = hook.result.current.removeFile(file, "remove");
    });
    await waitFor(() => expect(finishRemoval).toBeDefined());
    act(() => command("close-window"));
    expect(desktop.cancelClose).toHaveBeenCalledTimes(1);
    expect(desktop.confirmClose).not.toHaveBeenCalled();
    await act(async () => {
      finishRemoval();
      expect(await removing).toBe(true);
    });
    act(() => command("close-window"));
    await waitFor(() => expect(desktop.confirmClose).toHaveBeenCalledTimes(1));
  });
});
