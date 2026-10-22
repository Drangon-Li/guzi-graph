import { EXPORT_DATA_TYPES, MIME_TYPES } from "@excalidraw/common";

import {
  copyToClipboard,
  createPasteEvent,
  parseClipboard,
  parseDataTransferEvent,
  readSystemClipboard,
  serializeAsClipboardJSON,
} from "./clipboard";
import { API } from "./tests/helpers/api";

import type { SubcanvasScenes } from "./features/subcanvas/model";
import type { BinaryFiles, DataURL } from "./types";

const customClipboardType = `web ${MIME_TYPES.excalidrawClipboard}`;

const readBlobText = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsText(blob);
  });

describe("copyToClipboard()", () => {
  it("writes PNG and private element data in one item without public JSON", async () => {
    const rectangle = API.createElement({ type: "rectangle" });
    let resolveImage!: (blob: Blob) => void;
    const image = vi.fn(
      () => new Promise<Blob>((resolve) => (resolveImage = resolve)),
    );
    const write = vi.fn().mockResolvedValue(undefined);
    const clipboardItem = vi.fn((data) => ({ data }));
    const supports = vi.fn().mockReturnValue(true);
    const ownerWindow = {
      ClipboardItem: Object.assign(clipboardItem, { supports }),
      Blob: window.Blob,
      navigator: { clipboard: { write } },
    } as unknown as Window & typeof globalThis;
    const event = createPasteEvent({ types: {} });

    const copying = copyToClipboard([rectangle], null, event, undefined, {
      ownerWindow,
      image,
    });

    expect(supports).toHaveBeenCalledWith(customClipboardType);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toHaveLength(1);
    const data = clipboardItem.mock.calls[0][0];
    expect(Object.keys(data)).toEqual([MIME_TYPES.png, customClipboardType]);
    expect(data[MIME_TYPES.png]).toBeInstanceOf(Promise);
    expect(event.clipboardData?.getData(MIME_TYPES.text)).toBe("");
    expect(JSON.parse(await readBlobText(data[customClipboardType]))).toEqual(
      JSON.parse(
        serializeAsClipboardJSON({ elements: [rectangle], files: null }),
      ),
    );
    resolveImage(new Blob(["png"], { type: MIME_TYPES.png }));
    await copying;
  });

  it.each([false, undefined])(
    "keeps element copying when custom format support is %s",
    async (supported) => {
      const rectangle = API.createElement({ type: "rectangle" });
      const event = createPasteEvent({ types: {} });
      const image = vi.fn();
      const write = vi.fn();
      const ownerWindow = {
        ClipboardItem: {
          supports: supported === undefined ? undefined : () => supported,
        },
        navigator: { clipboard: { write } },
      } as unknown as Window & typeof globalThis;

      await copyToClipboard([rectangle], null, event, undefined, {
        ownerWindow,
        image,
      });

      expect(image).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(
        JSON.parse(event.clipboardData!.getData(MIME_TYPES.excalidrawClipboard))
          .elements,
      ).toEqual([rectangle]);
      expect(event.clipboardData?.getData(MIME_TYPES.text)).toBe(
        event.clipboardData?.getData(MIME_TYPES.excalidrawClipboard),
      );
    },
  );
});

describe("readSystemClipboard()", () => {
  it("reads the private format alongside PNG using the owning window", async () => {
    const json = serializeAsClipboardJSON({
      elements: [API.createElement({ type: "rectangle" })],
      files: null,
    });
    const png = new Blob(["png"], { type: MIME_TYPES.png });
    const getType = vi.fn(async (type: string) =>
      type === customClipboardType ? { text: async () => json } : png,
    );
    const read = vi
      .fn()
      .mockResolvedValue([
        { types: [MIME_TYPES.png, customClipboardType], getType },
      ]);
    const ownerWindow = {
      navigator: { clipboard: { read } },
    } as unknown as Window & typeof globalThis;

    const types = await readSystemClipboard(ownerWindow);

    expect(read).toHaveBeenCalledTimes(1);
    expect(types[MIME_TYPES.excalidrawClipboard]).toBe(json);
    expect(types[MIME_TYPES.png]).toBeInstanceOf(File);
    expect(getType).toHaveBeenCalledWith(customClipboardType);
    const parsed = await parseClipboard(
      await parseDataTransferEvent(createPasteEvent({ types }, window)),
    );
    expect(parsed.elements).toEqual(JSON.parse(json).elements);
  });
});

