import english from "./en.json";

import type { DesktopSettings } from "../../../shared/desktop-api";

export type DesktopLanguage = DesktopSettings["language"];

export const translate = (
  language: DesktopLanguage,
  message: string,
  params: Record<string, string | number> = {},
): string => {
  const text =
    language === "en"
      ? (english as Record<string, string>)[message] || message
      : message;
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    params[key] === undefined ? placeholder : String(params[key]),
  );
};
