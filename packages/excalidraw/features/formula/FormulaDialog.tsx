import { useCallback, useState } from "react";

import {
  CaptureUpdateAction,
  createFormulaSvg,
  getFormulaDimensions,
  isTextElement,
  newElementWith,
  newTextElement,
  tryGetFormulaLayout,
  updateBoundElements,
} from "@excalidraw/element";

import { Dialog } from "../../components/Dialog";
import DialogActionButton from "../../components/DialogActionButton";
import { UIAppStateContext } from "../../context/ui-appState";
import { t } from "../../i18n";

import "./FormulaDialog.scss";

import type { AppClassProperties } from "../../types";

export const FormulaDialog = ({
  app,
  elementId,
}: {
  app: AppClassProperties;
  elementId?: string;
}) => {
  const element = elementId ? app.scene.getNonDeletedElement(elementId) : null;
  const current = isTextElement(element) && element.latex ? element : null;
  const [source, setSource] = useState(current?.latex ?? "");
  const latex = source.trim();
  const layout = latex ? tryGetFormulaLayout(latex) : null;

  const previewRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && layout) {
        const { width, height } = getFormulaDimensions(layout, 28);
        node.replaceChildren(
          createFormulaSvg(
            layout,
            node.ownerDocument,
            width,
            height,
            "currentColor",
          ),
        );
      }
    },
    [layout],
  );

  const close = () => {
    app.setOpenDialog(null);
    app.focusContainer();
  };

  const submit = () => {
    if (!layout || app.state.viewModeEnabled) {
      return;
    }
    if (elementId) {
      if (current && !current.locked && current.latex !== latex) {
        const updated = newElementWith(current, {
          latex,
          text: latex,
          originalText: latex,
          ...getFormulaDimensions(layout, current.fontSize),
        });
        updateBoundElements(updated, app.scene, {
          changedElements: new Map([[updated.id, updated]]),
        });
        app.syncActionResult({
          elements: app.scene
            .getElementsIncludingDeleted()
            .map((item) => (item.id === updated.id ? updated : item)),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
    } else {
      const {
        currentItemFontSize,
        currentItemStrokeColor,
        currentItemOpacity,
      } = app.state;
      app.onInsertElements([
        {
          ...newTextElement({
            x: 0,
            y: 0,
            text: latex,
            fontSize: currentItemFontSize,
            strokeColor: currentItemStrokeColor,
            opacity: currentItemOpacity,
            renderEnvironment: app.renderEnvironment,
          }),
          latex,
          ...getFormulaDimensions(layout, currentItemFontSize),
        },
      ]);
    }
    close();
  };

  return (
    <UIAppStateContext.Provider value={app.state}>
      <Dialog
        title={t(elementId ? "labels.editFormula" : "labels.insertFormula")}
        size="small"
        autofocus={false}
        onCloseRequest={close}
        closeOnClickOutside={false}
      >
        <form
          className="formula-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label>
            {t("labels.formulaSource")}
            <textarea
              className="TextInput"
              dir="ltr"
              rows={4}
              autoFocus
              spellCheck={false}
              placeholder={String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          {layout ? (
            <div
              className="formula-dialog__preview"
              role="img"
              aria-label={t("labels.formulaPreview")}
              ref={previewRef}
            />
          ) : latex ? (
            <div className="formula-dialog__error" role="status">
              {t("labels.invalidFormula")}
            </div>
          ) : null}
          <div className="formula-dialog__actions">
            <DialogActionButton label={t("buttons.cancel")} onClick={close} />
            <DialogActionButton
              type="submit"
              actionType="primary"
              label={t("buttons.confirm")}
              disabled={!layout}
            />
          </div>
        </form>
      </Dialog>
    </UIAppStateContext.Provider>
  );
};
