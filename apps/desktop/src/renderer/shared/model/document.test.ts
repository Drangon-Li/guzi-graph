import "@excalidraw/element";
import { newStickyNoteElement, newImageElement } from "@excalidraw/element";
import {
  createTableData,
  createTableElements,
  syncTableData,
} from "@excalidraw/element/table";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";

import type { FileId } from "@excalidraw/element/types";

import { createSceneTracker, documentContentSignature } from "./document";

import type { SceneSnapshot } from "./document";

it("caches persistent subcanvas signatures during pointer changes and detects child image replacement", () => {
  const fontRegistryJSON = vi.fn(() => ({}));
  const note = newStickyNoteElement({
    type: "stickynote",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    customData: { subcanvas: { sceneId: "child" } },
  });
  const fileId = "nested-image" as FileId;
  const image = newImageElement({
    type: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fileId,
  });
  const scene: SceneSnapshot = {
    elements: [note],
    appState: {
      ...getDefaultAppState(),
      width: 1000,
      height: 800,
      offsetTop: 0,
      offsetLeft: 0,
      subscenes: {
        child: {
          version: 1,
          title: "Child",
          elements: [image],
          appState: { fontRegistry: { toJSON: fontRegistryJSON } as any },
        },
      },
    },
    files: {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA" as any,
        created: 1,
      },
    },
  };
  const track = createSceneTracker();
  const first = track(scene);
  fontRegistryJSON.mockClear();
  expect(
    track({
      ...scene,
      appState: { ...scene.appState, scrollX: 20, cursorButton: "down" },
    }),
  ).toBe(first);
  expect(fontRegistryJSON).not.toHaveBeenCalled();
  const replaced = track({
    ...scene,
    files: {
      [fileId]: {
        ...scene.files[fileId],
        dataURL: "data:image/png;base64,BBBB" as any,
      },
    },
  });
  expect(replaced).not.toBe(first);
  expect(JSON.parse(replaced).files[fileId].dataURL).toBe(
    "data:image/png;base64,BBBB",
  );
  const edited = track({
    ...scene,
    appState: {
      ...scene.appState,
      subscenes: {
        child: {
          ...scene.appState.subscenes.child,
          title: "Renamed",
          elements: [{ ...image, version: image.version + 1 }],
        },
      },
    },
  });
  expect(JSON.parse(edited).appState.subscenes.child.title).toBe("Renamed");
});

it("keeps table persistence snapshots stable across API reads and onChange normalization", () => {
  const table = createTableElements(createTableData(1, 1), 0, 0);
  const elements = table.elements.map((element) =>
    element.type === "text"
      ? {
          ...element,
          originalText: "Native cell edit",
          text: "Native cell edit",
          version: element.version + 1,
        }
      : element,
  );
  const state: SceneSnapshot = {
    elements,
    appState: {
      ...getDefaultAppState(),
      width: 1000,
      height: 800,
      offsetLeft: 0,
      offsetTop: 0,
    },
    files: {},
  };
  const track = createSceneTracker();
  const saved = track(state);
  for (let index = 0; index < 3; index++) {
    expect(track({ ...state, elements: syncTableData(elements) })).toBe(saved);
    expect(track(state)).toBe(saved);
  }
  const editedAgain = elements.map((element) =>
    element.type === "text"
      ? {
          ...element,
          originalText: "Second edit",
          text: "Second edit",
          version: element.version + 1,
        }
      : element,
  );
  const changed = track({ ...state, elements: editedAgain });
  expect(changed).not.toBe(saved);
  expect(changed).toContain("Second edit");
});

