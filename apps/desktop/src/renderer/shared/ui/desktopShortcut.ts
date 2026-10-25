export const desktopShortcut = (platform: string, key: string, shift = false) =>
  platform === "darwin"
    ? `⌘${shift ? "⇧" : ""}${key}`
    : `Ctrl+${shift ? "Shift+" : ""}${key}`;
