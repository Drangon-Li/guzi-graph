import { CaptureUpdateAction } from "@excalidraw/excalidraw";

import type {
  AppState,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { fileTitle } from "../../shared/model/document";
import {
  registerPreferenceFonts,
  getPreferenceColorTopPicks,
} from "../../shared/config/editorPreferences";
import { fileName, isPathInDirectory } from "../../shared/model/path";

import type {
  DesktopSettings,
  ProjectFile,
  RecoveryDraft,
} from "../../../shared/desktop-api";
import type { WorkspaceState } from "./state";
import type { DocumentActions } from "./documents";

/**
 * Settings, the project directory, file and folder management, renaming
 * and recovery-draft handling.
 */
export const createProjectFileActions = (
  workspace: WorkspaceState,
  {
    saveSession,
    activate,
    refreshProjects,
    createDocument,
    parse,
    scheduleDraft,
    commitText,
  }: DocumentActions,
) => {
  const {
    ownerWindow,
    desktop,
    documentsRef,
    closingRef,
    settingsQueue,
    settingsRef,
    relocationId,
    setError,
    refresh,
    reportError,
    setSettings,
    setProjects,
    setDrafts,
  } = workspace;

  const changeDirectory = async () => {
    try {
      const next = await desktop.chooseDirectory();
      if (next) {
        settingsRef.current = next;
        setSettings(next);
        await refreshProjects();
      }
    } catch (failure) {
      reportError(failure);
    }
  };

  const updateSettings = (update: Partial<DesktopSettings>) => {
    const task = settingsQueue.current.then(async () => {
      try {
        const next = await desktop.updateSettings(update);
        settingsRef.current = next;
        const { editorPreferences: preferences, stickyNoteMode } = update;
        if (stickyNoteMode) {
          const appState = { currentItemStickyNoteMode: stickyNoteMode };
          for (const document of documentsRef.current) {
            document.initialData = {
              ...document.initialData,
              appState: { ...document.initialData.appState, ...appState },
            };
            for (const editor of new Set([
              document.api,
              document.activeEditor?.(),
            ])) {
              editor?.updateScene({
                appState,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        }
        if (preferences) {
          const registry = registerPreferenceFonts(preferences);
          const defaultsFor = (appState?: Partial<AppState> | null) => ({
            currentItemFontFamily: preferences.defaultFontFamily,
            fontRegistry: { ...appState?.fontRegistry, ...registry },
            fontTopPicks: preferences.fontTopPicks,
            colorTopPicks: getPreferenceColorTopPicks(
              preferences,
              appState?.colorTopPicks,
            ),
          });
          const applyDefaults = <T extends ExcalidrawInitialDataState>(
            scene: T,
          ): T => ({
            ...scene,
            appState: {
              ...scene.appState,
              ...defaultsFor(scene.appState),
            },
          });
          for (const document of documentsRef.current) {
            document.initialData = applyDefaults(document.initialData);
            for (const slide of document.presentation?.slides ?? []) {
              slide.scene = applyDefaults(slide.scene);
            }
            for (const runtime of document.slideRuntime?.values() ?? []) {
              if (runtime.snapshot) {
                runtime.snapshot = applyDefaults(runtime.snapshot);
              }
            }
            for (const editor of new Set([
              document.api,
              document.activeEditor?.(),
            ])) {
              if (editor && !editor.isDestroyed) {
                editor.updateScene({
                  appState: defaultsFor(editor.getAppState()),
                  captureUpdate: CaptureUpdateAction.NEVER,
                });
              }
            }
          }
        }
        setSettings(next);
        return next;
      } catch (failure) {
        reportError(failure);
        return null;
      }
    });
    settingsQueue.current = task.then(() => {});
    return task;
  };

  const changeTheme = (theme: DesktopSettings["theme"]) =>
    updateSettings({ theme });

  const mutateFile = async (
    operation: "rename" | "move",
    file: ProjectFile,
    value: string,
  ) => {
    if (closingRef.current) {
      return false;
    }
    try {
      const pendingDocument = documentsRef.current.find(
        (item) => item.path === file.path,
      );
      while (pendingDocument?.saving) {
        await pendingDocument.saving;
      }
      if (closingRef.current) {
        return false;
      }
      const next = await (operation === "rename"
        ? desktop.renameFile(file.path, value)
        : desktop.moveFile(file.path, value));
      const document = documentsRef.current.find(
        (item) => item.path === file.path,
      );
      if (document) {
        document.path = next.path;
        document.title = fileTitle(next.path);
        if (document.dirty) {
          scheduleDraft(document);
        }
        refresh();
        saveSession();
      }
      await refreshProjects();
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    }
  };

  const syncFolderPins = (next: DesktopSettings, rootDirectory: string) => {
    const current = settingsRef.current;
    const updated = {
      ...current,
      pinnedFoldersByRoot: {
        ...current.pinnedFoldersByRoot,
        [rootDirectory]: next.pinnedFoldersByRoot?.[rootDirectory] ?? [],
      },
    };
    settingsRef.current = updated;
    setSettings(updated);
  };

  const setFolderPinned = (category: string, pinned: boolean) => {
    const rootDirectory = settingsRef.current.rootDirectory;
    if (!rootDirectory) {
      return Promise.resolve(false);
    }
    const task = settingsQueue.current.then(async () => {
      try {
        const next = await desktop.setFolderPinned(
          category,
          pinned,
          rootDirectory,
        );
        syncFolderPins(next, rootDirectory);
        return true;
      } catch (failure) {
        reportError(failure);
        return false;
      }
    });
    settingsQueue.current = task.then(() => {});
    return task;
  };

  const relocateFolder = async (
    operation: "move" | "rename",
    category: string,
    value: string,
  ) => {
    if (closingRef.current || !settingsRef.current.rootDirectory) {
      return false;
    }
    const rootDirectory = settingsRef.current.rootDirectory;
    const source = `${rootDirectory.replace(/[\\/]+$/, "")}/${category}`;
    const affected = documentsRef.current.filter(
      (document) =>
        document.path &&
        isPathInDirectory(document.path, source, desktop.platform),
    );
    if (affected.some((document) => document.relocating)) {
      return false;
    }
    let release!: () => void;
    const relocating = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const document of affected) {
      document.relocating = relocating;
      ownerWindow.clearTimeout(document.draftTimer);
    }
    try {
      for (const document of affected) {
        while (document.saving) {
          await document.saving;
        }
        await document.draftTask;
      }
      if (
        closingRef.current ||
        settingsRef.current.rootDirectory !== rootDirectory
      ) {
        return false;
      }
      const moved = await (operation === "move"
        ? desktop.moveFolder(category, value, rootDirectory)
        : desktop.renameFolder(category, value, rootDirectory));
      const remap = (candidate: string | null) =>
        candidate &&
        isPathInDirectory(candidate, moved.source, desktop.platform)
          ? `${moved.destination}${candidate.slice(moved.source.length)}`
          : candidate;
      for (const document of documentsRef.current) {
        document.path = remap(document.path);
      }
      setDrafts((current) =>
        current.map((draft) => ({ ...draft, path: remap(draft.path) })),
      );
      refresh();
      await saveSession();
      try {
        const syncingSettings = settingsQueue.current.then(async () => {
          const nextSettings = await desktop.getSettings();
          syncFolderPins(nextSettings, rootDirectory);
        });
        settingsQueue.current = syncingSettings.catch(() => {});
        const [nextIndex] = await Promise.all([
          desktop.listProjects(),
          syncingSettings,
        ]);
        if (
          settingsRef.current.rootDirectory === rootDirectory &&
          nextIndex.rootDirectory === rootDirectory
        ) {
          const relative = (candidate: string) =>
            candidate
              .slice(rootDirectory.replace(/[\\/]+$/, "").length + 1)
              .replace(/\\/g, "/");
          setProjects({
            index: nextIndex,
            folderRelocation: {
              id: ++relocationId.current,
              rootDirectory,
              source: relative(moved.source),
              destination: relative(moved.destination),
            },
          });
        }
      } catch (failure) {
        reportError(failure);
      }
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    } finally {
      for (const document of affected) {
        delete document.relocating;
        if (document.dirty) {
          scheduleDraft(document);
        }
      }
      release();
    }
  };

  const moveFolder = (category: string, parentCategory: string) =>
    relocateFolder("move", category, parentCategory);

  const renameFolder = (category: string, name: string) =>
    relocateFolder("rename", category, name);

  const createFolder = async (name: string) => {
    try {
      await desktop.createFolder(name);
      await refreshProjects();
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    }
  };

  const recover = async (draft: RecoveryDraft) => {
    const existing = documentsRef.current.find(
      (document) => document.id === draft.id,
    );
    if (existing) {
      activate(existing.id);
      return true;
    }
    try {
      const data = await parse(draft.content);
      const opened = documentsRef.current.find(
        (document) => document.id === draft.id,
      );
      if (opened) {
        activate(opened.id);
        return true;
      }
      await desktop.writeDraft({ ...draft, path: null });
      const recovered = documentsRef.current.find(
        (document) => document.id === draft.id,
      );
      if (recovered) {
        activate(recovered.id);
        return true;
      }
      createDocument(data, undefined, draft);
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
      return true;
    } catch (failure) {
      reportError(failure);
      return false;
    }
  };

  const renameDocument = async (id: string, name: string) => {
    const document = documentsRef.current.find((item) => item.id === id);
    if (!document || closingRef.current) {
      return false;
    }
    const trimmed = name.trim();
    const title = fileTitle(trimmed);
    if (
      !trimmed ||
      !title ||
      title === "." ||
      title === ".." ||
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      Array.from(trimmed).some((character) => character.charCodeAt(0) < 32)
    ) {
      setError("请输入有效的画布名称，不要包含路径或特殊字符。");
      return false;
    }
    commitText(document);
    if (document.saving) {
      await document.saving;
    }
    if (document.path) {
      return mutateFile(
        "rename",
        {
          path: document.path,
          relativePath: document.path,
          name: fileName(document.path),
          category: "",
          modifiedAt: document.modifiedAt || 0,
          size: document.content.length,
        },
        title,
      );
    }
    document.title = title;
    if (document.dirty) {
      scheduleDraft(document);
    }
    refresh();
    return true;
  };

  const discardDraft = async (id: string) => {
    try {
      await desktop.deleteDraft(id);
      setDrafts((current) => current.filter((draft) => draft.id !== id));
    } catch (failure) {
      reportError(failure);
    }
  };

  return {
    changeDirectory,
    updateSettings,
    changeTheme,
    mutateFile,
    setFolderPinned,
    moveFolder,
    renameFolder,
    createFolder,
    recover,
    renameDocument,
    discardDraft,
  };
};

export type ProjectFileActions = ReturnType<typeof createProjectFileActions>;
