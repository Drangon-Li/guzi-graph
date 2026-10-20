import { registerCustomFontRegistry } from "@excalidraw/common";
import { getElementAbsoluteCoords } from "@excalidraw/element/bounds";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import type { SubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";

import type { SceneSnapshot } from "./document";
import type { DesktopAPI } from "./shared";

export type StructuredExportFormat = "json" | "md";
type Point = [number, number];
type Binding = Extract<ExcalidrawElement, { type: "arrow" }>["startBinding"];

type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  points?: Point[];
};

type ElementRecord = {
  id: string;
  type: ExcalidrawElement["type"];
  sceneIndex: number;
  geometry: Geometry;
  frameId: string | null;
  groupIds: string[];
  containerId: string | null;
  labelTextIds: string[];
  boundElements: { id: string; type: string }[];
  link: string | null;
};

export type SemanticNode = ElementRecord & {
  originalText?: string;
  richText?: Extract<ExcalidrawElement, { type: "text" }>["richText"];
  subcanvasId?: string;
  renderedText?: string;
  name?: string | null;
  fileId?: string | null;
  image?: {
    status: string;
    scale: readonly number[];
    crop: unknown;
  };
};

export type SemanticConnector = ElementRecord & {
  type: "arrow" | "line";
  start: { binding: Binding; worldPoint: Point };
  end: { binding: Binding; worldPoint: Point };
  startArrowhead: string | null;
  endArrowhead: string | null;
  direction: "start-to-end" | "end-to-start" | "bidirectional" | "undirected";
  worldPoints: Point[];
};

export type LayoutRelation = {
  childId: string;
  parentId: string;
  parentKind: "element" | "group";
  source: "explicit" | "inferred";
  rule:
    | "text-container"
    | "frame-membership"
    | "group-membership"
    | "smallest-containing-rectangle";
  tolerance?: number;
};

type Asset = {
  fileId: string;
  mimeType: string | null;
  path: string | null;
  name: string | null;
  status: "available" | "missing" | "unsupported-data";
  byteLength: number | null;
  digest: string | null;
  created: number | null;
  lastRetrieved: number | null;
};

type SpatialCut = {
  source: "inferred";
  axis: "x" | "y";
  gap: number;
  beforeTextIds: string[];
  afterTextIds: string[];
};

export type StructuredExport = {
  format: "guzi-graph.semantic";
  version: 1;
  title: string;
  source: { liveElementCount: number; deletedElementCount: number };
  nodes: SemanticNode[];
  connectors: SemanticConnector[];
  assets: Asset[];
  assetDirectory: string;
  layout: {
    includeInferredStructure: boolean;
    relations: LayoutRelation[];
    readingOrder: {
      source: "inferred";
      rule: "regions-top-to-bottom-with-whitespace-column-blocks";
      sections: {
        regionId: string | null;
        textIds: string[];
        spatialCuts: SpatialCut[];
      }[];
    };
  };
  subcanvases?: { id: string; title: string; document: StructuredExport }[];
  subcanvasLinks?: {
    parentSceneId: string | null;
    pinElementId: string;
    sceneId: string;
  }[];
  diagnostics: { code: string; elementIds: string[]; message: string }[];
};

const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const canonical = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map(canonical) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareId(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    ) as T;
  }
  return value;
};

const digest = (text: string) => {
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return [first, second]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
};

const utf8 = (text: string): ArrayBuffer => {
  const bytes: number[] = [];
  for (const character of text) {
    let code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes).buffer;
};

const decodeDataURL = (dataURL: string): ArrayBuffer | null => {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(dataURL);
  if (!match) {
    return null;
  }
  if (!/;base64$/i.test(match[1])) {
    try {
      return utf8(decodeURIComponent(match[2]));
    } catch {
      return null;
    }
  }
  const encoded = match[2].replace(/\s/g, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 4) {
    const value =
      (alphabet.indexOf(encoded[index]) << 18) |
      (alphabet.indexOf(encoded[index + 1]) << 12) |
      (Math.max(0, alphabet.indexOf(encoded[index + 2])) << 6) |
      Math.max(0, alphabet.indexOf(encoded[index + 3]));
    bytes.push((value >> 16) & 255);
    if (encoded[index + 2] !== "=") {
      bytes.push((value >> 8) & 255);
    }
    if (encoded[index + 3] !== "=") {
      bytes.push(value & 255);
    }
  }
  return new Uint8Array(bytes).buffer;
};

