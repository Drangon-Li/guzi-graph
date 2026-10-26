import { vi } from "vitest";
import { createElement } from "react";

import * as common from "@excalidraw/common";
import { t } from "@excalidraw/excalidraw/i18n";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  fireEvent,
  render,
  toggleMenu,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  LibraryItems,
} from "@excalidraw/excalidraw/types";

import ExcalidrawApp from "../App";
import { STORAGE_KEYS } from "../app_constants";
import Collab from "../collab/Collab";
import { AIComponents } from "../components/AI";
import { ShareDialog } from "../share/ShareDialog";
import * as data from "../data";
import { LibraryIndexedDBAdapter, LocalData } from "../data/LocalData";

import type { ComponentProps } from "react";

const singleUser = vi.hoisted(() => ({ enabled: true }));

vi.mock("../singleUser", () => ({
  get SINGLE_USER_MODE() {
    return singleUser.enabled;
  },
}));
vi.mock("../collab/Collab", async (importOriginal) => {
  const original = await importOriginal<typeof import("../collab/Collab")>();
  return {
    ...original,
    default: vi.fn((props: ComponentProps<typeof original.default>) =>
      createElement(original.default, props),
    ),
  };
});
vi.mock("../components/AI", () => ({
  AIComponents: vi.fn(() => null),
}));
vi.mock("../share/ShareDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../share/ShareDialog")>()),
  ShareDialog: vi.fn(() => null),
}));

const { h } = window;

