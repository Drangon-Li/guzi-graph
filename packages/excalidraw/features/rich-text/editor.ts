import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  createEditor,
  HISTORY_PUSH_TAG,
  HISTORY_MERGE_TAG,
} from "lexical";
import { registerRichText } from "@lexical/rich-text";
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
  registerList,
} from "@lexical/list";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import {
  $patchStyleText,
  $getSelectionStyleValueForProperty,
} from "@lexical/selection";
import { applyDarkModeFilter, getFontString, THEME } from "@excalidraw/common";
import {
  bumpVersion,
  getBoundTextElementId,
  getContainerElement,
  getTextElementAngle,
  getTextElementWithAccuratePosition,
  updateBoundElements,
  getBoundTextMaxHeight,
  computeContainerDimensionForBoundText,
  isStickyNoteElement,
  isNonDeletedElement,
  isArrowElement,
  richTextFromPlainText,
  normalizeRichTextBackground,
  normalizeRichTextColor,
  richTextToPlainText,
  redrawTextBoundingBox,
} from "@excalidraw/element";

import type {
  RichTextDocument,
  RichTextParagraph,
  RichTextRun,
} from "@excalidraw/element";
import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import {
  actionDecreaseFontSize,
  actionIncreaseFontSize,
} from "../../actions/actionProperties";
import {
  actionResetZoom,
  actionZoomIn,
  actionZoomOut,
} from "../../actions/actionCanvas";

import {
  actionSaveToActiveFile,
  actionSaveFileToDisk,
} from "../../actions/actionExport";

import {
  registerRichTextEditor,
  publishRichTextSelectionState,
} from "./editorBridge";

import type {
  ElementNode,
  LexicalEditor,
  LexicalNode,
  TextNode,
  RangeSelection,
} from "lexical";

import type { RichTextCommand } from "./editorBridge";
import type { TextWysiwygOptions } from "../../wysiwyg/textWysiwyg";

export const $readRichText = (): RichTextDocument => {
  const paragraphs: RichTextParagraph[] = [];
  const runsFrom = (node: ElementNode): RichTextRun[] => {
    const runs: RichTextRun[] = [];
    const visit = (node: LexicalNode) => {
      if ($isTextNode(node)) {
        const background = normalizeRichTextBackground(
          node.getStyle().match(/background-color:\s*([^;]+)/i)?.[1],
        );
        const color = normalizeRichTextColor(
          node.getStyle().match(/(?:^|;)\s*color:\s*([^;]+)/i)?.[1],
        );
        runs.push({
          text: node.getTextContent(),
          ...(node.hasFormat("bold") && { bold: true }),
          ...(node.hasFormat("italic") && { italic: true }),
          ...(node.hasFormat("underline") && { underline: true }),
          ...(background && { background }),
          ...(color && { color }),
        });
      } else if ($isLineBreakNode(node)) {
        runs.push({ text: "\n" });
      } else if ($isElementNode(node) && !$isListNode(node)) {
        node.getChildren().forEach(visit);
      }
    };
    node.getChildren().forEach(visit);
    return runs.length ? runs : [{ text: "" }];
  };
  const visit = (node: LexicalNode, indent = 0) => {
    if ($isListNode(node)) {
      node.getChildren().forEach((child) => {
        if (!$isListItemNode(child)) {
          return;
        }
        const nested = child.getChildren().filter($isListNode);
        const runs = runsFrom(child);
        if (runs.some((run) => run.text) || !nested.length) {
          paragraphs.push({
            runs,
            list: {
              kind: node.getListType() === "number" ? "ordered" : "bullet",
              indent,
            },
          });
        }
        nested.forEach((nested) => visit(nested, indent + 1));
      });
    } else if ($isElementNode(node)) {
      paragraphs.push({ runs: runsFrom(node) });
    }
  };
  $getRoot()
    .getChildren()
    .forEach((node) => visit(node));
  return {
    version: 1,
    paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: "" }] }],
  };
};