const fileExtension = (mimeType: string) =>
  ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
  }[mimeType] || "bin");

const rotate = (point: Point, center: Point, angle: number): Point => {
  const x = point[0] - center[0];
  const y = point[1] - center[1];
  return [
    center[0] + x * Math.cos(angle) - y * Math.sin(angle),
    center[1] + x * Math.sin(angle) + y * Math.cos(angle),
  ];
};

const corners = (geometry: Geometry): Point[] => {
  const { x, y, width, height, angle } = geometry;
  const center: Point = [x + width / 2, y + height / 2];
  return (
    [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ] as Point[]
  ).map((point) => rotate(point, center, angle));
};

const contains = (parent: Geometry, child: Geometry) => {
  const center: Point = [
    parent.x + parent.width / 2,
    parent.y + parent.height / 2,
  ];
  return corners(child).every((point) => {
    const [x, y] = rotate(point, center, -parent.angle);
    return (
      x >= parent.x - 2 &&
      x <= parent.x + parent.width + 2 &&
      y >= parent.y - 2 &&
      y <= parent.y + parent.height + 2
    );
  });
};

const readingOrder = <T extends { id: string; geometry: Geometry }>(
  items: T[],
): T[] => {
  const remaining = [...items].sort(
    (a, b) =>
      a.geometry.y - b.geometry.y ||
      a.geometry.x - b.geometry.x ||
      compareId(a.id, b.id),
  );
  const result: T[] = [];
  while (remaining.length) {
    const first = remaining.shift()!;
    const row = [first];
    for (let index = 0; index < remaining.length; ) {
      const item = remaining[index];
      if (
        Math.abs(item.geometry.y - first.geometry.y) <=
        Math.min(
          24,
          Math.min(
            Math.abs(item.geometry.height),
            Math.abs(first.geometry.height),
          ) / 2,
        )
      ) {
        row.push(...remaining.splice(index, 1));
      } else {
        index++;
      }
    }
    result.push(
      ...row.sort(
        (a, b) =>
          a.geometry.x - b.geometry.x ||
          a.geometry.y - b.geometry.y ||
          compareId(a.id, b.id),
      ),
    );
  }
  return result;
};