const comparisonScene = () => ({
  type: "excalidraw",
  version: 2,
  elements: [
    {
      id: "a",
      type: "rectangle",
      x: 10,
      text: "Text",
      strokeColor: "red",
      version: 1,
      versionNonce: 2,
      updated: 3,
      isDeleted: false,
      customData: { table: { version: 1 } },
    },
    {
      id: "b",
      type: "rectangle",
      x: 20,
      version: 4,
      versionNonce: 5,
      updated: 6,
      isDeleted: false,
    },
  ],
  appState: {
    viewBackgroundColor: "white",
    subscenes: {
      child: {
        version: 1,
        title: "Child",
        elements: [
          {
            id: "child-cell",
            type: "text",
            text: "Child text",
            version: 1,
            versionNonce: 2,
            updated: 3,
            isDeleted: false,
          },
        ],
        appState: { viewBackgroundColor: "white" },
      },
    },
  },
  files: {
    image: {
      id: "image",
      dataURL: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      created: 1,
    },
  },
  metadata: { version: 7, updated: 8, elements: [{ version: 9 }] },
});

const comparisonContent = (
  scene: ReturnType<typeof comparisonScene>,
  presentation: boolean,
) =>
  JSON.stringify(
    presentation
      ? {
          type: "guzi-presentation",
          version: 1,
          width: 1280,
          height: 720,
          slides: [{ id: "slide", title: "Slide", scene }],
        }
      : scene,
  );

it.each([false, true])(
  "compares scene content independently of element runtime metadata and tombstones (presentation=%s)",
  (presentation) => {
    const original = comparisonScene();
    const restored = comparisonScene();
    restored.elements = restored.elements.map((element) => ({
      ...element,
      version: 10,
      versionNonce: 20,
      updated: 30,
    }));
    restored.elements.push({
      ...restored.elements[0],
      id: "deleted",
      isDeleted: true,
    });
    restored.appState.subscenes.child.elements = [
      {
        ...restored.appState.subscenes.child.elements[0],
        version: 10,
        versionNonce: 20,
        updated: 30,
      },
      {
        ...restored.appState.subscenes.child.elements[0],
        id: "deleted-child",
        isDeleted: true,
      },
    ];
    const content = comparisonContent(restored, presentation);
    expect(documentContentSignature(content)).toBe(
      documentContentSignature(comparisonContent(original, presentation)),
    );
  },
);

it.each([false, true])(
  "keeps real scene, nested data and ordering changes in comparison (presentation=%s)",
  (presentation) => {
    const original = documentContentSignature(
      comparisonContent(comparisonScene(), presentation),
    );
    const changes = [
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.version = 3;
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.elements[0].text = "Changed";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.elements[0].strokeColor = "blue";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.elements[0].customData!.table.version = 2;
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.elements.reverse();
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.files.image.dataURL = "different bytes";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.appState.viewBackgroundColor = "black";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.appState.subscenes.child.elements[0].text = "Changed child";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.appState.subscenes.child.version = 2;
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.appState.subscenes.child.title = "Changed title";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.appState.subscenes.child.appState.viewBackgroundColor = "black";
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.metadata.version = 8;
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.metadata.updated = 9;
      },
      (scene: ReturnType<typeof comparisonScene>) => {
        scene.metadata.elements[0].version = 10;
      },
    ];
    changes.forEach((change) => {
      const changed = comparisonScene();
      change(changed);
      expect(
        documentContentSignature(comparisonContent(changed, presentation)),
      ).not.toBe(original);
    });
  },
);

it("keeps presentation page order, identity and document metadata in comparison", () => {
  const deck = {
    type: "guzi-presentation",
    version: 1,
    width: 1280,
    height: 720,
    slides: [
      { id: "first", title: "First", scene: comparisonScene() },
      { id: "second", title: "Second", scene: comparisonScene() },
    ],
  };
  const content = JSON.stringify(deck);
  const original = documentContentSignature(content);
  const changes = [
    (value: typeof deck) => {
      value.version = 2;
    },
    (value: typeof deck) => {
      value.width = 1920;
    },
    (value: typeof deck) => {
      value.slides.reverse();
    },
    (value: typeof deck) => {
      value.slides[0].id = "different";
    },
    (value: typeof deck) => {
      value.slides[0].title = "Renamed";
    },
  ];
  changes.forEach((change) => {
    const changed = JSON.parse(content) as typeof deck;
    change(changed);
    expect(documentContentSignature(JSON.stringify(changed))).not.toBe(
      original,
    );
  });
});

