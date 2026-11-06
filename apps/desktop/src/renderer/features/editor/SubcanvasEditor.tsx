import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import { CaptureUpdateAction } from "@excalidraw/element";
import { getSubcanvasId } from "@excalidraw/excalidraw/subcanvas";
import { cloneSubcanvasScenes } from "@excalidraw/excalidraw/subcanvasActions";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type {
  SubcanvasScene,
  SubcanvasScenes,
} from "@excalidraw/excalidraw/subcanvas";
import type { HistoryCheckpoint } from "@excalidraw/excalidraw/history";

import { PaperPageControls } from "../paper/PaperPageControls";
import { getPaperTextPlacement } from "../paper/paperWriting";

import {
  appendFontReplacementHistory,
  replaceSnapshotFonts,
} from "./canvasFonts";

import "./SubcanvasEditor.scss";

import type { PaperGestureHandler } from "../paper/PaperPageControls";
import type { SceneSnapshot } from "../../shared/model/document";
import type { CanvasDocument } from "../workspace/workspace";

const savedChildState = (state: AppState): SubcanvasScene["appState"] => ({
  viewBackgroundColor: state.viewBackgroundColor,
  scrollX: state.scrollX,
  scrollY: state.scrollY,
  zoom: state.zoom,
  gridModeEnabled: state.gridModeEnabled,
  gridSize: state.gridSize,
  objectsSnapModeEnabled: state.objectsSnapModeEnabled,
  fontRegistry: state.fontRegistry,
});

