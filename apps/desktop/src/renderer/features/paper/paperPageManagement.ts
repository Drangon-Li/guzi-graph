import { arrayToMap } from "@excalidraw/common";
import {
  getBoundTextElementId,
  getCommonBounds,
  getElementBounds,
  getNonDeletedElements,
  handleBindTextResize,
  isArrowElement,
  isBindableElement,
  LinearElementEditor,
  newElementWith,
  Scene,
  syncInvalidIndicesImmutable,
  updateBoundPoint,
} from "@excalidraw/element";
import { isCloseTo } from "@excalidraw/math";

import type { Mutable } from "@excalidraw/common/utility-types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

import {
  A4,
  createPaperPage,
  getPaperPages,
  getPaperSettings,
  isPaperRule,
  PAPER_GAP,
} from "./paper";

type PaperPage = ReturnType<typeof getPaperPages>[number];

export type PaperPageAction =
  | { type: "insert"; pageId: string }
  | { type: "move"; pageId: string; direction: -1 | 1 }
  | { type: "reorder"; pageId: string; targetId: string }
  | { type: "delete"; pageId: string; confirmed?: boolean };

const paperOwners = (
  elements: readonly NonDeletedExcalidrawElement[],
  pages: readonly PaperPage[],
) => {
  const owners = new Map<string, string | null>(
    pages.map((page) => [page.id, page.id]),
  );
  const byId = arrayToMap(elements);
  const groups = new Map<string, ExcalidrawElement[]>();
  for (const element of elements) {
    const groupId = element.groupIds.at(-1);
    if (groupId && !(element.type === "text" && element.containerId)) {
      const members = groups.get(groupId) ?? [];
      members.push(element);
      groups.set(groupId, members);
    }
  }
  const groupOwners = new Map<string, string | null>();
  const ownerAtBounds = ([left, top, right, bottom]: ReturnType<
    typeof getElementBounds
  >) => {
    let owner: string | null = null;
    for (const page of pages) {
      if (page.y > top) {
        break;
      }
      if (
        left >= page.x &&
        right <= page.x + page.width &&
        bottom <= page.y + page.height
      ) {
        if (owner) {
          return null;
        }
        owner = page.id;
      }
    }
    return owner;
  };
  const ownerOf = (element: ExcalidrawElement): string | null => {
    if (owners.has(element.id)) {
      return owners.get(element.id)!;
    }
    // Children of an unassigned frame or container must stay with their parent.
    owners.set(element.id, null);
    const parent =
      (element.type === "text" && element.containerId
        ? byId.get(element.containerId)
        : undefined) ??
      (element.frameId ? byId.get(element.frameId) : undefined);
    if (parent) {
      const owner = ownerOf(parent);
      owners.set(element.id, owner);
      return owner;
    }

    const groupId = element.groupIds.at(-1);
    const members = groupId ? groups.get(groupId) : undefined;
    if (groupId && members && !groupOwners.has(groupId)) {
      groupOwners.set(groupId, ownerAtBounds(getCommonBounds(members, byId)));
    }
    const owner =
      groupId && groupOwners.has(groupId)
        ? groupOwners.get(groupId)!
        : ownerAtBounds(getElementBounds(element, byId));
    owners.set(element.id, owner);
    return owner;
  };

  for (const element of elements) {
    ownerOf(element);
  }
  return owners;
};

const isPaperDecoration = (element: ExcalidrawElement, page: PaperPage) => {
  if (!element.locked || element.frameId !== page.id || element.angle) {
    return false;
  }
  const kind = page.customData?.guziPaper?.kind;
  if (element.type === "line" && kind === "ruled") {
    return isPaperRule(element, page);
  }
  return (
    element.x === page.x &&
    element.y === page.y &&
    element.width === page.width &&
    element.height === page.height &&
    element.type === "rectangle" &&
    element.strokeColor === "transparent" &&
    element.backgroundColor === "#ffffff"
  );
};

const removeDeletedBindings = (
  element: ExcalidrawElement,
  deleted: ReadonlySet<string>,
) => {
  const updates: Partial<
    Mutable<Pick<ExcalidrawElement, "frameId" | "boundElements">>
  > = {};
  if (element.frameId && deleted.has(element.frameId)) {
    updates.frameId = null;
  }
  if (element.boundElements?.some(({ id }) => deleted.has(id))) {
    updates.boundElements = element.boundElements.filter(
      ({ id }) => !deleted.has(id),
    );
  }
  if (isArrowElement(element)) {
    return newElementWith(element, {
      ...updates,
      ...(element.startBinding && deleted.has(element.startBinding.elementId)
        ? { startBinding: null }
        : {}),
      ...(element.endBinding && deleted.has(element.endBinding.elementId)
        ? { endBinding: null }
        : {}),
    });
  }
  return newElementWith(element, updates);
};

