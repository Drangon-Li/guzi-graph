import { CaptureUpdateAction, newElementWith } from "@excalidraw/element";

import { getSubcanvasId } from "../features/subcanvas/model";

import { register } from "./register";

export const actionSubcanvasTitle = register<
  string | { elementId: string; title: string } | null
>({
  name: "subcanvasTitle",
  label: "labels.subcanvasTitle",
  trackEvent: false,
  predicate: (elements, state) =>
    !state.viewModeEnabled &&
    elements.filter(
      (element) => !element.isDeleted && state.selectedElementIds[element.id],
    ).length === 1 &&
    elements.some(
      (element) =>
        state.selectedElementIds[element.id] && getSubcanvasId(element),
    ),
  perform: (elements, state, value) => {
    const pin = elements.find(
      (element) =>
        !element.isDeleted &&
        (value && typeof value === "object"
          ? element.id === value.elementId
          : state.selectedElementIds[element.id]) &&
        getSubcanvasId(element),
    );
    const sceneId = getSubcanvasId(pin);
    if (!pin || !sceneId) {
      return false;
    }
    if (value == null) {
      return {
        appState: { openDialog: { name: "subcanvasTitle", elementId: pin.id } },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }
    const current =
      pin.customData?.subcanvas?.title ?? state.subscenes[sceneId]?.title ?? "";
    const title = typeof value === "string" ? value : value.title;
    if (title === current) {
      return false;
    }
    return {
      elements: elements.map((element) =>
        element.id === pin.id
          ? newElementWith(element, {
              customData: {
                ...element.customData,
                subcanvas: { ...element.customData?.subcanvas, title },
              },
            })
          : element,
      ),
      appState: {
        openDialog: null,
        ...(state.subscenes[sceneId]
          ? {
              subscenes: {
                ...state.subscenes,
                [sceneId]: { ...state.subscenes[sceneId], title },
              },
            }
          : {}),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});
