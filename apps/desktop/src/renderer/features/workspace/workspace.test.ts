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
import { Fonts } from "@excalidraw/excalidraw/fonts";

import { FONT_FAMILY, getSystemFontId } from "@excalidraw/common";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  createTableData,
  createTableElements,
  syncTableData,
} from "@excalidraw/element/table";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type {
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { createSceneTracker } from "../../shared/model/document";
import { DEFAULT_EDITOR_PREFERENCES } from "../../shared/config/editorPreferences";
import { Projects } from "../projects/Projects";

import { bundledExamples } from "../examples/catalog";
import * as slideRenderer from "../presentation/renderSlide";
import * as canvasCommands from "../plugins/canvasCommands";
import {
  createPresentation,
  parsePresentation,
  serializePresentation,
} from "../presentation/model";

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
import type { PluginRequest, PluginResponse } from "../../../shared/plugins";

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
  let plugin: (request: PluginRequest) => void;
  let cancelPlugin: (requestId: string) => void;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    command = () => {};
    plugin = () => {};
    cancelPlugin = () => {};
    desktop = {
      getUpdateState: vi.fn(),
      checkStartupUpdate: vi.fn().mockResolvedValue(null),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      onUpdateState: vi.fn(() => () => {}),
      platform: "darwin",
      getUserPlugins: vi.fn().mockResolvedValue([]),
      installUserPlugin: vi.fn().mockResolvedValue([]),
      setUserPluginEnabled: vi.fn().mockResolvedValue([]),
      removeUserPlugin: vi.fn().mockResolvedValue([]),
      runUserPluginCommand: vi.fn().mockResolvedValue(null),
      onUserPluginState: vi.fn(() => () => {}),
      getSettings: vi.fn().mockResolvedValue(settings),
      getPlugins: vi.fn().mockResolvedValue([]),
      setPluginEnabled: vi.fn().mockResolvedValue([]),
      configurePlugin: vi.fn().mockResolvedValue([]),
      onPluginState: vi.fn(() => () => {}),
      onPluginRequest: vi.fn((callback) => {
        plugin = callback;
        return () => {};
      }),
      onPluginRequestCancelled: vi.fn((callback) => {
        cancelPlugin = callback;
        return () => {};
      }),
      respondPluginRequest: vi.fn(),
      setPluginHostReady: vi.fn().mockResolvedValue(undefined),
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
      exportPdf: vi.fn(),
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

  it("shares a pending file dialog between native-menu commands and renderer shortcuts", async () => {
    const hook = await mount();
    let finish!: (files: DiskDocument[]) => void;
    vi.mocked(desktop.openFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let opening!: Promise<void>;
    act(() => {
      command("open");
      opening = hook.result.current.openFiles();
      command("open");
    });
    expect(desktop.openFiles).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish([]);
      await opening;
    });
    await act(async () => hook.result.current.openFiles());
    expect(desktop.openFiles).toHaveBeenCalledTimes(2);
  });

  const addDocument = (hook: Awaited<ReturnType<typeof mount>>) => {
    let document!: CanvasDocument;
    let scene = snapshot();
    const api = {
      isDestroyed: false,
      getSceneElementsIncludingDeleted: () => scene.elements,
      getAppState: () => scene.appState,
      getFiles: () => scene.files,
      updateScene: vi.fn((update) => {
        scene = {
          ...scene,
          elements: update.elements ?? scene.elements,
          appState: { ...scene.appState, ...update.appState },
        };
      }),
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
    return {
      document,
      api,
      edit,
      captureScene: (next: SceneSnapshot) =>
        act(() => {
          scene = next;
          hook.result.current.capture(document, scene);
        }),
      setState: (update: Partial<SceneSnapshot["appState"]>) => {
        scene = { ...scene, appState: { ...scene.appState, ...update } };
      },
      changeWithoutCapture: (version: number) => {
        scene = snapshot(version);
      },
    };
  };

  let pluginSequence = 0;
  const sendPlugin = async (
    command: string,
    args: Record<string, unknown>,
    requestId = `transport-${++pluginSequence}`,
  ): Promise<PluginResponse> => {
    const previousResponses = vi.mocked(desktop.respondPluginRequest).mock.calls
      .length;
    await act(async () => plugin({ requestId, command, arguments: args }));
    await waitFor(() =>
      expect(
        vi
          .mocked(desktop.respondPluginRequest)
          .mock.calls.slice(previousResponses)
          .some(([response]) => response.requestId === requestId),
      ).toBe(true),
    );
    return vi
      .mocked(desktop.respondPluginRequest)
      .mock.calls.slice(previousResponses)
      .find(([response]) => response.requestId === requestId)![0];
  };

  it("captures unsaved edits before checking plugin revisions and submits once per requestId", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    const read = await sendPlugin("read_canvas", {
      documentId: item.document.id,
    });
    const revision = (read.result as any).revision;
    item.changeWithoutCapture(5);
    const conflict = await sendPlugin("apply_operations", {
      documentId: item.document.id,
      expectedRevision: revision,
      requestId: "stale",
      operations: [{ type: "patch", id: "rectangle", patch: { x: 42 } }],
    });
    expect(conflict.error?.code).toBe("REVISION_CONFLICT");
    expect(item.api.updateScene).not.toHaveBeenCalled();
    const args = {
      documentId: item.document.id,
      expectedRevision: item.document.revision,
      requestId: "write-once",
      operations: [{ type: "patch", id: "rectangle", patch: { x: 42 } }],
    };
    const response = await sendPlugin("apply_operations", args);
    expect(response.error).toBeUndefined();
    expect((response.result as any).revision).toBeGreaterThan(
      args.expectedRevision,
    );
    expect(item.api.updateScene).toHaveBeenCalledTimes(1);
    expect(item.api.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({ captureUpdate: "IMMEDIATELY" }),
    );
    expect(item.api.getSceneElementsIncludingDeleted()[0].x).toBe(42);
    expect((await sendPlugin("apply_operations", args)).result).toEqual(
      response.result,
    );
    expect(item.api.updateScene).toHaveBeenCalledTimes(1);
    expect(
      (
        await sendPlugin("apply_operations", {
          ...args,
          operations: [{ type: "delete", id: "rectangle" }],
        })
      ).error?.code,
    ).toBe("REQUEST_ID_CONFLICT");
    hook.unmount();
    expect(desktop.setPluginHostReady).toHaveBeenLastCalledWith(false);
  });

  it("deduplicates ordinary requests only until the current task settles", async () => {
    const hook = await mount();
    let finish!: (
      index: Awaited<ReturnType<DesktopAPI["listProjects"]>>,
    ) => void;
    const projects = vi.mocked(desktop.listProjects);
    projects.mockClear();
    projects.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const request = {
      requestId: "reused-read",
      command: "list_canvases",
      arguments: {},
    };
    await act(async () => {
      plugin(request);
      plugin(request);
    });
    expect(projects).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({
        rootDirectory: "/drawings",
        files: [],
        folders: [],
        history: [],
      });
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(desktop.respondPluginRequest)
          .mock.calls.filter(
            ([response]) => response.requestId === "reused-read",
          ),
      ).toHaveLength(2),
    );
    expect(projects).toHaveBeenCalledTimes(1);
    await sendPlugin("list_canvases", {}, "reused-read");
    expect(projects).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("allows the same mutation request ID to retry after a failed task", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    const loadFonts = vi
      .spyOn(canvasCommands, "loadCanvasOperationFonts")
      .mockRejectedValueOnce(new Error("Font loading failed"))
      .mockResolvedValue(undefined);
    const args = {
      documentId: item.document.id,
      expectedRevision: item.document.revision,
      requestId: "retry-failed-mutation",
      operations: [{ type: "patch", id: "rectangle", patch: { x: 42 } }],
    };
    try {
      const failed = await sendPlugin("apply_operations", args);
      expect(failed.error?.message).toBe("Font loading failed");
      expect(item.api.updateScene).not.toHaveBeenCalled();
      const retried = await sendPlugin("apply_operations", args);
      expect(retried.error).toBeUndefined();
      expect(item.api.updateScene).toHaveBeenCalledTimes(1);
      expect((await sendPlugin("apply_operations", args)).result).toEqual(
        retried.result,
      );
      expect(item.api.updateScene).toHaveBeenCalledTimes(1);
    } finally {
      loadFonts.mockRestore();
    }
  });

  it("clears a closed document's idempotent results while retaining another open document's results", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    const second = addDocument(hook);
    const sets = vi.spyOn(Map.prototype, "set");
    const args = {
      documentId: first.document.id,
      expectedRevision: first.document.revision,
      requestId: "closed-document-result",
      operations: [{ type: "patch", id: "rectangle", patch: { x: 42 } }],
    };
    const secondArgs = {
      ...args,
      documentId: second.document.id,
      expectedRevision: second.document.revision,
      requestId: "open-document-result",
    };
    const firstKey = `apply_operations:${first.document.id}:${args.requestId}`;
    const secondKey = `apply_operations:${second.document.id}:${secondArgs.requestId}`;
    try {
      expect(
        (await sendPlugin("apply_operations", args)).error,
      ).toBeUndefined();
      expect(
        (await sendPlugin("apply_operations", secondArgs)).error,
      ).toBeUndefined();
      const index = sets.mock.calls.findIndex(([key]) => key === firstKey);
      const cache = sets.mock.contexts[index] as Map<string, unknown>;
      expect(cache.has(firstKey)).toBe(true);
      expect(cache.has(secondKey)).toBe(true);
      vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
        disk("/drawings/closed.excalidraw", request.content),
      );
      expect(
        (await sendPlugin("save_canvas", { documentId: first.document.id }))
          .error,
      ).toBeUndefined();
      expect(
        (await sendPlugin("close_document", { documentId: first.document.id }))
          .error,
      ).toBeUndefined();
      expect(cache.has(firstKey)).toBe(false);
      expect(cache.has(secondKey)).toBe(true);
      expect((await sendPlugin("apply_operations", args)).error?.code).toBe(
        "NOT_FOUND",
      );
      expect(
        (await sendPlugin("apply_operations", secondArgs)).error,
      ).toBeUndefined();
      expect(second.api.updateScene).toHaveBeenCalledTimes(1);
    } finally {
      sets.mockRestore();
    }
  });

  it("keeps read, save and close available when persistent mutation history is full", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    const sets = vi.spyOn(Map.prototype, "set");
    try {
      await sendPlugin(
        "read_canvas",
        { documentId: item.document.id },
        "history-cache",
      );
      const index = sets.mock.calls.findIndex(
        ([key]) => key === "request:history-cache",
      );
      const cache = sets.mock.contexts[index] as Map<string, unknown>;
      for (let index = 0; index < 10000; index++) {
        cache.set(`apply_operations:${item.document.id}:history-${index}`, {
          fingerprint: `history-${index}`,
          task: Promise.resolve({}),
          documentId: item.document.id,
        });
      }
      expect(cache.size).toBe(10000);
      const mutation = await sendPlugin("apply_operations", {
        documentId: item.document.id,
        expectedRevision: item.document.revision,
        requestId: "new-history",
        operations: [{ type: "patch", id: "rectangle", patch: { x: 42 } }],
      });
      expect(mutation.error?.code).toBe("BUSY");
      expect(mutation.error?.message).toContain("Save and close");
      expect(item.api.updateScene).not.toHaveBeenCalled();
      expect(
        (await sendPlugin("read_canvas", { documentId: item.document.id }))
          .error,
      ).toBeUndefined();
      vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
        disk("/drawings/full-history.excalidraw", request.content),
      );
      expect(
        (await sendPlugin("save_canvas", { documentId: item.document.id }))
          .error,
      ).toBeUndefined();
      expect(desktop.saveFile).toHaveBeenCalledTimes(1);
      expect(cache.size).toBe(10000);
      expect(
        (await sendPlugin("close_document", { documentId: item.document.id }))
          .error,
      ).toBeUndefined();
      expect(cache.size).toBe(0);
      expect(hook.result.current.documents).not.toContain(item.document);
    } finally {
      sets.mockRestore();
    }
  });

  it("does not remove a replacement cache entry when an older ordinary request finishes", async () => {
    const hook = await mount();
    let finish!: (
      index: Awaited<ReturnType<DesktopAPI["listProjects"]>>,
    ) => void;
    vi.mocked(desktop.listProjects).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const sets = vi.spyOn(Map.prototype, "set");
    try {
      await act(async () =>
        plugin({
          requestId: "late-read",
          command: "list_canvases",
          arguments: {},
        }),
      );
      expect(typeof finish).toBe("function");
      const index = sets.mock.calls.findIndex(
        ([key]) => key === "request:late-read",
      );
      const cache = sets.mock.contexts[index] as Map<string, unknown>;
      const replacement = {
        fingerprint: "new task",
        task: Promise.resolve({}),
      };
      cache.set("request:late-read", replacement);
      await act(async () => {
        finish({
          rootDirectory: "/drawings",
          files: [],
          folders: [],
          history: [],
        });
      });
      await waitFor(() =>
        expect(desktop.respondPluginRequest).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: "late-read" }),
        ),
      );
      expect(cache.get("request:late-read")).toBe(replacement);
      cache.delete("request:late-read");
    } finally {
      sets.mockRestore();
      hook.unmount();
    }
  });

  it("rechecks unsaved edits after waiting for operation fonts", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    let finishFonts!: () => void;
    const fonts = vi
      .spyOn(canvasCommands, "loadCanvasOperationFonts")
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishFonts = resolve)),
      );
    try {
      await act(async () =>
        plugin({
          requestId: "font-race",
          command: "apply_operations",
          arguments: {
            documentId: item.document.id,
            expectedRevision: item.document.revision,
            requestId: "font-race-write",
            operations: [{ type: "patch", id: "rectangle", patch: { x: 42 } }],
          },
        }),
      );
      expect(fonts).toHaveBeenCalledWith(expect.any(Array), root.ownerDocument);
      expect(item.api.updateScene).not.toHaveBeenCalled();
      item.changeWithoutCapture(5);
      await act(async () => finishFonts());
      await waitFor(() =>
        expect(desktop.respondPluginRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: "font-race",
            error: expect.objectContaining({ code: "REVISION_CONFLICT" }),
          }),
        ),
      );
      expect(item.api.updateScene).not.toHaveBeenCalled();
      expect(item.api.getSceneElementsIncludingDeleted()[0].version).toBe(5);
    } finally {
      fonts.mockRestore();
      hook.unmount();
    }
  });

  it("rejects plugin writes while typing, dragging or editing a subcanvas", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    for (const update of [
      { cursorButton: "down" as const },
      { cursorButton: "up" as const, editingTextElement: {} as any },
    ]) {
      item.setState(update);
      expect(
        (
          await sendPlugin("apply_operations", {
            documentId: item.document.id,
            expectedRevision: item.document.revision,
            requestId: `busy-${pluginSequence}`,
            operations: [{ type: "delete", id: "rectangle" }],
          })
        ).error?.code,
      ).toBe("BUSY");
    }
    item.setState({ editingTextElement: null });
    item.document.activeEditor = () => null;
    expect(
      (await sendPlugin("save_canvas", { documentId: item.document.id })).error
        ?.code,
    ).toBe("BUSY");
    expect(item.api.updateScene).not.toHaveBeenCalled();
    expect(item.api.commitEditing).not.toHaveBeenCalled();
  });

  it("saves plugin canvases through automation and propagates write errors", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    vi.mocked(desktop.saveFile).mockResolvedValue(
      disk("/drawings/automation.excalidraw", item.document.content),
    );
    const saved = await sendPlugin("save_canvas", {
      documentId: item.document.id,
    });
    expect(saved.error).toBeUndefined();
    expect(desktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ automation: true, path: null }),
    );
    expect((saved.result as any).path).toBe("/drawings/automation.excalidraw");
    vi.mocked(desktop.saveFile).mockRejectedValue(
      new Error("File changed on disk"),
    );
    const failed = await sendPlugin("save_canvas", {
      documentId: item.document.id,
    });
    expect(failed.error?.message).toBe("File changed on disk");
  });

  it("acknowledges create_canvas only after the mounted canvas initializes", async () => {
    const hook = await mount();
    await act(async () =>
      plugin({
        requestId: "create-mounted",
        command: "create_canvas",
        arguments: { title: "Automation drawing" },
      }),
    );
    const document = hook.result.current.documents[0];
    expect(document.title).toBe("Automation drawing");
    expect(desktop.respondPluginRequest).not.toHaveBeenCalled();
    const scene = snapshot();
    const api = {
      isDestroyed: false,
      getSceneElementsIncludingDeleted: () => scene.elements,
      getAppState: () => scene.appState,
      getFiles: () => scene.files,
    } as ExcalidrawImperativeAPI;
    act(() => hook.result.current.initialize(document, api));
    await waitFor(() =>
      expect(desktop.respondPluginRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "create-mounted",
          result: expect.objectContaining({
            documentId: document.id,
            initialized: true,
            dirty: true,
          }),
        }),
      ),
    );
  });

  it("opens authorized canvas files and waits for initialization", async () => {
    const hook = await mount();
    const scene = snapshot();
    vi.mocked(desktop.readFile).mockResolvedValue(
      disk("/drawings/known.excalidraw", createSceneTracker()(scene)),
    );
    await act(async () =>
      plugin({
        requestId: "open-mounted",
        command: "open_canvas",
        arguments: { path: "/drawings/known.excalidraw" },
      }),
    );
    await waitFor(() => expect(hook.result.current.documents).toHaveLength(1));
    const document = hook.result.current.documents[0];
    const api = {
      isDestroyed: false,
      getSceneElementsIncludingDeleted: () => scene.elements,
      getAppState: () => scene.appState,
      getFiles: () => scene.files,
    } as ExcalidrawImperativeAPI;
    act(() => hook.result.current.initialize(document, api));
    await waitFor(() =>
      expect(desktop.respondPluginRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "open-mounted",
          result: expect.objectContaining({
            path: "/drawings/known.excalidraw",
            initialized: true,
          }),
        }),
      ),
    );
    expect(desktop.readFile).toHaveBeenCalledWith("/drawings/known.excalidraw");
  });

  it("opens a canvas alias using the canonical path returned by storage", async () => {
    const hook = await mount();
    const path = "/private/var/folders/drawings/known.excalidraw";
    const alias = "/var/folders/drawings/known.excalidraw";
    vi.mocked(desktop.readFile).mockResolvedValue(
      disk(path, createSceneTracker()(snapshot())),
    );

    const opened = await sendMountedPlugin(hook, "open_canvas", {
      path: alias,
    });

    expect(opened.error).toBeUndefined();
    expect(opened.result).toMatchObject({
      documentId: hook.result.current.documents[0].id,
      path,
      initialized: true,
    });
    expect(hook.result.current.documents).toHaveLength(1);
    expect(desktop.readFile).toHaveBeenCalledWith(alias);
  });

  it("reuses the canonical canvas when its alias is opened again", async () => {
    const hook = await mount();
    const path = "/private/var/folders/drawings/known.excalidraw";
    const alias = "/var/folders/drawings/known.excalidraw";
    vi.mocked(desktop.readFile).mockResolvedValue(
      disk(path, createSceneTracker()(snapshot())),
    );
    const first = await sendMountedPlugin(hook, "open_canvas", { path });
    expect(first.error).toBeUndefined();
    const documentId = hook.result.current.documents[0].id;

    const reopened = await sendMountedPlugin(hook, "open_canvas", {
      path: alias,
    });

    expect(reopened.error).toBeUndefined();
    expect(reopened.result).toMatchObject({
      documentId,
      path,
      initialized: true,
    });
    expect(hook.result.current.documents).toHaveLength(1);
    expect(desktop.readFile).toHaveBeenLastCalledWith(alias);
  });

  it("does not open a canvas after the pending plugin request is cancelled", async () => {
    const hook = await mount();
    let finishRead!: (file: DiskDocument) => void;
    vi.mocked(desktop.readFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    await act(async () =>
      plugin({
        requestId: "cancel-open",
        command: "open_canvas",
        arguments: { path: "/drawings/cancel.excalidraw" },
      }),
    );
    cancelPlugin("cancel-open");
    await act(async () =>
      finishRead(
        disk("/drawings/cancel.excalidraw", createSceneTracker()(snapshot())),
      ),
    );
    expect(hook.result.current.documents).toHaveLength(0);
    expect(desktop.respondPluginRequest).not.toHaveBeenCalled();
  });

  it("rejects expired writes before touching the live canvas", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    await act(async () =>
      plugin({
        requestId: "expired-write",
        expiresAt: Date.now() - 1,
        command: "apply_operations",
        arguments: {
          documentId: item.document.id,
          expectedRevision: item.document.revision,
          requestId: "expired",
          operations: [{ type: "delete", id: "rectangle" }],
        },
      }),
    );
    expect(desktop.respondPluginRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "expired-write",
        error: expect.objectContaining({ code: "TIMEOUT" }),
      }),
    );
    expect(item.api.updateScene).not.toHaveBeenCalled();
  });

  it("does not start another automatic save after cancellation while waiting for an existing save", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    let finishSave!: (saved: boolean) => void;
    item.document.saving = new Promise((resolve) => {
      finishSave = resolve;
    });
    await act(async () =>
      plugin({
        requestId: "cancel-save",
        command: "save_canvas",
        arguments: { documentId: item.document.id },
      }),
    );
    cancelPlugin("cancel-save");
    await act(async () => {
      item.document.saving = null;
      finishSave(true);
    });
    expect(desktop.saveFile).not.toHaveBeenCalled();
    expect(desktop.respondPluginRequest).not.toHaveBeenCalled();
  });

  const attachSlide = (
    hook: Awaited<ReturnType<typeof mount>>,
    document: CanvasDocument,
  ) => {
    let scene: SceneSnapshot = {
      elements: document.initialData.elements ?? [],
      appState: { ...snapshot().appState, ...document.initialData.appState },
      files: document.initialData.files ?? {},
    };
    const api = {
      isDestroyed: false,
      getSceneElementsIncludingDeleted: () => scene.elements,
      getAppState: () => scene.appState,
      getFiles: () => scene.files,
      commitEditing: vi.fn(),
      history: { checkpoint: vi.fn() },
      updateScene: vi.fn((update) => {
        scene = {
          ...scene,
          elements: update.elements ?? scene.elements,
          appState: { ...scene.appState, ...update.appState },
        };
      }),
      addFiles: vi.fn((files) => {
        scene.files = {
          ...scene.files,
          ...Object.fromEntries(files.map((file: any) => [file.id, file])),
        };
      }),
      desktopSave: (saveAs: boolean) =>
        hook.result.current.editorSave(document, scene, saveAs),
    } as unknown as ExcalidrawImperativeAPI;
    act(() => hook.result.current.initialize(document, api));
    const edit = (next: SceneSnapshot) =>
      act(() => {
        scene = next;
        hook.result.current.capture(document, scene);
      });
    return { api, edit };
  };

  const presentationContent = () => {
    const deck = createPresentation("first", "Opening", snapshot(11));
    deck.slides.push({ id: "second", title: "Details", scene: snapshot(22) });
    return serializePresentation(deck);
  };

  const sendMountedPlugin = async (
    hook: Awaited<ReturnType<typeof mount>>,
    command: string,
    args: Record<string, unknown>,
  ): Promise<PluginResponse> => {
    const requestId = `mounted-${++pluginSequence}`;
    await act(async () => plugin({ requestId, command, arguments: args }));
    await waitFor(() => {
      for (const document of hook.result.current.documents) {
        if (!document.api) {
          attachSlide(hook, document);
        }
      }
      expect(
        vi
          .mocked(desktop.respondPluginRequest)
          .mock.calls.some(([response]) => response.requestId === requestId),
      ).toBe(true);
    });
    return vi
      .mocked(desktop.respondPluginRequest)
      .mock.calls.find(([response]) => response.requestId === requestId)![0];
  };

  it("runs the MCP presentation lifecycle with idempotent page operations and genuine close/reopen", async () => {
    const hook = await mount();
    const created = await sendMountedPlugin(hook, "create_presentation", {
      title: "MCP deck",
    });
    expect(created.error).toBeUndefined();
    const document = hook.result.current.documents[0];
    const first = document.activeSlideId!;
    const addArgs = {
      documentId: document.id,
      expectedRevision: document.revision,
      requestId: "add-once",
      operation: { type: "add", title: "Methods" },
    };
    const added = await sendMountedPlugin(hook, "update_presentation", addArgs);
    expect(added.error).toBeUndefined();
    const second = document.activeSlideId!;
    expect(document.presentation!.slides.map((slide) => slide.title)).toEqual([
      "第 1 页",
      "Methods",
    ]);
    expect(
      (await sendMountedPlugin(hook, "update_presentation", addArgs)).result,
    ).toEqual(added.result);
    expect(document.presentation!.slides).toHaveLength(2);
    const update = (operation: Record<string, unknown>) =>
      sendMountedPlugin(hook, "update_presentation", {
        documentId: document.id,
        expectedRevision: document.revision,
        requestId: `change-${pluginSequence}`,
        operation,
      });
    expect(
      (await update({ type: "duplicate", slideId: second })).error,
    ).toBeUndefined();
    const third = document.activeSlideId!;
    expect(
      (await update({ type: "rename", slideId: third, title: "Results" }))
        .error,
    ).toBeUndefined();
    expect(
      (await update({ type: "move", slideId: third, toIndex: 0 })).error,
    ).toBeUndefined();
    expect(document.presentation!.slides.map((slide) => slide.id)).toEqual([
      third,
      first,
      second,
    ]);
    expect(
      (await update({ type: "delete", slideId: second })).error,
    ).toBeUndefined();
    expect(
      (await update({ type: "select", slideId: first })).error,
    ).toBeUndefined();
    const dirtyClose = await sendPlugin("close_document", {
      documentId: document.id,
    });
    expect(dirtyClose.error?.code).toBe("UNSAVED_CHANGES");
    expect(hook.result.current.closePrompt).toBeNull();
    vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
      disk("/drawings/MCP deck.guzi-presentation", request.content),
    );
    const saved = await sendPlugin("save_presentation", {
      documentId: document.id,
    });
    expect(saved.error).toBeUndefined();
    expect(document.dirty).toBe(false);
    expect(desktop.saveFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: "presentation", automation: true }),
    );
    const persisted = document.content;
    expect(
      (await sendPlugin("close_document", { documentId: document.id })).result,
    ).toMatchObject({ closed: true });
    expect(hook.result.current.documents).toHaveLength(0);
    vi.mocked(desktop.readFile).mockResolvedValue(
      disk("/drawings/MCP deck.guzi-presentation", persisted),
    );
    const opened = await sendMountedPlugin(hook, "open_canvas", {
      path: "/drawings/MCP deck.guzi-presentation",
    });
    expect(opened.error).toBeUndefined();
    expect(opened.result).toMatchObject({
      kind: "presentation",
      dirty: false,
      slides: [{ id: third, title: "Results" }, { id: first }],
    });
    expect((opened.result as any).documentId).not.toBe(document.id);
  });

  it("edits an explicit inactive slide without switching or changing another slide", async () => {
    const hook = await mount();
    const created = await sendMountedPlugin(hook, "create_presentation", {
      title: "Targeted edits",
    });
    expect(created.error).toBeUndefined();
    const document = hook.result.current.documents[0];
    const first = document.activeSlideId!;
    await sendMountedPlugin(hook, "update_presentation", {
      documentId: document.id,
      expectedRevision: document.revision,
      requestId: "add-target",
      operation: { type: "add" },
    });
    const second = document.activeSlideId!;
    const currentApi = document.api!;
    const args = {
      documentId: document.id,
      slideId: first,
      expectedRevision: document.revision,
      requestId: "inactive-edit",
      operations: [
        {
          type: "create",
          tempId: "shape",
          element: {
            type: "rectangle",
            x: 100,
            y: 100,
            width: 120,
            height: 60,
            label: { text: "Only first" },
          },
        },
      ],
    };
    const edited = await sendPlugin("apply_operations", args);
    expect(edited.error).toBeUndefined();
    expect(document.activeSlideId).toBe(second);
    expect(currentApi.updateScene).not.toHaveBeenCalled();
    expect(
      (
        await sendPlugin("read_canvas", {
          documentId: document.id,
          slideId: first,
        })
      ).result,
    ).toMatchObject({
      elements: [
        expect.objectContaining({ type: "rectangle" }),
        expect.objectContaining({ originalText: "Only first" }),
      ],
    });
    expect(
      (
        await sendPlugin("read_canvas", {
          documentId: document.id,
          slideId: second,
        })
      ).result,
    ).toMatchObject({ elements: [] });
    expect((await sendPlugin("apply_operations", args)).result).toEqual(
      edited.result,
    );
    const invalid = await sendPlugin("apply_operations", {
      ...args,
      requestId: "missing-slide",
      slideId: "missing",
    });
    expect(invalid.error?.code).toBe("NOT_FOUND");
    expect(
      (
        await sendPlugin("apply_operations", {
          ...args,
          requestId: "stale-page",
        })
      ).error?.code,
    ).toBe("REVISION_CONFLICT");
  });

  it("copies a slide across documents while preserving source content and file identity", async () => {
    const hook = await mount();
    await sendMountedPlugin(hook, "create_presentation", {
      title: "Source deck",
    });
    const source = hook.result.current.documents[0];
    const sourceSlide = source.activeSlideId!;
    await sendPlugin("apply_operations", {
      documentId: source.id,
      expectedRevision: source.revision,
      requestId: "source-content",
      operations: [
        {
          type: "create",
          element: { type: "text", text: "Cross-deck", x: 10, y: 10 },
        },
      ],
    });
    const original = source.content;
    await sendMountedPlugin(hook, "create_presentation", {
      title: "Destination deck",
    });
    const target = hook.result.current.documents[1];
    const result = await sendMountedPlugin(hook, "update_presentation", {
      documentId: target.id,
      expectedRevision: target.revision,
      requestId: "cross-deck-copy",
      operation: {
        type: "copy_from",
        sourceDocumentId: source.id,
        sourceSlideId: sourceSlide,
      },
    });
    expect(result.error).toBeUndefined();
    expect(target.presentation!.slides).toHaveLength(2);
    expect(target.activeSlideId).not.toBe(sourceSlide);
    expect(
      (await sendPlugin("read_canvas", { documentId: target.id })).result,
    ).toMatchObject({
      elements: [expect.objectContaining({ originalText: "Cross-deck" })],
    });
    expect(source.content).toBe(original);
  });

  it("routes presentation controls to the mounted UI and blocks content edits during playback", async () => {
    const hook = await mount();
    await sendMountedPlugin(hook, "create_presentation", { title: "Playback" });
    const document = hook.result.current.documents[0];
    const execute = vi.fn(async (command) => {
      if (command.action === "start") {
        document.presenting = true;
      }
      if (command.action === "stop") {
        document.presenting = false;
      }
      return {
        presenting: !!document.presenting,
        slideId: document.activeSlideId!,
        index: 0,
        slideCount: 1,
        fullscreen: false,
      };
    });
    document.presentationController = { execute };
    expect(
      (
        await sendPlugin("control_presentation", {
          documentId: document.id,
          action: "start",
        })
      ).result,
    ).toMatchObject({ presenting: true });
    expect(execute).toHaveBeenCalledWith({ action: "start" });
    expect(
      (
        await sendPlugin("update_presentation", {
          documentId: document.id,
          expectedRevision: document.revision,
          requestId: "playing-add",
          operation: { type: "add" },
        })
      ).error?.code,
    ).toBe("BUSY");
    expect(
      (
        await sendPlugin("control_presentation", {
          documentId: document.id,
          action: "status",
        })
      ).result,
    ).toMatchObject({ presenting: true });
    expect(
      (
        await sendPlugin("control_presentation", {
          documentId: document.id,
          action: "stop",
        })
      ).result,
    ).toMatchObject({ presenting: false });
    expect(
      (
        await sendPlugin("update_presentation", {
          documentId: document.id,
          expectedRevision: document.revision,
          requestId: "last-slide",
          operation: { type: "delete", slideId: document.activeSlideId },
        })
      ).error?.code,
    ).toBe("INVALID_ARGUMENT");
  });

  it("rejects controls when a user switches away while the requested slide is mounting", async () => {
    const hook = await mount();
    await sendMountedPlugin(hook, "create_presentation", {
      title: "Switch race",
    });
    const document = hook.result.current.documents[0];
    const first = document.activeSlideId!;
    await sendMountedPlugin(hook, "update_presentation", {
      documentId: document.id,
      expectedRevision: document.revision,
      requestId: "race-add",
      operation: { type: "add" },
    });
    const second = document.activeSlideId!;
    await act(async () =>
      plugin({
        requestId: "race-control",
        command: "control_canvas",
        arguments: {
          documentId: document.id,
          slideId: first,
          action: "zoom",
          zoom: 2,
        },
      }),
    );
    expect(document.api).toBeNull();
    act(() => hook.result.current.selectSlide(document, second));
    const other = attachSlide(hook, document);
    await waitFor(() =>
      expect(desktop.respondPluginRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "race-control",
          error: expect.objectContaining({ code: "BUSY" }),
        }),
      ),
    );
    expect(other.api.updateScene).not.toHaveBeenCalled();
  });

  it("keeps export page metadata stable and bounds large PNG output without cropping", async () => {
    const hook = await mount();
    await sendMountedPlugin(hook, "create_presentation", {
      title: "Export snapshot",
    });
    const document = hook.result.current.documents[0];
    const first = document.activeSlideId!;
    await sendMountedPlugin(hook, "update_presentation", {
      documentId: document.id,
      expectedRevision: document.revision,
      requestId: "export-add",
      operation: { type: "add" },
    });
    const second = document.activeSlideId!;
    let finish!: (blob: Blob) => void;
    const render = vi.spyOn(slideRenderer, "renderSlidePng").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = sendPlugin("export_presentation", {
        documentId: document.id,
        format: "png",
      });
      await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
      act(() => hook.result.current.selectSlide(document, first));
      attachSlide(hook, document);
      finish(new Blob(["png"], { type: "image/png" }));
      expect((await pending).result).toMatchObject({ slideId: second });
      document.presentation!.width = 8192;
      document.presentation!.height = 4608;
      render.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
      expect(
        (
          await sendPlugin("export_presentation", {
            documentId: document.id,
            format: "png",
          })
        ).error,
      ).toBeUndefined();
      expect(render).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bounds: { x: 0, y: 0, width: 8192, height: 4608 },
        }),
        4096,
        2304,
        root.ownerDocument,
      );
    } finally {
      render.mockRestore();
    }
  });

  it("releases completed large export results and executes a reused transport ID again", async () => {
    const hook = await mount();
    await sendMountedPlugin(hook, "create_presentation", {
      title: "Large export",
    });
    const document = hook.result.current.documents[0];
    const render = vi.spyOn(slideRenderer, "renderSlidePng").mockResolvedValue(
      new Blob([new Uint8Array(2 * 1024 * 1024).fill(1)], {
        type: "image/png",
      }),
    );
    const sets = vi.spyOn(Map.prototype, "set");
    try {
      const args = { documentId: document.id, format: "png" };
      const first = await sendPlugin(
        "export_presentation",
        args,
        "large-export",
      );
      expect(first.error).toBeUndefined();
      const index = sets.mock.calls.findIndex(
        ([key]) => key === "request:large-export",
      );
      const cache = sets.mock.contexts[index] as Map<string, unknown>;
      expect((first.result as any).image.data.length).toBeGreaterThan(
        2 * 1024 * 1024,
      );
      expect(cache.has("request:large-export")).toBe(false);
      const firstPrefix = (first.result as any).image.data.slice(0, 64);
      render.mockResolvedValue(
        new Blob([new Uint8Array(2 * 1024 * 1024).fill(2)], {
          type: "image/png",
        }),
      );
      const second = await sendPlugin(
        "export_presentation",
        args,
        "large-export",
      );
      expect(second.error).toBeUndefined();
      expect(render).toHaveBeenCalledTimes(2);
      expect((second.result as any).image.data.slice(0, 64)).not.toBe(
        firstPrefix,
      );
      expect(cache.has("request:large-export")).toBe(false);
    } finally {
      sets.mockRestore();
      render.mockRestore();
    }
  });

  it("exports either the complete PDF or an explicit single page without a save dialog", async () => {
    const hook = await mount();
    await sendMountedPlugin(hook, "create_presentation", {
      title: "PDF export",
    });
    const document = hook.result.current.documents[0];
    const first = document.activeSlideId!;
    await sendMountedPlugin(hook, "update_presentation", {
      documentId: document.id,
      expectedRevision: document.revision,
      requestId: "pdf-add",
      operation: { type: "add" },
    });
    vi.mocked(desktop.exportPdf).mockResolvedValue(
      new TextEncoder().encode("%PDF-1.7 test").buffer,
    );
    const pages = vi
      .spyOn(slideRenderer, "renderPresentationPdfPages")
      .mockImplementation(async (deck) =>
        deck.slides.map((slide) => ({
          title: slide.title,
          svg: "<svg/>",
          width: 1280,
          height: 720,
        })),
      );
    try {
      const all = await sendPlugin("export_presentation", {
        documentId: document.id,
        format: "pdf",
      });
      expect(all.result).toMatchObject({
        file: { mimeType: "application/pdf", name: "PDF export.pdf" },
      });
      expect(pages.mock.lastCall![0].slides).toHaveLength(2);
      expect(desktop.exportPdf).toHaveBeenLastCalledWith(
        expect.objectContaining({ pages: [expect.anything()] }),
      );
      expect(
        (
          await sendPlugin("export_presentation", {
            documentId: document.id,
            format: "pdf",
            slideId: first,
          })
        ).error,
      ).toBeUndefined();
      expect(pages.mock.lastCall![0].slides.map((slide) => slide.id)).toEqual([
        first,
      ]);
      expect(desktop.exportPdf).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ pages: expect.anything() }),
      );
      expect(desktop.savePdf).not.toHaveBeenCalled();
    } finally {
      pages.mockRestore();
    }
  });

  it("creates a presentation from the native command and saves every edited page with its own images", async () => {
    const hook = await mount();
    act(() => command("new-presentation"));
    const document = hook.result.current.documents[0];
    expect(document).toMatchObject({
      path: null,
      title: "未命名演示文稿",
      dirty: true,
      unsavedCopy: true,
      presentation: { width: 1280, height: 720, slides: [{}] },
    });
    const firstId = document.activeSlideId!;
    const first = attachSlide(hook, document);
    const imageScene = (version: number): SceneSnapshot => {
      const scene = snapshot(version);
      return {
        ...scene,
        elements: [
          {
            ...scene.elements[0],
            type: "image",
            fileId: "image",
            status: "saved",
            scale: [1, 1],
          } as ExcalidrawElement,
        ],
        files: {
          image: {
            id: "image" as any,
            mimeType: "image/png",
            dataURL: `data:image/png;base64,page${version}` as any,
            created: 1,
          },
        },
      };
    };
    first.edit(imageScene(11));
    act(() => hook.result.current.addSlide(document));
    const secondId = document.activeSlideId!;
    expect(secondId).not.toBe(firstId);
    const second = attachSlide(hook, document);
    second.edit(imageScene(22));
    act(() => hook.result.current.selectSlide(document, firstId));
    const firstAgain = attachSlide(hook, document);
    firstAgain.edit(imageScene(33));
    vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
      disk("/drawings/talk.guzi-presentation", request.content),
    );
    await act(async () => {
      expect(await hook.result.current.requestSave(document)).toBe(true);
    });
    const request = vi.mocked(desktop.saveFile).mock.calls[0][0];
    expect(request).toMatchObject({ format: "presentation", path: null });
    const saved = await parsePresentation(
      request.content,
      root.ownerDocument.defaultView!,
    );
    expect(saved!.slides.map((slide) => slide.id)).toEqual([firstId, secondId]);
    expect(saved!.slides.map((slide) => slide.scene.elements![0].x)).toEqual([
      33, 22,
    ]);
    expect(
      saved!.slides.map((slide) => slide.scene.files!.image.dataURL),
    ).toEqual(["data:image/png;base64,page33", "data:image/png;base64,page22"]);
    expect(document.dirty).toBe(false);
    expect(document.path).toBe("/drawings/talk.guzi-presentation");
    expect(document.title).toBe("talk");
  });

  it("retains edits made on another page while an earlier complete presentation save is pending", async () => {
    const hook = await mount();
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk("/drawings/talk.guzi-presentation", presentationContent()),
    ]);
    await act(async () => hook.result.current.openFiles());
    const document = hook.result.current.documents[0];
    const first = attachSlide(hook, document);
    first.edit(snapshot(33));
    let finish!: (file: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let saving!: Promise<boolean>;
    act(() => {
      saving = hook.result.current.requestSave(document);
    });
    const submitted = vi.mocked(desktop.saveFile).mock.calls[0][0].content;
    act(() => hook.result.current.selectSlide(document, "second"));
    const second = attachSlide(hook, document);
    second.edit(snapshot(44));
    await act(async () => {
      finish(disk("/drawings/talk.guzi-presentation", submitted));
      expect(await saving).toBe(true);
    });
    expect(document.savedContent).toBe(submitted);
    expect(document.dirty).toBe(true);
    expect(
      JSON.parse(document.savedContent!).slides.map(
        (slide: any) => slide.scene.elements[0].x,
      ),
    ).toEqual([33, 22]);
    expect(
      JSON.parse(document.content).slides.map(
        (slide: any) => slide.scene.elements[0].x,
      ),
    ).toEqual([33, 44]);
    await waitFor(() => expect(desktop.writeDraft).toHaveBeenCalled());
    expect(vi.mocked(desktop.writeDraft).mock.calls.at(-1)![0]).toMatchObject({
      path: "/drawings/talk.guzi-presentation",
      content: document.content,
    });
    expect(desktop.deleteDraft).not.toHaveBeenCalled();
  });

  it("reopens all presentation pages and preserves the saved baseline when switching pages", async () => {
    const hook = await mount();
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk("/drawings/talk.guzi-presentation", presentationContent()),
    ]);
    await act(async () => hook.result.current.openFiles());
    const document = hook.result.current.documents[0];
    const first = attachSlide(hook, document);
    expect(document.dirty).toBe(false);
    expect(document.initialData.elements![0].x).toBe(11);
    const saved = document.savedContent;
    act(() => hook.result.current.selectSlide(document, "second"));
    attachSlide(hook, document);
    expect(document.initialData.elements![0].x).toBe(22);
    expect(document.savedContent).toBe(saved);
    expect(document.dirty).toBe(false);
    act(() => hook.result.current.selectSlide(document, "first"));
    const firstAgain = attachSlide(hook, document);
    firstAgain.edit(snapshot(33));
    expect(first.api.commitEditing).toHaveBeenCalled();
    act(() => hook.result.current.selectSlide(document, "second"));
    attachSlide(hook, document);
    expect(document.savedContent).toBe(saved);
    expect(document.dirty).toBe(true);
    act(() => hook.result.current.selectSlide(document, "first"));
    attachSlide(hook, document);
    expect(document.initialData.elements![0].x).toBe(33);
  });

  it("recovers complete presentation drafts as independent unsaved documents", async () => {
    const draft = {
      id: "presentation-recovery",
      path: "/drawings/talk.guzi-presentation",
      title: "Recovered talk",
      content: presentationContent(),
      modifiedAt: 100,
    };
    vi.mocked(desktop.listDrafts).mockResolvedValue([draft]);
    const hook = await mount();
    await act(async () => {
      expect(await hook.result.current.recover(draft)).toBe(true);
    });
    const document = hook.result.current.documents[0];
    attachSlide(hook, document);
    expect(document).toMatchObject({
      id: draft.id,
      path: null,
      title: draft.title,
      dirty: true,
      recovered: true,
      savedContent: null,
    });
    expect(desktop.writeDraft).toHaveBeenCalledWith({ ...draft, path: null });
    expect(document.presentation!.slides.map((slide) => slide.title)).toEqual([
      "Opening",
      "Details",
    ]);
    act(() => hook.result.current.selectSlide(document, "second"));
    attachSlide(hook, document);
    expect(document.initialData.elements![0].x).toBe(22);
    expect(document.dirty).toBe(true);
    expect(document.savedContent).toBeNull();
    vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
      disk("/drawings/recovered.guzi-presentation", request.content),
    );
    await act(async () => {
      expect(await hook.result.current.requestSave(document)).toBe(true);
    });
    expect(desktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: null,
        format: "presentation",
      }),
    );
    expect(hook.result.current.drafts).toHaveLength(0);
  });

  it("renames, orders, duplicates and deletes pages while retaining at least one page", async () => {
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newPresentation()!;
    });
    attachSlide(hook, document).edit(snapshot(11));
    const first = document.activeSlideId!;
    act(() => hook.result.current.addSlide(document));
    attachSlide(hook, document).edit(snapshot(22));
    const second = document.activeSlideId!;
    act(() => {
      hook.result.current.renameSlide(document, first, "  Opening  ");
      hook.result.current.renameSlide(document, second, "   ");
      hook.result.current.moveSlide(document, second, 0);
    });
    expect(document.presentation!.slides.map((slide) => slide.id)).toEqual([
      second,
      first,
    ]);
    expect(document.presentation!.slides[1].title).toBe("Opening");
    expect(document.presentation!.slides[0].title.trim()).not.toBe("");
    act(() => hook.result.current.addSlide(document, first));
    attachSlide(hook, document).edit(snapshot(33));
    const duplicate = document.activeSlideId!;
    expect(document.presentation!.slides.map((slide) => slide.id)).toEqual([
      second,
      first,
      duplicate,
    ]);
    expect(document.presentation!.slides[1].scene.elements![0].x).toBe(11);
    expect(document.presentation!.slides[2].scene.elements![0].x).toBe(33);
    act(() => hook.result.current.deleteSlide(document, duplicate));
    attachSlide(hook, document);
    expect(document.activeSlideId).toBe(first);
    act(() => hook.result.current.deleteSlide(document, first));
    attachSlide(hook, document);
    expect(document.activeSlideId).toBe(second);
    const content = document.content;
    act(() => hook.result.current.deleteSlide(document, second));
    expect(document.presentation!.slides).toHaveLength(1);
    expect(document.content).toBe(content);
    expect(document.dirty).toBe(true);
  });

  it("duplicates a renamed saved slide without corrupting live runtime state", async () => {
    const hook = await mount();
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk("/drawings/talk.guzi-presentation", presentationContent()),
    ]);
    await act(async () => hook.result.current.openFiles());
    const document = hook.result.current.documents[0];
    const first = attachSlide(hook, document);
    const live = snapshot(33);
    live.appState.collaborators.set("peer" as SocketId, { username: "Peer" });
    live.appState.selectedElementIds = { rectangle: true };
    live.appState.hoveredElementIds = { rectangle: true };
    first.edit(live);
    const checkpoint = { undo: [], redo: [] };
    vi.mocked(first.api.history.checkpoint!).mockReturnValue(checkpoint);
    act(() => hook.result.current.renameSlide(document, "first", "中文名称"));
    expect(
      document.presentation!.slides[0].scene.appState?.collaborators,
    ).toBeInstanceOf(Map);

    act(() => hook.result.current.addSlide(document, "first"));
    expect(document.initialData.appState).not.toHaveProperty("collaborators");
    expect(document.initialData.appState).not.toHaveProperty(
      "selectedElementIds",
    );
    expect(document.initialData.appState).not.toHaveProperty(
      "hoveredElementIds",
    );
    const copy = attachSlide(hook, document);
    expect(copy.api.getAppState().collaborators).toBeInstanceOf(Map);
    expect(() =>
      copy.api.getAppState().collaborators.forEach(() => {}),
    ).not.toThrow();
    expect(copy.api.getSceneElementsIncludingDeleted()[0].x).toBe(33);
    const originalRuntime = document.slideRuntime!.get("first")!;
    expect(originalRuntime.snapshot?.appState.collaborators).toBe(
      live.appState.collaborators,
    );
    expect(originalRuntime.history).toBe(checkpoint);

    act(() => hook.result.current.selectSlide(document, "first"));
    const reopened = attachSlide(hook, document);
    expect(reopened.api.getAppState().collaborators).toBe(
      live.appState.collaborators,
    );
    expect(reopened.api.getAppState().selectedElementIds).toEqual({
      rectangle: true,
    });
    expect(document.presentation!.slides[0].title).toBe("中文名称");
  });

  it("copies a frozen page without changing the deck and pastes it after the current page even after the source is deleted", async () => {
    const hook = await mount();
    const source = createPresentation("first", "Opening", snapshot(11));
    source.slides.push(
      { id: "second", title: "Details", scene: snapshot(22) },
      { id: "last", title: "Ending", scene: snapshot(66) },
    );
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk("/drawings/talk.guzi-presentation", serializePresentation(source)),
    ]);
    await act(async () => hook.result.current.openFiles());
    const document = hook.result.current.documents[0];
    const first = attachSlide(hook, document);
    const original = document.presentation!.slides[0].scene;
    const content = document.content;
    const revision = document.revision;
    let clipboard!: string;
    act(() => {
      clipboard = hook.result.current.copySlide(document, "first")!;
    });
    expect(JSON.parse(clipboard).slides).toHaveLength(1);
    expect(document.presentation!.slides.map((slide) => slide.id)).toEqual([
      "first",
      "second",
      "last",
    ]);
    expect(document.content).toBe(content);
    expect(document.revision).toBe(revision);
    expect(document.dirty).toBe(false);
    first.edit(snapshot(33));
    act(() => hook.result.current.deleteSlide(document, "first"));
    attachSlide(hook, document);
    await act(async () => hook.result.current.pasteSlide(document, clipboard));
    const pasted = document.presentation!.slides[1];
    expect(document.presentation!.slides.map((slide) => slide.id)).toEqual([
      "second",
      pasted.id,
      "last",
    ]);
    expect(document.activeSlideId).toBe(pasted.id);
    expect(pasted.id).not.toBe("first");
    expect(pasted.title).toBe("Opening 副本");
    expect(pasted.scene).not.toBe(original);
    expect(pasted.scene.elements![0].x).toBe(11);
    attachSlide(hook, document).edit(snapshot(44));
    await act(async () => hook.result.current.pasteSlide(document, clipboard));
    expect(document.presentation!.slides[1].scene.elements![0].x).toBe(44);
    expect(document.presentation!.slides[2].scene.elements![0].x).toBe(11);
    expect(document.presentation!.slides[2].id).not.toBe(pasted.id);
  });

  it("flushes the latest composite scene before copying and retains nested scenes, images, tables and rich text", async () => {
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newPresentation()!;
    });
    attachSlide(hook, document);
    let composite = snapshot(1);
    const table = createTableElements(createTableData(1, 1), 0, 0);
    table.elements = table.elements.map((element) => ({
      ...element,
      id: `table-${element.id}`,
      boundElements:
        element.boundElements?.map((bound) => ({
          ...bound,
          id: `table-${bound.id}`,
        })) ?? null,
      ...(element.type === "text" && element.containerId
        ? { containerId: `table-${element.containerId}` }
        : {}),
    }));
    const nested = JSON.parse(bundledExamples[0].content);
    const committed: SceneSnapshot = {
      ...snapshot(55),
      elements: [
        ...table.elements.map((element) =>
          element.type === "text"
            ? {
                ...element,
                text: "Latest cell",
                originalText: "Latest cell",
                richText: {
                  version: 1 as const,
                  paragraphs: [{ runs: [{ text: "Latest cell", bold: true }] }],
                },
              }
            : element,
        ),
        ...nested.elements,
        {
          ...snapshot().elements[0],
          id: "image",
          type: "image",
          fileId: "image" as any,
          groupIds: [],
          status: "saved",
          scale: [1, 1],
          crop: null,
        } as ExcalidrawElement,
      ],
      appState: { ...snapshot().appState, ...nested.appState },
      files: {
        ...nested.files,
        image: {
          id: "image" as any,
          dataURL: "data:image/png;base64,AAAA" as any,
          mimeType: "image/png",
          created: 1,
        },
      },
    };
    document.getSnapshot = () => composite;
    document.flushEditing = vi.fn(() => {
      composite = committed;
    });
    let clipboard!: string;
    act(() => {
      clipboard = hook.result.current.copySlide(
        document,
        document.activeSlideId!,
      )!;
    });
    expect(document.flushEditing).toHaveBeenCalledTimes(1);
    expect(document.presentation!.slides).toHaveLength(1);
    await act(async () => hook.result.current.pasteSlide(document, clipboard));
    const pasted = document.presentation!.slides[1].scene;
    const cell = pasted.elements!.find(
      (element) => element.type === "text" && element.text === "Latest cell",
    )!;
    expect(
      cell.type === "text" && cell.richText?.paragraphs[0].runs[0],
    ).toEqual({
      text: "Latest cell",
      bold: true,
    });
    expect(
      pasted.elements!.find((element) => element.id === table.elements[0].id)
        ?.customData?.table,
    ).toMatchObject({
      rows: table.elements[0].customData!.table.rows,
      columns: table.elements[0].customData!.table.columns,
      cells: [
        {
          text: "Latest cell",
          richText: cell.type === "text" && cell.richText,
        },
      ],
    });
    expect(pasted.appState?.subscenes).toEqual(
      JSON.parse(clipboard).slides[0].scene.appState.subscenes,
    );
    expect(Object.keys(pasted.appState!.subscenes!)).not.toHaveLength(0);
    expect(pasted.files!.image.dataURL).toBe("data:image/png;base64,AAAA");
    expect(pasted.files!.image).not.toBe(committed.files.image);
  });

  it.each([undefined, { x: -900, y: -500, width: 1600, height: 900 }])(
    "retains source page bounds when pasting into a differently sized presentation: %j",
    async (bounds) => {
      const hook = await mount();
      const source = createPresentation("source", "Wide page", snapshot());
      source.width = 1920;
      source.height = 1080;
      source.slides[0].bounds = bounds;
      let document!: CanvasDocument;
      act(() => {
        document = hook.result.current.newPresentation()!;
      });
      attachSlide(hook, document);
      await act(async () =>
        hook.result.current.pasteSlide(document, serializePresentation(source)),
      );
      expect(document.presentation!.width).toBe(1280);
      expect(document.presentation!.slides[1].bounds).toEqual(
        bounds ?? { x: 0, y: 0, width: 1920, height: 1080 },
      );
    },
  );

  it("ignores other clipboard text and propagates damaged presentation errors without changing pages", async () => {
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newPresentation()!;
    });
    attachSlide(hook, document);
    const content = document.content;
    const target = document;
    for (const text of ["plain text", "null", '{"type":"excalidraw"}']) {
      await act(async () => hook.result.current.pasteSlide(target, text));
    }
    await expect(
      hook.result.current.pasteSlide(document, '{"type":"guzi-presentation"}'),
    ).rejects.toThrow();
    expect(document.presentation!.slides).toHaveLength(1);
    expect(document.content).toBe(content);
    expect(hook.result.current.copySlide(document, "missing")).toBeNull();
  });

  it.each(["presenting", "closed"] as const)(
    "abandons a pending paste when its document becomes %s",
    async (state) => {
      const hook = await mount();
      vi.mocked(desktop.openFiles).mockResolvedValue([
        disk("/drawings/talk.guzi-presentation", presentationContent()),
      ]);
      await act(async () => hook.result.current.openFiles());
      const document = hook.result.current.documents[0];
      attachSlide(hook, document);
      const clipboard = hook.result.current.copySlide(document, "first")!;
      const scene = document.presentation!.slides[0].scene;
      let finish!: (scene: Awaited<ReturnType<typeof loadFromBlob>>) => void;
      vi.mocked(loadFromBlob).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let pasting!: Promise<void>;
      act(() => {
        pasting = hook.result.current.pasteSlide(document, clipboard);
      });
      if (state === "closed") {
        await act(async () => {
          expect(await hook.result.current.closeDocument(document.id)).toBe(
            true,
          );
        });
      } else {
        document.presenting = true;
      }
      await act(async () => {
        finish(scene as Awaited<ReturnType<typeof loadFromBlob>>);
        await pasting;
      });
      expect(document.presentation!.slides).toHaveLength(2);
      expect(document.activeSlideId).toBe("first");
    },
  );

  it("captures committed drawing edits when converting a canvas into a separate presentation", async () => {
    const hook = await mount();
    const source = addDocument(hook);
    vi.mocked(source.api.commitEditing).mockImplementation(() =>
      source.edit(55),
    );
    let converted!: CanvasDocument;
    act(() => {
      converted = hook.result.current.newPresentation(source.document)!;
    });
    attachSlide(hook, converted);
    expect(converted.id).not.toBe(source.document.id);
    expect(converted.path).toBeNull();
    expect(converted.initialData.elements![0].x).toBe(55);
    expect(converted.dirty).toBe(true);
    expect(source.document.presentation).toBeUndefined();
    expect(source.document.dirty).toBe(true);
    expect(desktop.saveFile).not.toHaveBeenCalled();
  });

  it("flushes a composite subcanvas snapshot before changing pages without leaking it into a new page", async () => {
    const source = JSON.parse(bundledExamples[0].content);
    const content = serializePresentation(
      createPresentation("first", "Opening", source),
    );
    const hook = await mount();
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk("/drawings/nested.guzi-presentation", content),
    ]);
    await act(async () => hook.result.current.openFiles());
    const document = hook.result.current.documents[0];
    attachSlide(hook, document);
    let composite: SceneSnapshot = {
      elements: document.initialData.elements!,
      appState: { ...snapshot().appState, ...document.initialData.appState },
      files: document.initialData.files ?? {},
    };
    const [childId, child] = Object.entries(composite.appState.subscenes).find(
      ([, child]) => child.elements.length,
    )!;
    const originalX = child.elements[0].x;
    const committed = {
      ...composite,
      appState: {
        ...composite.appState,
        subscenes: {
          ...composite.appState.subscenes,
          [childId]: {
            ...child,
            elements: child.elements.map((element, index) =>
              index
                ? element
                : {
                    ...element,
                    x: originalX + 100,
                    version: element.version + 1,
                    versionNonce: element.versionNonce + 1,
                  },
            ),
          },
        },
      },
    };
    document.getSnapshot = () => composite;
    const flush = vi.fn(() => {
      composite = committed;
    });
    document.flushEditing = flush;
    act(() => hook.result.current.addSlide(document));
    expect(flush).toHaveBeenCalled();
    attachSlide(hook, document);
    const saved = JSON.parse(document.content);
    expect(
      saved.slides[0].scene.appState.subscenes[childId].elements[0].x,
    ).toBe(originalX + 100);
    expect(saved.slides[1].scene.elements).toHaveLength(0);
    expect(saved.slides[1].scene.appState.subscenes ?? {}).toEqual({});
    act(() => hook.result.current.selectSlide(document, "first"));
    attachSlide(hook, document);
    expect(
      document.initialData.appState!.subscenes![childId].elements[0].x,
    ).toBe(originalX + 100);
    expect(document.dirty).toBe(true);
  });

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

  it("replaces only the active canvas layer and skips locked text", async () => {
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newDocument();
    });
    const editor = attachSlide(hook, document);
    const text = API.createElement({
      type: "text",
      id: "root-text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const locked = API.createElement({
      type: "text",
      id: "locked",
      fontFamily: FONT_FAMILY.Excalifont,
      locked: true,
    });
    const childText = API.createElement({
      type: "text",
      id: "child-text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    editor.edit({
      ...snapshot(),
      elements: [text, locked],
      appState: {
        ...snapshot().appState,
        subscenes: {
          child: {
            version: 1,
            title: "child",
            elements: [childText],
            appState: {},
          },
        },
      },
    });
    await act(async () =>
      hook.result.current.applyFontToCurrentLayer(document, FONT_FAMILY.Nunito),
    );
    expect(editor.api.getSceneElementsIncludingDeleted()[0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
    });
    expect(editor.api.getSceneElementsIncludingDeleted()[1]).toBe(locked);
    expect(editor.api.getAppState().currentItemFontFamily).toBe(
      FONT_FAMILY.Nunito,
    );
    expect(editor.api.getAppState().subscenes.child.elements[0]).toBe(
      childText,
    );
    expect(editor.api.updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ captureUpdate: "IMMEDIATELY" }),
    );
    expect(document.dirty).toBe(true);
  });

  it.each(["empty", "same-font", "locked"])(
    "sets the current layer default on a %s canvas without changing its text",
    async (kind) => {
      const hook = await mount();
      let document!: CanvasDocument;
      act(() => {
        document = hook.result.current.newDocument();
      });
      const editor = attachSlide(hook, document);
      const elements =
        kind === "empty"
          ? []
          : [
              API.createElement({
                type: "text",
                fontFamily:
                  kind === "same-font"
                    ? FONT_FAMILY.Nunito
                    : FONT_FAMILY.Excalifont,
                locked: kind === "locked",
              }),
            ];
      editor.edit({ ...snapshot(), elements });
      await act(async () =>
        hook.result.current.applyFontToCurrentLayer(
          document,
          FONT_FAMILY.Nunito,
        ),
      );
      expect(editor.api.getAppState().currentItemFontFamily).toBe(
        FONT_FAMILY.Nunito,
      );
      expect(editor.api.getSceneElementsIncludingDeleted()).toBe(elements);
      expect(
        hook.result.current.settings.editorPreferences?.defaultFontFamily,
      ).not.toBe(FONT_FAMILY.Nunito);
    },
  );

  it("keeps current layer content and dirty state unchanged when font loading fails", async () => {
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newDocument();
    });
    document.initialData = {
      elements: [
        API.createElement({ type: "text", fontFamily: FONT_FAMILY.Excalifont }),
      ],
    };
    const editor = attachSlide(hook, document);
    const content = document.content;
    const load = vi
      .spyOn(Fonts, "loadElementsFonts")
      .mockRejectedValueOnce(new Error("font unavailable"));
    try {
      await act(async () => {
        await expect(
          hook.result.current.applyFontToCurrentLayer(
            document,
            FONT_FAMILY.Nunito,
          ),
        ).rejects.toThrow("font unavailable");
      });
      expect(editor.api.updateScene).not.toHaveBeenCalled();
      expect(document.content).toBe(content);
      expect(document.dirty).toBe(false);
    } finally {
      load.mockRestore();
    }
  });

  it("replaces every open document and hidden presentation page while retaining cached undo history", async () => {
    const hook = await mount();
    let canvas!: CanvasDocument;
    let deck!: CanvasDocument;
    act(() => {
      canvas = hook.result.current.newDocument();
      deck = hook.result.current.newPresentation()!;
    });
    const text = API.createElement({
      type: "text",
      id: "root-text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const childText = API.createElement({
      type: "text",
      id: "child-text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    const pin = {
      ...API.createElement({ type: "stickynote", id: "pin" }),
      customData: { subcanvas: { sceneId: "child" } },
    };
    const scene = {
      ...snapshot(),
      elements: [text, pin],
      appState: {
        ...snapshot().appState,
        subscenes: {
          child: {
            version: 1 as const,
            title: "child",
            elements: [childText],
            appState: {},
          },
        },
      },
    };
    const canvasEditor = attachSlide(hook, canvas);
    canvasEditor.edit(scene);
    const firstId = deck.activeSlideId!;
    const firstEditor = attachSlide(hook, deck);
    firstEditor.edit(scene);
    const checkpoint = { undo: [], redo: [] };
    vi.mocked(firstEditor.api.history.checkpoint!).mockReturnValue(checkpoint);
    act(() => hook.result.current.addSlide(deck));
    const secondEditor = attachSlide(hook, deck);
    secondEditor.edit({
      ...scene,
      elements: [
        API.createElement({
          type: "text",
          id: "second-text",
          fontFamily: FONT_FAMILY.Excalifont,
        }),
      ],
    });
    await act(async () =>
      hook.result.current.applyFontToCurrentLayer(
        deck,
        FONT_FAMILY["Comic Shanns"],
      ),
    );
    expect(
      secondEditor.api.getSceneElementsIncludingDeleted()[0],
    ).toMatchObject({ fontFamily: FONT_FAMILY["Comic Shanns"] });
    expect(
      deck.presentation!.slides.find((slide) => slide.id === firstId)!.scene
        .elements![0],
    ).toMatchObject({ fontFamily: FONT_FAMILY.Excalifont });
    expect(
      canvasEditor.api.getSceneElementsIncludingDeleted()[0],
    ).toMatchObject({ fontFamily: FONT_FAMILY.Excalifont });
    await act(async () =>
      hook.result.current.applyFontToOpenDocuments(FONT_FAMILY.Nunito),
    );
    expect(
      canvasEditor.api.getSceneElementsIncludingDeleted()[0],
    ).toMatchObject({ fontFamily: FONT_FAMILY.Nunito });
    expect(canvasEditor.api.getAppState().currentItemFontFamily).toBe(
      FONT_FAMILY.Nunito,
    );
    expect(
      canvasEditor.api.getAppState().subscenes.child.elements[0],
    ).toMatchObject({ fontFamily: FONT_FAMILY.Nunito });
    expect(
      secondEditor.api.getSceneElementsIncludingDeleted()[0],
    ).toMatchObject({ fontFamily: FONT_FAMILY.Nunito });
    expect(secondEditor.api.getAppState().currentItemFontFamily).toBe(
      FONT_FAMILY.Nunito,
    );
    const hidden = deck.presentation!.slides.find(
      (slide) => slide.id === firstId,
    )!;
    const runtime = deck.slideRuntime!.get(firstId)!;
    expect(hidden.scene.elements![0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
    });
    expect(hidden.scene.appState!.subscenes!.child.elements[0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
    });
    expect(runtime.snapshot!.elements).toBe(hidden.scene.elements);
    expect(runtime.history!.undo).toHaveLength(1);
    expect(runtime.children.get("child")!.undo).toHaveLength(1);
    expect(checkpoint.undo).toHaveLength(0);
    expect(canvas.dirty).toBe(true);
    expect(deck.dirty).toBe(true);
    expect(
      JSON.parse(deck.content).slides.every(
        (slide: any) =>
          slide.scene.elements[0].fontFamily === FONT_FAMILY.Nunito,
      ),
    ).toBe(true);
    act(() => hook.result.current.selectSlide(deck, firstId));
    const restored = attachSlide(hook, deck);
    expect(restored.api.getSceneElementsIncludingDeleted()[0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
    });
    await waitFor(() =>
      expect(desktop.writeDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: deck.id, content: deck.content }),
      ),
    );
  });

  it("uses the global default for new text when reopening old files or visiting hidden slides", async () => {
    vi.mocked(desktop.getSettings).mockResolvedValue({
      ...settings,
      editorPreferences: {
        ...DEFAULT_EDITOR_PREFERENCES,
        defaultFontFamily: FONT_FAMILY.Nunito,
      },
    });
    const text = API.createElement({
      type: "text",
      fontFamily: FONT_FAMILY.Excalifont,
    });
    vi.mocked(desktop.openFiles).mockResolvedValue([
      disk(
        "/drawings/fonts.excalidraw",
        createSceneTracker()({ ...snapshot(), elements: [text] }),
      ),
      disk("/drawings/fonts.guzi-presentation", presentationContent()),
    ]);
    const hook = await mount();
    await act(async () => hook.result.current.openFiles());
    const [canvas, deck] = hook.result.current.documents;
    expect(canvas.initialData.appState?.currentItemFontFamily).toBe(
      FONT_FAMILY.Nunito,
    );
    expect(canvas.initialData.elements![0]).toMatchObject({
      fontFamily: FONT_FAMILY.Excalifont,
    });
    attachSlide(hook, deck);
    const next = deck.presentation!.slides.find(
      (slide) => slide.id !== deck.activeSlideId,
    )!;
    act(() => hook.result.current.selectSlide(deck, next.id));
    expect(deck.initialData.appState?.currentItemFontFamily).toBe(
      FONT_FAMILY.Nunito,
    );
  });

  it("retains dirty replacements made before an open canvas has mounted", async () => {
    const hook = await mount();
    let document!: CanvasDocument;
    act(() => {
      document = hook.result.current.newDocument();
    });
    document.initialData = {
      elements: [
        API.createElement({ type: "text", fontFamily: FONT_FAMILY.Excalifont }),
      ],
    };
    await act(async () =>
      hook.result.current.applyFontToOpenDocuments(FONT_FAMILY.Nunito),
    );
    expect(document.initialData.elements![0]).toMatchObject({
      fontFamily: FONT_FAMILY.Nunito,
    });
    expect(document.dirty).toBe(true);
    attachSlide(hook, document);
    expect(document.dirty).toBe(true);
    await waitFor(() =>
      expect(desktop.writeDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: document.id, content: document.content }),
      ),
    );
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

  it("returns clean after save, edit and undo despite runtime metadata and deleted cells", async () => {
    const hook = await mount();
    const item = addDocument(hook);
    item.edit(2);
    vi.mocked(desktop.saveFile).mockImplementation(async (request) =>
      disk("/drawings/undo.excalidraw", request.content),
    );
    await act(async () => {
      expect(await hook.result.current.requestSave(item.document)).toBe(true);
    });
    const saved = item.document.savedContent;
    item.edit(3);
    expect(item.document.dirty).toBe(true);
    const restored = snapshot(2);
    item.captureScene({
      ...restored,
      elements: [
        { ...restored.elements[0], version: 10, versionNonce: 20, updated: 30 },
        { ...restored.elements[0], id: "deleted-cell", isDeleted: true },
      ],
    });
    expect(item.document.dirty).toBe(false);
    expect(item.document.content).not.toBe(saved);
    expect(item.document.savedContent).toBe(saved);
    expect(JSON.parse(item.document.content).elements).toHaveLength(2);
    item.edit(3);
    expect(item.document.dirty).toBe(true);
  });

  it.each([false, true])(
    "compares actual content after a pending save (undo=%s)",
    async (undo) => {
      const hook = await mount();
      const item = addDocument(hook);
      item.edit(2);
      let finish!: (file: DiskDocument) => void;
      vi.mocked(desktop.saveFile).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let saving!: Promise<boolean>;
      act(() => {
        saving = hook.result.current.requestSave(item.document);
      });
      const submitted = vi.mocked(desktop.saveFile).mock.calls[0][0].content;
      item.edit(3);
      if (undo) {
        const restored = snapshot(2);
        item.captureScene({
          ...restored,
          elements: [
            {
              ...restored.elements[0],
              version: 10,
              versionNonce: 20,
              updated: 30,
            },
          ],
        });
      }
      await act(async () => {
        finish(disk("/drawings/async.excalidraw", submitted));
        expect(await saving).toBe(true);
      });
      expect(item.document.dirty).toBe(!undo);
      expect(item.document.savedContent).toBe(submitted);
      expect(item.document.content).not.toBe(submitted);
    },
  );

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

  it.each(["rename", "move"] as const)(
    "waits for a pending save before a project file %s",
    async (operation) => {
      const hook = await mount();
      const first = addDocument(hook);
      const originalPath = "/drawings/original.excalidraw";
      const nextPath = "/drawings/updated.excalidraw";
      first.document.path = originalPath;
      first.edit(2);
      let finish!: (file: DiskDocument) => void;
      vi.mocked(desktop.saveFile).mockImplementation(
        () => new Promise((resolve) => (finish = resolve)),
      );
      const mutate = vi.mocked(
        operation === "rename" ? desktop.renameFile : desktop.moveFile,
      );
      mutate.mockResolvedValue(disk(nextPath, first.document.content));
      let saving!: Promise<boolean>;
      let changing!: Promise<boolean>;
      act(() => {
        saving = hook.result.current.requestSave(first.document);
        changing = hook.result.current.mutateFile(
          operation,
          projectFile(originalPath),
          "updated",
        );
      });
      try {
        expect(mutate).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          finish(disk(originalPath, first.document.content));
          expect(await saving).toBe(true);
          expect(await changing).toBe(true);
        });
      }
      expect(mutate).toHaveBeenCalledWith(originalPath, "updated");
      expect(first.document.path).toBe(nextPath);
      expect(first.document.dirty).toBe(false);
    },
  );

  it.each(["cancel", "failure"])(
    "keeps project renaming available after a pending save ends in %s",
    async (outcome) => {
      const hook = await mount();
      const first = addDocument(hook);
      const originalPath = "/drawings/original.excalidraw";
      const nextPath = "/drawings/updated.excalidraw";
      first.document.path = originalPath;
      first.edit(2);
      const content = first.document.content;
      let finish!: () => void;
      vi.mocked(desktop.saveFile).mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              outcome === "cancel"
                ? resolve(null)
                : reject(new Error("disk unavailable"));
          }),
      );
      vi.mocked(desktop.renameFile).mockResolvedValue(disk(nextPath, content));
      let saving!: Promise<boolean>;
      let renaming!: Promise<boolean>;
      act(() => {
        saving = hook.result.current.requestSave(first.document);
        renaming = hook.result.current.mutateFile(
          "rename",
          projectFile(originalPath),
          "updated",
        );
      });
      try {
        expect(desktop.renameFile).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          finish();
          expect(await saving).toBe(false);
          expect(await renaming).toBe(true);
        });
      }
      expect(first.document.path).toBe(nextPath);
      expect(first.document.content).toBe(content);
      expect(first.document.dirty).toBe(true);
      if (outcome === "failure") {
        expect(hook.result.current.error).toBe("disk unavailable");
      }
    },
  );

  it("keeps a Save As tab on its new path when the original project file is renamed", async () => {
    const hook = await mount();
    const first = addDocument(hook);
    const originalPath = "/drawings/original.excalidraw";
    const savedPath = "/outside/copy.excalidraw";
    const renamedPath = "/drawings/renamed.excalidraw";
    first.document.path = originalPath;
    first.edit(2);
    let finish!: (file: DiskDocument) => void;
    vi.mocked(desktop.saveFile).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    vi.mocked(desktop.renameFile).mockResolvedValue(
      disk(renamedPath, first.document.content),
    );
    let saving!: Promise<boolean>;
    let renaming!: Promise<boolean>;
    act(() => {
      saving = hook.result.current.requestSave(first.document, true);
      renaming = hook.result.current.mutateFile(
        "rename",
        projectFile(originalPath),
        "renamed",
      );
    });
    await act(async () => {
      finish(disk(savedPath, first.document.content));
      expect(await saving).toBe(true);
      expect(await renaming).toBe(true);
    });
    expect(desktop.renameFile).toHaveBeenCalledWith(originalPath, "renamed");
    expect(first.document.path).toBe(savedPath);
    expect(first.document.title).toBe("copy");
    expect(first.document.dirty).toBe(false);
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
