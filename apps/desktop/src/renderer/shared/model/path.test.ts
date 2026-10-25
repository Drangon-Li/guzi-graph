import { fileTitle } from "./document";
import { fileName, isPathInDirectory, parentDirectory } from "./path";

it.each([
  ["/drawings/sketch.excalidraw", "/drawings"],
  ["/sketch.excalidraw", "/"],
  ["C:\\drawings\\sketch.excalidraw", "C:\\drawings"],
  ["C:\\sketch.excalidraw", "C:\\"],
  ["C:/sketch.excalidraw", "C:/"],
  ["C:\\", "C:\\"],
  ["\\\\server\\share\\sketch.excalidraw", "\\\\server\\share\\"],
  ["\\\\server\\share\\folder\\sketch.excalidraw", "\\\\server\\share\\folder"],
  ["\\\\server\\share", "\\\\server\\share"],
])("finds the parent of %s without dropping its root", (path, parent) => {
  expect(parentDirectory(path, path.startsWith("/") ? "darwin" : "win32")).toBe(
    parent,
  );
});

it.each([
  ["C:\\drawings\\draft\\sketch.excalidraw", "C:\\drawings\\", true],
  ["c:/Drawings/sketch.excalidraw", "C:\\drawings", true],
  ["C:\\sketch.excalidraw", "C:\\", true],
  ["C:\\drawings-old\\sketch.excalidraw", "C:\\drawings", false],
  ["D:\\drawings\\sketch.excalidraw", "C:\\drawings", false],
  ["\\\\SERVER\\Share\\sketch.excalidraw", "\\\\server\\share", true],
  ["\\\\server\\share-old\\sketch.excalidraw", "\\\\server\\share", false],
  ["/drawings/sketch.excalidraw", "/", true],
  ["/drawings-old/sketch.excalidraw", "/drawings", false],
  ["/Drawings/sketch.excalidraw", "/drawings", false],
  ["/drawings/sketch.excalidraw", null, false],
])("checks directory boundaries for %s in %s", (path, directory, expected) => {
  expect(
    isPathInDirectory(
      path,
      directory,
      path.startsWith("/") ? "darwin" : "win32",
    ),
  ).toBe(expected);
});

it("shares Windows basenames between file operations and document titles", () => {
  const path = "C:\\drawings\\草图.guzi-presentation";
  expect(fileName(path)).toBe("草图.guzi-presentation");
  expect(fileTitle(path)).toBe("草图");
});

it("preserves literal POSIX backslashes in file names and directories", () => {
  const path = "/drawings\\draft/草\\图.excalidraw";
  expect(fileName(path)).toBe("草\\图.excalidraw");
  expect(fileTitle("草\\图.excalidraw")).toBe("草\\图");
  expect(parentDirectory(path, "darwin")).toBe("/drawings\\draft");
  expect(isPathInDirectory(path, "/drawings", "darwin")).toBe(false);
  expect(isPathInDirectory(path, "/drawings\\draft", "darwin")).toBe(true);
});
