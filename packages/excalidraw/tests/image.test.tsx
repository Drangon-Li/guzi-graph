import { MIME_TYPES, randomId, reseed } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";

import * as blobModule from "../data/blob";
import * as filesystemModule from "../data/filesystem";
import { Excalidraw } from "../index";
import { createPasteEvent } from "../clipboard";

import { API } from "./helpers/api";
import {
  mockHTMLImageElement,
  mockMultipleHTMLImageElements,
} from "./helpers/mocks";
import { UI } from "./helpers/ui";
import { act, GlobalTestState, render, waitFor } from "./test-utils";
import {
  DEER_IMAGE_DIMENSIONS,
  SMILEY_IMAGE_DIMENSIONS,
} from "./fixtures/constants";
import { INITIALIZED_IMAGE_PROPS } from "./helpers/constants";

import type { ExcalidrawProps } from "../types";

const { h } = window;

export const setupImageTest = async (
  sizes: { width: number; height: number }[],
  props?: ExcalidrawProps,
) => {
  await render(
    <Excalidraw autoFocus={true} handleKeyboardGlobally={true} {...props} />,
  );

  h.state.height = 1000;

  mockMultipleHTMLImageElements(sizes.map((size) => [size.width, size.height]));
};

describe("resizeImageFile", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the original file when it already fits the max dimensions", async () => {
    mockMultipleHTMLImageElements([[100, 100]]);

    const imageFile = new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: MIME_TYPES.png,
    });

    await expect(
      blobModule.resizeImageFile(imageFile, { maxWidthOrHeight: 200 }),
    ).resolves.toBe(imageFile);
  });
});