export const $writeRichText = (
  document: RichTextDocument,
  selection?: { start: number; end: number } | null,
  selectAll = false,
) => {
  const root = $getRoot();
  root.clear();
  const textPositions: { node: TextNode; start: number; end: number }[] = [];
  const lists: { node: ListNode; kind: string; item: ListItemNode | null }[] =
    [];
  let offset = 0;
  document.paragraphs.forEach((paragraph, index) => {
    let target: ElementNode;
    if (paragraph.list) {
      const { kind } = paragraph.list;
      const indent = Math.min(paragraph.list.indent, lists.length);
      lists.length = Math.min(lists.length, indent + 1);
      if (!lists[indent] || lists[indent].kind !== kind) {
        const list = $createListNode(kind === "ordered" ? "number" : "bullet");
        if (indent > 0 && lists[indent - 1]?.item) {
          lists[indent - 1].item!.append(list);
        } else {
          root.append(list);
        }
        lists[indent] = { node: list, kind, item: null };
      }
      const item = $createListItemNode();
      lists[indent].node.append(item);
      lists[indent].item = item;
      target = item;
    } else {
      lists.length = 0;
      target = $createParagraphNode();
      root.append(target);
    }
    for (const run of paragraph.runs) {
      const text = $createTextNode(run.text);
      if (run.bold) {
        text.toggleFormat("bold");
      }
      if (run.italic) {
        text.toggleFormat("italic");
      }
      if (run.underline) {
        text.toggleFormat("underline");
      }
      if (run.background || run.color) {
        text.setStyle(
          `${run.background ? `background-color: ${run.background};` : ""}${
            run.color ? `color: ${run.color};` : ""
          }`,
        );
      }
      target.append(text);
      textPositions.push({
        node: text,
        start: offset,
        end: offset + run.text.length,
      });
      offset += run.text.length;
    }
    if (index < document.paragraphs.length - 1) {
      offset++;
    }
  });
  if (selection || selectAll) {
    const range = $createRangeSelection();
    const setPoint = (point: typeof range.anchor, value: number) => {
      const entry =
        textPositions.find((entry) => value <= entry.end) ??
        textPositions[textPositions.length - 1];
      if (entry) {
        point.set(
          entry.node.getKey(),
          Math.max(
            0,
            Math.min(entry.node.getTextContentSize(), value - entry.start),
          ),
          "text",
        );
      } else {
        point.set(root.getKey(), 0, "element");
      }
    };
    setPoint(range.anchor, selection?.start ?? 0);
    setPoint(range.focus, selection?.end ?? offset);
    $setSelection(range);
  }
};

export const $getRichTextSelectionOffsets = (selection = $getSelection()) => {
  if (!$isRangeSelection(selection)) {
    return null;
  }
  const offsetAt = (point: typeof selection.anchor) => {
    const prefix = $createRangeSelection();
    prefix.anchor.set($getRoot().getKey(), 0, "element");
    prefix.focus.set(point.key, point.offset, point.type);
    return prefix.getTextContent().length;
  };
  return { start: offsetAt(selection.anchor), end: offsetAt(selection.focus) };
};

export const applyRichTextEditorCommand = (
  editor: LexicalEditor,
  command: RichTextCommand,
) => {
  if (
    command.type === "bold" ||
    command.type === "italic" ||
    command.type === "underline"
  ) {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, command.type);
  } else if (command.type === "list") {
    editor.dispatchCommand(
      command.value === "ordered"
        ? INSERT_ORDERED_LIST_COMMAND
        : command.value === "bullet"
        ? INSERT_UNORDERED_LIST_COMMAND
        : REMOVE_LIST_COMMAND,
      undefined,
    );
  } else if (command.type === "indent") {
    editor.dispatchCommand(
      command.value === "in" ? INDENT_CONTENT_COMMAND : OUTDENT_CONTENT_COMMAND,
      undefined,
    );
  } else if (command.type === "background" || command.type === "color") {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, {
          [command.type === "background" ? "background-color" : "color"]:
            command.value,
        });
      }
    });
  }
};