export const SubcanvasEditor = ({
  document,
  historyCache,
  ...props
}: ExcalidrawProps & {
  document: CanvasDocument;
  historyCache?: Map<string, HistoryCheckpoint>;
}) => {
  const [path, setPath] = useState(() => document.sleepCheckpoint?.path ?? []);
  const [rootReady, setRootReady] = useState(false);
  const rootHistory = useRef(document.sleepCheckpoint?.history);
  const childViewMode = useRef(document.sleepCheckpoint?.childViewModeEnabled);
  const root = useRef<ExcalidrawImperativeAPI | null>(null);
  const [rootApi, setRootApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const paperGesture = useRef<PaperGestureHandler | null>(null);
  const paperScrollConstraint = useRef<AppState["scrollConstraints"]>(null);
  const registerPaperGesture = useCallback(
    (handler: PaperGestureHandler | null) => {
      paperGesture.current = handler;
    },
    [],
  );
  const child = useRef<ExcalidrawImperativeAPI | null>(null);
  const childReady = useRef(false);
  const scenes = useRef<SubcanvasScenes>({});
  const files = useRef<BinaryFiles>({});
  const lastRootMap = useRef<SubcanvasScenes | null>(null);
  const lastChildMap = useRef<SubcanvasScenes | null>(null);
  const checkpoints = useRef(
    historyCache ??
      document.sleepCheckpoint?.children ??
      new Map<string, HistoryCheckpoint>(),
  );
  const latest = useRef(props);
  latest.current = props;
  const activeId = path.at(-1);
  const currentId = useRef(activeId);
  currentId.current = activeId;
  const english = props.langCode === "en";

  const snapshot = (): SceneSnapshot => {
    const api = root.current!;
    files.current = { ...files.current, ...api.getFiles() };
    const childApi = child.current;
    if (childApi && !childApi.isDestroyed) {
      files.current = { ...files.current, ...childApi.getFiles() };
    }
    return {
      elements: api.getSceneElementsIncludingDeleted(),
      appState: { ...api.getAppState(), subscenes: scenes.current },
      files: files.current,
    };
  };

  const publish = () => {
    const api = root.current;
    if (!api || api.isDestroyed) {
      return;
    }
    api.updateScene({
      appState: { subscenes: scenes.current },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const next = snapshot();
    latest.current.onChange?.(
      api.getSceneElementsIncludingDeleted(),
      next.appState,
      next.files,
    );
  };

  const captureChild = (
    id: string,
    elements: readonly ExcalidrawElement[],
    state: AppState,
    childFiles: BinaryFiles,
  ) => {
    if (!scenes.current[id]) {
      return;
    }
    if (state.subscenes !== lastChildMap.current) {
      lastChildMap.current = state.subscenes;
      scenes.current = { ...scenes.current, ...state.subscenes };
    }
    const previous = scenes.current[id];
    const appState = savedChildState(state);
    const nextFiles = Object.values(childFiles).filter(
      (file) => files.current[file.id] !== file,
    );
    if (nextFiles.length) {
      files.current = { ...files.current, ...childFiles };
      root.current?.addFiles(nextFiles);
    }
    if (
      previous.elements === elements &&
      JSON.stringify(previous.appState) === JSON.stringify(appState) &&
      !nextFiles.length
    ) {
      return;
    }
    scenes.current = {
      ...scenes.current,
      [id]: { ...previous, elements, appState },
    };
    publish();
  };

  const flushChild = () => {
    const api = child.current;
    const id = currentId.current;
    if (!api || api.isDestroyed || !id || !childReady.current) {
      return;
    }
    flushSync(() => api.commitEditing());
    captureChild(
      id,
      api.getSceneElementsIncludingDeleted(),
      api.getAppState(),
      api.getFiles(),
    );
    const checkpoint = api.history.checkpoint?.();
    if (checkpoint) {
      checkpoints.current.set(id, checkpoint);
    }
  };

  const navigate = (nextPath: string[]) => {
    const api = child.current;
    if (api?.hasPendingImages?.()) {
      void api.waitForPendingImages().then(() => {
        if (!api.isDestroyed && child.current === api) {
          navigate(nextPath);
        }
      });
      return;
    }
    if (
      nextPath.length === path.length &&
      nextPath.every((id, index) => id === path[index])
    ) {
      return;
    }
    flushChild();
    child.current = null;
    childReady.current = false;
    childViewMode.current = undefined;
    delete document.sleepCheckpoint;
    lastChildMap.current = null;
    setPath(nextPath);
  };

  const open = (elementId: string) => {
    flushChild();
    const api = child.current ?? root.current;
    const element = api
      ?.getSceneElements()
      .find((item) => item.id === elementId);
    const id = getSubcanvasId(element);
    if (id && scenes.current[id] && !path.includes(id)) {
      navigate([...path, id]);
    }
  };

  const duplicate: NonNullable<ExcalidrawProps["onDuplicate"]> = (
    elements,
    previous,
    context,
  ) => {
    const hostResult = latest.current.onDuplicate?.(
      elements,
      previous,
      context,
    );
    if (hostResult === false) {
      return false;
    }
    const next = hostResult ?? elements;
    const originalIds = new Set(previous.map((element) => element.id));
    const copies = cloneSubcanvasScenes(
      next.filter((element) => !originalIds.has(element.id)),
      scenes.current,
    );
    if (!Object.keys(copies.scenes).length) {
      return [...next];
    }
    scenes.current = { ...scenes.current, ...copies.scenes };
    const changed = new Map(
      copies.elements.map((element) => [element.id, element]),
    );
    publish();
    return next.map((element) => changed.get(element.id) ?? element);
  };

  useEffect(() => {
    document.hasPendingImages = () =>
      !!root.current?.hasPendingImages?.() ||
      !!child.current?.hasPendingImages?.();
    document.flushPendingImages = async () => {
      while (document.hasPendingImages?.()) {
        await Promise.all([
          root.current?.waitForPendingImages?.(),
          child.current?.waitForPendingImages?.(),
        ]);
      }
      flushChild();
    };
    document.flushEditing = () => {
      flushChild();
      flushSync(() => root.current?.commitEditing());
    };
    document.getSnapshot = snapshot;
    document.checkpointEditor = () => {
      const id = currentId.current;
      const history = child.current?.history.checkpoint?.(Infinity);
      if (id && history) {
        checkpoints.current.set(id, history);
      }
      return {
        path,
        children: checkpoints.current,
        history: root.current?.history.checkpoint?.(Infinity),
        childViewModeEnabled: child.current?.getViewModePreference(),
        resetScrollConstraints:
          !!paperScrollConstraint.current &&
          root.current?.getAppState().scrollConstraints ===
            paperScrollConstraint.current,
      };
    };
    document.invalidateSubsceneHistory = (ids) => {
      ids.forEach((id) => checkpoints.current.delete(id));
    };
    document.activeEditor = () =>
      currentId.current
        ? childReady.current
          ? child.current
          : null
        : root.current;
    document.replaceAllSceneFonts = (fontFamily) => {
      const api = root.current;
      if (!api || api.isDestroyed) {
        return;
      }
      const previous = snapshot();
      const next = replaceSnapshotFonts(previous, fontFamily);
      const childApi = child.current;
      if (
        next === previous &&
        (!childApi ||
          childApi.isDestroyed ||
          childApi.getAppState().currentItemFontFamily === fontFamily)
      ) {
        return;
      }
      for (const [id, scene] of Object.entries(previous.appState.subscenes)) {
        if (id !== currentId.current) {
          const checkpoint = appendFontReplacementHistory(
            checkpoints.current.get(id),
            scene,
            next.appState.subscenes[id],
          );
          if (checkpoint) {
            checkpoints.current.set(id, checkpoint);
          }
        }
      }
      scenes.current = next.appState.subscenes;
      lastRootMap.current = scenes.current;
      lastChildMap.current = scenes.current;
      const childScene = currentId.current && scenes.current[currentId.current];
      if (childApi && !childApi.isDestroyed && childScene) {
        childApi.updateScene({
          elements: childScene.elements,
          appState: {
            currentItemFontFamily: fontFamily,
            fontRegistry:
              childScene.appState.fontRegistry ??
              childApi.getAppState().fontRegistry,
            subscenes: scenes.current,
          },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
      api.updateScene({
        elements: next.elements,
        appState: {
          currentItemFontFamily: fontFamily,
          fontRegistry: next.appState.fontRegistry,
          subscenes: scenes.current,
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    };
    return () => {
      delete document.hasPendingImages;
      delete document.flushPendingImages;
      delete document.flushEditing;
      delete document.getSnapshot;
      delete document.checkpointEditor;
      delete document.invalidateSubsceneHistory;
      delete document.activeEditor;
      delete document.replaceAllSceneFonts;
    };
  });

  const onViewportGesture: PaperGestureHandler = (gesture, state) => {
    if (!currentId.current && !document.presentation) {
      paperGesture.current?.(gesture, state);
    }
    latest.current.desktopIntegration?.onViewportGesture?.(gesture, state);
  };
  const integration = {
    ...props.desktopIntegration,
    getFreeTextPlacement: document.presentation
      ? undefined
      : getPaperTextPlacement,
    onViewportGesture,
    open: () => latest.current.desktopIntegration!.open(),
    subcanvas: { open },
    sceneFontLabel: activeId
      ? english
        ? "Replace fonts on this subcanvas"
        : "替换当前子画布字体"
      : props.desktopIntegration?.sceneFontLabel,
    save: async (_snapshot: SceneSnapshot, saveAs: boolean) => {
      await document.flushPendingImages?.();
      flushChild();
      root.current?.commitEditing();
      return (
        latest.current.desktopIntegration?.save(snapshot(), saveAs) ?? false
      );
    },
  };
  const scene = rootReady && activeId ? scenes.current[activeId] : null;

  return (
    <>
      <div className="desktop-root-canvas" inert={!!scene}>
        <Excalidraw
          {...props}
          autoFocus={props.autoFocus && !activeId}
          interaction={props.interaction !== false && !scene}
          handleKeyboardGlobally={!!props.handleKeyboardGlobally && !scene}
          desktopIntegration={integration}
          onDuplicate={duplicate}
          onExcalidrawAPI={(api) => {
            root.current = api;
            setRootApi(api);
            props.onExcalidrawAPI?.(api);
          }}
          onInitialize={(api) => {
            scenes.current = api.getAppState().subscenes;
            lastRootMap.current = scenes.current;
            files.current = api.getFiles();
            if (rootHistory.current) {
              api.history.restoreCheckpoint?.(rootHistory.current);
              rootHistory.current = undefined;
            }
            setRootReady(true);
            props.onInitialize?.(api);
          }}
          onChange={(elements, appState, nextFiles) => {
            if (appState.subscenes !== lastRootMap.current) {
              lastRootMap.current = appState.subscenes;
              scenes.current = appState.subscenes;
            }
            files.current = { ...files.current, ...nextFiles };
            props.onChange?.(
              elements,
              { ...appState, subscenes: scenes.current },
              files.current,
            );
          }}
        />
        {rootApi && (
          <PaperPageControls
            api={rootApi}
            active={!scene && !document.presentation}
            ownedConstraint={paperScrollConstraint}
            language={english ? "en" : "zh-CN"}
            register={registerPaperGesture}
          />
        )}
      </div>
      {scene && activeId && (
        <div className="desktop-subcanvas-overlay">
          <section
            className="desktop-subcanvas"
            role="dialog"
            aria-modal="true"
            aria-label={english ? "Subcanvas" : "子画布"}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !(event.target as HTMLElement).closest(
                  "textarea,input,[contenteditable=true],[role=dialog]:not(.desktop-subcanvas)",
                )
              ) {
                event.stopPropagation();
                navigate(path.slice(0, -1));
              }
            }}
          >
            <header className="desktop-subcanvas-header">
              <button
                type="button"
                aria-label={english ? "Back" : "返回上一级"}
                onClick={() => navigate(path.slice(0, -1))}
              >
                ← {english ? "Back" : "返回上一级"}
              </button>
              <nav aria-label={english ? "Canvas path" : "画布路径"}>
                <button type="button" onClick={() => navigate([])}>
                  {document.title}
                </button>
                {path.map((id, index) => (
                  <span key={id}>
                    <span aria-hidden="true"> / </span>
                    <button
                      type="button"
                      aria-current={
                        index === path.length - 1 ? "page" : undefined
                      }
                      onClick={() => navigate(path.slice(0, index + 1))}
                    >
                      {scenes.current[id]?.title}
                    </button>
                  </span>
                ))}
              </nav>
              <button
                type="button"
                aria-label={english ? "Collapse subcanvas" : "收起子画布"}
                onClick={() => navigate([])}
              >
                ✕
              </button>
            </header>
            <div className="desktop-subcanvas-content">
              <Excalidraw
                key={activeId}
                ownerDocument={props.ownerDocument}
                renderEnvironment={props.renderEnvironment}
                initialData={{
                  elements: scene.elements,
                  scrollToContent: scene.appState.scrollX === undefined,
                  appState: {
                    ...scene.appState,
                    viewModeEnabled: childViewMode.current,
                    subscenes: scenes.current,
                    fontTopPicks: root.current?.getAppState().fontTopPicks,
                    currentItemFontFamily:
                      root.current?.getAppState().currentItemFontFamily,
                    colorTopPicks: root.current?.getAppState().colorTopPicks,
                    currentItemStickyNoteMode:
                      root.current?.getAppState().currentItemStickyNoteMode,
                  },
                  files: files.current,
                }}
                onExcalidrawAPI={(api) => {
                  child.current = api;
                }}
                onInitialize={(api) => {
                  const checkpoint = checkpoints.current.get(activeId);
                  if (checkpoint) {
                    api.history.restoreCheckpoint?.(checkpoint);
                  }
                  childViewMode.current = undefined;
                  childReady.current = true;
                  delete document.sleepCheckpoint;
                }}
                onChange={(elements, state, nextFiles) =>
                  captureChild(activeId, elements, state, nextFiles)
                }
                onDuplicate={duplicate}
                desktopIntegration={{
                  ...integration,
                  getFreeTextPlacement: undefined,
                  onViewportGesture: undefined,
                  history: undefined,
                  elementPastePosition: undefined,
                }}
                interaction={props.interaction}
                handleKeyboardGlobally={props.handleKeyboardGlobally}
                autoFocus={props.interaction !== false}
                langCode={props.langCode}
                theme={props.theme}
                name={scene.title}
                UIOptions={props.UIOptions}
              >
                <MainMenu>
                  <MainMenu.DefaultItems.SaveToActiveFile />
                  <MainMenu.DefaultItems.SaveAsImage />
                  <MainMenu.DefaultItems.SearchMenu />
                  <MainMenu.DefaultItems.ClearCanvas />
                  <MainMenu.DefaultItems.ChangeCanvasBackground />
                  <MainMenu.DefaultItems.Preferences />
                  <MainMenu.DefaultItems.Help />
                </MainMenu>
              </Excalidraw>
            </div>
          </section>
        </div>
      )}
    </>
  );
};
