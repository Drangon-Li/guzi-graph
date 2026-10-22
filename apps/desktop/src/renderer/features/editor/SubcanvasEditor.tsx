import { useEffect, useRef, useState } from "react";
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

import "./SubcanvasEditor.scss";

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
  const [path, setPath] = useState<string[]>([]);
  const root = useRef<ExcalidrawImperativeAPI | null>(null);
  const child = useRef<ExcalidrawImperativeAPI | null>(null);
  const childReady = useRef(false);
  const scenes = useRef<SubcanvasScenes>({});
  const files = useRef<BinaryFiles>({});
  const lastRootMap = useRef<SubcanvasScenes | null>(null);
  const lastChildMap = useRef<SubcanvasScenes | null>(null);
  const checkpoints = useRef(
    historyCache ?? new Map<string, HistoryCheckpoint>(),
  );
  const latest = useRef(props);
  latest.current = props;
  const activeId = path.at(-1);
  const currentId = useRef(activeId);
  currentId.current = activeId;
  const english = props.langCode === "en";

  const snapshot = (): SceneSnapshot => {
    const api = root.current!;
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
    if (!api || api.isDestroyed || !id) {
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
    if (
      nextPath.length === path.length &&
      nextPath.every((id, index) => id === path[index])
    ) {
      return;
    }
    flushChild();
    child.current = null;
    childReady.current = false;
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
    document.flushEditing = () => {
      flushChild();
      flushSync(() => root.current?.commitEditing());
    };
    document.getSnapshot = snapshot;
    document.invalidateSubsceneHistory = (ids) => {
      ids.forEach((id) => checkpoints.current.delete(id));
    };
    document.activeEditor = () =>
      currentId.current
        ? childReady.current
          ? child.current
          : null
        : root.current;
    return () => {
      delete document.flushEditing;
      delete document.getSnapshot;
      delete document.invalidateSubsceneHistory;
      delete document.activeEditor;
    };
  });

  const integration = {
    ...props.desktopIntegration,
    open: () => latest.current.desktopIntegration!.open(),
    subcanvas: { open },
    save: async (_snapshot: SceneSnapshot, saveAs: boolean) => {
      flushChild();
      root.current?.commitEditing();
      return (
        latest.current.desktopIntegration?.save(snapshot(), saveAs) ?? false
      );
    },
  };
  const scene = activeId ? scenes.current[activeId] : null;

  return (
    <>
      <div className="desktop-root-canvas" inert={!!scene}>
        <Excalidraw
          {...props}
          interaction={props.interaction !== false && !scene}
          handleKeyboardGlobally={!!props.handleKeyboardGlobally && !scene}
          desktopIntegration={integration}
          onDuplicate={duplicate}
          onExcalidrawAPI={(api) => {
            root.current = api;
            props.onExcalidrawAPI?.(api);
          }}
          onInitialize={(api) => {
            scenes.current = api.getAppState().subscenes;
            lastRootMap.current = scenes.current;
            files.current = api.getFiles();
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
                initialData={{
                  elements: scene.elements,
                  scrollToContent: scene.appState.scrollX === undefined,
                  appState: {
                    ...scene.appState,
                    subscenes: scenes.current,
                    fontTopPicks: root.current?.getAppState().fontTopPicks,
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
                  childReady.current = true;
                }}
                onChange={(elements, state, nextFiles) =>
                  captureChild(activeId, elements, state, nextFiles)
                }
                onDuplicate={duplicate}
                desktopIntegration={integration}
                interaction={props.interaction}
                handleKeyboardGlobally={props.handleKeyboardGlobally}
                autoFocus
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