describe("single-user Web app", () => {
  beforeEach(() => {
    singleUser.enabled = true;
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it.each([
    "/?id=remote",
    "/#json=remote,secret",
    "/#room=room,sTdLvMC_M3V8_vGa3UVRDg",
    "/#url=https%3A%2F%2Fexample.com%2Fscene.excalidraw",
    "/excalidraw-plus-export",
  ])("restores local data without loading remote scenes at %s", async (url) => {
    const rectangle = API.createElement({
      type: "rectangle",
      id: "local-rectangle",
      width: 100,
      height: 100,
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([rectangle]),
    );
    window.history.replaceState({}, "", url);
    const importScene = vi.spyOn(data, "importFromBackend");
    const parseRoom = vi.spyOn(data, "getCollaborationLinkData");
    const parseCollaboration = vi.spyOn(data, "isCollaborationLink");
    const fetchRemote = vi.spyOn(globalThis, "fetch");

    await render(<ExcalidrawApp />);

    expect(h.elements.map(({ id }) => id)).toEqual(["local-rectangle"]);
    expect(h.app.state.isLoading).toBe(false);
    expect(h.app.props.isCollaborating).toBe(false);
    expect(importScene).not.toHaveBeenCalled();
    expect(parseRoom).not.toHaveBeenCalled();
    expect(parseCollaboration).not.toHaveBeenCalled();
    expect(fetchRemote).not.toHaveBeenCalled();
    expect(Collab).not.toHaveBeenCalled();
    expect(ShareDialog).not.toHaveBeenCalled();
    expect(AIComponents).not.toHaveBeenCalled();
    expect(h.app.props.aiEnabled).toBe(false);
    expect(h.app.props.UIOptions.textSelectionToolbar).toBe(true);
    expect(h.app.props.UIOptions.libraryRemoteActions).toBe(false);
    expect(h.app.props.UIOptions.canvasActions.export).toEqual({
      onExportToBackend: undefined,
      renderCustomUI: undefined,
      saveFileToDisk: true,
    });
    expect(h.app.props.desktopIntegration).toBeUndefined();
  });

  it("restores local image files through IndexedDB storage", async () => {
    const file: BinaryFileData = {
      id: common.toBrandedType<FileId>("local-image"),
      dataURL: common.toBrandedType<BinaryFileData["dataURL"]>(
        "data:image/png;base64,iVBORw0KGgo=",
      ),
      mimeType: "image/png",
      created: Date.now(),
    };
    const image = API.createElement({
      type: "image",
      fileId: file.id,
      status: "saved",
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([image]),
    );
    const getFiles = vi
      .spyOn(LocalData.fileStorage, "getFiles")
      .mockResolvedValue({
        loadedFiles: [file],
        erroredFiles: new Map(),
      });

    await render(<ExcalidrawApp />);

    expect(getFiles).toHaveBeenCalledWith([file.id]);
    await waitFor(() => expect(h.app.files[file.id]).toEqual(file));
  });

  it.each(["query", "hash", "hashchange"])(
    "rejects remote addLibrary %s while restoring local library items",
    async (entry) => {
      const libraryItems: LibraryItems = [
        {
          id: "saved-library-item",
          status: "unpublished",
          created: 0,
          elements: [API.createElement({ type: "rectangle" })],
        },
      ];
      await LibraryIndexedDBAdapter.save({ libraryItems });
      const libraryUrl = encodeURIComponent(
        "https://libraries.excalidraw.com/remote.excalidrawlib",
      );
      if (entry !== "hashchange") {
        window.history.replaceState(
          {},
          "",
          `/${entry === "query" ? "?" : "#"}addLibrary=${libraryUrl}`,
        );
      }
      const fetchLibrary = vi.spyOn(globalThis, "fetch");

      await render(<ExcalidrawApp />);
      if (entry === "hashchange") {
        await act(async () => {
          const oldURL = window.location.href;
          window.history.replaceState({}, "", `/#addLibrary=${libraryUrl}`);
          fireEvent(window, new HashChangeEvent("hashchange", { oldURL }));
        });
      }

      await waitFor(async () => {
        expect(await h.app.library.getLatestLibrary()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "saved-library-item" }),
          ]),
        );
      });
      expect(fetchLibrary).not.toHaveBeenCalled();
      expect(h.app.state.errorMessage).toBeNull();
    },
  );

  it("keeps local library import and export controls without external browsing", async () => {
    await LibraryIndexedDBAdapter.save({
      libraryItems: [
        {
          id: "local-library-controls",
          status: "unpublished",
          created: 0,
          elements: [API.createElement({ type: "rectangle" })],
        },
      ],
    });
    const { container } = await render(<ExcalidrawApp />);
    await act(async () => h.app.library.getLatestLibrary());
    API.setAppState({
      openSidebar: {
        name: common.DEFAULT_SIDEBAR.name,
        tab: common.LIBRARY_SIDEBAR_TAB,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".layer-ui__library")).not.toBeNull();
    });
    expect(container.querySelector(".library-menu-browse-button")).toBeNull();
    fireEvent.click(
      container.querySelector(
        ".library-menu-dropdown-container .dropdown-menu-button",
      )!,
    );
    expect(
      container.querySelector('[data-testid="lib-dropdown--load"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="lib-dropdown--export"]'),
    ).not.toBeNull();
  });

  it("keeps local saving and flushes pending changes on blur", async () => {
    const save = vi.spyOn(LocalData, "save");
    const flush = vi.spyOn(LocalData, "flushSave");
    await render(<ExcalidrawApp />);

    const rectangle = API.createElement({
      type: "rectangle",
      id: "saved-rectangle",
      width: 100,
      height: 100,
    });
    act(() => API.updateScene({ elements: [rectangle] }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: rectangle.id })]),
        expect.any(Object),
        expect.any(Object),
        expect.any(Function),
      );
    });
    fireEvent.blur(window);
    expect(flush).toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)!),
    ).toEqual([expect.objectContaining({ id: rectangle.id })]);
  });

  it("reloads newer browser storage on focus without a collaboration API", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    await render(<ExcalidrawApp />);
    const testEnv = vi.spyOn(common, "isTestEnv").mockReturnValue(false);
    act(() => LocalData.flushSave());
    const rectangle = API.createElement({
      type: "rectangle",
      id: "other-tab-rectangle",
      width: 100,
      height: 100,
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([rectangle]),
    );
    localStorage.setItem(
      STORAGE_KEYS.VERSION_DATA_STATE,
      JSON.stringify(Date.now() + 1000),
    );

    fireEvent.focus(window);

    await waitFor(() => {
      expect(testEnv).toHaveBeenCalled();
      expect(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
      ).toContain(rectangle.id);
      expect(h.elements.map(({ id }) => id)).toEqual([rectangle.id]);
    });
  });

  it("ignores remote hash changes without overwriting the current canvas", async () => {
    await render(<ExcalidrawApp />);
    const rectangle = API.createElement({
      type: "rectangle",
      id: "current-rectangle",
      width: 100,
      height: 100,
    });
    act(() => API.updateScene({ elements: [rectangle] }));
    const importScene = vi.spyOn(data, "importFromBackend");

    await act(async () => {
      window.history.replaceState({}, "", "/#json=remote,secret");
      fireEvent(window, new HashChangeEvent("hashchange"));
    });

    expect(h.elements.map(({ id }) => id)).toEqual([rectangle.id]);
    expect(h.app.state.isLoading).toBe(false);
    expect(importScene).not.toHaveBeenCalled();
  });

  it("shows local storage guidance and omits Plus marketing", async () => {
    const { container } = await render(<ExcalidrawApp />);
    expect(container.textContent).toContain("谷子白板");
    expect(container.textContent).toContain(
      "数据保存在本浏览器，请定期导出备份",
    );
    toggleMenu(container);
    expect(container.querySelector('a[href*="plus"]')).toBeNull();
    expect(container.querySelector('a[href*="sign-up"]')).toBeNull();
    expect(container.querySelector('a[href*="twitter"]')).toBeNull();
    expect(container.querySelector(".app-sidebar-promo-container")).toBeNull();
  });

  it("keeps local commands while hiding remote and AI commands", async () => {
    const { container } = await render(<ExcalidrawApp />);
    toggleMenu(container);
    expect(container.querySelector(".dropdown-menu")?.textContent).toContain(
      t("buttons.load"),
    );
    API.setAppState({
      openMenu: null,
      openDialog: { name: "commandPalette" },
    });

    await waitFor(() => {
      const commands = Array.from(
        container.ownerDocument.querySelectorAll(
          ".command-palette-dialog .command-item .name",
        ),
        (item) => item.textContent,
      );
      expect(commands).toContain(t("exportDialog.disk_title"));
      expect(commands).toContain(t("buttons.exportImage"));
      expect(commands).not.toContain(t("labels.liveCollaboration"));
      expect(commands).not.toContain(t("labels.share"));
      expect(commands).not.toContain(
        t("overwriteConfirm.action.excalidrawPlus.button"),
      );
      expect(commands).not.toContain(`${t("labels.textToDiagram")}...`);
      expect(commands).not.toContain(`${t("toolBar.mermaidToExcalidraw")}...`);
      expect(commands).not.toContain("Excalidraw+");
      expect(commands).not.toContain("GitHub");
    });
    const exportImage = Array.from(
      container.ownerDocument.querySelectorAll(
        ".command-palette-dialog .command-item",
      ),
    ).find((item) => item.textContent?.includes(t("buttons.exportImage")));
    fireEvent.click(exportImage!);
    await waitFor(() => {
      expect(h.app.state.openDialog?.name).toBe("imageExport");
    });
  });

  it("preserves remote import, collaboration and exports in the default mode", async () => {
    singleUser.enabled = false;
    const rectangle = API.createElement({
      type: "rectangle",
      id: "remote-rectangle",
      width: 100,
      height: 100,
    });
    const importScene = vi
      .spyOn(data, "importFromBackend")
      .mockResolvedValue({ elements: [rectangle] });
    window.history.replaceState({}, "", "/#json=remote,secret");

    const { container } = await render(<ExcalidrawApp />);

    expect(importScene).toHaveBeenCalledWith("remote", "secret");
    expect(h.elements.map(({ id }) => id)).toEqual([rectangle.id]);
    expect(Collab).toHaveBeenCalled();
    expect(ShareDialog).toHaveBeenCalled();
    expect(AIComponents).toHaveBeenCalled();
    expect(h.app.props.aiEnabled).toBe(true);
    expect(h.app.props.UIOptions.textSelectionToolbar).toBe(false);
    expect(h.app.props.UIOptions.libraryRemoteActions).toBe(true);
    expect(h.app.props.UIOptions.canvasActions.export).toEqual({
      onExportToBackend: expect.any(Function),
      renderCustomUI: expect.any(Function),
      saveFileToDisk: true,
    });
    toggleMenu(container);
    expect(container.querySelector('a[href*="plus"]')).not.toBeNull();
  });
});
