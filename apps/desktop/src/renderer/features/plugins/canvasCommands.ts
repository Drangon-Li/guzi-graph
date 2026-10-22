import {
  ROUNDNESS,
  getFontString,
  getSizeFromPoints,
  randomId,
} from "@excalidraw/common";
import {
  bindBindingElement,
  convertToExcalidrawElements,
  fixBindingsAfterDeletion,
  getBoundTextElement,
  handleBindTextResize,
  isArrowElement,
  isBindableElement,
  isTextElement,
  newElementWith,
  newFrameElement,
  moveAllLeft,
  moveAllRight,
  moveOneLeft,
  moveOneRight,
  redrawTextBoundingBox,
  syncInvalidIndices,
  updateBindings,
} from "@excalidraw/element";
import { Scene } from "@excalidraw/element/Scene";
import { charWidth } from "@excalidraw/element/textMeasurements";
import { Fonts } from "@excalidraw/excalidraw/fonts";
import {
  canMergeTableCells,
  createTableElements,
  getTableRoot,
  isTableElement,
  isTableRoot,
  mergeTableCells,
  splitTableCells,
  updateTableElements,
} from "@excalidraw/element/table";
import { getSubcanvasId } from "@excalidraw/excalidraw/subcanvas";
import { convertStickyNoteToSubcanvas } from "@excalidraw/excalidraw/subcanvasActions";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { SubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";

import {
  createTableDataArgument,
  finite,
  imageFileArgument,
  normalizeTextFields,
  onlyKeys,
  richTextArgument,
  tableRangeArgument,
  updateTableData,
} from "./canvasCommandData";

export class CanvasCommandError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new CanvasCommandError("INVALID_ARGUMENT", message);
};

export const objectArgument = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Expected an object.");
  }
  return value as Record<string, unknown>;
};

export const stringArgument = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    return invalid(
      `${name} must be a nonempty string (at most 4096 characters).`,
    );
  }
  return value;
};

const basicTypes = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "image",
  "freedraw",
  "frame",
  "stickynote",
  "subcanvas",
  "table",
]);
const commonFields = new Set([
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "roundness",
  "opacity",
]);
const textFields = new Set([
  "text",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "lineHeight",
  "richText",
  "paragraphSpacing",
]);
const lineFields = new Set(["points", "startArrowhead", "endArrowhead"]);
const typeFields: Record<string, readonly string[]> = {
  image: ["fileId", "scale"],
  freedraw: ["points", "pressures", "simulatePressure"],
  frame: ["name"],
  subcanvas: ["title"],
};

export const CANVAS_CAPABILITIES = {
  elementTypes: [...basicTypes],
  operations: {
    create: {
      required: ["element.type", "element.x", "element.y"],
      optional: ["tempId"],
      table: { required: ["rows", "columns"], optional: ["cells"] },
      image: {
        requiredOneOf: ["fileId", "file"],
        file: ["mimeType", "dataURL"],
      },
    },
    patch: { required: ["id", "patch"] },
    delete: { required: ["id"] },
    table: {
      required: ["id"],
      optional: ["cells", "rows", "columns", "merge", "split"],
    },
    group: { required: ["ids"] },
    ungroup: { required: ["ids"] },
    lock: { required: ["ids", "locked"] },
    order: {
      required: ["ids", "position"],
      positions: ["front", "back", "forward", "backward"],
    },
    frame: { required: ["ids", "frameId"] },
    canvas: {
      required: ["patch"],
      fields: [
        "viewBackgroundColor",
        "gridModeEnabled",
        "gridSize",
        "objectsSnapModeEnabled",
      ],
    },
    subcanvas: { required: ["id", "title"] },
  },
  limits: {
    operations: 500,
    points: 1000,
    tableAxes: 100,
    tableCells: 2500,
    imageDataURLBytes: 1024 * 1024,
    batchImageDataURLBytes: 2 * 1024 * 1024,
    generatedElements: 10000,
  },
  imageMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  richText: {
    version: 1,
    marks: ["bold", "italic", "underline", "background"],
    lists: ["ordered", "bullet"],
  },
} as const;
const numericFields = new Set([
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeWidth",
  "roughness",
  "opacity",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "paragraphSpacing",
]);
const enums: Record<string, readonly unknown[]> = {
  fillStyle: ["hachure", "cross-hatch", "solid", "zigzag"],
  strokeStyle: ["solid", "dashed", "dotted"],
  textAlign: ["left", "center", "right"],
  verticalAlign: ["top", "middle", "bottom"],
  startArrowhead: [
    null,
    "arrow",
    "bar",
    "dot",
    "triangle",
    "circle",
    "circle_outline",
    "triangle_outline",
    "diamond",
    "diamond_outline",
    "crowfoot_one",
    "crowfoot_many",
    "crowfoot_one_or_many",
  ],
  endArrowhead: [
    null,
    "arrow",
    "bar",
    "dot",
    "triangle",
    "circle",
    "circle_outline",
    "triangle_outline",
    "diamond",
    "diamond_outline",
    "crowfoot_one",
    "crowfoot_many",
    "crowfoot_one_or_many",
  ],
};

