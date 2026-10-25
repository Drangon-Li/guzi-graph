import { vi } from "vitest";

import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { AppState } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { LocalData, localStorageQuotaExceededAtom } from "../data/LocalData";

const save = () =>
  new Promise<void>((resolve) => {
    const appState: AppState = {
      ...getDefaultAppState(),
      offsetTop: 0,
      offsetLeft: 0,
      width: 800,
      height: 600,
    };
    LocalData.save([], appState, {}, resolve);
    LocalData.flushSave();
  });

describe("LocalData storage quota", () => {
  beforeEach(() => {
    appJotaiStore.set(localStorageQuotaExceededAtom, false);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(LocalData.fileStorage, "saveFiles").mockResolvedValue({
      savedFiles: new Map(),
      erroredFiles: new Map(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    appJotaiStore.set(localStorageQuotaExceededAtom, false);
  });

  it.each([
    "QuotaExceededError",
    "NS_ERROR_DOM_QUOTA_REACHED",
    "QUOTA_EXCEEDED_ERR",
  ])("shows the quota warning for %s", async (name) => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full", name);
    });

    await save();

    expect(appJotaiStore.get(localStorageQuotaExceededAtom)).toBe(true);
  });

  it.each([22, 1014])(
    "recognizes legacy quota error code %s when the name is unavailable",
    async (code) => {
      const error = new DOMException("Storage is full", "UnknownError");
      Object.defineProperty(error, "code", { value: code });
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw error;
      });

      await save();

      expect(appJotaiStore.get(localStorageQuotaExceededAtom)).toBe(true);
    },
  );

  it.each([
    new DOMException("Storage is blocked", "SecurityError"),
    Object.assign(new Error("Write failed"), { name: "QuotaExceededError" }),
  ])(
    "does not report unrelated failures as quota exhaustion",
    async (error) => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw error;
      });

      await save();

      expect(appJotaiStore.get(localStorageQuotaExceededAtom)).toBe(false);
    },
  );

  it("clears the quota warning after saving succeeds again", async () => {
    const setItem = vi
      .spyOn(localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("Storage is full", "NS_ERROR_DOM_QUOTA_REACHED");
      });

    await save();
    expect(appJotaiStore.get(localStorageQuotaExceededAtom)).toBe(true);
    setItem.mockRestore();

    await save();
    expect(appJotaiStore.get(localStorageQuotaExceededAtom)).toBe(false);
  });
});
