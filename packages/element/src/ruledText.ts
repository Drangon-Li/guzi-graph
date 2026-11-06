import { getLineHeight, getVerticalOffset } from "@excalidraw/common";

import type { ExcalidrawTextElement, FontFamilyValues } from "./types";

export const getRuledTextLineSpacing = (
  element: Pick<ExcalidrawTextElement, "customData"> &
    Partial<Pick<ExcalidrawTextElement, "containerId">>,
) => {
  const data = element.customData?.guziRuledText;
  return !element.containerId &&
    data?.version === 1 &&
    typeof data.lineSpacing === "number" &&
    Number.isFinite(data.lineSpacing) &&
    data.lineSpacing > 0
    ? data.lineSpacing
    : null;
};

export const getRuledTextBaseline = (element: ExcalidrawTextElement) =>
  element.y +
  getVerticalOffset(
    element.fontFamily,
    element.fontSize,
    element.lineHeight * element.fontSize,
  );

export const getRuledTextTypography = (
  fontFamily: FontFamilyValues,
  requestedFontSize: number,
  baselineY: number,
  lineSpacing: number,
) => {
  const fontSize = Math.min(
    requestedFontSize,
    lineSpacing / getLineHeight(fontFamily),
  );
  return {
    fontFamily,
    fontSize,
    lineHeight: (lineSpacing / fontSize) as ExcalidrawTextElement["lineHeight"],
    y: baselineY - getVerticalOffset(fontFamily, fontSize, lineSpacing),
  };
};

export const getRuledTextFontUpdate = (
  element: ExcalidrawTextElement,
  fontSize: number,
  fontFamily = element.fontFamily,
) => {
  const lineSpacing = getRuledTextLineSpacing(element);
  return lineSpacing
    ? getRuledTextTypography(
        fontFamily,
        fontSize,
        getRuledTextBaseline(element),
        lineSpacing,
      )
    : null;
};

export const getRuledTextRunFontLimit = (
  {
    fontFamily,
    fontSize,
  }: Pick<ExcalidrawTextElement, "fontFamily" | "fontSize">,
  lineSpacing: number,
) => {
  const heightPerUnit = getLineHeight(fontFamily);
  const ascentPerUnit = getVerticalOffset(fontFamily, 1, heightPerUnit);
  const baseline = getVerticalOffset(fontFamily, fontSize, lineSpacing);
  return Math.min(
    baseline / ascentPerUnit,
    (lineSpacing - baseline) / (heightPerUnit - ascentPerUnit),
  );
};