const defaultRoundness = (type: string) => {
  if (type === "rectangle") {
    return { type: ROUNDNESS.ADAPTIVE_RADIUS };
  }
  if (["diamond", "arrow", "line"].includes(type)) {
    return { type: ROUNDNESS.PROPORTIONAL_RADIUS };
  }
  return null;
};

const validateFields = (
  type: string,
  value: Record<string, unknown>,
  patch = false,
) => {
  for (const [key, field] of Object.entries(value)) {
    if (
      !commonFields.has(key) &&
      !(type === "text" && textFields.has(key)) &&
      !((type === "arrow" || type === "line") && lineFields.has(key)) &&
      !typeFields[type]?.includes(key)
    ) {
      invalid(`Unsupported ${type} field: ${key}.`);
    }
    if (key === "richText") {
      if (!(patch && field === null)) {
        richTextArgument(field, invalid);
      }
    } else if (key === "paragraphSpacing") {
      finite(field, key, 0, 1000, invalid);
    } else if (key === "name" && field === null) {
      continue;
    } else if (key === "simulatePressure") {
      if (typeof field !== "boolean") {
        invalid("simulatePressure must be boolean.");
      }
    } else if (key === "pressures") {
      if (!Array.isArray(field) || field.length > 1000) {
        invalid("pressures must contain at most 1000 values.");
      }
      for (const pressure of field as unknown[]) {
        finite(pressure, "pressure", 0, 1, invalid);
      }
    } else if (key === "scale") {
      if (
        !Array.isArray(field) ||
        field.length !== 2 ||
        field.some((item) => item !== 1 && item !== -1)
      ) {
        invalid("Image scale requires two values of 1 or -1.");
      }
    } else if (numericFields.has(key)) {
      if (
        typeof field !== "number" ||
        !Number.isFinite(field) ||
        Math.abs(field) > 1e7
      ) {
        invalid(`${key} must be a finite number within ±10000000.`);
      }
      if (
        ["width", "height", "strokeWidth", "roughness"].includes(key) &&
        (field as number) < 0
      ) {
        invalid(`${key} cannot be negative.`);
      }
      if (
        ["fontSize", "fontFamily", "lineHeight"].includes(key) &&
        (field as number) <= 0
      ) {
        invalid(`${key} must be positive.`);
      }
      if (key === "fontSize" && (field as number) > 512) {
        invalid("fontSize cannot exceed 512.");
      }
      if (key === "lineHeight" && (field as number) > 10) {
        invalid("lineHeight cannot exceed 10.");
      }
      if (
        key === "opacity" &&
        ((field as number) < 0 || (field as number) > 100)
      ) {
        invalid("opacity must be between 0 and 100.");
      }
    } else if (key === "roundness") {
      if (field !== null) {
        const roundness = objectArgument(field);
        if (
          Object.keys(roundness).some((key) => key !== "type") ||
          !defaultRoundness(type) ||
          roundness.type !== defaultRoundness(type)?.type
        ) {
          invalid(`Invalid roundness for ${type}.`);
        }
      }
    } else if (enums[key]) {
      if (!enums[key].includes(field)) {
        invalid(`Invalid ${key}.`);
      }
    } else if (key === "points") {
      if (
        !Array.isArray(field) ||
        field.length < 2 ||
        field.length > 1000 ||
        field.some(
          (point) =>
            !Array.isArray(point) ||
            point.length !== 2 ||
            point.some(
              (n) =>
                typeof n !== "number" ||
                !Number.isFinite(n) ||
                Math.abs(n) > 1e7,
            ),
        )
      ) {
        invalid("points must contain 2–1000 finite coordinate pairs.");
      }
      if (
        (field as number[][])[0][0] !== 0 ||
        (field as number[][])[0][1] !== 0
      ) {
        invalid("The first line point must be [0, 0].");
      }
    } else if (typeof field !== "string" || field.length > 100000) {
      invalid(`${key} must be a string of at most 100000 characters.`);
    }
  }
};

