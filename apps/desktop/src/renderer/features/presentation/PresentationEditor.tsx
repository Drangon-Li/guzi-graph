import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { MIME_TYPES } from "@excalidraw/common";
import {
  createPasteEvent,
  parseDataTransferEvent,
  readSystemClipboard,
} from "@excalidraw/excalidraw/clipboard";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "../editor/SubcanvasEditor";

import { PresentationLayout } from "./PresentationLayout";
import { exportPresentationPdf } from "./renderSlide";
import { getSlideBounds } from "./model";

import "./PresentationEditor.scss";

import type { ReactNode } from "react";
import type { CanvasDocument, Workspace } from "../workspace/workspace";

type PendingPaste = { slideId: string; event?: ClipboardEvent };

const SlideCanvas = ({ children }: { children: ReactNode }) => {
  const content = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = content.current!;
    const overlay = node.parentElement!.querySelector<HTMLDivElement>(
      ".desktop-presentation-slide-transition",
    )!;
    return () => {
      const canvas = node.querySelector<HTMLCanvasElement>(
        ".desktop-root-canvas canvas.static",
      );
      if (
        overlay.childElementCount ||
        !canvas ||
        !canvas.width ||
        !canvas.height
      ) {
        return;
      }
      // Capture before the old editor destroys its canvas on unmount.
      const copy = node.ownerDocument.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.style.width = canvas.style.width;
      copy.style.height = canvas.style.height;
      copy.getContext("2d")!.drawImage(canvas, 0, 0);
      overlay.replaceChildren(copy);
      const boundary = node.querySelector(
        ".desktop-presentation-page-boundary",
      );
      if (boundary) {
        overlay.append(boundary.cloneNode(true));
      }
      overlay.hidden = false;
    };
  }, []);

  return (
    <div className="desktop-presentation-slide-canvas" ref={content}>
      {children}
    </div>
  );
};