const updateDisplacedArrows = (
  elements: readonly ExcalidrawElement[],
  distanceFor: (id: string) => number,
) => {
  const rerouteIds = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted || !isArrowElement(element)) {
      continue;
    }
    const distance = distanceFor(element.id);
    if (
      [element.startBinding, element.endBinding].some(
        (binding) =>
          binding && !isCloseTo(distanceFor(binding.elementId), distance),
      )
    ) {
      rerouteIds.add(element.id);
      const textId = getBoundTextElementId(element);
      if (textId) {
        rerouteIds.add(textId);
      }
    }
  }

  if (rerouteIds.size === 0) {
    return elements;
  }

  // The core arrow editor mutates arrows and their bound text in place.
  const scene = new Scene(
    elements.map((element) =>
      rerouteIds.has(element.id) ? { ...element } : element,
    ),
    { skipValidation: true },
  );
  try {
    const byId = scene.getNonDeletedElementsMap();
    for (const id of rerouteIds) {
      const arrow = byId.get(id);
      if (!isArrowElement(arrow)) {
        continue;
      }
      const points = new Map<number, { point: LocalPoint }>();
      for (const edge of ["startBinding", "endBinding"] as const) {
        const binding = arrow[edge];
        const target = binding && byId.get(binding.elementId);
        if (target && isBindableElement(target)) {
          const point = updateBoundPoint(arrow, edge, binding, target, byId);
          if (point) {
            points.set(edge === "startBinding" ? 0 : arrow.points.length - 1, {
              point,
            });
          }
        }
      }
      LinearElementEditor.movePoints(arrow, scene, points, undefined, {
        isBindingEnabled: true,
      });
      handleBindTextResize(arrow, scene, false);
    }
    return scene.getElementsIncludingDeleted();
  } finally {
    scene.destroy();
  }
};

export const changePaperPages = (
  elements: readonly ExcalidrawElement[],
  action: PaperPageAction,
) => {
  const pages = getPaperPages(elements);
  const index = pages.findIndex((page) => page.id === action.pageId);
  if (index < 0 || (action.type === "delete" && pages.length < 2)) {
    return null;
  }
  const page = pages[index];
  const firstY = pages[0].y;
  const live = getNonDeletedElements(elements);
  const owners = paperOwners(live, pages);
  const deleted = new Set<string>();
  let inserted: ExcalidrawElement[] = [];
  let destination = page.id;

  if (action.type === "insert") {
    const landscape = page.width > page.height;
    inserted = createPaperPage({
      x: page.x,
      y: page.y + page.height + PAPER_GAP,
      width: landscape ? A4.height : A4.width,
      height: landscape ? A4.width : A4.height,
      name: "A4",
      settings: getPaperSettings(page),
    });
    const frame = getPaperPages(inserted)[0];
    destination = frame.id;
    pages.splice(index + 1, 0, frame);
  } else if (action.type === "delete") {
    for (const [id, owner] of owners) {
      if (owner === page.id) {
        deleted.add(id);
      }
    }
    if (
      !action.confirmed &&
      live.some(
        (element) =>
          element.id !== page.id &&
          deleted.has(element.id) &&
          !isPaperDecoration(element, page),
      )
    ) {
      return { requiresConfirmation: true } as const;
    }
    pages.splice(index, 1);
    destination = pages[Math.min(index, pages.length - 1)].id;
  } else {
    const target =
      action.type === "move"
        ? index + action.direction
        : pages.findIndex((candidate) => candidate.id === action.targetId);
    if (target < 0 || target >= pages.length || target === index) {
      return null;
    }
    pages.splice(index, 1);
    pages.splice(target, 0, page);
  }

  let y = firstY;
  const distances = new Map<string, number>();
  for (const nextPage of pages) {
    distances.set(nextPage.id, y - nextPage.y);
    y += nextPage.height + PAPER_GAP;
  }

  const pageDistanceFor = (id: string) => {
    const owner = owners.get(id);
    return owner ? distances.get(owner) ?? 0 : 0;
  };
  const sharedArrowDistances = new Map<string, number>();
  for (const element of live) {
    if (
      isArrowElement(element) &&
      owners.get(element.id) === null &&
      element.startBinding &&
      element.endBinding
    ) {
      const start = pageDistanceFor(element.startBinding.elementId);
      const end = pageDistanceFor(element.endBinding.elementId);
      if (start && isCloseTo(start, end)) {
        sharedArrowDistances.set(element.id, start);
      }
    }
  }
  for (const element of live) {
    if (element.type === "text" && element.containerId) {
      const distance = sharedArrowDistances.get(element.containerId);
      if (distance) {
        sharedArrowDistances.set(element.id, distance);
      }
    }
  }
  const distanceFor = (id: string) =>
    sharedArrowDistances.get(id) ?? pageDistanceFor(id);
  const shifted = elements.map((element) => {
    if (element.isDeleted) {
      return element;
    }
    if (deleted.has(element.id)) {
      return newElementWith(element, { isDeleted: true });
    }
    const distance = distanceFor(element.id);
    const moved = distance
      ? newElementWith(element, { y: element.y + distance })
      : element;
    return deleted.size ? removeDeletedBindings(moved, deleted) : moved;
  });
  const updated = updateDisplacedArrows(shifted, distanceFor);
  const insertDistance = distances.get(destination) ?? 0;
  const withInsertion = inserted.length
    ? [
        ...inserted.map((element) =>
          newElementWith(element, { y: element.y + insertDistance }),
        ),
        ...updated,
      ]
    : updated;
  const ordered = inserted.length && syncInvalidIndicesImmutable(withInsertion);

  return {
    requiresConfirmation: false,
    destination,
    deleted,
    unassigned: live.filter(
      (element) =>
        owners.get(element.id) === null &&
        !(element.type === "text" && element.containerId),
    ).length,
    elements: ordered ? [...ordered.values()] : withInsertion,
  } as const;
};