describe("image insertion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    reseed(7);

    const generateIdSpy = vi.spyOn(blobModule, "generateIdFromFile");
    const resizeFileSpy = vi.spyOn(blobModule, "resizeImageFile");

    generateIdSpy.mockImplementation(() =>
      Promise.resolve(randomId() as FileId),
    );
    resizeFileSpy.mockImplementation((file: File) => Promise.resolve(file));

    Object.assign(document, {
      elementFromPoint: () => GlobalTestState.canvas,
    });
  });

  const setup = () =>
    setupImageTest([DEER_IMAGE_DIMENSIONS, SMILEY_IMAGE_DIMENSIONS]);

  const assert = async () => {
    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({
          ...INITIALIZED_IMAGE_PROPS,
          ...DEER_IMAGE_DIMENSIONS,
        }),
        expect.objectContaining({
          ...INITIALIZED_IMAGE_PROPS,
          ...SMILEY_IMAGE_DIMENSIONS,
        }),
      ]);
    });
    // Not placed on top of each other
    const dimensionsSet = new Set(h.elements.map((el) => `${el.x}-${el.y}`));
    expect(dimensionsSet.size).toEqual(h.elements.length);
  };

  it("should eventually initialize all dropped images", async () => {
    await setup();

    const files = await Promise.all([
      API.loadFile("./fixtures/deer.png"),
      API.loadFile("./fixtures/smiley.png"),
    ]);
    await API.drop(files.map((file) => ({ kind: "file", file })));

    await assert();
  });

  it("should eventually initialize all pasted images", async () => {
    await setup();

    document.dispatchEvent(
      createPasteEvent({
        files: await Promise.all([
          API.loadFile("./fixtures/deer.png"),
          API.loadFile("./fixtures/smiley.png"),
        ]),
      }),
    );

    await assert();
  });

  it("should eventually initialize all images added through image tool", async () => {
    await setup();

    const fileOpenSpy = vi.spyOn(filesystemModule, "fileOpen");
    fileOpenSpy.mockImplementation(
      async () =>
        await Promise.all([
          API.loadFile("./fixtures/deer.png"),
          API.loadFile("./fixtures/smiley.png"),
        ]),
    );
    UI.clickExtraTool("image");

    await assert();
  });

  it("passes host-configured max image dimensions to the resize helper", async () => {
    await setupImageTest([DEER_IMAGE_DIMENSIONS], {
      imageOptions: { maxWidthOrHeight: 2048 },
    });
    vi.unstubAllGlobals();
    mockHTMLImageElement(
      DEER_IMAGE_DIMENSIONS.width,
      DEER_IMAGE_DIMENSIONS.height,
    );

    await API.drop([
      { kind: "file", file: await API.loadFile("./fixtures/deer.png") },
    ]);

    await waitFor(() => {
      expect(blobModule.resizeImageFile).toHaveBeenCalledWith(
        expect.any(File),
        { maxWidthOrHeight: 2048 },
      );
      expect(h.app.api.getSceneElements()).toHaveLength(1);
      expect(h.app.api.getSceneElements()[0]).toMatchObject({
        type: "image",
        fileId: expect.any(String),
      });
    });
  });

  it("enforces host-configured max image file size", async () => {
    await setupImageTest([DEER_IMAGE_DIMENSIONS], {
      imageOptions: { maxFileSizeBytes: 1024 * 1024 },
    });

    await API.drop([
      {
        kind: "file",
        file: new File([new Uint8Array(2 * 1024 * 1024)], "image.png", {
          type: MIME_TYPES.png,
        }),
      },
    ]);

    await waitFor(() => {
      expect(h.state.errorMessage).toBe(
        "File is too big. Maximum allowed size is 1MB.",
      );
    });
  });

  it("limits concurrent image initialization across batches and retains every file", async () => {
    await setupImageTest(
      Array.from({ length: 12 }, () => DEER_IMAGE_DIMENSIONS),
    );
    vi.unstubAllGlobals();
    mockHTMLImageElement(
      DEER_IMAGE_DIMENSIONS.width,
      DEER_IMAGE_DIMENSIONS.height,
    );
    let started = 0;
    const releases: (() => void)[] = [];
    vi.mocked(blobModule.generateIdFromFile).mockImplementation(() => {
      const id = `limited-${started++}` as FileId;
      return new Promise((resolve) => releases.push(() => resolve(id)));
    });
    const file = await API.loadFile("./fixtures/deer.png");
    let importing!: Promise<void>;
    act(() => {
      importing = Promise.all([
        h.app.insertImages(Array(6).fill(file), 0, 0),
        h.app.insertImages(Array(6).fill(file), 100, 100),
      ]).then(() => {});
    });
    await waitFor(() => expect(started).toBe(4));
    expect(h.app.api.hasPendingImages()).toBe(true);
    const waitForStarted = (total: number) =>
      waitFor(() => expect(started).toBe(total));
    for (const total of [8, 12]) {
      await act(async () => releases.splice(0).forEach((release) => release()));
      await waitForStarted(total);
    }
    await act(async () => {
      releases.splice(0).forEach((release) => release());
      await importing;
      await h.app.api.waitForPendingImages();
    });
    expect(h.app.api.hasPendingImages()).toBe(false);
    expect(h.app.api.getSceneElements()).toHaveLength(12);
    expect(Object.keys(h.app.api.getFiles())).toHaveLength(12);
    expect(
      h.app.api
        .getSceneElements()
        .every(
          (element) =>
            element.type === "image" && !!element.fileId && element.width > 0,
        ),
    ).toBe(true);
  });

  it("settles pending image imports when an image fails", async () => {
    await setup();
    vi.mocked(blobModule.generateIdFromFile).mockRejectedValue(
      new Error("bad image"),
    );
    const file = await API.loadFile("./fixtures/deer.png");
    await act(async () => {
      await h.app.insertImages([file], 0, 0);
      await h.app.api.waitForPendingImages();
    });
    expect(h.app.api.hasPendingImages()).toBe(false);
    expect(h.app.api.getSceneElements()).toHaveLength(0);
    expect(h.state.errorMessage).toBe("bad image");
  });
});
