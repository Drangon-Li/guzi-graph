import {
  DEFAULT_ELEMENT_BACKGROUND_PICKS,
  DEFAULT_ELEMENT_STROKE_PICKS,
  FONT_FAMILY,
  FONT_SIZES,
  registerCustomFontRegistry,
} from "@excalidraw/common";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { Merge } from "@excalidraw/common/utility-types";

import type { EditorPreferences } from "./shared";

type ResolvedEditorPreferences = Merge<
  EditorPreferences,
  Required<
    Pick<
      EditorPreferences,
      | "defaultStrokeColor"
      | "defaultElementBackground"
      | "elementStrokeTopPicks"
      | "elementBackgroundTopPicks"
      | "fontSizePresets"
    >
  >
>;

export const DEFAULT_EDITOR_PREFERENCES: ResolvedEditorPreferences = {
  defaultFontFamily: FONT_FAMILY.Excalifont,
  defaultBackground: "#ffffff",
  defaultStrokeColor: "#1e1e1e",
  defaultElementBackground: "transparent",
  elementStrokeTopPicks: [...DEFAULT_ELEMENT_STROKE_PICKS],
  elementBackgroundTopPicks: [...DEFAULT_ELEMENT_BACKGROUND_PICKS],
  fontSizePresets: { ...FONT_SIZES },
  fontTopPicks: [
    FONT_FAMILY.Excalifont,
    FONT_FAMILY.Nunito,
    FONT_FAMILY["Comic Shanns"],
  ],
  backgroundTopPicks: ["#ffffff", "#f8f9fa", "#f5faff", "#fffce8", "#fdf8f6"],
  systemFonts: [],
};

export const registerPreferenceFonts = (preferences?: EditorPreferences) => {
  const registry = Object.fromEntries(
    (preferences?.systemFonts ?? []).map(({ id, family }) => [
      String(id),
      family,
    ]),
  );
  registerCustomFontRegistry(registry);
  return registry;
};

export const resolveEditorPreferences = (
  preferences?: EditorPreferences,
): ResolvedEditorPreferences => ({
  ...DEFAULT_EDITOR_PREFERENCES,
  ...preferences,
});

export const getPreferenceColorTopPicks = (
  preferences: EditorPreferences,
  previous?: AppState["colorTopPicks"],
): AppState["colorTopPicks"] => ({
  stickyNoteStroke: null,
  stickyNoteBackground: null,
  bucketFill: null,
  ...previous,
  elementStroke:
    preferences.elementStrokeTopPicks ??
    DEFAULT_EDITOR_PREFERENCES.elementStrokeTopPicks,
  elementBackground:
    preferences.elementBackgroundTopPicks ??
    DEFAULT_EDITOR_PREFERENCES.elementBackgroundTopPicks,
});
