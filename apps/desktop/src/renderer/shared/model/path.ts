export const fileName = (path: string) =>
  path.split(/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path) ? /[\\/]/ : /\//).pop() ||
  "";

export const parentDirectory = (path: string, platform: string) => {
  const windows = platform === "win32";
  const normalized = windows ? path.replace(/\\/g, "/") : path;
  const root =
    normalized.match(
      windows ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i : /^\//,
    )?.[0] || "";
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  const separator = trimmed.search(windows ? /[\\/][^\\/]*$/ : /\/[^/]*$/);
  return separator < root.length
    ? path.slice(0, root.length) || "."
    : trimmed.slice(0, separator);
};

export const isPathInDirectory = (
  path: string,
  directory: string | null,
  platform: string,
) => {
  if (!directory) {
    return false;
  }
  const normalize = (value: string) =>
    (platform === "win32" ? value.replace(/\\/g, "/") : value).replace(
      /\/+$/,
      "",
    );
  let parent = normalize(directory);
  let child = normalize(path);
  if (platform === "win32") {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  return child.startsWith(`${parent}/`);
};
