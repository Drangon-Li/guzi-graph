import type {
  AppClassProperties,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { updateImageCache } from "../src/image";

import type { FileId } from "../src/types";

it("limits image decoding across concurrent loads sharing a cache", async () => {
  const cache: AppClassProperties["imageCache"] = new Map();
  const files: BinaryFiles = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => {
      const id = `image-${i}` as FileId;
      return [
        id,
        {
          id,
          mimeType: "image/png",
          dataURL:
            "data:image/png;base64,AA==" as BinaryFiles[string]["dataURL"],
          created: 1,
        },
      ];
    }),
  );
  const images: HTMLImageElement[] = [];
  let active = 0;
  let maximum = 0;
  const createImage = () => {
    const image = document.createElement("img");
    images.push(image);
    maximum = Math.max(maximum, ++active);
    return image;
  };
  const fileIds = Object.keys(files) as FileId[];
  const loading = Promise.all([
    updateImageCache({
      imageCache: cache,
      files,
      fileIds: fileIds.slice(0, 6),
      createImage,
    }),
    updateImageCache({
      imageCache: cache,
      files,
      fileIds: fileIds.slice(6),
      createImage,
    }),
  ]);
  expect(images).toHaveLength(4);
  expect(cache.size).toBe(12);
  for (let round = 0; round < 3; round++) {
    const current = images.splice(0);
    for (const image of current) {
      active--;
      image.onload!(new Event("load"));
    }
    await new Promise<void>((resolve) =>
      queueMicrotask(() => queueMicrotask(resolve)),
    );
  }
  const results = await loading;
  expect(maximum).toBe(4);
  expect(cache.size).toBe(12);
  expect(results.every((result) => result.erroredFiles.size === 0)).toBe(true);
  expect(
    [...cache.values()].every(({ image }) => image instanceof HTMLImageElement),
  ).toBe(true);
});
