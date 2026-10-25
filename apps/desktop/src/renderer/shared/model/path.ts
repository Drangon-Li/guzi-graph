export const fileName = (path: string) => path.split(/[\\/]/).pop() || "";

export const parentDirectory = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const root =
    normalized.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0] || "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = trimmed.search(/[\\/][^\\/]*$/);
  return separator < root.length
    ? path.slice(0, root.length) || "."
    : trimmed.slice(0, separator);
};

export const isPathInDirectory = (path: string, directory: string | null) => {
  if (!directory) {
    return false;
  }
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "");
  let parent = normalize(directory);
  let child = normalize(path);
  if (/^(?:[a-z]:|\/\/)/i.test(parent)) {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  return child.startsWith(`${parent}/`);
};