const paragraphReadingOrder = (
  items: SemanticNode[],
): { nodes: SemanticNode[]; spatialCuts: SpatialCut[] } => {
  if (items.length < 2) {
    return { nodes: items, spatialCuts: [] };
  }
  const bounds = new Map(
    items.map((node) => {
      const points = corners(node.geometry);
      return [
        node.id,
        {
          x1: Math.min(...points.map(([x]) => x)),
          x2: Math.max(...points.map(([x]) => x)),
          y1: Math.min(...points.map(([, y]) => y)),
          y2: Math.max(...points.map(([, y]) => y)),
        },
      ];
    }),
  );
  const heights = items
    .map((node) => Math.abs(node.geometry.height))
    .sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const cuts = (axis: "x" | "y") => {
    const start = axis === "x" ? "x1" : "y1";
    const end = axis === "x" ? "x2" : "y2";
    const intervals = items
      .map((node) => ({ node, bounds: bounds.get(node.id)! }))
      .sort(
        (a, b) =>
          a.bounds[start] - b.bounds[start] || compareId(a.node.id, b.node.id),
      );
    const candidates: {
      position: number;
      gap: number;
      before: SemanticNode[];
      after: SemanticNode[];
    }[] = [];
    let lastEnd = intervals[0].bounds[end];
    for (const interval of intervals.slice(1)) {
      if (interval.bounds[start] > lastEnd) {
        const position = (lastEnd + interval.bounds[start]) / 2;
        candidates.push({
          position,
          gap: interval.bounds[start] - lastEnd,
          before: items.filter((node) => bounds.get(node.id)![end] < position),
          after: items.filter((node) => bounds.get(node.id)![start] > position),
        });
      }
      lastEnd = Math.max(lastEnd, interval.bounds[end]);
    }
    return candidates.sort((a, b) => b.gap - a.gap || a.position - b.position);
  };
  // Repeated substantial text and overlapping stacks avoid treating rows of tiny diagram labels as columns.
  const vertical = cuts("x").find((cut) => {
    const hasRepeatedText = (nodes: SemanticNode[]) =>
      nodes.filter(
        (node) => (node.originalText || "").replace(/\s/g, "").length >= 8,
      ).length >= 2;
    if (
      cut.gap < 16 ||
      !hasRepeatedText(cut.before) ||
      !hasRepeatedText(cut.after)
    ) {
      return false;
    }
    const verticalRange = (nodes: SemanticNode[]) => [
      Math.min(...nodes.map((node) => bounds.get(node.id)!.y1)),
      Math.max(...nodes.map((node) => bounds.get(node.id)!.y2)),
    ];
    const [beforeStart, beforeEnd] = verticalRange(cut.before);
    const [afterStart, afterEnd] = verticalRange(cut.after);
    return (
      Math.min(beforeEnd, afterEnd) - Math.max(beforeStart, afterStart) >=
      Math.min(24, medianHeight)
    );
  });
  const horizontal = vertical
    ? undefined
    : cuts("y").find((cut) => cut.gap >= Math.max(24, medianHeight * 0.8));
  const cut = vertical || horizontal;
  if (!cut) {
    return { nodes: readingOrder(items), spatialCuts: [] };
  }
  const before = paragraphReadingOrder(cut.before);
  const after = paragraphReadingOrder(cut.after);
  return {
    nodes: [...before.nodes, ...after.nodes],
    spatialCuts: [
      {
        source: "inferred",
        axis: vertical ? "x" : "y",
        gap: cut.gap,
        beforeTextIds: before.nodes.map((node) => node.id),
        afterTextIds: after.nodes.map((node) => node.id),
      },
      ...before.spatialCuts,
      ...after.spatialCuts,
    ],
  };
};

export const collectExportSubcanvases = (
  elements: readonly ExcalidrawElement[],
  subscenes: SubcanvasScenes = {},
) => {
  const scenes: { id: string; scene: SubcanvasScenes[string] }[] = [];
  const links: NonNullable<StructuredExport["subcanvasLinks"]> = [];
  const visited = new Set<string>();
  const visit = (
    elements: readonly ExcalidrawElement[],
    parentSceneId: string | null,
  ) => {
    for (const element of elements) {
      const sceneId =
        element.type === "stickynote" &&
        !element.isDeleted &&
        element.customData?.subcanvas?.sceneId;
      if (typeof sceneId !== "string" || !subscenes[sceneId]) {
        continue;
      }
      links.push({ parentSceneId, pinElementId: element.id, sceneId });
      if (visited.has(sceneId)) {
        continue;
      }
      visited.add(sceneId);
      const scene = subscenes[sceneId];
      scenes.push({ id: sceneId, scene });
      visit(scene.elements, sceneId);
    }
  };
  visit(elements, null);
  return { scenes, links };
};

