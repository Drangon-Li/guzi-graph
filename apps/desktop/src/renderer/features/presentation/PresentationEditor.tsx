import { useCallback, useEffect, useRef, useState } from "react";

import { MIME_TYPES } from "@excalidraw/common";
import {
  createPasteEvent,
  parseDataTransferEvent,
  readSystemClipboard,
} from "@excalidraw/excalidraw/clipboard";

import type { AppState, ExcalidrawProps } from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "../editor/SubcanvasEditor";

import { PresentationLayout } from "./PresentationLayout";
import { exportPresentationPdf } from "./renderSlide";
import { getSlideBounds } from "./model";

import "./PresentationEditor.scss";

import type { CanvasDocument, Workspace } from "../workspace/workspace";

type PendingPaste = { slideId: string; event?: ClipboardEvent };

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
        <SubcanvasEditor
          {...props}
          key={slideId}
          autoFocus={false}
          document={document}
          historyCache={runtime.children}
          viewModeEnabled={false}
          initialData={{ ...document.initialData, scrollToContent: false }}
          interaction={props.interaction !== false && !presenting}
          handleKeyboardGlobally={!!props.handleKeyboardGlobally && !presenting}
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
            if (runtime.snapshot) {
              positionBoundary(api.getAppState());
            } else {
              fit();
            }
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
      </div>
    </PresentationLayout>
  );
};
