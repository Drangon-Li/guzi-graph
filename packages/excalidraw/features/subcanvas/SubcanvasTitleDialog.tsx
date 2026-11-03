import { useState } from "react";

import { actionSubcanvasTitle } from "../../actions/actionSubcanvas";
import { Dialog } from "../../components/Dialog";
import DialogActionButton from "../../components/DialogActionButton";
import { UIAppStateContext } from "../../context/ui-appState";
import { t } from "../../i18n";

import type { AppClassProperties } from "../../types";

export const SubcanvasTitleDialog = ({
  app,
  elementId,
  onClose,
}: {
  app: AppClassProperties;
  elementId: string;
  onClose: () => void;
}) => {
  const pin = app.scene.getElement(elementId);
  const [title, setTitle] = useState(pin?.customData?.subcanvas?.title ?? "");
  return (
    <UIAppStateContext.Provider value={app.state}>
      <Dialog
        title={t("labels.subcanvasTitle")}
        size="small"
        onCloseRequest={onClose}
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await actionSubcanvasTitle.perform(
              app.scene.getElementsIncludingDeleted(),
              app.state,
              { elementId, title },
              app,
            );
            if (result) {
              app.api.updateScene({
                elements: result.elements,
                appState: { ...app.state, ...result.appState },
                captureUpdate: result.captureUpdate,
              });
            }
            onClose();
          }}
        >
          <label>
            {t("labels.name")}
            <input
              className="TextInput"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              style={{
                width: "100%",
                boxSizing: "border-box",
                margin: "8px 0 16px",
              }}
            />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <DialogActionButton label={t("buttons.cancel")} onClick={onClose} />
            <DialogActionButton
              type="submit"
              actionType="primary"
              label={t("buttons.confirm")}
            />
          </div>
        </form>
      </Dialog>
    </UIAppStateContext.Provider>
  );
};