it("compares normal bindings as a set while preserving their payload and source", () => {
  const content = (
    boundElements: { id: string; type: string; detail?: string }[] | null,
  ) =>
    JSON.stringify({
      ...comparisonScene(),
      elements: [{ ...comparisonScene().elements[0], boundElements }],
    });
  const bindings = [
    { id: "label", type: "text" },
    { id: "arrow", type: "arrow", detail: "keep" },
  ];
  const original = content(bindings);
  const signature = documentContentSignature(original);
  expect(documentContentSignature(content([...bindings].reverse()))).toBe(
    signature,
  );
  expect(
    documentContentSignature(
      content(bindings.map(({ id, type, ...rest }) => ({ ...rest, type, id }))),
    ),
  ).toBe(signature);
  expect(bindings.map((binding) => binding.id)).toEqual(["label", "arrow"]);
  expect(JSON.parse(original).elements[0].boundElements).toEqual(bindings);
  expect(
    documentContentSignature(content([...bindings, bindings[1]])),
  ).not.toBe(signature);
  expect(
    documentContentSignature(
      content([bindings[0], { ...bindings[1], detail: "changed" }]),
    ),
  ).not.toBe(signature);
  expect(documentContentSignature(content(null))).toBe(
    documentContentSignature(content([])),
  );
  expect(documentContentSignature(content(null))).not.toBe(signature);
});

it("preserves conflicting text binding order and other ordered element arrays", () => {
  const content = (
    boundElements: { id: string; type: string }[],
    points = [
      [0, 0],
      [10, 20],
    ],
  ) =>
    JSON.stringify({
      ...comparisonScene(),
      elements: [{ ...comparisonScene().elements[0], boundElements, points }],
    });
  const bindings = [
    { id: "first-label", type: "text" },
    { id: "second-label", type: "text" },
  ];
  expect(documentContentSignature(content(bindings))).not.toBe(
    documentContentSignature(content([...bindings].reverse())),
  );
  const normal = [{ id: "label", type: "text" }];
  expect(documentContentSignature(content(normal))).not.toBe(
    documentContentSignature(
      content(normal, [
        [10, 20],
        [0, 0],
      ]),
    ),
  );
});

it.each([false, true])(
  "ignores JSON object key order throughout known documents while preserving arrays (presentation=%s)",
  (presentation) => {
    const value = JSON.parse(
      comparisonContent(comparisonScene(), presentation),
    );
    const scene = presentation ? value.slides[0].scene : value;
    scene.appState.subscenes.second = {
      ...scene.appState.subscenes.child,
      title: "Second child",
    };
    const original = JSON.stringify(value);
    const reordered = JSON.stringify(JSON.parse(original), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    );
    expect(reordered).not.toBe(original);
    expect(documentContentSignature(reordered)).toBe(
      documentContentSignature(original),
    );
  },
);

it("keeps numeric values exact in document comparison", () => {
  const original = comparisonScene();
  const changed = comparisonScene();
  changed.elements[0].x = 10.000000000000002;
  expect(documentContentSignature(JSON.stringify(changed))).not.toBe(
    documentContentSignature(JSON.stringify(original)),
  );
});

it("keeps absence and other empty array values distinct from null", () => {
  const scene = comparisonScene();
  const content = (value: object) => JSON.stringify({ ...scene, ...value });
  const empty = content({ metadata: { items: [] } });
  const cleared = content({ metadata: { items: null } });
  expect(documentContentSignature(empty)).not.toBe(
    documentContentSignature(cleared),
  );
  const withNullBinding = content({
    elements: [{ ...scene.elements[0], boundElements: null }],
  });
  const absentBinding = content({ elements: [scene.elements[0]] });
  expect(documentContentSignature(withNullBinding)).not.toBe(
    documentContentSignature(absentBinding),
  );
});
