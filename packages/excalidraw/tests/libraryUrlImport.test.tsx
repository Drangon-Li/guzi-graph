import { useState } from "react";

import { MIME_TYPES } from "@excalidraw/common";

import { useHandleLibrary } from "../data/library";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, fireEvent, render, waitFor } from "./test-utils";

import type { ExcalidrawImperativeAPI, LibraryItems } from "../types";

const libraryUrl = "https://libraries.excalidraw.com/test.excalidrawlib";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

it.each([
  { libraryUrlImport: undefined, urlType: "hash" },
  { libraryUrlImport: false, urlType: "hash" },
  { libraryUrlImport: undefined, urlType: "query" },
  { libraryUrlImport: false, urlType: "query" },
])(
  "respects libraryUrlImport=$libraryUrlImport for $urlType URLs while preserving local library load and save",
  async ({ libraryUrlImport, urlType }) => {
    const localItems: LibraryItems = [
      {
        id: "local-item",
        status: "unpublished",
        created: 1,
        elements: [API.createElement({ type: "rectangle" })],
      },
    ];
    const adapter = {
      load: vi.fn(async () => ({ libraryItems: localItems })),
      save: vi.fn(async () => {}),
    };
    const fetchLibrary = vi.fn(async () => ({
      blob: async () =>
        new Blob(
          [
            await API.readFile(
              "./fixtures/fixture_library.excalidrawlib",
              "utf8",
            ),
          ],
          { type: MIME_TYPES.excalidrawlib },
        ),
    }));
    vi.stubGlobal("fetch", fetchLibrary);
    const Harness = () => {
      const [api, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);
      useHandleLibrary({ excalidrawAPI: api, adapter, libraryUrlImport });
      return (
        <Excalidraw
          onExcalidrawAPI={(nextAPI) => {
            if (!nextAPI) {
              return;
            }
            window.history.replaceState(
              {},
              "",
              urlType === "hash"
                ? `#addLibrary=${encodeURIComponent(libraryUrl)}&token=${
                    nextAPI.id
                  }`
                : `?addLibrary=${encodeURIComponent(libraryUrl)}#token=${
                    nextAPI.id
                  }`,
            );
            setAPI(nextAPI);
          }}
        />
      );
    };
    await render(<Harness />);
    await waitFor(() => expect(adapter.load).toHaveBeenCalled());
    await waitFor(async () => {
      expect(await window.h.app.library.getLatestLibrary()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "local-item" })]),
      );
    });
    if (libraryUrlImport === false) {
      expect(fetchLibrary).not.toHaveBeenCalled();
      const locationBeforeHashChange = window.location.href;
      act(() => {
        const ownerWindow = window.h.app.ownerWindow;
        ownerWindow.dispatchEvent(
          new ownerWindow.HashChangeEvent("hashchange"),
        );
      });
      expect(fetchLibrary).not.toHaveBeenCalled();
      expect(window.location.href).toBe(locationBeforeHashChange);
      await act(async () => {
        await window.h.app.api.updateLibrary({
          libraryItems: [],
          merge: false,
        });
      });
      await waitFor(() =>
        expect(adapter.save).toHaveBeenCalledWith({ libraryItems: [] }),
      );
    } else {
      await waitFor(() =>
        expect(fetchLibrary).toHaveBeenCalledWith(libraryUrl),
      );
      await waitFor(async () => {
        expect(await window.h.app.library.getLatestLibrary()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "local-item" }),
            expect.objectContaining({
              elements: expect.arrayContaining([
                expect.objectContaining({ id: "A" }),
              ]),
            }),
          ]),
        );
      });
    }
  },
);

it.each([
  { libraryRemoteActions: undefined, localOnly: false },
  { libraryRemoteActions: false, localOnly: false },
  { libraryRemoteActions: undefined, localOnly: true },
  { libraryRemoteActions: true, localOnly: true },
])(
  "respects libraryRemoteActions=$libraryRemoteActions with localOnly=$localOnly",
  async ({ libraryRemoteActions, localOnly }) => {
    const remoteActionsEnabled = !localOnly && libraryRemoteActions !== false;
    const { container } = await render(
      <Excalidraw
        UIOptions={{ libraryRemoteActions }}
        desktopIntegration={
          localOnly
            ? { localOnly: true, save: async () => true, open: async () => {} }
            : undefined
        }
        initialData={{
          appState: { openSidebar: { name: "default", tab: "library" } },
          libraryItems: [
            {
              id: "publishable-item",
              status: "unpublished",
              created: 1,
              elements: [API.createElement({ type: "rectangle" })],
            },
          ],
        }}
      />,
    );
    expect(!!container.querySelector(".library-menu-browse-button")).toBe(
      remoteActionsEnabled,
    );
    await waitFor(() =>
      expect(container.querySelector(".library-unit__dragger")).not.toBeNull(),
    );
    fireEvent.click(container.querySelector(".library-unit__dragger")!, {
      shiftKey: true,
    });
    const menuTrigger = container.querySelector(
      '.layer-ui__library [data-testid="dropdown-menu-button"]',
    )!;
    if (menuTrigger.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(menuTrigger);
    }
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="lib-dropdown--export"]'),
      ).not.toBeNull(),
    );
    expect(
      !!container.querySelector('[data-testid="lib-dropdown--remove"]'),
    ).toBe(remoteActionsEnabled);
    fireEvent.click(menuTrigger);
  },
);