export const isCanvasBusy = (state: AppState) =>
  !!(
    state.editingTextElement ||
    state.newElement ||
    state.multiElement ||
    state.resizingElement ||
    state.isResizing ||
    state.isRotating ||
    state.cursorButton === "down" ||
    state.selectedLinearElement?.isEditing ||
    state.openDialog
  );

export const loadCanvasOperationFonts = async (
  elements: readonly ExcalidrawElement[],
  ownerDocument: Document,
): Promise<void> => {
  await Fonts.loadElementsFonts(elements, ownerDocument);
  // Detached preflight can cache fallback character widths before fonts finish loading.
  for (const element of elements) {
    if (isTextElement(element)) {
      charWidth.clearCache(getFontString(element));
    }
  }
};

const assertWritable = (element: ExcalidrawElement) => {
  if (element.locked) {
    throw new CanvasCommandError(
      "LOCKED_TARGET",
      `Element ${element.id} is locked.`,
    );
  }
  if (!basicTypes.has(element.type)) {
    throw new CanvasCommandError(
      "UNSUPPORTED_TARGET",
      `Element ${element.id} has an unsupported type.`,
    );
  }
};

export const canvasExportDimensions = (width: number, height: number) => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 100000 ||
    height > 100000
  ) {
    throw new CanvasCommandError(
      "EXPORT_TOO_LARGE",
      "PNG canvas bounds must be finite and no larger than 100000 pixels per side.",
    );
  }
  const scale = Math.min(1, 4096 / Math.max(width, height));
  return {
    width: Math.max(1, Math.ceil(width * scale)),
    height: Math.max(1, Math.ceil(height * scale)),
    scale,
  };
};

const updateCanvasTableElements = (
  ...args: Parameters<typeof updateTableElements>
) => {
  const [elements] = args;
  const before = new Map(elements.map((element) => [element.id, element]));
  const rebuilt = updateTableElements(...args);
  const alive = new Set(
    rebuilt
      .filter((element) => !element.isDeleted)
      .map((element) => element.id),
  );
  const next = rebuilt.map((element) => {
    const arrows = before
      .get(element.id)
      ?.boundElements?.filter(
        (bound) => bound.type === "arrow" && alive.has(bound.id),
      );
    if (element.isDeleted || !arrows?.length) {
      return element;
    }
    const bindings = new Map(
      [...(element.boundElements ?? []), ...arrows].map((bound) => [
        bound.id,
        bound,
      ]),
    );
    return newElementWith(element, { boundElements: [...bindings.values()] });
  });
  const removed = elements.filter(
    (element) => !element.isDeleted && !alive.has(element.id),
  );
  fixBindingsAfterDeletion(next, removed);
  return next;
};

