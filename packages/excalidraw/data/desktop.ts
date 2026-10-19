import { CaptureUpdateAction } from "@excalidraw/element";

import { t } from "../i18n";

import type { AppClassProperties } from "../types";

const pendingSaves = new WeakSet<AppClassProperties>();

export const saveDesktopDocument = async (
  app: AppClassProperties,
  saveAs: boolean,
): Promise<boolean> => {
  const integration = app.props.desktopIntegration;
  if (!integration || pendingSaves.has(app)) {
    return false;
  }

  pendingSaves.add(app);
  try {
    app.api.commitEditing();
    const saved = await integration.save(
      {
        elements: app.scene.getElementsIncludingDeleted(),
        appState: app.state,
        files: app.files,
      },
      saveAs,
    );
    if (saved) {
      app.syncActionResult({
        captureUpdate: CaptureUpdateAction.NEVER,
        appState: {
          openDialog: null,
          toast: { message: t("toast.fileSaved"), duration: 1500 },
        },
      });
    }
    return saved;
  } catch (error: any) {
    if (error?.name !== "AbortError") {
      app.syncActionResult({
        captureUpdate: CaptureUpdateAction.NEVER,
        appState: { errorMessage: error.message },
      });
    }
    return false;
  } finally {
    pendingSaves.delete(app);
  }
};