export const richTextWysiwyg = ({
  element,
  app,
  excalidrawContainer,
  getViewportCoords,
  autoSelect = true,
  initialSelection,
  initialCaretSceneCoords,
  onChange,
  onSubmit,
  canvas,
}: TextWysiwygOptions) => {
  const { ownerDocument, ownerWindow } = app;
  const box = excalidrawContainer?.querySelector<HTMLDivElement>(
    ".excalidraw-textEditorContainer",
  );
  if (!box) {
    throw new Error("Text editor container is missing");
  }
  const editable = ownerDocument.createElement("div");
  editable.contentEditable = "true";
  editable.dataset.type = "wysiwyg";
  editable.className = "excalidraw-wysiwyg excalidraw-rich-text";
  editable.setAttribute("role", "textbox");
  editable.setAttribute("aria-multiline", "true");
  editable.dir = "auto";
  Object.assign(editable.style, {
    position: "absolute",
    margin: "0",
    padding: "0",
    border: "0",
    outline: "0",
    background: "transparent",
    overflow: "visible",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    pointerEvents: "auto",
    zIndex: "var(--zIndex-wysiwyg)",
  });
  const style = ownerDocument.createElement("style");
  style.textContent =
    ".excalidraw-rich-text p{margin:0;margin-bottom:var(--rich-paragraph-gap,0)}.excalidraw-rich-text p:last-child{margin-bottom:0}.excalidraw-rich-text ul,.excalidraw-rich-text ol{margin:0;padding-left:1.5em}.excalidraw-rich-text li{margin-bottom:var(--rich-paragraph-gap,0)}.excalidraw-rich-text .rich-bold{font-weight:bold}.excalidraw-rich-text .rich-italic{font-style:italic}.excalidraw-rich-text .rich-underline{text-decoration:underline;text-decoration-thickness:max(1px,.05em);text-underline-offset:max(1px,.06em);text-decoration-skip-ink:none}.excalidraw-rich-text [data-lexical-text]::selection{-webkit-text-fill-color:HighlightText}";
  box.append(style, editable);
  const editor = createEditor({
    namespace: `excalidraw-${element.id}`,
    nodes: [ListNode, ListItemNode],
    theme: {
      text: {
        bold: "rich-bold",
        italic: "rich-italic",
        underline: "rich-underline",
      },
    },
    onError: (error) => {
      throw error;
    },
  });
  editor.setRootElement(editable);
  const disposers = [
    registerRichText(editor),
    registerList(editor),
    registerHistory(editor, createEmptyHistoryState(), 300),
  ];
  let destroyed = false;
  let submitting = false;
  let lastDocument =
    element.richText ?? richTextFromPlainText(element.originalText);
  let lastSerialized = JSON.stringify(lastDocument);
  editor.update(
    () =>
      $writeRichText(
        lastDocument,
        initialSelection,
        autoSelect && !initialCaretSceneCoords,
      ),
    { discrete: true },
  );
  const initialContainer = getContainerElement(
    element,
    app.scene.getNonDeletedElementsMap(),
  );
  const initialContainerHeight = initialContainer?.height ?? 0;
  const latest = () =>
    app.scene.getElement<ExcalidrawTextElement>(element.id) ?? element;
  const updateTextColors = () => {
    editor.getEditorState().read(() => {
      for (const node of $getRoot().getAllTextNodes()) {
        const dom = editor.getElementByKey(node.getKey());
        const color = normalizeRichTextColor(
          node.getStyle().match(/(?:^|;)\s*color:\s*([^;]+)/i)?.[1],
        );
        if (dom && color && app.state.theme === THEME.DARK) {
          const displayedColor = applyDarkModeFilter(color);
          dom.style.webkitTextFillColor = displayedColor;
          dom.style.textDecorationColor = displayedColor;
        } else if (dom) {
          dom.style.webkitTextFillColor = "";
          dom.style.textDecorationColor = "";
        }
      }
    });
  };
  const updateStyle = () => {
    const current = latest();
    const container = getContainerElement(
      current,
      app.scene.getNonDeletedElementsMap(),
    );
    if (
      container &&
      isNonDeletedElement(container) &&
      !isArrowElement(container) &&
      !isStickyNoteElement(container)
    ) {
      const targetHeight = Math.max(
        initialContainerHeight,
        computeContainerDimensionForBoundText(current.height, container.type),
      );
      if (
        container.height !== targetHeight &&
        (current.height >
          getBoundTextMaxHeight(
            container,
            current as ExcalidrawTextElement & { containerId: string },
          ) ||
          container.height > initialContainerHeight)
      ) {
        app.scene.mutateElement(container, { height: targetHeight });
        redrawTextBoundingBox(current, container, app.scene);
        updateBoundElements(container, app.scene);
      }
    }
    const positioned = getTextElementWithAccuratePosition(
      current,
      app.scene.getNonDeletedElementsMap(),
    );
    const [x, y] = getViewportCoords(positioned.x, positioned.y);
    const insets = app.viewport.getSidebarInsets();
    box.style.left = `${insets.left}px`;
    box.style.right = `${insets.right}px`;
    const angle = getTextElementAngle(current, container);
    const zoom = app.state.zoom.value;
    Object.assign(editable.style, {
      font: getFontString(current),
      lineHeight: `${current.lineHeight}`,
      width: `${Math.max(1, current.width)}px`,
      minHeight: `${current.height}px`,
      left: `${x - insets.left}px`,
      top: `${y}px`,
      textAlign: current.textAlign,
      color: applyDarkModeFilter(
        current.strokeColor,
        app.state.theme === THEME.DARK,
      ),
      opacity: `${current.opacity / 100}`,
      whiteSpace: current.autoResize && !container ? "pre" : "pre-wrap",
      transformOrigin: `${current.width / 2}px ${current.height / 2}px`,
      transform: `translate(${(current.width * (zoom - 1)) / 2}px, ${
        (current.height * (zoom - 1)) / 2
      }px) scale(${zoom}) rotate(${angle}rad)`,
    });
    editable.style.setProperty(
      "--rich-paragraph-gap",
      `${(current.paragraphSpacing ?? 0) * current.fontSize}px`,
    );
    updateTextColors();
  };
  updateStyle();
  const synchronize = () => {
    if (destroyed || editor.isComposing()) {
      return;
    }
    editor.getEditorState().read(() => {
      lastDocument = $readRichText();
    });
    const serialized = JSON.stringify(lastDocument);
    if (serialized === lastSerialized) {
      return;
    }
    lastSerialized = serialized;
    const current = latest();
    app.scene.mutateElement(current, { richText: lastDocument });
    onChange?.(richTextToPlainText(lastDocument));
    const updated = latest();
    const container = getContainerElement(
      updated,
      app.scene.getNonDeletedElementsMap(),
    );
    if (container) {
      redrawTextBoundingBox(updated, container, app.scene);
    }
  };
  let savedSelection: RangeSelection | null = null;
  const publishSelection = () => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      savedSelection = selection.clone();
      const kinds = new Set(
        selection.getNodes().map((node) => {
          let parent: LexicalNode | null = node;
          while (parent && !$isListNode(parent)) {
            parent = parent.getParent();
          }
          return $isListNode(parent)
            ? parent.getListType() === "number"
              ? ("ordered" as const)
              : ("bullet" as const)
            : ("none" as const);
        }),
      );
      const background = $getSelectionStyleValueForProperty(
        selection,
        "background-color",
        "transparent",
      );
      publishRichTextSelectionState(ownerDocument, {
        elementId: element.id,
        background: background || null,
        color:
          $getSelectionStyleValueForProperty(
            selection,
            "color",
            latest().strokeColor,
          ) || null,
        hasSelection: !selection.isCollapsed(),
        list: kinds.size === 1 ? [...kinds][0] : null,
      });
    });
  };
  publishSelection();
  disposers.push(
    editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      updateTextColors();
      publishSelection();
      if (dirtyElements.size || dirtyLeaves.size) {
        synchronize();
      }
    }),
  );
  const submit = (viaKeyboard = false) => {
    if (destroyed || submitting) {
      return;
    }
    if (editor.isComposing()) {
      return;
    }
    submitting = true;
    editor.read(() => {
      lastDocument = $readRichText();
    });
    synchronize();
    const current = latest();
    const container = getContainerElement(
      current,
      app.scene.getNonDeletedElementsMap(),
    );
    if (container) {
      const text = richTextToPlainText(lastDocument);
      if (text.trim()) {
        if (!getBoundTextElementId(container)) {
          app.scene.mutateElement(container, {
            boundElements: [
              ...(container.boundElements ?? []),
              { id: element.id, type: "text" },
            ],
          });
        } else if (isArrowElement(container)) {
          bumpVersion(container);
        }
      } else {
        app.scene.mutateElement(container, {
          boundElements: container.boundElements?.filter(
            (binding) => binding.id !== element.id,
          ),
        });
      }
      redrawTextBoundingBox(current, container, app.scene);
    }
    destroyed = true;
    disposers.forEach((dispose) => dispose());
    editor.setRootElement(null);
    observer?.disconnect();
    editable.remove();
    style.remove();
    box.style.removeProperty("left");
    box.style.removeProperty("right");
    onSubmit({
      viaKeyboard,
      nextOriginalText: richTextToPlainText(lastDocument),
    });
  };
  const execute = (command: RichTextCommand) => {
    if (command.type === "layout") {
      return;
    }
    editable.focus({ preventScroll: true });
    editor.update(
      () => {
        if (!$isRangeSelection($getSelection()) && savedSelection) {
          $setSelection(savedSelection.clone());
        }
        applyRichTextEditorCommand(editor, command);
      },
      { tag: HISTORY_PUSH_TAG },
    );
  };
  disposers.push(
    registerRichTextEditor(ownerDocument, {
      elementId: element.id,
      hasTextSelection: () => !!savedSelection && !savedSelection.isCollapsed(),
      execute,
    }),
  );
  disposers.push(
    editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (event.isComposing) {
          return false;
        }
        event.preventDefault();
        editor.dispatchCommand(
          event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND,
          undefined,
        );
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    const viewportAction = [
      actionZoomIn,
      actionZoomOut,
      actionResetZoom,
      actionDecreaseFontSize,
      actionIncreaseFontSize,
    ].find((action) => action.keyTest(event));
    if (viewportAction) {
      event.preventDefault();
      event.stopPropagation();
      app.actionManager.executeAction(viewportAction);
      updateStyle();
      return;
    }
    if (
      event.key === "Escape" ||
      (event.key === "Enter" && (event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault();
      event.stopPropagation();
      submit(true);
    } else if (
      (event.metaKey || event.ctrlKey) &&
      ["b", "i", "u"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      event.stopPropagation();
      execute({
        type:
          event.key.toLowerCase() === "b"
            ? "bold"
            : event.key.toLowerCase() === "i"
            ? "italic"
            : "underline",
      });
    } else if (actionSaveToActiveFile.keyTest(event)) {
      event.preventDefault();
      event.stopPropagation();
      submit(true);
      app.actionManager.executeAction(actionSaveToActiveFile, "keyboard");
    } else if (actionSaveFileToDisk.keyTest(event)) {
      event.preventDefault();
      event.stopPropagation();
      submit(true);
      app.actionManager.executeAction(actionSaveFileToDisk, "keyboard");
    }
  };
  const stopKeyPropagation = (event: KeyboardEvent) => event.stopPropagation();
  editable.addEventListener("keydown", onKeyDown, true);
  // Lexical's bubble listener must receive editing keys before the canvas is isolated.
  editable.addEventListener("keydown", stopKeyPropagation);
  editable.addEventListener("compositionend", synchronize);
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof ownerWindow.Element) || editable.contains(target)) {
      return;
    }
    if (
      target.closest(
        ".App-menu__left, .selected-shape-actions, .properties-content, .compact-shape-actions-island, .selection-toolbar, .properties-trigger",
      )
    ) {
      return;
    }
    submit(false);
  };
  const onWindowBlur = () => submit(false);
  const onBlur = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (
      next instanceof ownerWindow.Element &&
      next.closest(
        ".selected-shape-actions, .properties-content, .compact-shape-actions-island, .selection-toolbar",
      )
    ) {
      return;
    }
    if (!next) {
      return;
    }
    submit(false);
  };
  editable.addEventListener("blur", onBlur);
  ownerWindow.addEventListener("pointerdown", onPointerDown, true);
  ownerWindow.addEventListener("blur", onWindowBlur);
  ownerWindow.addEventListener("beforeunload", onWindowBlur);
  disposers.push(() => {
    editable.removeEventListener("keydown", onKeyDown, true);
    editable.removeEventListener("keydown", stopKeyPropagation);
    editable.removeEventListener("compositionend", synchronize);
    editable.removeEventListener("blur", onBlur);
    ownerWindow.removeEventListener("pointerdown", onPointerDown, true);
    ownerWindow.removeEventListener("blur", onWindowBlur);
    ownerWindow.removeEventListener("beforeunload", onWindowBlur);
  });
  disposers.push(
    app.scene.onUpdate(() => {
      updateStyle();
      const current = latest();
      if (
        current.richText &&
        JSON.stringify(current.richText) !== lastSerialized &&
        !editor.isComposing()
      ) {
        lastDocument = current.richText;
        lastSerialized = JSON.stringify(lastDocument);
        editor.update(
          () => {
            const selection = $getSelection();
            const offsets = $getRichTextSelectionOffsets(
              $isRangeSelection(selection) ? selection : savedSelection,
            );
            $writeRichText(lastDocument, offsets);
          },
          { tag: HISTORY_MERGE_TAG },
        );
      }
    }),
  );
  disposers.push(app.onScrollChangeEmitter.on(updateStyle));
  disposers.push(app.onChangeEmitter.on(updateStyle));
  const onBoxScroll = () => {
    const x = box.scrollLeft;
    const y = box.scrollTop;
    if (!x && !y) {
      return;
    }
    box.scrollLeft = box.scrollTop = 0;
    app.viewport.translate((state) => ({
      scrollX: state.scrollX - (x && x + 5) / state.zoom.value,
      scrollY: state.scrollY - (y && y + 5) / state.zoom.value,
    }));
  };
  box.addEventListener("scroll", onBoxScroll);
  disposers.push(() => box.removeEventListener("scroll", onBoxScroll));
  const observer =
    "ResizeObserver" in ownerWindow
      ? new ownerWindow.ResizeObserver(updateStyle)
      : null;
  observer?.observe(canvas);
  editable.focus({ preventScroll: true });
  if (initialCaretSceneCoords && !initialSelection) {
    const [x, y] = getViewportCoords(
      initialCaretSceneCoords.x,
      initialCaretSceneCoords.y,
    );
    const rect = excalidrawContainer!.getBoundingClientRect();
    const document = ownerDocument as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = document.caretPositionFromPoint?.(
      x + rect.left,
      y + rect.top,
    );
    const range =
      document.caretRangeFromPoint?.(x + rect.left, y + rect.top) ??
      ownerDocument.createRange();
    if (position && editable.contains(position.offsetNode)) {
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
    if (editable.contains(range.startContainer)) {
      const selection = ownerWindow.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      editor.update(
        () => {
          const selection = $createRangeSelection();
          selection.applyDOMRange(range);
          $setSelection(selection);
        },
        { discrete: true },
      );
    }
  }
  return () => submit(false);
};
