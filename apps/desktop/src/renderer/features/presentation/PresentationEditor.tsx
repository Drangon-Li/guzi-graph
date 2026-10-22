import { useRef, useState } from "react";

import type { AppState, ExcalidrawProps } from "@excalidraw/excalidraw/types";

import { SubcanvasEditor } from "../editor/SubcanvasEditor";

import { PresentationLayout } from "./PresentationLayout";
import { exportPresentationPdf } from "./renderSlide";
import { getSlideBounds } from "./model";

import "./PresentationEditor.scss";

import type { CanvasDocument, Workspace } from "../workspace/workspace";

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
          onExcalidrawAPI={(api) => {
            if (document.activeSlideId === slideId) {
              props.onExcalidrawAPI?.(api);
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
