import { CaptureUpdateAction } from "@excalidraw/element";
import { updateBoundElements } from "@excalidraw/element/binding";

import { getLanguage } from "../i18n";
import { getSubcanvasId } from "../subcanvas";
import {
  convertStickyNoteToSubcanvas,
  setStickyNoteCreationMode,
} from "../subcanvasActions";

import "./SubcanvasActions.scss";

import type { AppClassProperties, AppState } from "../types";

export const SubcanvasActions = ({
  app,
  appState,
}: {
  app: AppClassProperties;
  appState: AppState;
}) => {
  if (!app.props.desktopIntegration?.subcanvas) {
    return null;
  }
  const notes = app.scene
    .getNonDeletedElements()
    .filter(
      (element) =>
        element.type === "stickynote" &&
        appState.selectedElementIds[element.id],
    );
  if (notes.length !== 1) {
    return null;
  }
  const note = notes[0];
  const en = getLanguage().code === "en";
  const isPin = !!getSubcanvasId(note);
  return (
    <div
      className="subcanvas-actions"
      role="group"
      aria-label={en ? "Subcanvas" : "子画布"}
    >
      <h3>{en ? "Subcanvas" : "子画布"}</h3>
      <button
        type="button"
        className="subcanvas-action-button"
        onClick={() => {
          if (isPin) {
            app.props.desktopIntegration!.subcanvas!.open(note.id);
            return;
          }
          app.api.commitEditing();
          const result = convertStickyNoteToSubcanvas(
            app.scene.getElementsIncludingDeleted(),
            note.id,
            appState.subscenes,
            en ? "Subcanvas" : "子画布",
          );
          if (result) {
            setStickyNoteCreationMode(app, "subcanvas");
            const pin = result.elements.find(
              (element) => element.id === note.id,
            )!;
            app.api.updateScene({
              elements: result.elements,
              appState: { subscenes: result.scenes },
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
            updateBoundElements(pin as typeof note, app.scene, {
              changedElements: new Map([[pin.id, pin]]),
            });
          }
        }}
      >
        {isPin
          ? en
            ? "Open subcanvas"
            : "打开子画布"
          : en
          ? "Convert to subcanvas"
          : "转为子画布"}
      </button>
    </div>
  );
};