export const buildStructuredExport = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  options: {
    title: string;
    includeInferredStructure: boolean;
    subscenes?: SubcanvasScenes;
  },
): StructuredExport => {
  const live = elements.filter((element) => !element.isDeleted);
  const liveIds = new Set(live.map((element) => element.id));
  const elementsMap = new Map(live.map((element) => [element.id, element]));
  const nodes: SemanticNode[] = [];
  const connectors: SemanticConnector[] = [];
  const diagnostics: StructuredExport["diagnostics"] = [];
  const relations: LayoutRelation[] = [];
  const texts = live.filter((element) => element.type === "text");
  const labels = (id: string) =>
    texts.filter((text) => text.containerId === id).map((text) => text.id);
  for (const [sceneIndex, element] of live.entries()) {
    const geometry: Geometry = {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      angle: element.angle,
      ...("points" in element
        ? { points: element.points.map(([x, y]) => [x, y] as Point) }
        : {}),
    };
    const record: ElementRecord = {
      id: element.id,
      type: element.type,
      sceneIndex,
      geometry,
      frameId: element.frameId || null,
      groupIds: [...element.groupIds],
      containerId: element.type === "text" ? element.containerId : null,
      labelTextIds: labels(element.id),
      boundElements: (element.boundElements || []).map((item) => ({ ...item })),
      link: element.link || null,
    };
    if (record.frameId) {
      relations.push({
        childId: record.id,
        parentId: record.frameId,
        parentKind: "element",
        source: "explicit",
        rule: "frame-membership",
      });
    }
    for (const groupId of record.groupIds) {
      relations.push({
        childId: record.id,
        parentId: groupId,
        parentKind: "group",
        source: "explicit",
        rule: "group-membership",
      });
    }
    if (record.containerId) {
      relations.push({
        childId: record.id,
        parentId: record.containerId,
        parentKind: "element",
        source: "explicit",
        rule: "text-container",
      });
    }
    if (element.type === "arrow" || element.type === "line") {
      const points = element.points.map(
        ([x, y]) => [element.x + x, element.y + y] as Point,
      );
      // Curved lines rotate around their curve bounds, which can differ from point bounds.
      const [, , , , centerX, centerY] = getElementAbsoluteCoords(
        element,
        elementsMap,
      );
      const center: Point = [centerX, centerY];
      const worldPoints = points.map((point) =>
        rotate(point, center, element.angle),
      );
      const startArrowhead = element.startArrowhead || null;
      const endArrowhead = element.endArrowhead || null;
      const startBinding = canonical(element.startBinding || null);
      const endBinding = canonical(element.endBinding || null);
      connectors.push({
        ...record,
        type: element.type,
        worldPoints,
        start: {
          binding: startBinding,
          worldPoint: worldPoints[0] || [element.x, element.y],
        },
        end: {
          binding: endBinding,
          worldPoint: worldPoints.at(-1) || [element.x, element.y],
        },
        startArrowhead,
        endArrowhead,
        direction:
          startArrowhead && endArrowhead
            ? "bidirectional"
            : endArrowhead
            ? "start-to-end"
            : startArrowhead
            ? "end-to-start"
            : "undirected",
      });
      if (
        startBinding &&
        endBinding &&
        startBinding.elementId === endBinding.elementId
      ) {
        diagnostics.push({
          code: "same-container-self-loop",
          elementIds: [element.id, startBinding.elementId],
          message:
            "Both endpoints bind to the same element; retained without inferring a business relationship.",
        });
      }
      if (!startBinding || !endBinding) {
        diagnostics.push({
          code:
            !startBinding && !endBinding
              ? "unbound-connector"
              : "partially-bound-connector",
          elementIds: [element.id],
          message:
            "Unbound endpoints retain their world coordinates; no nearest-node binding was invented.",
        });
      }
      for (const binding of [startBinding, endBinding]) {
        if (binding && !liveIds.has(binding.elementId)) {
          diagnostics.push({
            code: "missing-binding-target",
            elementIds: [element.id, binding.elementId],
            message:
              "The original binding references a deleted or missing element.",
          });
        }
      }
    } else {
      nodes.push({
        ...record,
        ...(element.type === "stickynote" &&
        typeof element.customData?.subcanvas?.sceneId === "string"
          ? { subcanvasId: element.customData.subcanvas.sceneId }
          : {}),
        ...(element.type === "text"
          ? {
              originalText: element.originalText ?? element.text,
              ...(element.richText ? { richText: element.richText } : {}),
              ...(element.originalText !== element.text
                ? { renderedText: element.text }
                : {}),
            }
          : {}),
        ...(element.type === "frame" || element.type === "magicframe"
          ? { name: element.name }
          : {}),
        ...(element.type === "image"
          ? {
              fileId: element.fileId,
              image: {
                status: element.status,
                scale: [...element.scale],
                crop: canonical(element.crop || null),
              },
            }
          : {}),
      });
    }
  }
  const rectangles = nodes.filter((node) => node.type === "rectangle");
  if (options.includeInferredStructure) {
    for (const node of nodes) {
      if (
        node.containerId ||
        node.frameId ||
        node.groupIds.length ||
        node.type === "frame" ||
        node.type === "magicframe"
      ) {
        continue;
      }
      const area = Math.abs(node.geometry.width * node.geometry.height);
      const parent = rectangles
        .filter(
          (rectangle) =>
            rectangle.id !== node.id &&
            Math.abs(rectangle.geometry.width * rectangle.geometry.height) >
              area &&
            contains(rectangle.geometry, node.geometry),
        )
        .sort(
          (a, b) =>
            Math.abs(a.geometry.width * a.geometry.height) -
              Math.abs(b.geometry.width * b.geometry.height) ||
            compareId(a.id, b.id),
        )[0];
      if (parent) {
        relations.push({
          childId: node.id,
          parentId: parent.id,
          parentKind: "element",
          source: "inferred",
          rule: "smallest-containing-rectangle",
          tolerance: 2,
        });
      }
    }
  }
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const recordMap = new Map(
    [...nodes, ...connectors].map((node) => [node.id, node]),
  );
  const sectionMap = new Map<
    string,
    { regionId: string | null; textIds: string[]; geometry: Geometry }
  >();
  const findRegion = (
    id: string,
    visited = new Set<string>(),
  ): string | null => {
    if (visited.has(id)) {
      return null;
    }
    visited.add(id);
    const record = recordMap.get(id);
    if (!record) {
      return null;
    }
    if (record.frameId && liveIds.has(record.frameId)) {
      return record.frameId;
    }
    if (record.groupIds.length) {
      return `group:${record.groupIds[0]}`;
    }
    if (record.containerId) {
      const container = nodeMap.get(record.containerId);
      return (
        findRegion(record.containerId, visited) ||
        (container?.type === "rectangle" ||
        container?.type === "frame" ||
        container?.type === "magicframe"
          ? container.id
          : null)
      );
    }
    return (
      relations.find(
        (relation) => relation.childId === id && relation.source === "inferred",
      )?.parentId || null
    );
  };
  for (const node of nodes.filter((node) => node.type === "text")) {
    const regionId = findRegion(node.id);
    const key = regionId || `note:${node.id}`;
    let section = sectionMap.get(key);
    if (!section) {
      const groupRecords = regionId?.startsWith("group:")
        ? [...recordMap.values()].filter((record) =>
            record.groupIds.includes(regionId.slice(6)),
          )
        : [];
      const points = groupRecords.flatMap((record) => corners(record.geometry));
      const geometry =
        nodeMap.get(regionId || "")?.geometry ||
        (points.length
          ? {
              x: Math.min(...points.map(([x]) => x)),
              y: Math.min(...points.map(([, y]) => y)),
              width:
                Math.max(...points.map(([x]) => x)) -
                Math.min(...points.map(([x]) => x)),
              height:
                Math.max(...points.map(([, y]) => y)) -
                Math.min(...points.map(([, y]) => y)),
              angle: 0,
            }
          : node.geometry);
      section = { regionId, textIds: [], geometry };
      sectionMap.set(key, section);
    }
    section.textIds.push(node.id);
  }
  const sections = readingOrder(
    [...sectionMap.entries()].map(([id, section]) => ({ id, ...section })),
  ).map((section) => {
    const ordered = paragraphReadingOrder(
      section.textIds.map((id) => nodeMap.get(id)!),
    );
    return {
      regionId: section.regionId,
      textIds: ordered.nodes.map((node) => node.id),
      spatialCuts: ordered.spatialCuts,
    };
  });
  const referencedFileIds = [
    ...new Set(nodes.flatMap((node) => (node.fileId ? [node.fileId] : []))),
  ].sort(compareId);
  const assets: Asset[] = referencedFileIds.map((fileId) => {
    const file = files[fileId];
    const data = file ? decodeDataURL(file.dataURL) : null;
    const hash = file && data ? digest(file.dataURL) : null;
    const safeId =
      fileId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "image";
    return {
      fileId,
      mimeType: file?.mimeType || null,
      path: null,
      name:
        file && hash
          ? `${safeId}-${hash}.${fileExtension(file.mimeType)}`
          : null,
      status: !file ? "missing" : data ? "available" : "unsupported-data",
      byteLength: data?.byteLength ?? null,
      digest: hash,
      created: file?.created ?? null,
      lastRetrieved: file?.lastRetrieved ?? null,
    };
  });
  const assetDirectory = `guzi-assets-${digest(
    JSON.stringify({ nodes, connectors, assets }),
  )}`;
  for (const asset of assets) {
    if (asset.name) {
      asset.path = `${assetDirectory}/${asset.name}`;
    }
    if (asset.status !== "available") {
      diagnostics.push({
        code: "missing-image-data",
        elementIds: nodes
          .filter((node) => node.fileId === asset.fileId)
          .map((node) => node.id),
        message: `Image resource ${asset.fileId} is ${asset.status}; no attachment path was invented.`,
      });
    }
  }
  const images = nodes.filter((node) => node.type === "image");
  if (images.length) {
    diagnostics.push({
      code: "images-not-ocr",
      elementIds: images.map((node) => node.id),
      message:
        "Images are exported as attachments. Text and diagram content inside images were not recognized or inferred.",
    });
  }
  for (const node of images.filter((node) => !node.fileId)) {
    diagnostics.push({
      code: "missing-image-file-id",
      elementIds: [node.id],
      message: "The image has no resource identifier and cannot be attached.",
    });
  }
  const unlabeled = nodes.filter(
    (node) =>
      ["ellipse", "rectangle", "diamond", "stickynote"].includes(node.type) &&
      !node.labelTextIds.length,
  );
  if (unlabeled.length) {
    diagnostics.push({
      code: "unlabeled-shapes",
      elementIds: unlabeled.map((node) => node.id),
      message:
        "These shapes have no explicitly bound text labels; no names or domain meanings were invented.",
    });
  }
  for (const relation of relations.filter(
    (relation) =>
      relation.parentKind === "element" && !liveIds.has(relation.parentId),
  )) {
    diagnostics.push({
      code: "missing-layout-target",
      elementIds: [relation.childId, relation.parentId],
      message:
        "An explicit layout relationship references a missing or deleted element.",
    });
  }
  const graph = collectExportSubcanvases(elements, options.subscenes);
  const subcanvases = graph.scenes.map(({ id, scene }) => ({
    id,
    title: scene.title,
    document: buildStructuredExport(scene.elements, files, {
      title: scene.title,
      includeInferredStructure: options.includeInferredStructure,
    }),
  }));
  for (const child of subcanvases) {
    for (const asset of child.document.assets) {
      if (!assets.some((existing) => existing.fileId === asset.fileId)) {
        assets.push({ ...asset });
      }
    }
  }
  assets.sort((a, b) => compareId(a.fileId, b.fileId));
  const sharedAssetDirectory = subcanvases.length
    ? `guzi-assets-${digest(JSON.stringify({ assets, subcanvases }))}`
    : assetDirectory;
  for (const asset of assets) {
    if (asset.name) {
      asset.path = `${sharedAssetDirectory}/${asset.name}`;
    }
  }
  for (const child of subcanvases) {
    child.document.assetDirectory = sharedAssetDirectory;
    child.document.assets.forEach((asset) => {
      if (asset.name) {
        asset.path = `${sharedAssetDirectory}/${asset.name}`;
      }
    });
  }
  return {
    ...(subcanvases.length ? { subcanvases, subcanvasLinks: graph.links } : {}),
    format: "guzi-graph.semantic",
    version: 1,
    title: options.title,
    source: {
      liveElementCount: live.length,
      deletedElementCount: elements.length - live.length,
    },
    nodes,
    connectors,
    assets,
    assetDirectory: sharedAssetDirectory,
    layout: {
      includeInferredStructure: options.includeInferredStructure,
      relations,
      readingOrder: {
        source: "inferred",
        rule: "regions-top-to-bottom-with-whitespace-column-blocks",
        sections,
      },
    },
    diagnostics,
  };
};

