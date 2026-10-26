import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";

import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { SubcanvasEditor } from "../features/editor/SubcanvasEditor";

import { App } from "./App";

import type {
  DesktopAPI,
  DesktopCommand,
  DesktopSettings,
} from "../../shared/desktop-api";

vi.mock("../features/editor/SubcanvasEditor", () => ({
  SubcanvasEditor: vi.fn(() => null),
}));
vi.mock("../features/projects/FilePreview", () => ({
  FilePreview: () => <div />,
}));
vi.mock("@excalidraw/excalidraw", async (original) => {
  const actual = await original<typeof import("@excalidraw/excalidraw")>();
  return { ...actual, useHandleLibrary: vi.fn() };
});

const settings: DesktopSettings = {
  rootDirectory: "/drawings",
  theme: "light",
  language: "zh-CN",
  toolPanelDock: "floating",
  toolPanelWidth: 280,
  structuredExportFormat: "json",
  includeInferredStructure: true,
  skipRemoveConfirmation: false,
  skipTrashConfirmation: false,
};
const filePath = "/drawings/升级画布.excalidraw";
const content = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

describe.each(["darwin", "win32"] as const)(
  "installing an update from settings on %s",
  (platform) => {
    let root: HTMLDivElement;
    let desktop: DesktopAPI;
    let command: (value: DesktopCommand) => void;

    beforeEach(() => {
      root = document.createElement("div");
      root.ownerDocument.body.append(root);
      command = () => {};
      desktop = {
        platform,
        checkStartupUpdate: vi.fn().mockResolvedValue(null),
        getSettings: vi.fn().mockResolvedValue(settings),
        listProjects: vi.fn().mockResolvedValue({
          rootDirectory: "/drawings",
          files: [],
          folders: [],
          history: [],
        }),
        getSession: vi.fn().mockResolvedValue({
          paths: [filePath],
          activePath: filePath,
        }),
        setSession: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockResolvedValue({
          path: filePath,
          content,
          modifiedAt: 1,
          size: content.length,
        }),
        recordOpenedFile: vi.fn().mockResolvedValue(undefined),
        listDrafts: vi.fn().mockResolvedValue([]),
        takePendingFiles: vi.fn().mockResolvedValue([]),
        writeDraft: vi.fn().mockResolvedValue(undefined),
        deleteDraft: vi.fn().mockResolvedValue(undefined),
        setPluginHostReady: vi.fn().mockResolvedValue(undefined),
        getUserPlugins: vi.fn().mockResolvedValue([]),
        onUserPluginState: vi.fn(() => () => {}),
        onCommand: vi.fn((callback) => {
          command = callback;
          return () => {};
        }),
        onFilesOpened: vi.fn(() => () => {}),
        getUpdateState: vi.fn().mockResolvedValue({
          status: "downloaded",
          currentVersion: "0.8.1",
          availableVersion: "0.8.2",
        }),
        checkForUpdates: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.8.1",
          availableVersion: "0.8.2",
        }),
        downloadUpdate: vi.fn().mockResolvedValue({
          status: "downloaded",
          currentVersion: "0.8.1",
          availableVersion: "0.8.2",
          progress: 100,
        }),
        onUpdateState: vi.fn(() => () => {}),
        installUpdate: vi.fn(async () => {
          expect(
            within(root).queryByRole("dialog", { name: "桌面设置" }),
          ).not.toBeInTheDocument();
          command("close-window");
        }),
        saveFile: vi.fn(async (request) => ({
          path: filePath,
          content: request.content,
          modifiedAt: 2,
          size: request.content.length,
        })),
        confirmClose: vi.fn(),
        cancelClose: vi.fn(),
      } as unknown as DesktopAPI;
      root.ownerDocument.defaultView!.desktop = desktop;
    });

    afterEach(() => {
      cleanup();
      root.remove();
      vi.clearAllMocks();
    });

    const mount = async (dirty: boolean) => {
      const view = render(<App root={root} />, { container: root });
      await view.findByRole("tab", { name: "升级画布" });
      const editor = vi.mocked(SubcanvasEditor).mock.lastCall![0];
      let scene = {
        elements: [] as OrderedExcalidrawElement[],
        appState: {
          ...getDefaultAppState(),
          width: 1000,
          height: 700,
          offsetLeft: 0,
          offsetTop: 0,
        },
        files: {},
      };
      const api = {
        isDestroyed: false,
        getSceneElementsIncludingDeleted: () => scene.elements,
        getAppState: () => scene.appState,
        getFiles: () => scene.files,
        commitEditing: vi.fn(),
        desktopSave: (saveAs: boolean) =>
          editor.desktopIntegration!.save!(scene, saveAs),
      } as unknown as ExcalidrawImperativeAPI;
      act(() => editor.onInitialize?.(api));
      if (dirty) {
        scene = {
          ...scene,
          elements: [
            {
              id: "saved-rectangle",
              type: "rectangle",
              x: 10,
              y: 20,
              width: 100,
              height: 80,
              version: 1,
              versionNonce: 1,
              isDeleted: false,
              index: "a0",
            } as OrderedExcalidrawElement,
          ],
        };
        act(() =>
          editor.onChange?.(scene.elements, scene.appState, scene.files),
        );
      }
      fireEvent.click(view.getByRole("button", { name: "返回项目页" }));
      fireEvent.click(view.getByRole("button", { name: "设置" }));
      const dialog = view.getByRole("dialog", { name: "桌面设置" });
      const install = await within(dialog).findByRole("button", {
        name: "安装并重启",
      });
      return { view, install };
    };

    const available = {
      status: "available" as const,
      currentVersion: "0.8.1",
      availableVersion: "0.8.2",
    };

    it("prompts once in StrictMode and leaves downloading to the user", async () => {
      vi.mocked(desktop.checkStartupUpdate).mockResolvedValue(available);
      vi.mocked(desktop.getUpdateState).mockResolvedValue(available);
      const view = render(
        <StrictMode>
          <App root={root} />
        </StrictMode>,
        { container: root },
      );
      const prompt = await view.findByRole("dialog", { name: "发现新版本" });
      expect(desktop.checkStartupUpdate).toHaveBeenCalledTimes(1);
      await within(prompt).findByRole("button", { name: "下载更新" });
      expect(desktop.downloadUpdate).not.toHaveBeenCalled();
      expect(desktop.installUpdate).not.toHaveBeenCalled();
      fireEvent.click(within(prompt).getByRole("button", { name: "稍后更新" }));
      expect(view.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(view.getByRole("button", { name: "返回项目页" }));
      fireEvent.click(view.getByRole("button", { name: "设置" }));
      await view.findByRole("button", { name: "下载更新" });
      expect(
        view.queryByRole("dialog", { name: "发现新版本" }),
      ).not.toBeInTheDocument();
      expect(desktop.checkStartupUpdate).toHaveBeenCalledTimes(1);
    });

    it("keeps a manual available result inside settings without a startup prompt", async () => {
      vi.mocked(desktop.getUpdateState).mockResolvedValue({
        status: "idle",
        currentVersion: "0.8.1",
      });
      const view = render(<App root={root} />, { container: root });
      await view.findByRole("tab", { name: "升级画布" });
      fireEvent.click(view.getByRole("button", { name: "返回项目页" }));
      fireEvent.click(view.getByRole("button", { name: "设置" }));
      fireEvent.click(await view.findByRole("button", { name: "检查更新" }));
      await view.findByRole("button", { name: "下载更新" });
      expect(desktop.checkForUpdates).toHaveBeenCalledTimes(1);
      fireEvent.click(view.getByRole("button", { name: "完成" }));
      expect(view.queryByRole("dialog")).not.toBeInTheDocument();
      expect(desktop.downloadUpdate).not.toHaveBeenCalled();
    });

    it("does not block closing while a startup update waits for workspace loading", async () => {
      vi.mocked(desktop.checkStartupUpdate).mockResolvedValue(available);
      let resolveSession!: (session: {
        paths: string[];
        activePath: null;
      }) => void;
      vi.mocked(desktop.getSession).mockReturnValue(
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
      );
      const view = render(<App root={root} />, { container: root });
      await act(async () => {});
      expect(
        view.queryByRole("dialog", { name: "发现新版本" }),
      ).not.toBeInTheDocument();
      act(() => command("close-window"));
      await waitFor(() =>
        expect(desktop.confirmClose).toHaveBeenCalledTimes(1),
      );
      expect(desktop.cancelClose).not.toHaveBeenCalled();
      await act(async () => resolveSession({ paths: [], activePath: null }));
    });

    it.each(["保存", "取消"])(
      "defers a startup result arriving during an existing close prompt and honors %s",
      async (choice) => {
        let resolveStartup!: (state: typeof available) => void;
        vi.mocked(desktop.checkStartupUpdate).mockReturnValue(
          new Promise((resolve) => {
            resolveStartup = resolve;
          }),
        );
        const { view } = await mount(true);
        fireEvent.click(view.getByRole("button", { name: "完成" }));
        act(() => command("close-window"));
        const savePrompt = await view.findByRole("dialog", {
          name: "保存画布更改？",
        });
        vi.mocked(desktop.getUpdateState).mockResolvedValue(available);
        await act(async () => resolveStartup(available));
        expect(
          view.queryByRole("dialog", { name: "发现新版本" }),
        ).not.toBeInTheDocument();
        expect(desktop.cancelClose).not.toHaveBeenCalled();
        fireEvent.click(
          within(savePrompt).getByRole("button", { name: choice }),
        );
        await waitFor(() =>
          expect(
            choice === "保存" ? desktop.confirmClose : desktop.cancelClose,
          ).toHaveBeenCalledTimes(1),
        );
        expect(desktop.saveFile).toHaveBeenCalledTimes(
          choice === "保存" ? 1 : 0,
        );
      },
    );

    it.each(["up-to-date", "error", "unavailable", "rejected"])(
      "does not prompt for a startup result of %s",
      async (outcome) => {
        if (outcome === "rejected") {
          vi.mocked(desktop.checkStartupUpdate).mockRejectedValue(
            new Error("Offline"),
          );
        } else {
          vi.mocked(desktop.checkStartupUpdate).mockResolvedValue({
            currentVersion: "0.8.1",
            status: outcome as "up-to-date" | "error" | "unavailable",
          });
        }
        const view = render(<App root={root} />, { container: root });
        await view.findByRole("tab", { name: "升级画布" });
        expect(view.queryByRole("dialog")).not.toBeInTheDocument();
        expect(view.queryByRole("alert")).not.toBeInTheDocument();
        expect(desktop.downloadUpdate).not.toHaveBeenCalled();
      },
    );

    it.each(["保存", "取消"])(
      "defers a startup prompt behind settings and preserves %s before installing",
      async (choice) => {
        let resolveStartup!: (state: typeof available) => void;
        vi.mocked(desktop.checkStartupUpdate).mockReturnValue(
          new Promise((resolve) => {
            resolveStartup = resolve;
          }),
        );
        const { view } = await mount(true);
        vi.mocked(desktop.getUpdateState).mockResolvedValue(available);
        await act(async () => resolveStartup(available));
        expect(
          view.queryByRole("dialog", { name: "发现新版本" }),
        ).not.toBeInTheDocument();
        fireEvent.click(view.getByRole("button", { name: "完成" }));
        const prompt = await view.findByRole("dialog", { name: "发现新版本" });
        fireEvent.click(
          await within(prompt).findByRole("button", { name: "下载更新" }),
        );
        expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
        fireEvent.click(
          await within(prompt).findByRole("button", { name: "安装并重启" }),
        );
        const savePrompt = await view.findByRole("dialog", {
          name: "保存画布更改？",
        });
        expect(
          view.queryByRole("dialog", { name: "发现新版本" }),
        ).not.toBeInTheDocument();
        fireEvent.click(
          within(savePrompt).getByRole("button", { name: choice }),
        );
        await waitFor(() =>
          expect(
            choice === "保存" ? desktop.confirmClose : desktop.cancelClose,
          ).toHaveBeenCalledTimes(1),
        );
        expect(desktop.saveFile).toHaveBeenCalledTimes(
          choice === "保存" ? 1 : 0,
        );
      },
    );

    it.each(["保存", "取消"])(
      "closes settings before a synchronous close command and honors %s",
      async (choice) => {
        const { view, install } = await mount(true);
        fireEvent.click(install);
        const prompt = await view.findByRole("dialog", {
          name: "保存画布更改？",
        });
        expect(
          view.queryByRole("dialog", { name: "桌面设置" }),
        ).not.toBeInTheDocument();
        expect(desktop.installUpdate).toHaveBeenCalledTimes(1);
        expect(desktop.cancelClose).not.toHaveBeenCalled();
        expect(desktop.confirmClose).not.toHaveBeenCalled();
        fireEvent.click(within(prompt).getByRole("button", { name: choice }));
        if (choice === "保存") {
          await waitFor(() =>
            expect(desktop.confirmClose).toHaveBeenCalledTimes(1),
          );
          expect(desktop.cancelClose).not.toHaveBeenCalled();
          expect(desktop.saveFile).toHaveBeenCalledTimes(1);
          const saved = JSON.parse(
            vi.mocked(desktop.saveFile).mock.calls[0][0].content,
          );
          expect(saved.elements).toEqual([
            expect.objectContaining({ id: "saved-rectangle" }),
          ]);
          expect(
            vi.mocked(desktop.saveFile).mock.invocationCallOrder[0],
          ).toBeLessThan(
            vi.mocked(desktop.confirmClose).mock.invocationCallOrder[0],
          );
        } else {
          await waitFor(() =>
            expect(desktop.cancelClose).toHaveBeenCalledTimes(1),
          );
          expect(desktop.confirmClose).not.toHaveBeenCalled();
          expect(desktop.saveFile).not.toHaveBeenCalled();
          expect(
            view.getByText("未保存", { selector: ".desktop-save-status" }),
          ).toBeInTheDocument();
        }
      },
    );

    it("closes a clean canvas normally without a save prompt", async () => {
      const { view, install } = await mount(false);
      fireEvent.click(install);
      await waitFor(() =>
        expect(desktop.confirmClose).toHaveBeenCalledTimes(1),
      );
      expect(desktop.installUpdate).toHaveBeenCalledTimes(1);
      expect(desktop.cancelClose).not.toHaveBeenCalled();
      expect(desktop.saveFile).not.toHaveBeenCalled();
      expect(view.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps install failures visible after settings has unmounted", async () => {
      const { view, install } = await mount(false);
      vi.mocked(desktop.installUpdate).mockRejectedValueOnce(
        new Error("Install bridge failed"),
      );
      fireEvent.click(install);
      await waitFor(() =>
        expect(view.getByRole("alert")).toHaveTextContent(
          "Install bridge failed",
        ),
      );
      expect(
        view.queryByRole("dialog", { name: "桌面设置" }),
      ).not.toBeInTheDocument();
      expect(desktop.confirmClose).not.toHaveBeenCalled();
      expect(desktop.cancelClose).not.toHaveBeenCalled();
    });
  },
);
