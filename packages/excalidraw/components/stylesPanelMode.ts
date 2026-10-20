import { deriveStylesPanelMode } from "@excalidraw/common";

import type { EditorInterface } from "@excalidraw/common";

import { getToolPanelDock } from "./ToolPanel";

import type { ExcalidrawProps, UIAppState } from "../types";

export const getEditorStylesPanelMode = (
  editorInterface: EditorInterface,
  appState: UIAppState,
  toolPanel?: NonNullable<ExcalidrawProps["desktopIntegration"]>["toolPanel"],
) =>
  getToolPanelDock(
    toolPanel,
    appState,
    editorInterface.formFactor === "phone",
  ) !== "floating"
    ? "full"
    : deriveStylesPanelMode(editorInterface);
