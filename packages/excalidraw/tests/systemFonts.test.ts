import { getFontFamilyString, getSystemFontId } from "@excalidraw/common";

import { Fonts } from "../fonts";
import { restoreAppState } from "../data/restore";
import {
  clearAppStateForLocalStorage,
  cleanAppStateForExport,
} from "../appState";

it("restores named system fonts before restoring font shortcuts and exports their names", () => {
  const id = getSystemFontId("Songti SC");
  const registry = { [id]: "Songti SC" };
  const state = restoreAppState(
    { fontRegistry: registry, fontTopPicks: [id] },
    null,
  );
  expect(state.fontRegistry).toEqual(registry);
  expect(state.fontTopPicks).toEqual([id]);
  expect(getFontFamilyString({ fontFamily: id })).toContain('"Songti SC"');
  expect(Fonts.registered.get(id)?.metadata.local).toBe(true);
  expect(cleanAppStateForExport(state).fontRegistry).toEqual(registry);
  expect(clearAppStateForLocalStorage(state).fontRegistry).toEqual(registry);
});

it("rejects font id collisions explicitly and keeps the existing family", () => {
  const id = getSystemFontId("Named collision fixture");
  Fonts.registerCustomFonts({ [id]: "Named collision fixture" });
  expect(() => Fonts.registerCustomFonts({ [id]: "Another family" })).toThrow(
    "already assigned",
  );
  expect(getFontFamilyString({ fontFamily: id })).toContain(
    "Named collision fixture",
  );
});

it("drops malformed registry records without replacing built-in font families", () => {
  const state = restoreAppState(
    {
      fontRegistry: {
        "5": "Override builtin",
        "123456": "",
        "123457": "bad\nfamily",
      },
    },
    null,
  );
  expect(state.fontRegistry).toEqual({});
  expect(getFontFamilyString({ fontFamily: 5 })).toContain("Excalifont");
});
