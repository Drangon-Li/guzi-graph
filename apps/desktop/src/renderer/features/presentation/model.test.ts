import { rectangleFixture } from "@excalidraw/excalidraw/tests/fixtures/elementFixture";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles, SocketId } from "@excalidraw/excalidraw/types";

import {
  copyPresentationScene,
  createPresentation,
  getSlideBounds,
  parsePresentation,
  serializePresentation,
} from "./model";

const file = (id: string): BinaryFiles[string] => ({
  id: id as BinaryFiles[string]["id"],
  mimeType: "image/png",
  dataURL: `data:image/png;base64,${id}` as BinaryFiles[string]["dataURL"],
  created: 1,
});

const image = (id: string): ExcalidrawElement =>
  ({
    ...rectangleFixture,
    id,
    type: "image",
    fileId: id,
    status: "saved",
    scale: [1, 1],
    crop: null,
  } as ExcalidrawElement);

describe("presentation model", () => {
  it("copies live scenes through the persistent state boundary", () => {
    const appState = {
      ...getDefaultAppState(),
      viewBackgroundColor: "#ddeeff",
      selectedElementIds: { rectangle: true as const },
      hoveredElementIds: { rectangle: true as const },
    };
    const source = {
      elements: [{ ...rectangleFixture }],
      appState,
      files: {},
    };
    const peerId = "peer" as SocketId;
    appState.collaborators.set(peerId, { username: "Peer" });
    const copy = copyPresentationScene(source);
    expect(copy.appState).not.toHaveProperty("collaborators");
    expect(copy.appState).not.toHaveProperty("selectedElementIds");
    expect(copy.appState).not.toHaveProperty("hoveredElementIds");
    expect(copy.appState?.viewBackgroundColor).toBe("#ddeeff");
    expect(restoreAppState(copy.appState, null).collaborators).toBeInstanceOf(
      Map,
    );
    expect(copy.elements).toEqual(source.elements);
    expect(copy.elements?.[0]).not.toBe(source.elements[0]);
    expect(source.appState.collaborators).toBeInstanceOf(Map);
    expect(source.appState.collaborators.get(peerId)?.username).toBe("Peer");
    expect(source.appState.selectedElementIds).toEqual({ rectangle: true });
  });

  it("creates a blank 1280 × 720 presentation", async () => {
    const deck = createPresentation("first", "第一页");
    expect(deck).toMatchObject({
      type: "guzi-presentation",
      version: 1,
      width: 1280,
      height: 720,
      slides: [{ id: "first", title: "第一页", scene: {} }],
    });
    const restored = await parsePresentation(
      serializePresentation(deck),
      window,
    );
    expect(restored?.slides[0].scene.elements).toEqual([]);
  });

  it("round trips all pages, nested images and fonts while cleaning runtime state", async () => {
    const pin = {
      ...rectangleFixture,
      id: "pin",
      type: "stickynote",
      customData: { subcanvas: { sceneId: "child" } },
    } as ExcalidrawElement;
    const deck = createPresentation("first", "第一页", {
      elements: [image("first-image"), pin],
      appState: {
        viewBackgroundColor: "#ddeeff",
        selectedElementIds: { pin: true },
        fontRegistry: { 123456: "Example Font" },
        subscenes: {
          child: {
            version: 1,
            title: "子画布",
            elements: [image("nested-image")],
            appState: {},
          },
        },
      },
      files: {
        "first-image": file("first-image"),
        "nested-image": file("nested-image"),
        unused: file("unused"),
      },
    });
    deck.slides.push({
      id: "second",
      title: "第二页",
      scene: {
        elements: [image("second-image")],
        files: { "second-image": file("second-image") },
      },
    });
    deck.slides.push({ id: "third", title: "空白页", scene: {} });
    const content = serializePresentation(deck);
    const saved = JSON.parse(content);
    expect(saved.slides).toHaveLength(3);
    expect(saved.slides[0].scene.appState.selectedElementIds).toBeUndefined();
    expect(Object.keys(saved.slides[0].scene.files)).toEqual([
      "first-image",
      "nested-image",
    ]);
    const restored = await parsePresentation(content, window);
    expect(restored?.slides.map((slide) => slide.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(restored?.slides[0].scene.appState).toMatchObject({
      viewBackgroundColor: "#ddeeff",
      fontRegistry: { 123456: "Example Font" },
      subscenes: {
        child: { title: "子画布", elements: [{ fileId: "nested-image" }] },
      },
    });
    expect(restored?.slides[0].scene.files?.["nested-image"]).toEqual(
      file("nested-image"),
    );
    expect(restored?.slides[1].scene.files?.["second-image"]).toEqual(
      file("second-image"),
    );
  });

  it.each(["{}", '{"type":"excalidraw"}', "not json", "null"])(
    "leaves non-presentation data to the scene loader: %s",
    async (content) => {
      expect(await parsePresentation(content, window)).toBeNull();
    },
  );

  it("round trips an explicit scene viewport without moving its contents", async () => {
    const deck = createPresentation("first", "Viewport", {
      elements: [{ ...rectangleFixture, x: -800, y: -400 }],
    });
    const bounds = { x: -900, y: -500, width: 1600, height: 900 };
    deck.slides[0].bounds = bounds;
    const restored = await parsePresentation(
      serializePresentation(deck),
      window,
    );
    expect(restored?.slides[0].bounds).toEqual(bounds);
    expect(restored?.slides[0].scene.elements?.[0]).toMatchObject({
      x: -800,
      y: -400,
    });
    expect(getSlideBounds(deck.slides[0], 1280, 720)).toEqual(bounds);
    expect(
      getSlideBounds(createPresentation("empty", "Empty").slides[0], 1280, 720),
    ).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(
      getSlideBounds(
        {
          ...deck.slides[0],
          bounds: { x: 0, y: 0, width: 1600 + 1e-10, height: 900 },
        },
        1280,
        720,
      ).width,
    ).toBeGreaterThan(1600);
  });

  it.each([
    { x: "bad", y: 0, width: 1600, height: 900 },
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 0, y: 0, width: 100, height: 100 },
    null,
  ])("rejects invalid explicit page bounds: %j", async (bounds) => {
    const saved = JSON.parse(
      serializePresentation(createPresentation("first", "A")),
    );
    saved.slides[0].bounds = bounds;
    await expect(
      parsePresentation(JSON.stringify(saved), window),
    ).rejects.toThrow();
  });

  it.each([
    { version: 2 },
    { width: 0 },
    { height: -1 },
    { width: 100 },
    { slides: [] },
    { slides: [null] },
    {
      slides: [
        { id: "same", title: "A", scene: {} },
        { id: "same", title: "B", scene: {} },
      ],
    },
    { slides: [{ id: "", title: "A", scene: {} }] },
  ])("rejects damaged presentation headers: %j", async (patch) => {
    await expect(
      parsePresentation(
        JSON.stringify({ ...createPresentation("first", "A"), ...patch }),
        window,
      ),
    ).rejects.toThrow();
  });

  it.each([
    null,
    { type: "excalidrawlib", elements: [] },
    { elements: "bad" },
    { elements: [null] },
    { elements: [{ ...rectangleFixture, x: "bad" }] },
    { elements: [rectangleFixture, rectangleFixture] },
    { elements: [{ ...rectangleFixture, type: "unsupported" }] },
    { elements: [], appState: { subscenes: { child: { version: 2 } } } },
    {
      elements: [],
      appState: {
        subscenes: {
          child: {
            version: 1,
            title: "Broken child",
            elements: [{ ...rectangleFixture, type: "unsupported" }],
            appState: {},
          },
        },
      },
    },
    { elements: [], files: { image: {} } },
  ])("rejects damaged scenes instead of dropping a page: %j", async (scene) => {
    const saved = JSON.parse(
      serializePresentation(createPresentation("first", "A")),
    );
    saved.slides.push({ id: "bad", title: "Bad", scene });
    await expect(
      parsePresentation(JSON.stringify(saved), window),
    ).rejects.toThrow();
  });
});
