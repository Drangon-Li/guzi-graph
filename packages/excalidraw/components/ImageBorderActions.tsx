import { isTransparent } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  isImageElement,
  newElementWith,
} from "@excalidraw/element";

import type { ExcalidrawImageElement } from "@excalidraw/element/types";

import { getLanguage } from "../i18n";

import { ColorPicker } from "./ColorPicker/ColorPicker";
import { createIcon } from "./icons";

import "./ImageBorderActions.scss";

import type { ActionManager } from "../actions/manager";
import type { AppClassProperties, UIAppState } from "../types";

const labels = {
  "zh-CN": {
    border: "图片边框",
    none: "无边框",
    solid: "实线",
    dotted: "短虚线",
    dashed: "长虚线",
    borderColor: "边框颜色",
  },
  en: {
    border: "Image border",
    none: "No border",
    solid: "Solid border",
    dotted: "Short dashed border",
    dashed: "Long dashed border",
    borderColor: "Border color",
  },
};

const borderIcons = [
  createIcon(
    <>
      <rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="2 3" />
      <path d="M3 21L21 3" />
    </>,
    {
      width: 24,
      height: 24,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.75,
      strokeLinecap: "round",
    },
  ),
  ...[undefined, "2 3", "7 3"].map((dash) =>
    createIcon(<path d="M3 12h18" strokeDasharray={dash} />, {
      width: 24,
      height: 24,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.75,
    }),
  ),
];

export const ImageBorderActions = ({
  app,
  appState,
  renderAction,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  renderAction: ActionManager["renderAction"];
}) => {
  const label = labels[getLanguage().code === "en" ? "en" : "zh-CN"];
  const images = app.scene.getSelectedElements(appState).filter(isImageElement);
  if (!images.length) {
    return null;
  }
  const image = images[0];
  const styles = ["none", "solid", "dotted", "dashed"] as const;
  const selected = images.map((element) =>
    element.imageBorder ? element.strokeStyle : "none",
  );
  type Updates = Partial<
    Pick<
      ExcalidrawImageElement,
      "imageBorder" | "strokeColor" | "strokeWidth" | "strokeStyle"
    >
  >;
  const update = (
    updates: Updates | ((element: ExcalidrawImageElement) => Updates),
  ) => {
    const ids = new Set(
      app.scene
        .getSelectedElements(app.state)
        .filter(isImageElement)
        .map((element) => element.id),
    );
    app.syncActionResult({
      elements: app.scene
        .getElementsIncludingDeleted()
        .map((element) =>
          ids.has(element.id) && isImageElement(element)
            ? newElementWith(
                element,
                typeof updates === "function" ? updates(element) : updates,
              )
            : element,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };
  return (
    <div className="image-border-actions">
      <fieldset>
        <legend>{label.border}</legend>
        <div className="buttonList image-border-styles">
          {styles.map((style, index) => (
            <button
              type="button"
              key={style}
              title={label[style]}
              aria-label={label[style]}
              aria-pressed={selected.every((value) => value === style)}
              className={
                selected.every((value) => value === style)
                  ? "active"
                  : undefined
              }
              onClick={() =>
                update((element) => ({
                  imageBorder: style !== "none",
                  ...(style !== "none" && {
                    strokeStyle: style,
                    ...(isTransparent(element.strokeColor) && {
                      strokeColor: "#1b1b1f",
                    }),
                  }),
                }))
              }
            >
              {borderIcons[index]}
            </button>
          ))}
        </div>
      </fieldset>
      <>
        <fieldset>
          <legend>{label.borderColor}</legend>
          <ColorPicker
            type="elementStroke"
            color={
              images.every(
                (element) => element.strokeColor === image.strokeColor,
              )
                ? image.strokeColor
                : null
            }
            label={label.borderColor}
            onChange={(strokeColor) => update({ strokeColor })}
            elements={app.scene.getNonDeletedElements()}
            appState={appState}
            topPicks={appState.colorTopPicks.elementStroke ?? undefined}
            customizableTopPicks="elementStroke"
            updateData={(updates) =>
              app.syncActionResult({
                appState: { ...app.state, ...updates },
                captureUpdate: CaptureUpdateAction.NEVER,
              })
            }
          />
        </fieldset>
        {renderAction("changeStrokeWidth")}
        {renderAction("changeSloppiness")}
      </>
    </div>
  );
};
