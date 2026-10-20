import { CaptureUpdateAction } from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
} from "@excalidraw/element/table";

import { getSelectedTableRoot, getTableDefaults } from "../table";

import { register } from "./register";

export const actionInsertTable = register({
  name: "insertTable",
  label: "labels.insertTable",
  keywords: ["table", "spreadsheet"],
  trackEvent: { category: "element" },
  keyTest: (event) =>
    event.key.toLowerCase() === "h" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.repeat,
  perform: (_, appState, __, app) => {
    app.setActiveTool({ type: "selection" });
    app.onInsertElements(
      createTableElements(
        createTableData(3, 3, getTableDefaults(appState)),
        0,
        0,
        {
          roughness: appState.currentItemRoughness,
          opacity: appState.currentItemOpacity,
        },
      ).elements,
    );
    app.focusContainer();
    return { captureUpdate: CaptureUpdateAction.NEVER };
  },
});

export const actionTableProperties = register({
  name: "tableProperties",
  label: "labels.tableProperties",
  trackEvent: false,
  predicate: (elements, appState) =>
    !appState.editingTextElement &&
    !!getSelectedTableRoot(elements, appState.selectedElementIds),
  perform: (elements, appState) => {
    const root = getSelectedTableRoot(elements, appState.selectedElementIds);
    return root
      ? {
          appState: { openDialog: { name: "table", elementId: root.id } },
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
        }
      : false;
  },
});