export const escapeMarkdown = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");

export const structuredExportToMarkdown = (
  document: StructuredExport,
): string => {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const lines = [
    `# ${escapeMarkdown(document.title.replace(/[\r\n]+/g, " "))}`,
    "",
    `Format: guzi-graph.semantic v1 · ${document.nodes.length} nodes · ${
      document.connectors.length
    } connectors · ${
      document.nodes.filter((node) => node.type === "text").length
    } text elements`,
    "",
    "Layout and reading order are spatial inferences, not domain semantics. Explicit frame, group and text-container relationships take priority. Unbound endpoints and same-container self-loops are preserved. Images have not been OCR processed.",
    "",
    "## Canvas text",
    "",
  ];
  for (const section of document.layout.readingOrder.sections) {
    lines.push(
      `### ${
        section.regionId
          ? `Region: ${escapeMarkdown(section.regionId)}`
          : "Independent note"
      }`,
      "",
    );
    for (const id of section.textIds) {
      const node = nodeMap.get(id)!;
      lines.push(
        `Text ID: ${escapeMarkdown(id)}${
          node.containerId
            ? ` · explicit container: ${escapeMarkdown(node.containerId)}`
            : ""
        }`,
        "",
      );
      lines.push(
        ...(node.originalText || "")
          .split(/\r\n|\r|\n/)
          .map(
            (line) =>
              `> ${escapeMarkdown(line).replace(/^ +/, (spaces) =>
                "&#32;".repeat(spaces.length),
              )}`,
          ),
        "",
      );
    }
  }
  lines.push(
    "## Connections",
    "",
    "Arrowhead direction describes visual endpoints only. Unknown endpoints retain coordinates; no nearest-node binding is inferred.",
    "",
    "| Connector ID | Type | Start binding / point | Direction | End binding / point | Arrowheads (start / end) | Labels (text IDs) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  const endpoint = (point: SemanticConnector["start"]) =>
    `${
      point.binding ? escapeMarkdown(point.binding.elementId) : "unknown"
    } @ (${point.worldPoint
      .map((value) => String(Math.round(value * 1000) / 1000))
      .join(", ")})`;
  for (const connector of document.connectors) {
    lines.push(
      `| ${escapeMarkdown(connector.id)} | ${connector.type} | ${endpoint(
        connector.start,
      )} | ${connector.direction} | ${endpoint(connector.end)} | ${
        connector.startArrowhead || "none"
      } / ${connector.endArrowhead || "none"} | ${connector.labelTextIds
        .map(escapeMarkdown)
        .join(", ")} |`,
    );
  }
  lines.push("", "## Images", "");
  for (const node of document.nodes.filter((node) => node.type === "image")) {
    const asset = document.assets.find((item) => item.fileId === node.fileId);
    lines.push(
      `Image ID: ${escapeMarkdown(node.id)} · resource: ${escapeMarkdown(
        node.fileId || "missing",
      )} · OCR: not performed`,
      "",
    );
    lines.push(
      asset?.path
        ? `![Image attachment](${asset.path})`
        : "Image data unavailable; no attachment was exported.",
      "",
    );
  }
  lines.push(
    "## Layout evidence",
    "",
    "Reading order: inferred, whole regions top to bottom and same-row regions left to right. Within a region, recursive whitespace cuts keep repeated column paragraphs together (left column before right); isolated labels use row order. The JSON records each inferred cut and its supporting text IDs.",
    "",
    "| Child ID | Parent ID | Parent kind | Evidence | Rule |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const relation of document.layout.relations) {
    lines.push(
      `| ${escapeMarkdown(relation.childId)} | ${escapeMarkdown(
        relation.parentId,
      )} | ${relation.parentKind} | ${relation.source} | ${relation.rule}${
        relation.tolerance === undefined
          ? ""
          : ` (tolerance ${relation.tolerance}px)`
      } |`,
    );
  }
  lines.push(
    "",
    "## Element inventory",
    "",
    "Every live source element appears once in this inventory. Geometry remains available in the semantic JSON export.",
    "",
    "| Element ID | Type | Text label IDs | Frame | Groups |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const element of [...document.nodes, ...document.connectors].sort(
    (a, b) => a.sceneIndex - b.sceneIndex,
  )) {
    lines.push(
      `| ${escapeMarkdown(element.id)} | ${
        element.type
      } | ${element.labelTextIds
        .map(escapeMarkdown)
        .join(", ")} | ${escapeMarkdown(
        element.frameId || "",
      )} | ${element.groupIds.map(escapeMarkdown).join(", ")} |`,
    );
  }
  lines.push("", "## Diagnostics", "");
  for (const diagnostic of document.diagnostics) {
    lines.push(
      `- ${diagnostic.code}: ${escapeMarkdown(
        diagnostic.message,
      )} IDs: ${diagnostic.elementIds.map(escapeMarkdown).join(", ")}`,
    );
  }
  if (document.subcanvases?.length) {
    lines.push(
      "",
      "## Subcanvas hierarchy",
      "",
      "| Parent scene | Pin element | Subcanvas |",
      "| --- | --- | --- |",
    );
    for (const link of document.subcanvasLinks ?? []) {
      lines.push(
        `| ${escapeMarkdown(link.parentSceneId ?? "root")} | ${escapeMarkdown(
          link.pinElementId,
        )} | ${escapeMarkdown(link.sceneId)} |`,
      );
    }
    for (const child of document.subcanvases) {
      lines.push(
        "",
        `## Subcanvas: ${escapeMarkdown(child.title)} (${escapeMarkdown(
          child.id,
        )})`,
        "",
        structuredExportToMarkdown(child.document).replace(/^#/gm, "##"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

export const prepareStructuredExport = (
  document: StructuredExport,
  files: BinaryFiles,
  format: StructuredExportFormat,
): Parameters<DesktopAPI["saveExport"]>[0] => ({
  name: document.title,
  extension: format,
  data: utf8(
    format === "json"
      ? `${JSON.stringify(document, null, 2)}\n`
      : structuredExportToMarkdown(document),
  ),
  assetDirectory: document.assetDirectory,
  assets: document.assets
    .filter((asset) => asset.status === "available")
    .map((asset) => {
      const data = decodeDataURL(files[asset.fileId].dataURL);
      if (!data || digest(files[asset.fileId].dataURL) !== asset.digest) {
        throw new Error(
          "Image data changed after export preview. Reopen the export dialog.",
        );
      }
      return { name: asset.name!, data };
    }),
});

export const exportCanvasPdf = async (
  api: ExcalidrawImperativeAPI,
  title: string,
  desktop: DesktopAPI,
  options: { includeSubcanvases?: boolean; snapshot?: SceneSnapshot } = {},
): Promise<boolean> => {
  api.commitEditing();
  const elements = (
    options.snapshot?.elements ?? api.getSceneElements()
  ).filter(
    (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
  );
  if (!elements.length) {
    throw new Error("The canvas is empty.");
  }
  const appState = {
    ...(options.snapshot?.appState ?? api.getAppState()),
    exportScale: 1,
    exportEmbedScene: false,
  };
  const files = { ...(options.snapshot?.files ?? api.getFiles()) };
  const { exportToSvg } = await import("@excalidraw/utils/export");
  registerCustomFontRegistry(appState.fontRegistry ?? {});
  const svg = await exportToSvg({
    elements,
    appState,
    files,
    exportPadding: 24,
    reuseImages: true,
  });
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  if (!(width > 0 && height > 0)) {
    throw new Error("The canvas has invalid PDF dimensions.");
  }
  const pages: NonNullable<Parameters<DesktopAPI["savePdf"]>[0]["pages"]> = [];
  if (options.includeSubcanvases) {
    for (const { scene } of collectExportSubcanvases(
      elements,
      appState.subscenes,
    ).scenes) {
      const live = scene.elements.filter(
        (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
      );
      if (!live.length) {
        continue;
      }
      registerCustomFontRegistry(scene.appState.fontRegistry ?? {});
      const child = await exportToSvg({
        elements: live,
        appState: {
          ...appState,
          ...scene.appState,
          exportScale: 1,
          exportEmbedScene: false,
        },
        files,
        exportPadding: 24,
        reuseImages: true,
      });
      const pageWidth = Number(child.getAttribute("width"));
      const pageHeight = Number(child.getAttribute("height"));
      if (!(pageWidth > 0 && pageHeight > 0)) {
        throw new Error("A subcanvas has invalid PDF dimensions.");
      }
      pages.push({
        title: scene.title,
        svg: child.outerHTML,
        width: pageWidth,
        height: pageHeight,
      });
    }
  }
  return desktop.savePdf({
    name: title,
    svg: svg.outerHTML,
    width,
    height,
    ...(pages.length ? { pages } : {}),
  });
};
