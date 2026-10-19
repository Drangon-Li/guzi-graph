import {
  fileOpen as browserFileOpen,
  fileSave as browserFileSave,
} from "browser-fs-access";

import { fileOpen, fileSave, setFileSystemAdapter } from "./filesystem";

vi.mock("browser-fs-access", () => ({
  fileOpen: vi.fn(),
  fileSave: vi.fn().mockResolvedValue(null),
  supported: true,
}));

afterEach(() => {
  setFileSystemAdapter(null);
  vi.clearAllMocks();
});

it.each(["png", "svg"] as const)(
  "sends resolved %s blobs and file metadata to the native adapter",
  async (extension) => {
    const nativeSave = vi.fn().mockResolvedValue(null);
    setFileSystemAdapter({ fileSave: nativeSave });
    const blob = new Blob(["export"]);
    const options = { name: "drawing", extension, description: "Export" };
    expect(await fileSave(Promise.resolve(blob), options)).toBeNull();
    expect(nativeSave).toHaveBeenCalledWith(blob, options);
    expect(browserFileSave).not.toHaveBeenCalled();
  },
);

it("preserves native cancellation as AbortError", async () => {
  const error = new DOMException("Cancelled", "AbortError");
  setFileSystemAdapter({ fileSave: vi.fn().mockRejectedValue(error) });
  await expect(
    fileSave(new Blob(), {
      name: "drawing",
      extension: "png",
      description: "",
    }),
  ).rejects.toBe(error);
});

it("restores default browser saving when the adapter is removed", async () => {
  setFileSystemAdapter({ fileSave: vi.fn().mockResolvedValue(null) });
  setFileSystemAdapter(null);
  const blob = new Blob();
  await fileSave(blob, { name: "drawing", extension: "png", description: "" });
  expect(browserFileSave).toHaveBeenCalledWith(
    blob,
    expect.objectContaining({ fileName: "drawing.png" }),
    undefined,
    false,
  );
});

it("retains the browser picker and normalization for local library imports", async () => {
  setFileSystemAdapter({ fileSave: vi.fn().mockResolvedValue(null) });
  const file = new File(["{}"], "local.excalidrawlib", {
    type: "application/vnd.excalidrawlib+json",
  });
  vi.mocked(browserFileOpen).mockResolvedValue(file);
  expect(
    await fileOpen({ description: "Library", extensions: ["excalidrawlib"] }),
  ).toMatchObject({ name: file.name, type: file.type, size: file.size });
  expect(browserFileOpen).toHaveBeenCalledTimes(1);
});