describe("parseClipboard()", () => {
  it.each([false, true])(
    "restores custom elements, files and subcanvases before PNG (plain paste: %s)",
    async (isPlainPaste) => {
      const note = {
        ...API.createElement({ type: "stickynote" }),
        customData: { subcanvas: { sceneId: "child" } },
      };
      const image = API.createElement({ type: "image", fileId: "image-file" });
      const files: BinaryFiles = {
        "image-file": {
          id: image.fileId!,
          mimeType: MIME_TYPES.png,
          dataURL: "data:image/png;base64,cG5n" as DataURL,
          created: 1,
        },
      };
      const subscenes: SubcanvasScenes = {
        child: { version: 1, title: "Child", elements: [image], appState: {} },
      };
      const json = serializeAsClipboardJSON({
        elements: [note],
        files,
        subscenes,
      });
      const dataList = await parseDataTransferEvent(
        createPasteEvent({
          types: {
            [MIME_TYPES.excalidrawClipboard]: json,
            [MIME_TYPES.html]: '<img src="https://example.com/image.png" />',
          },
          files: [new File(["png"], "preview.png", { type: MIME_TYPES.png })],
        }),
      );

      const parsed = await parseClipboard(dataList, isPlainPaste);

      expect(parsed.elements).toEqual([note]);
      expect(parsed.files).toEqual(files);
      expect(parsed.subscenes).toEqual(subscenes);
      expect(parsed.text).toBe(
        isPlainPaste ? JSON.stringify([note], null, 2) : undefined,
      );
      expect(parsed.mixedContent).toBeUndefined();
      expect(dataList.getFiles()).toHaveLength(1);
    },
  );

  it.each([
    "not JSON",
    JSON.stringify({ elements: [] }),
    JSON.stringify({
      type: EXPORT_DATA_TYPES.excalidrawClipboard,
      elements: {},
    }),
  ])("ignores invalid private element data: %s", async (customData) => {
    const dataList = await parseDataTransferEvent(
      createPasteEvent({
        types: {
          [MIME_TYPES.excalidrawClipboard]: customData,
          [MIME_TYPES.text]: "fallback text",
        },
        files: [new File(["png"], "preview.png", { type: MIME_TYPES.png })],
      }),
    );

    expect(await parseClipboard(dataList)).toEqual({
      text: "fallback text",
      html: undefined,
    });
    expect(dataList.getFiles()).toHaveLength(1);
  });

  it("should parse JSON as plaintext if not excalidraw-api/clipboard data", async () => {
    let text;
    let clipboardData;
    // -------------------------------------------------------------------------

    text = "123";
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({ types: { "text/plain": text } }),
      ),
    );
    expect(clipboardData.text).toBe(text);

    // -------------------------------------------------------------------------

    text = "[123]";
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({ types: { "text/plain": text } }),
      ),
    );
    expect(clipboardData.text).toBe(text);

    // -------------------------------------------------------------------------

    text = JSON.stringify({ val: 42 });
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({ types: { "text/plain": text } }),
      ),
    );
    expect(clipboardData.text).toBe(text);
  });

  it("should parse valid excalidraw JSON if inside text/plain", async () => {
    const rect = API.createElement({ type: "rectangle" });

    const json = serializeAsClipboardJSON({ elements: [rect], files: null });
    const clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({
          types: {
            "text/plain": json,
          },
        }),
      ),
    );
    expect(clipboardData.elements).toEqual([rect]);
  });

  it("should parse valid excalidraw JSON if inside text/html", async () => {
    const rect = API.createElement({ type: "rectangle" });

    let json;
    let clipboardData;
    // -------------------------------------------------------------------------
    json = serializeAsClipboardJSON({ elements: [rect], files: null });
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({
          types: {
            "text/html": json,
          },
        }),
      ),
    );
    expect(clipboardData.elements).toEqual([rect]);
    // -------------------------------------------------------------------------
    json = serializeAsClipboardJSON({ elements: [rect], files: null });
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({
          types: {
            "text/html": `<div> ${json}</div>`,
          },
        }),
      ),
    );
    expect(clipboardData.elements).toEqual([rect]);
    // -------------------------------------------------------------------------
  });

  it("should parse <image> `src` urls out of text/html", async () => {
    let clipboardData;
    // -------------------------------------------------------------------------
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({
          types: {
            "text/html": `<img src="https://example.com/image.png" />`,
          },
        }),
      ),
    );
    expect(clipboardData.mixedContent).toEqual([
      {
        type: "imageUrl",
        value: "https://example.com/image.png",
      },
    ]);
    // -------------------------------------------------------------------------
    clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({
          types: {
            "text/html": `<div><img src="https://example.com/image.png" /></div><a><img src="https://example.com/image2.png" /></a>`,
          },
        }),
      ),
    );
    expect(clipboardData.mixedContent).toEqual([
      {
        type: "imageUrl",
        value: "https://example.com/image.png",
      },
      {
        type: "imageUrl",
        value: "https://example.com/image2.png",
      },
    ]);
  });

  it("should parse text content alongside <image> `src` urls out of text/html", async () => {
    const clipboardData = await parseClipboard(
      await parseDataTransferEvent(
        createPasteEvent({
          types: {
            "text/html": `<a href="https://example.com">hello </a><div><img src="https://example.com/image.png" /></div><b>my friend!</b>`,
          },
        }),
      ),
    );
    expect(clipboardData.mixedContent).toEqual([
      {
        type: "text",
        // trimmed
        value: "hello",
      },
      {
        type: "imageUrl",
        value: "https://example.com/image.png",
      },
      {
        type: "text",
        value: "my friend!",
      },
    ]);
  });
});
