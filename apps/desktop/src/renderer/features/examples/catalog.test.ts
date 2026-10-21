import { createHash } from "node:crypto";

import { bundledExamples } from "./catalog";

it("bundles the original complete Transformer document without external images", () => {
  const content = bundledExamples[0].content;
  expect(createHash("sha256").update(content).digest("hex")).toBe(
    "c8db1bd73f3b563ae35f9c0041d3380878e1e49a00d16427447dc081ff81d92d",
  );
  const scene = JSON.parse(content);
  expect(scene.type).toBe("excalidraw");
  expect(scene.elements).toHaveLength(114);
  expect(Object.keys(scene.appState.subscenes)).toHaveLength(5);
  expect(
    scene.appState.subscenes["transformer-qkv-detail"].elements,
  ).toHaveLength(40);
  const allElements = [scene, ...Object.values(scene.appState.subscenes)];
  for (const canvas of allElements as { elements: { type: string }[] }[]) {
    expect(canvas.elements.some((element) => element.type === "image")).toBe(
      false,
    );
  }
  expect(scene.files).toEqual({});
});