/** Builds on detached elements so a rejected batch cannot mutate the live scene. */
export const prepareCanvasOperations = (
  current: readonly ExcalidrawElement[],
  operations: unknown,
  appState: AppState,
  options: { files?: BinaryFiles; subscenes?: SubcanvasScenes } = {},
) => {
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 500
  ) {
    invalid("operations must contain 1–500 operations.");
  }
  const next: ExcalidrawElement[] = JSON.parse(JSON.stringify(current));
  const files: BinaryFiles = { ...(options.files ?? {}) };
  let subscenes: SubcanvasScenes = JSON.parse(
    JSON.stringify(options.subscenes ?? appState.subscenes ?? {}),
  );
  const statePatch: Partial<AppState> = {};
  const existing = new Map(next.map((element) => [element.id, element]));
  const idMap: Record<string, string> = Object.create(null);
  const creates: {
    operation: Record<string, unknown>;
    skeleton: Record<string, unknown>;
  }[] = [];
  const ids = new Set(existing.keys());
  let generatedBudget = 0;
  let imageBytes = 0;
  for (const value of operations as unknown[]) {
    const operation = objectArgument(value);
    const allowed: Record<string, string[]> = {
      create: ["type", "tempId", "element"],
      patch: ["type", "id", "patch"],
      delete: ["type", "id"],
      table: ["type", "id", "cells", "rows", "columns", "merge", "split"],
      group: ["type", "ids"],
      ungroup: ["type", "ids"],
      lock: ["type", "ids", "locked"],
      order: ["type", "ids", "position"],
      frame: ["type", "ids", "frameId"],
      canvas: ["type", "patch"],
      subcanvas: ["type", "id", "title"],
    };
    if (!allowed[String(operation.type)]) {
      invalid("Unsupported operation type.");
    }
    onlyKeys(operation, allowed[String(operation.type)], invalid);
    if (operation.type === "create") {
      const element = objectArgument(operation.element);
      if (!basicTypes.has(String(element.type))) {
        invalid("Unsupported element type.");
      }
      const { type, label, start, end, file, rows, columns, cells, ...fields } =
        element;
      if (type === "table") {
        if (rows === undefined || columns === undefined) {
          invalid("Tables require row and column sizes.");
        }
        createTableDataArgument({ rows, columns, cells, ...fields }, invalid);
      } else if (
        rows !== undefined ||
        columns !== undefined ||
        cells !== undefined
      ) {
        invalid("Only tables support rows, columns, and cells.");
      }
      validateFields(String(type), fields);
      if (type === "text") {
        normalizeTextFields(fields, invalid);
      }
      if (file !== undefined) {
        if (type !== "image" || fields.fileId !== undefined) {
          invalid("Only an image without fileId can supply file data.");
        }
        const asset = imageFileArgument(file, files, invalid);
        if (!files[asset.id]) {
          imageBytes += asset.dataURL.length;
          if (imageBytes > 2 * 1024 * 1024) {
            invalid("New image data cannot exceed 2 MiB per batch.");
          }
          files[asset.id] = asset;
        }
        fields.fileId = asset.id;
      }
      if (
        type === "image" &&
        (typeof fields.fileId !== "string" ||
          !Object.hasOwn(files, fields.fileId))
      ) {
        invalid("Images require file data or an existing fileId.");
      }
      if (type === "image") {
        fields.status = "saved";
      }
      if (
        type === "frame" &&
        fields.angle !== undefined &&
        fields.angle !== 0
      ) {
        invalid("Frame rotation is not supported.");
      }
      generatedBudget +=
        type === "table"
          ? 1 + (rows as unknown[]).length * (columns as unknown[]).length * 2
          : 6;
      if (generatedBudget > 10000) {
        invalid("A batch may generate at most 10000 elements.");
      }
      if (type === "freedraw") {
        if (!Array.isArray(fields.points)) {
          invalid("Freehand elements require points.");
        }
        if (
          fields.pressures !== undefined &&
          (fields.pressures as unknown[]).length !==
            (fields.points as unknown[]).length
        ) {
          invalid("pressures must match the number of points.");
        }
        fields.simulatePressure ??= fields.pressures === undefined;
        fields.pressures ??= [];
        Object.assign(fields, getSizeFromPoints(fields.points as any));
      }
      if (typeof fields.x !== "number" || typeof fields.y !== "number") {
        invalid("Created elements require x and y.");
      }
      if (type === "text" && typeof fields.text !== "string") {
        invalid("Text elements require text.");
      }
      const id = randomId();
      ids.add(id);
      if (operation.tempId !== undefined) {
        const tempId = stringArgument(operation.tempId, "tempId");
        if (Object.hasOwn(idMap, tempId) || existing.has(tempId)) {
          invalid("tempId must be unique and cannot shadow an element ID.");
        }
        idMap[tempId] = id;
      }
      const skeleton: Record<string, unknown> = {
        roundness: defaultRoundness(String(type)),
        ...fields,
        type,
        id,
        ...(type === "table" ? { rows, columns, cells } : {}),
      };
      if (
        type === "text" &&
        fields.width !== undefined &&
        Number(fields.width) <= 0
      ) {
        invalid("Text width must be positive.");
      }
      if (label !== undefined) {
        if (
          !["rectangle", "ellipse", "diamond", "arrow", "stickynote"].includes(
            String(type),
          )
        ) {
          invalid("This element cannot have a label.");
        }
        const labelFields = { ...objectArgument(label) };
        validateFields("text", labelFields);
        normalizeTextFields(labelFields, invalid);
        if (typeof labelFields.text !== "string") {
          invalid("A label requires text.");
        }
        skeleton.label = labelFields;
      }
      if (start !== undefined || end !== undefined) {
        if (type !== "arrow") {
          invalid("Only arrows support bound endpoints.");
        }
        if (start !== undefined) {
          skeleton.start = objectArgument(start);
        }
        if (end !== undefined) {
          skeleton.end = objectArgument(end);
        }
      }
      creates.push({ operation, skeleton });
    }
  }
  const deferred: {
    arrowId: string;
    end: "start" | "end";
    targetId: string;
  }[] = [];
  const skeletons = creates.map(({ skeleton }) => {
    for (const end of ["start", "end"] as const) {
      if (!skeleton[end]) {
        continue;
      }
      const endpoint = objectArgument(skeleton[end]);
      if (endpoint.id !== undefined) {
        if (Object.keys(endpoint).some((key) => key !== "id")) {
          invalid("An endpoint reference accepts only id.");
        }
        const reference = stringArgument(endpoint.id, `${end}.id`);
        const targetId = idMap[reference] ?? reference;
        if (!ids.has(targetId)) {
          invalid(`Unknown endpoint ${reference}.`);
        }
        deferred.push({ arrowId: String(skeleton.id), end, targetId });
        delete skeleton[end];
      } else {
        const { type, ...fields } = endpoint;
        if (
          !["rectangle", "ellipse", "diamond", "text"].includes(String(type))
        ) {
          invalid("Unsupported endpoint type.");
        }
        validateFields(String(type), fields);
        if (type === "text") {
          normalizeTextFields(fields, invalid);
        }
        if (type === "text" && typeof fields.text !== "string") {
          invalid("A text endpoint requires text.");
        }
        skeleton[end] = {
          roundness: defaultRoundness(String(type)),
          type,
          ...fields,
        };
      }
    }
    return skeleton as unknown as ExcalidrawElementSkeleton;
  });
  const generated = skeletons.flatMap((value) => {
    const skeleton = value as unknown as Record<string, unknown>;
    if (skeleton.type === "table") {
      const { rows, columns, cells, type, id, ...fields } = skeleton;
      const table = createTableElements(
        createTableDataArgument({ rows, columns, cells, ...fields }, invalid),
        Number(fields.x),
        Number(fields.y),
        {
          roughness: Number(fields.roughness ?? 1),
          opacity: Number(fields.opacity ?? 100),
        },
      );
      const root = {
        ...table.root,
        ...fields,
        id: String(id),
      } as typeof table.root;
      // Native table layout owns cell geometry and bindings.
      return updateCanvasTableElements(
        [root, ...table.elements.slice(1)],
        root,
        (data) => data,
      );
    }
    if (skeleton.type === "frame") {
      return [
        newFrameElement({
          ...skeleton,
          x: Number(skeleton.x),
          y: Number(skeleton.y),
          width: Number(skeleton.width ?? 640),
          height: Number(skeleton.height ?? 480),
        } as any),
      ];
    }
    const isSubcanvas = skeleton.type === "subcanvas";
    const { title, ...fields } = skeleton;
    const elements = convertToExcalidrawElements(
      [
        {
          ...fields,
          ...(isSubcanvas ? { type: "stickynote" } : {}),
        } as unknown as ExcalidrawElementSkeleton,
      ],
      { regenerateIds: false },
    );
    if (isSubcanvas) {
      const converted = convertStickyNoteToSubcanvas(
        elements,
        String(skeleton.id),
        subscenes,
        typeof title === "string" ? title : "子画布",
      );
      if (!converted) {
        return invalid("Unable to create subcanvas container.");
      }
      subscenes = converted.scenes;
      return converted.elements;
    }
    return elements;
  });
  next.push(...generated);
  const scene = new Scene(syncInvalidIndices(next), { skipValidation: true });
  try {
    const find = (id: unknown, allowLocked = false) => {
      const reference = stringArgument(id, "id");
      const element = scene.getElement(idMap[reference] ?? reference);
      if (!element || element.isDeleted) {
        return invalid(`Unknown or deleted element ${reference}.`);
      }
      const pending = [element];
      const checked = new Set<string>();
      while (pending.length) {
        const related = pending.pop()!;
        if (checked.has(related.id)) {
          continue;
        }
        checked.add(related.id);
        if (!allowLocked || !related.locked) {
          assertWritable(related);
        } else if (!basicTypes.has(related.type)) {
          invalid("Unsupported locked element type.");
        }
        const relatedIds = [
          ...(related.boundElements?.map(({ id }) => id) ?? []),
          ...(isTextElement(related) && related.containerId
            ? [related.containerId]
            : []),
          ...(isArrowElement(related)
            ? [
                related.startBinding?.elementId,
                related.endBinding?.elementId,
              ].filter((id): id is string => !!id)
            : []),
        ];
        for (const relatedId of relatedIds) {
          const next = scene.getElement(relatedId);
          if (next && !next.isDeleted) {
            pending.push(next);
          }
        }
      }
      return element;
    };
    const replace = (elements: readonly ExcalidrawElement[]) =>
      scene.replaceAllElements(elements, { skipValidation: true });
    const replaceUpdates = (updates: Map<string, ExcalidrawElement>) =>
      replace(
        scene
          .getElementsIncludingDeleted()
          .map((element) => updates.get(element.id) ?? element),
      );
    const family = (element: ExcalidrawElement) => {
      const all = scene.getNonDeletedElements();
      const root = getTableRoot(element, all);
      const members = root
        ? all.filter(
            (item) =>
              item.id === root.id ||
              (isTableElement(item) && item.groupIds[0] === root.groupIds[0]),
          )
        : element.type === "frame"
        ? [element, ...all.filter((item) => item.frameId === element.id)]
        : [element];
      const ids = new Set(members.map((item) => item.id));
      for (const item of [...members]) {
        const label = getBoundTextElement(
          item,
          scene.getNonDeletedElementsMap(),
        );
        if (label) {
          ids.add(label.id);
        }
        if (isTextElement(item) && item.containerId) {
          ids.add(item.containerId);
        }
      }
      return all.filter((item) => ids.has(item.id));
    };
    const select = (ids: unknown, allowLocked = false) => {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 500 ||
        new Set(ids).size !== ids.length
      ) {
        return invalid("ids must contain 1–500 unique element IDs.");
      }
      const elements = new Map<string, ExcalidrawElement>();
      const pending = ids.map((id) => find(id, allowLocked));
      while (pending.length) {
        const element = pending.pop()!;
        if (elements.has(element.id)) {
          continue;
        }
        const groupId = element.groupIds[element.groupIds.length - 1];
        const grouped = groupId
          ? scene
              .getNonDeletedElements()
              .filter((item) => item.groupIds.includes(groupId))
          : [];
        for (const member of [...family(element), ...grouped]) {
          find(member.id, allowLocked);
          if (!elements.has(member.id)) {
            elements.set(member.id, member);
            for (const relative of family(member)) {
              if (!elements.has(relative.id)) {
                pending.push(relative);
              }
            }
          }
        }
      }
      return [...elements.values()];
    };
    for (const binding of deferred) {
      const arrow = find(binding.arrowId);
      const target = find(binding.targetId);
      if (
        !isArrowElement(arrow) ||
        !isBindableElement(target) ||
        (isTableElement(target) && !isTableRoot(target))
      ) {
        invalid("Invalid arrow binding target.");
      }
      bindBindingElement(
        arrow as any,
        target as any,
        "orbit",
        binding.end,
        scene,
        appState.zoom,
      );
    }
    for (const { skeleton } of creates) {
      if (skeleton.type !== "text" || skeleton.width === undefined) {
        continue;
      }
      const element = find(skeleton.id);
      if (!isTextElement(element)) {
        continue;
      }
      const text = newElementWith(element, {
        width: Number(skeleton.width),
        autoResize: false,
      });
      scene.replaceAllElements(
        scene
          .getElementsIncludingDeleted()
          .map((item) => (item.id === text.id ? text : item)),
        { skipValidation: true },
      );
      redrawTextBoundingBox(text, null, scene);
    }
    for (const value of operations as unknown[]) {
      const operation = objectArgument(value);
      if (operation.type === "create") {
        continue;
      }
      if (operation.type === "canvas") {
        const patch = objectArgument(operation.patch);
        onlyKeys(patch, CANVAS_CAPABILITIES.operations.canvas.fields, invalid);
        if (!Object.keys(patch).length) {
          invalid("A canvas patch cannot be empty.");
        }
        for (const [key, value] of Object.entries(patch)) {
          if (key === "viewBackgroundColor") {
            stringArgument(value, key);
          } else if (key === "gridSize") {
            finite(value, key, 1, 1000, invalid, true);
          } else if (typeof value !== "boolean") {
            invalid(`${key} must be boolean.`);
          }
        }
        Object.assign(statePatch, patch);
        continue;
      }
      if (
        ["group", "ungroup", "lock", "order", "frame"].includes(
          String(operation.type),
        )
      ) {
        const selected = select(operation.ids, operation.type === "lock");
        const selectedIds = new Set(selected.map((element) => element.id));
        if (operation.type === "lock") {
          if (typeof operation.locked !== "boolean") {
            invalid("locked must be boolean.");
          }
          replaceUpdates(
            new Map(
              selected.map((element) => [
                element.id,
                newElementWith(element, {
                  locked: operation.locked as boolean,
                }),
              ]),
            ),
          );
        } else if (operation.type === "group") {
          if (
            selected.length < 2 ||
            selected.some((element) => element.type === "frame")
          ) {
            invalid(
              "Grouping requires at least two elements and cannot include frames.",
            );
          }
          const frameIds = new Set(selected.map((element) => element.frameId));
          if (frameIds.size !== 1) {
            invalid("Grouped elements must belong to the same frame.");
          }
          const groupId = randomId();
          replaceUpdates(
            new Map(
              selected.map((element) => [
                element.id,
                newElementWith(element, {
                  groupIds: [...element.groupIds, groupId],
                }),
              ]),
            ),
          );
        } else if (operation.type === "ungroup") {
          const groupIds = new Set(
            selected.flatMap((element) => {
              const groups = element.groupIds;
              const nativeTable = getTableRoot(
                element,
                scene.getNonDeletedElements(),
              );
              return groups.length && (!nativeTable || groups.length > 1)
                ? [groups[groups.length - 1]]
                : [];
            }),
          );
          const updates = new Map<string, ExcalidrawElement>();
          for (const element of scene.getNonDeletedElements()) {
            if (element.groupIds.some((id) => groupIds.has(id))) {
              find(element.id);
              updates.set(
                element.id,
                newElementWith(element, {
                  groupIds: element.groupIds.filter((id) => !groupIds.has(id)),
                }),
              );
            }
          }
          replaceUpdates(updates);
        } else if (operation.type === "frame") {
          const frame =
            operation.frameId === null ? null : find(operation.frameId);
          if (frame && frame.type !== "frame") {
            invalid("frameId must reference a frame.");
          }
          if (selected.some((element) => element.type === "frame")) {
            invalid("Frames cannot be nested.");
          }
          replaceUpdates(
            new Map(
              selected.map((element) => [
                element.id,
                newElementWith(element, { frameId: frame?.id ?? null }),
              ]),
            ),
          );
          // Native stacking expects frame contents immediately before the frame.
          if (frame) {
            const all = scene.getElementsIncludingDeleted();
            const children = all.filter(
              (element) => element.frameId === frame.id,
            );
            replace(
              syncInvalidIndices(
                all
                  .filter((element) => element.frameId !== frame.id)
                  .flatMap((element) =>
                    element.id === frame.id
                      ? [...children, element]
                      : [element],
                  ),
              ),
            );
          }
        } else {
          const state = {
            ...appState,
            selectedElementIds: Object.fromEntries(
              [...selectedIds].map((id) => [id, true as const]),
            ),
            selectedGroupIds: {},
            editingGroupId: null,
          };
          const all = scene.getElementsIncludingDeleted();
          switch (operation.position) {
            case "front":
              replace(moveAllRight(all, state));
              break;
            case "back":
              replace(moveAllLeft(all, state));
              break;
            case "forward":
              replace(moveOneRight(all, state, scene));
              break;
            case "backward":
              replace(moveOneLeft(all, state, scene));
              break;
            default:
              invalid("Invalid order position.");
          }
        }
        continue;
      }
      const element = find(operation.id);
      if (operation.type === "subcanvas") {
        const sceneId = getSubcanvasId(element);
        if (!sceneId || !Object.hasOwn(subscenes, sceneId)) {
          invalid("The target is not a reachable subcanvas container.");
        }
        const title = stringArgument(operation.title, "title");
        subscenes[sceneId!] = { ...subscenes[sceneId!], title };
        replaceUpdates(
          new Map([
            [
              element.id,
              newElementWith(element, {
                customData: {
                  ...element.customData,
                  subcanvas: { ...element.customData?.subcanvas, title },
                },
              }),
            ],
          ]),
        );
        continue;
      }
      if (operation.type === "table") {
        if (!isTableRoot(element)) {
          invalid("Table operations require the table root ID.");
        }
        for (const member of family(element)) {
          find(member.id);
        }
        if (
          !["cells", "rows", "columns", "merge", "split"].some(
            (key) => operation[key] !== undefined,
          )
        ) {
          invalid("A table operation requires an update.");
        }
        replace(
          updateCanvasTableElements(
            scene.getElementsIncludingDeleted(),
            element as any,
            (data) => {
              let next = updateTableData(data, operation, invalid);
              if (operation.merge !== undefined) {
                const range = tableRangeArgument(
                  operation.merge,
                  next,
                  invalid,
                );
                if (!canMergeTableCells(next, range)) {
                  invalid(
                    "Merge range must fully contain existing merged cells.",
                  );
                }
                next = mergeTableCells(next, range);
              }
              if (operation.split !== undefined) {
                next = splitTableCells(
                  next,
                  tableRangeArgument(operation.split, next, invalid),
                );
              }
              return next;
            },
          ),
        );
        for (const member of family(scene.getElement(element.id)!)) {
          if (member.boundElements?.some((bound) => bound.type === "arrow")) {
            updateBindings(member as any, scene, appState);
          }
        }
        continue;
      }
      if (isTableElement(element) && !isTableRoot(element)) {
        invalid("Address table cells through a table operation on their root.");
      }
      if (operation.type === "delete") {
        const removed = isTableRoot(element)
          ? family(element)
          : [
              element,
              ...family(element).filter(
                (item) =>
                  isTextElement(item) && item.containerId === element.id,
              ),
            ];
        for (const item of removed) {
          find(item.id);
        }
        const updates = new Map(
          removed.map((item) => [
            item.id,
            newElementWith(item, { isDeleted: true }),
          ]),
        );
        if (element.type === "frame") {
          for (const item of family(element)) {
            if (item.id !== element.id) {
              find(item.id);
              updates.set(item.id, newElementWith(item, { frameId: null }));
            }
          }
        }
        replaceUpdates(updates);
        fixBindingsAfterDeletion(scene.getElementsIncludingDeleted(), removed);
      } else {
        const patch = { ...objectArgument(operation.patch) };
        validateFields(element.type, patch, true);
        if (!Object.keys(patch).length) {
          invalid("An element patch cannot be empty.");
        }
        if (isTextElement(element)) {
          normalizeTextFields(patch, invalid, true);
          if (patch.text !== undefined) {
            patch.originalText = patch.text;
          }
        }
        if (
          element.type === "image" &&
          patch.fileId !== undefined &&
          !Object.hasOwn(files, String(patch.fileId))
        ) {
          invalid("Unknown image fileId.");
        }
        if (element.type === "image" && patch.fileId !== undefined) {
          patch.status = "saved";
        }
        if (isTableRoot(element)) {
          onlyKeys(patch, ["x", "y", "angle", "opacity", "roughness"], invalid);
          for (const member of family(element)) {
            find(member.id);
          }
          const changed = newElementWith(element, patch as any);
          replaceUpdates(new Map([[changed.id, changed]]));
          replace(
            updateCanvasTableElements(
              scene.getElementsIncludingDeleted(),
              changed,
              (data) => data,
            ),
          );
          for (const member of family(scene.getElement(changed.id)!)) {
            if (member.boundElements?.some((bound) => bound.type === "arrow")) {
              updateBindings(member as any, scene, appState);
            }
          }
          continue;
        }
        if (
          isTextElement(element) &&
          patch.width !== undefined &&
          !element.containerId
        ) {
          if (Number(patch.width) <= 0) {
            invalid("Text width must be positive.");
          }
          patch.autoResize = false;
        }
        if (
          element.type === "arrow" ||
          element.type === "line" ||
          element.type === "freedraw"
        ) {
          if (
            patch.points === undefined &&
            (patch.width !== undefined || patch.height !== undefined)
          ) {
            patch.points = element.points.map(([x, y], index) => [
              patch.width === undefined
                ? x
                : element.width
                ? (x * Number(patch.width)) / element.width
                : (index * Number(patch.width)) / (element.points.length - 1),
              patch.height === undefined
                ? y
                : element.height
                ? (y * Number(patch.height)) / element.height
                : (index * Number(patch.height)) / (element.points.length - 1),
            ]);
          }
          if (patch.points !== undefined) {
            Object.assign(patch, getSizeFromPoints(patch.points as any));
          }
          if (element.type === "freedraw") {
            const pressures = patch.pressures ?? element.pressures;
            const points = patch.points ?? element.points;
            if (
              (pressures as unknown[]).length &&
              (pressures as unknown[]).length !== (points as unknown[]).length
            ) {
              invalid("pressures must match the number of points.");
            }
          }
        }
        if (
          element.type === "frame" &&
          (patch.x !== undefined ||
            patch.y !== undefined ||
            patch.angle !== undefined)
        ) {
          if (patch.angle !== undefined && patch.angle !== element.angle) {
            invalid("Frame rotation is not supported.");
          }
          const updates = new Map<string, ExcalidrawElement>();
          for (const child of family(element)) {
            find(child.id);
            if (child.id !== element.id) {
              updates.set(
                child.id,
                newElementWith(child, {
                  x: child.x + Number(patch.x ?? element.x) - element.x,
                  y: child.y + Number(patch.y ?? element.y) - element.y,
                }),
              );
            }
          }
          replaceUpdates(updates);
        }
        const changed = newElementWith(element, patch as any);
        replaceUpdates(new Map([[changed.id, changed]]));
        if (isTextElement(changed)) {
          redrawTextBoundingBox(
            changed,
            changed.containerId
              ? scene.getElement(changed.containerId) ?? null
              : null,
            scene,
          );
        } else {
          handleBindTextResize(changed, scene, "se");
        }
        updateBindings(changed as any, scene, appState);
        if (changed.type === "frame") {
          for (const child of family(changed)) {
            if (child.id !== changed.id) {
              updateBindings(child as any, scene, appState);
            }
          }
        }
      }
    }
    return {
      elements: [...scene.getElementsIncludingDeleted()],
      idMap,
      files,
      subscenes,
      appState: statePatch,
    };
  } finally {
    scene.destroy();
  }
};
