import { FONT_METADATA } from "./font-metadata";
import { FONT_FAMILY } from "./constants";

const systemFontFamilies = new Map<number, string>();

export const getSystemFontFamily = (id: number) => systemFontFamilies.get(id);
export const getRegisteredSystemFonts = (): ReadonlyMap<number, string> =>
  systemFontFamilies;

export const isValidSystemFontFamily = (family: unknown): family is string =>
  typeof family === "string" &&
  family.trim().length > 0 &&
  family.length <= 200 &&
  !Array.from(family).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

export const getSystemFontId = (family: string) => {
  let hash = 2166136261;
  for (const char of family) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return 100000 + (hash >>> 0);
};

export const registerSystemFontFamily = (id: number, family: string) => {
  if (
    !Number.isSafeInteger(id) ||
    id < 100000 ||
    !isValidSystemFontFamily(family)
  ) {
    throw new Error("Invalid system font registration");
  }
  const registered = systemFontFamilies.get(id);
  if (registered && registered !== family) {
    throw new Error(`Font id ${id} is already assigned to ${registered}`);
  }
  systemFontFamilies.set(id, family);
  FONT_METADATA[id] = {
    metrics: { ...FONT_METADATA[FONT_FAMILY.Helvetica].metrics },
    local: true,
  };
};

export const registerCustomFontRegistry = (
  registry: Record<string, string>,
) => {
  for (const [key, family] of Object.entries(registry)) {
    const id = Number(key);
    if (
      Number.isSafeInteger(id) &&
      id >= 100000 &&
      isValidSystemFontFamily(family)
    ) {
      registerSystemFontFamily(id, family);
    }
  }
};