export const PresentationEditor = ({
  document,
  workspace,
  ...props
}: ExcalidrawProps & { document: CanvasDocument; workspace: Workspace }) => {
  const deck = document.presentation!;
  const slideId = document.activeSlideId!;
  const slide = deck.slides.find((item) => item.id === slideId)!;
  const bounds = getSlideBounds(slide, deck.width, deck.height);
  const [presenting, setPresenting] = useState(false);
  const boundary = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const transition = useRef<HTMLDivElement>(null);
  const [initialized, setInitialized] = useState<{
    slideId: string;
    api: ExcalidrawImperativeAPI;
  } | null>(null);
  const pendingPastes = useRef<PendingPaste[]>([]);
  const pasteEnabled = useRef(true);
  pasteEnabled.current = props.interaction !== false && !presenting;
  let runtime = document.slideRuntime!.get(slideId);
  if (!runtime) {
    runtime = { children: new Map() };
    document.slideRuntime!.set(slideId, runtime);
  }

  const positionBoundary = (state: AppState) => {
    const node = boundary.current;
    if (node) {
      const zoom = state.zoom.value;
      Object.assign(node.style, {
        left: `${(bounds.x + state.scrollX) * zoom}px`,
        top: `${(bounds.y + state.scrollY) * zoom}px`,
        width: `${bounds.width * zoom}px`,
        height: `${bounds.height * zoom}px`,
      });
    }
  };

  const fit = () => {
    const api = document.api;
    if (api && !api.isDestroyed) {
      api.setViewport({
        target: bounds,
        fit: "contain",
        offsets: { top: 84, bottom: 64, left: 56, right: 56, ui: true },
        animation: false,
      });
      positionBoundary(api.getAppState());
    }
  };

  useEffect(() => {
    if (!initialized || initialized.slideId !== slideId) {
      return;
    }
    const node = container.current!;
    const ownerWindow = node.ownerDocument.defaultView!;
    let frame = 0;
    const reveal = () => {
      ownerWindow.cancelAnimationFrame(frame);
      // StaticCanvas queues its draw from a passive effect. Leave a full frame
      // after that queue (and any resize) before exposing the new canvas.
      frame = ownerWindow.requestAnimationFrame(() => {
        frame = ownerWindow.requestAnimationFrame(() => {
          if (
            document.activeSlideId === slideId &&
            document.api === initialized.api &&
            !initialized.api.isDestroyed
          ) {
            transition.current!.hidden = true;
            transition.current!.replaceChildren();
          }
        });
      });
    };
    const observer = new ownerWindow.ResizeObserver(reveal);
    observer.observe(node);
    reveal();
    return () => {
      observer.disconnect();
      ownerWindow.cancelAnimationFrame(frame);
    };
  }, [document, initialized, slideId]);

  const flushPendingPastes = useCallback(() => {
    const api = document.api;
    if (
      !pasteEnabled.current ||
      !api ||
      api.isDestroyed ||
      api.getAppState().isLoading
    ) {
      return;
    }
    const ready = pendingPastes.current.filter(
      (paste) => paste.slideId === document.activeSlideId && paste.event,
    );
    pendingPastes.current = pendingPastes.current.filter(
      (paste) => !ready.includes(paste),
    );
    ready.forEach((paste) => api.pasteFromClipboard(paste.event!));
  }, [document]);

  useEffect(() => {
    flushPendingPastes();
  }, [props.interaction, presenting, flushPendingPastes]);

  const pasteToCanvas = (event: ClipboardEvent) => {
    const api = document.api;
    if (api && !api.isDestroyed && !api.getAppState().isLoading) {
      api.pasteFromClipboard(event);
      return;
    }
    const ownerWindow = container.current!.ownerDocument.defaultView!;
    const paste: PendingPaste = {
      slideId: document.activeSlideId!,
    };
    pendingPastes.current.push(paste);
    // Capture native data and request web custom formats before activation expires.
    const captured = parseDataTransferEvent(event);
    const customFormats =
      event.isTrusted &&
      Array.from(event.clipboardData?.files ?? []).some(
        (file) => file.type === MIME_TYPES.png,
      )
        ? readSystemClipboard(ownerWindow).catch(() => null)
        : Promise.resolve(null);
    void Promise.all([captured, customFormats])
      .then(([data, custom]) => {
        const types = Object.fromEntries(
          data.flatMap((item) =>
            item.kind === "string" ? [[item.type, item.value]] : [],
          ),
        );
        const elements = custom?.[MIME_TYPES.excalidrawClipboard];
        if (typeof elements === "string") {
          types[MIME_TYPES.excalidrawClipboard] = elements;
        }
        paste.event = createPasteEvent(
          { types, files: data.getFiles().map(({ file }) => file) },
          ownerWindow,
        );
        flushPendingPastes();
      })
      .catch(workspace.reportError);
  };

  return (
    <PresentationLayout
      presentation={deck}
      activeSlideId={slideId}
      revision={document.revision}
      active={props.interaction !== false}
      blocked={false}
      language={props.langCode === "en" ? "en" : "zh-CN"}
      theme={props.theme}
      onSelect={(id) => workspace.selectSlide(document, id)}
      onAdd={() => workspace.addSlide(document)}
      onCopy={(id) => workspace.copySlide(document, id)}
      onPaste={(content) => {
        void workspace
          .pasteSlide(document, content)
          .catch(workspace.reportError);
      }}
      onCanvasPaste={pasteToCanvas}
      onHistory={(direction) =>
        workspace.performPresentationHistory(document, direction)
      }
      onDelete={(id) => workspace.deleteSlide(document, id)}
      onRename={(id, title) => workspace.renameSlide(document, id, title)}
      onMove={(id, index) => workspace.moveSlide(document, id, index)}
      onFit={fit}
      onController={(controller) => {
        document.presentationController = controller ?? undefined;
      }}
      beforePresent={() => workspace.commitText(document)}
      onPresent={(value) => {
        document.presenting = value;
        setPresenting(value);
      }}
      onExportPdf={() => {
        workspace.commitText(document);
        const ownerDocument = container.current!.ownerDocument;
        void exportPresentationPdf(
          deck,
          document.title,
          ownerDocument.defaultView!.desktop,
          ownerDocument,
        ).catch(workspace.reportError);
      }}
    >
      <div className="desktop-presentation-canvas" ref={container}>
        <SlideCanvas key={slideId}>
          <SubcanvasEditor
            {...props}
            autoFocus={false}
            document={document}
            historyCache={runtime.children}
            viewModeEnabled={false}
            initialData={{ ...document.initialData, scrollToContent: false }}
            initialState={
              runtime.snapshot
                ? undefined
                : {
                    viewport: {
                      target: bounds,
                      fit: "contain",
                      offsets: {
                        top: 84,
                        bottom: 64,
                        left: 56,
                        right: 56,
                        ui: true,
                      },
                    },
                  }
            }
            interaction={props.interaction !== false && !presenting}
            handleKeyboardGlobally={
              !!props.handleKeyboardGlobally && !presenting
            }
            desktopIntegration={
              props.desktopIntegration && {
                ...props.desktopIntegration,
                history: {
                  undoAvailable:
                    !!document.presentationHistory?.undo.length &&
                    !document.presentationHistory.pending,
                  redoAvailable:
                    !!document.presentationHistory?.redo.length &&
                    !document.presentationHistory.pending,
                  perform: (direction) =>
                    workspace.performPresentationHistory(document, direction),
                },
              }
            }
            onExcalidrawAPI={(api) => {
              if (document.activeSlideId === slideId) {
                props.onExcalidrawAPI?.(api);
                api?.onIncrement((increment) => {
                  if (
                    document.activeSlideId === slideId &&
                    document.api === api
                  ) {
                    workspace.recordPresentationIncrement(document, increment);
                  }
                });
              }
            }}
            onInitialize={(api) => {
              if (document.activeSlideId !== slideId) {
                return;
              }
              if (runtime.history) {
                api.history.restoreCheckpoint?.(runtime.history);
              }
              props.onInitialize?.(api);
              workspace.resumePresentationHistory(document, api);
              flushPendingPastes();
              positionBoundary(api.getAppState());
              setInitialized({ slideId, api });
            }}
            onChange={(elements, state, files) => {
              if (document.activeSlideId === slideId) {
                positionBoundary(state);
                props.onChange?.(elements, state, files);
              }
            }}
          />
          <div
            className="desktop-presentation-page-boundary"
            ref={boundary}
            aria-hidden="true"
          />
        </SlideCanvas>
        <div
          className="desktop-presentation-slide-transition"
          ref={transition}
          aria-hidden="true"
          hidden
        />
      </div>
    </PresentationLayout>
  );
};
