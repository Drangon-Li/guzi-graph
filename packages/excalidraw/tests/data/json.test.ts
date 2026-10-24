import { getExportSource } from "@excalidraw/common";
import {
  createTableData,
  createTableElements,
  isTableRoot,
} from "@excalidraw/element/table";

import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/element/types";

import { getDefaultAppState } from "../../appState";
import { serializeAsJSON, serializeForJSON } from "../../data/json";
import { rectangleFixture } from "../fixtures/elementFixture";

import type { BinaryFileData, BinaryFiles, SocketId } from "../../types";

const image = (id: string, isDeleted = false): ExcalidrawImageElement => ({
  ...rectangleFixture,
  id,
  type: "image",
  fileId: id as FileId,
  status: "saved",
  scale: [1, 1],
  crop: null,
  isDeleted,
});

const file = (id: string): BinaryFileData => ({
  id: id as FileId,
  dataURL: `data:image/png;base64,${id}` as BinaryFileData["dataURL"],
  mimeType: "image/png",
  created: 1,
});

const liveTable = (): ExcalidrawElement[] =>
  createTableElements(createTableData(1, 1), 0, 0).elements.map((element) =>
    element.type === "text"
      ? {
          ...element,
          text: "Latest cell",
          originalText: "Latest cell",
          richText: {
            version: 1,
            paragraphs: [{ runs: [{ text: "Latest cell", bold: true }] }],
          },
        }
      : element,
  );

describe("JSON scene export", () => {
  it("keeps the string interface, field order and two-space formatting for both destinations", () => {
    const prefix = `{
  "type": "excalidraw",
  "version": 2,
  "source": ${JSON.stringify(getExportSource())},
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ddeeff",
    "subscenes": {}
  }`;
    const state = { viewBackgroundColor: "#ddeeff" };
    expect(serializeAsJSON([], state, {}, "local")).toBe(
      `${prefix},\n  "files": {}\n}`,
    );
    expect(serializeAsJSON([], state, {}, "database")).toBe(`${prefix}\n}`);
  });

  it.each(["local", "database"] as const)(
    "synchronizes persistent content and cleans %s exports without changing the live scene",
    (destination) => {
      const peerId = "peer" as SocketId;
      const elements = [
        ...liveTable(),
        image("root-image"),
        image("deleted-image", true),
        {
          ...rectangleFixture,
          id: "child-pin",
          type: "stickynote" as const,
          baseHeight: rectangleFixture.height,
          customData: { subcanvas: { sceneId: "child" } },
        },
      ];
      const appState = {
        ...getDefaultAppState(),
        viewBackgroundColor: "#ddeeff",
        fontRegistry: { 123456: "Example Font" },
        selectedElementIds: { "root-image": true as const },
        hoveredElementIds: { "root-image": true as const },
        collaborators: new Map([[peerId, { username: "Peer" }]]),
        subscenes: {
          child: {
            version: 1 as const,
            title: "子画布",
            elements: [...liveTable(), image("child-image")],
            appState: { viewBackgroundColor: "#aabbcc" },
          },
          orphan: {
            version: 1 as const,
            title: "Unreachable",
            elements: [image("orphan-image")],
            appState: {},
          },
        },
      };
      const files: BinaryFiles = Object.fromEntries(
        [
          "root-image",
          "child-image",
          "deleted-image",
          "orphan-image",
          "unused-image",
        ].map((id) => [id, file(id)]),
      );
      const before = JSON.stringify({ elements, appState, files });
      const data = serializeForJSON(elements, appState, files, destination);
      const saved = JSON.parse(
        serializeAsJSON(elements, appState, files, destination),
      );
      for (const exported of [data, saved]) {
        expect(exported).toMatchObject({
          type: "excalidraw",
          version: 2,
          source: getExportSource(),
          appState: {
            viewBackgroundColor: "#ddeeff",
            fontRegistry: { 123456: "Example Font" },
          },
        });
        expect(exported.appState).not.toHaveProperty("collaborators");
        expect(exported.appState).not.toHaveProperty("selectedElementIds");
        expect(exported.appState).not.toHaveProperty("hoveredElementIds");
        expect(exported.appState).not.toHaveProperty("scrollX");
        expect(Object.keys(exported.appState.subscenes)).toEqual(["child"]);
        expect(exported.appState.subscenes.child).toMatchObject({
          title: "子画布",
          appState: { viewBackgroundColor: "#aabbcc" },
        });
        for (const sceneElements of [
          exported.elements,
          exported.appState.subscenes.child.elements,
        ]) {
          const root = (sceneElements as ExcalidrawElement[]).find(
            isTableRoot,
          )!;
          expect(root.customData.table.cells[0]).toMatchObject({
            text: "Latest cell",
            richText: {
              paragraphs: [{ runs: [{ text: "Latest cell", bold: true }] }],
            },
          });
        }
      }
      if (destination === "local") {
        expect(Object.keys(data.files!)).toEqual(["root-image", "child-image"]);
        expect(saved.files).toEqual({
          "root-image": files["root-image"],
          "child-image": files["child-image"],
        });
      } else {
        expect(data.files).toBeUndefined();
        expect(saved).not.toHaveProperty("files");
      }
      expect(JSON.stringify({ elements, appState, files })).toBe(before);
      expect(appState.collaborators).toBeInstanceOf(Map);
      expect(appState.collaborators.get(peerId)?.username).toBe("Peer");
      expect(elements.find(isTableRoot)!.customData.table.cells[0].text).toBe(
        "",
      );
      expect(
        appState.subscenes.child.elements.find(isTableRoot)!.customData.table
          .cells[0].text,
      ).toBe("");
    },
  );
});
