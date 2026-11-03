import { flushSync } from "react-dom";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";
import { collectSubcanvasScenes } from "@excalidraw/excalidraw/subcanvas";
import { getNormalizedZoom } from "@excalidraw/excalidraw/scene/normalize";
import { getNonDeletedElements } from "@excalidraw/element";
import {
  exportScene,
  getExportConfigFromAppState,
} from "@excalidraw/excalidraw/scene/export";

import { fileTitle } from "../../shared/model/document";
import {
  CanvasCommandError,
  CANVAS_CAPABILITIES,
  canvasExportDimensions,
  isCanvasBusy,
  loadCanvasOperationFonts,
  objectArgument,
  prepareCanvasOperations,
  stringArgument,
} from "../plugins/canvasCommands";
import { stringDigest } from "../../shared/model/hash";
import {
  copyPresentationScene,
  getSlideBounds,
  serializePresentation,
} from "../presentation/model";
import {
  renderSlideSvg,
  renderSlidePng,
  renderPresentationPdfPages,
} from "../presentation/renderSlide";

import { apiSnapshot } from "./editorSnapshot";

import type { Presentation } from "../presentation/model";
import type { PresentationControlCommand } from "../presentation/control";
import type { SceneSnapshot } from "../../shared/model/document";
import type { PluginRequest } from "../../../shared/plugins";
import type { CanvasDocument } from "./types";
import type { WorkspaceState } from "./state";
import type { DocumentActions } from "./documents";
import type { PresentationActions } from "./presentationActions";
import type { CloseActions } from "./closeActions";

/**
 * MCP/plugin command bridge: validates requests, runs canvas and
 * presentation commands and keeps idempotent request history.
 */
export const createPluginRequestActions = (
  workspace: WorkspaceState,
  {
    activate,
    createDocument,
    openDocuments,
    recordContent,
    captureAPI,
    saveDocument,
  }: DocumentActions,
  {
    newPresentation,
    selectSlide,
    changeSlides,
    addSlide,
    deleteSlide,
    renameSlide,
    moveSlide,
  }: PresentationActions,
  { detachDocument }: CloseActions,
) => {
  const {
    isModalOpen,
    ownerDocument,
    ownerWindow,
    desktop,
    documentsRef,
    activeRef,
    readyRef,
    closingRef,
    removalVersion,
    pluginRequests,
    pluginDisposed,
    pluginPending,
    pluginWrites,
    refresh,
    closePrompt,
  } = workspace;

  const canvasDescriptor = (document: CanvasDocument) => ({
    documentId: document.id,
    path: document.path,
    title: document.title,
    revision: document.revision,
    dirty: document.dirty,
    initialized: document.initialized,
    kind: document.presentation ? "presentation" : "canvas",
  });

  const commandDocument = (value: unknown) => {
    const id = stringArgument(value, "documentId");
    const document = documentsRef.current.find((item) => item.id === id);
    if (!document) {
      throw new CanvasCommandError("NOT_FOUND", "Canvas document is not open.");
    }
    if (!document.initialized || !document.api || document.api.isDestroyed) {
      throw new CanvasCommandError("NOT_READY", "Canvas is not initialized.");
    }
    return document;
  };

  const assertCommandAvailable = (
    document?: CanvasDocument,
    allowPresenting = false,
  ) => {
    if (pluginDisposed.current) {
      throw new CanvasCommandError("CANCELLED", "Workspace was closed.");
    }
    if (
      !readyRef.current ||
      closingRef.current ||
      isModalOpen() ||
      closePrompt ||
      document?.removalPhase ||
      (!allowPresenting && document?.presenting) ||
      (document &&
        document.activeEditor &&
        document.activeEditor() !== document.api)
    ) {
      throw new CanvasCommandError(
        "BUSY",
        "Workspace or canvas is busy. Retry after editing finishes.",
      );
    }
    const editor =
      document?.api ??
      documentsRef.current
        .find((item) => item.id === activeRef.current)
        ?.activeEditor?.() ??
      documentsRef.current.find((item) => item.id === activeRef.current)?.api;
    if (editor && isCanvasBusy(editor.getAppState())) {
      throw new CanvasCommandError(
        "BUSY",
        "Canvas is being edited. Retry after editing finishes.",
      );
    }
  };

  const waitForCanvas = async (
    document: CanvasDocument,
    assertActive: () => void,
  ) => {
    const deadline = Date.now() + 10000;
    while (
      !document.initialized ||
      !document.api ||
      document.api.isDestroyed ||
      document.api.getAppState().isLoading
    ) {
      assertActive();
      if (pluginDisposed.current || !documentsRef.current.includes(document)) {
        throw new CanvasCommandError(
          "CANCELLED",
          "Canvas was closed before initialization.",
        );
      }
      if (Date.now() >= deadline) {
        throw new CanvasCommandError(
          "NOT_READY",
          "Canvas initialization timed out. Retry using list_canvases.",
        );
      }
      await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 25));
    }
    assertActive();
    captureAPI(document);
    return canvasDescriptor(document);
  };

  const presentationDescriptor = (document: CanvasDocument) => ({
    ...canvasDescriptor(document),
    width: document.presentation!.width,
    height: document.presentation!.height,
    activeSlideId: document.activeSlideId,
    presenting: !!document.presenting,
    slides: document.presentation!.slides.map((slide, index) => ({
      id: slide.id,
      title: slide.title,
      index,
      bounds: getSlideBounds(
        slide,
        document.presentation!.width,
        document.presentation!.height,
      ),
      elementCount:
        slide.scene.elements?.filter((element) => !element.isDeleted).length ??
        0,
    })),
  });

  const commandTitle = (value: unknown) => {
    const title = stringArgument(value, "title").trim();
    if (
      title.length > 200 ||
      // eslint-disable-next-line no-control-regex
      /[\\/\u0000-\u001f]/.test(title) ||
      title === "." ||
      title === ".."
    ) {
      throw new CanvasCommandError(
        "INVALID_ARGUMENT",
        "title must be a valid filename of at most 200 characters.",
      );
    }
    return title;
  };

  const assertRevision = (
    document: CanvasDocument,
    args: Record<string, unknown>,
  ) => {
    stringArgument(args.requestId, "requestId");
    if (
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision !== document.revision
    ) {
      throw new CanvasCommandError(
        "REVISION_CONFLICT",
        `Expected revision ${document.revision}. Read the document and retry.`,
      );
    }
  };

  const commandSnapshot = (
    document: CanvasDocument,
    args: Record<string, unknown>,
  ) => {
    const slideId =
      args.slideId === undefined
        ? document.activeSlideId
        : stringArgument(args.slideId, "slideId");
    if (args.slideId !== undefined && !document.presentation) {
      throw new CanvasCommandError(
        "INVALID_ARGUMENT",
        "slideId requires a presentation document.",
      );
    }
    const slide = document.presentation?.slides.find(
      (item) => item.id === slideId,
    );
    if (document.presentation && !slide) {
      throw new CanvasCommandError("NOT_FOUND", "Slide does not exist.");
    }
    const api = document.api!;
    const rootSnapshot: SceneSnapshot =
      !slide || slide.id === document.activeSlideId
        ? document.getSnapshot?.() ?? apiSnapshot(api)
        : {
            elements: slide.scene.elements ?? [],
            appState: {
              ...api.getAppState(),
              ...restoreAppState(slide.scene.appState, null),
            },
            files: slide.scene.files ?? {},
          };
    const subsceneId =
      args.subsceneId === undefined
        ? undefined
        : stringArgument(args.subsceneId, "subsceneId");
    const scenes = collectSubcanvasScenes(
      rootSnapshot.elements,
      rootSnapshot.appState.subscenes,
    );
    const subscene = subsceneId ? scenes[subsceneId] : undefined;
    if (subsceneId && !subscene) {
      throw new CanvasCommandError(
        "NOT_FOUND",
        "Subcanvas is not reachable from the requested canvas or slide.",
      );
    }
    const snapshot: SceneSnapshot = subscene
      ? {
          elements: subscene.elements,
          appState: {
            ...api.getAppState(),
            ...restoreAppState(
              { ...subscene.appState, subscenes: scenes },
              null,
            ),
          },
          files: rootSnapshot.files,
        }
      : rootSnapshot;
    return { slide, subsceneId, rootSnapshot, snapshot };
  };

  const blobData = async (blob: Blob) => {
    if (blob.size > 16 * 1024 * 1024) {
      throw new CanvasCommandError(
        "EXPORT_TOO_LARGE",
        "Export exceeds 16 MiB. Reduce the document size.",
      );
    }
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new ownerWindow.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(
          new CanvasCommandError("EXPORT_FAILED", "Export encoding failed."),
        );
      reader.readAsDataURL(blob);
    });
    return { data: url.slice(url.indexOf(",") + 1), mimeType: blob.type };
  };

  const runCanvasCommand = async (request: PluginRequest) => {
    const assertActive = () => {
      const pending = pluginPending.current.get(request.requestId);
      if (pluginDisposed.current || !pending || pending.cancelled) {
        throw new CanvasCommandError(
          "CANCELLED",
          "The plugin request was cancelled.",
        );
      }
      if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) {
        throw new CanvasCommandError(
          "TIMEOUT",
          "The plugin request expired before completion.",
        );
      }
    };
    const canOpen = () => {
      try {
        assertActive();
        assertCommandAvailable();
        return true;
      } catch {
        return false;
      }
    };
    assertActive();
    const args = objectArgument(request.arguments);
    if (request.command === "get_capabilities") {
      return {
        version: 2,
        maxRequestBytes: 2 * 1024 * 1024,
        plugins: {
          apiVersion: 1,
          guide: "get_plugin_development_guide",
          schema: "get_plugin_api_schema",
          activation:
            "Enable installed plugins in Market. MCP is configured in Settings.",
          runtime: "Isolated JavaScript Worker with declared permissions",
        },
        canvas: {
          ...CANVAS_CAPABILITIES,
          controls: ["undo", "redo", "select", "fit", "zoom"],
          close: "close_document (saved documents only)",
        },
        targets: {
          canvas: "documentId",
          slide: "documentId + slideId",
          subcanvas: "documentId + optional slideId + subsceneId",
        },
        presentations: {
          create: "create_presentation",
          open: "open_canvas",
          read: "read_presentation",
          save: "save_presentation",
          operations: [
            "add",
            "duplicate",
            "rename",
            "move",
            "delete",
            "select",
            "copy_from",
          ],
          playback: ["start", "next", "previous", "goto", "stop", "status"],
          export: ["png", "svg", "pdf"],
          format: "guzi-presentation",
          aspectRatio: "16:9",
        },
        defaults: {
          roughness: 1,
          strokeWidth: 2,
          fontFamily: 5,
          style: "hand-drawn unless explicitly requested otherwise",
        },
      };
    }
    if (request.command === "list_canvases") {
      documentsRef.current.forEach(captureAPI);
      const projects = await desktop.listProjects();
      assertActive();
      return {
        activeDocumentId: activeRef.current,
        canvases: documentsRef.current.map(canvasDescriptor),
        files: projects.files.map((file) => ({
          path: file.path,
          title: fileTitle(file.path),
          kind: file.path.endsWith(".guzi-presentation")
            ? "presentation"
            : "canvas",
        })),
      };
    }
    if (
      request.command === "create_canvas" ||
      request.command === "create_presentation"
    ) {
      assertCommandAvailable();
      const title = commandTitle(args.title);
      const source =
        args.sourceDocumentId === undefined
          ? undefined
          : commandDocument(args.sourceDocumentId);
      if (source) {
        assertCommandAvailable(source);
        if (source.hasPendingImages?.()) {
          await source.flushPendingImages?.();
          assertActive();
          assertCommandAvailable(source);
        }
      }
      const document =
        request.command === "create_presentation"
          ? newPresentation(source)!
          : createDocument();
      document.title = title;
      document.unsavedCopy = true;
      document.dirty = true;
      refresh();
      await waitForCanvas(document, assertActive);
      return document.presentation
        ? presentationDescriptor(document)
        : canvasDescriptor(document);
    }
    if (request.command === "open_canvas") {
      assertCommandAvailable();
      const path = stringArgument(args.path, "path");
      const file = await desktop.readFile(path);
      assertActive();
      assertCommandAvailable();
      await openDocuments([file], true, removalVersion.current, canOpen);
      assertActive();
      assertCommandAvailable();
      const document = documentsRef.current.find(
        (item) => item.path === file.path,
      );
      if (!document) {
        throw new CanvasCommandError(
          "OPEN_FAILED",
          "The requested document could not be opened.",
        );
      }
      await waitForCanvas(document, assertActive);
      return document.presentation
        ? presentationDescriptor(document)
        : canvasDescriptor(document);
    }
    const document = commandDocument(args.documentId);
    if (
      [
        "update_presentation",
        "control_presentation",
        "export_presentation",
        "export_canvas",
        "update_canvas",
      ].includes(request.command) &&
      document.hasPendingImages?.()
    ) {
      await document.flushPendingImages?.();
      await waitForCanvas(document, assertActive);
    }
    captureAPI(document);
    if (
      [
        "read_presentation",
        "update_presentation",
        "control_presentation",
        "export_presentation",
        "save_presentation",
      ].includes(request.command) &&
      !document.presentation
    ) {
      throw new CanvasCommandError(
        "UNSUPPORTED_TARGET",
        "This command requires a presentation document.",
      );
    }
    if (request.command === "read_presentation") {
      return presentationDescriptor(document);
    }
    if (request.command === "update_presentation") {
      assertCommandAvailable(document);
      assertRevision(document, args);
      const operation = objectArgument(args.operation);
      const deck = document.presentation!;
      const slideId =
        operation.slideId === undefined
          ? undefined
          : stringArgument(operation.slideId, "slideId");
      if (slideId && !deck.slides.some((slide) => slide.id === slideId)) {
        throw new CanvasCommandError("NOT_FOUND", "Slide does not exist.");
      }
      if (
        ["duplicate", "rename", "move", "delete", "select"].includes(
          String(operation.type),
        ) &&
        !slideId
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "slideId is required.",
        );
      }
      if (operation.type === "add") {
        const title =
          operation.title === undefined
            ? undefined
            : stringArgument(operation.title, "title").trim();
        const afterId =
          operation.afterSlideId === undefined
            ? undefined
            : stringArgument(operation.afterSlideId, "afterSlideId");
        if (afterId && !deck.slides.some((slide) => slide.id === afterId)) {
          throw new CanvasCommandError(
            "NOT_FOUND",
            "afterSlideId does not exist.",
          );
        }
        const insertion =
          deck.slides.findIndex(
            (slide) => slide.id === (afterId ?? document.activeSlideId),
          ) + 1;
        addSlide(document);
        if (title) {
          renameSlide(document, document.activeSlideId!, title);
        }
        moveSlide(document, document.activeSlideId!, insertion);
      } else if (operation.type === "duplicate") {
        addSlide(document, slideId);
      } else if (operation.type === "rename") {
        renameSlide(
          document,
          slideId!,
          stringArgument(operation.title, "title"),
        );
      } else if (operation.type === "move") {
        if (
          !Number.isInteger(operation.toIndex) ||
          Number(operation.toIndex) < 0 ||
          Number(operation.toIndex) >= deck.slides.length
        ) {
          throw new CanvasCommandError(
            "INVALID_ARGUMENT",
            "toIndex is outside the slide list.",
          );
        }
        moveSlide(document, slideId!, Number(operation.toIndex));
      } else if (operation.type === "delete") {
        if (deck.slides.length === 1) {
          throw new CanvasCommandError(
            "INVALID_ARGUMENT",
            "A presentation must retain at least one slide.",
          );
        }
        deleteSlide(document, slideId!);
      } else if (operation.type === "select") {
        selectSlide(document, slideId!);
      } else if (operation.type === "copy_from") {
        const source = commandDocument(operation.sourceDocumentId);
        assertCommandAvailable(source);
        captureAPI(source);
        const sourceId = stringArgument(
          operation.sourceSlideId,
          "sourceSlideId",
        );
        const slide = source.presentation?.slides.find(
          (item) => item.id === sourceId,
        );
        if (!slide) {
          throw new CanvasCommandError(
            "NOT_FOUND",
            "Source presentation slide does not exist.",
          );
        }
        const copy = {
          id: ownerWindow.crypto.randomUUID(),
          title: slide.title,
          bounds: {
            ...getSlideBounds(
              slide,
              source.presentation!.width,
              source.presentation!.height,
            ),
          },
          scene: copyPresentationScene(slide.scene),
        };
        changeSlides(
          document,
          (deck) => {
            const index = deck.slides.findIndex(
              (item) => item.id === document.activeSlideId,
            );
            deck.slides.splice(index + 1, 0, copy);
          },
          () => copy.id,
        );
      } else {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Unknown presentation operation.",
        );
      }
      await waitForCanvas(document, assertActive);
      return presentationDescriptor(document);
    }
    if (request.command === "control_presentation") {
      const action = stringArgument(args.action, "action");
      if (
        !["start", "next", "previous", "goto", "stop", "status"].includes(
          action,
        )
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Unknown playback action.",
        );
      }
      if (action !== "status" && action !== "stop") {
        assertCommandAvailable(document, true);
        if (action === "start") {
          assertCommandAvailable();
          flushSync(() => activate(document.id));
        }
      }
      if (!document.presentationController) {
        throw new CanvasCommandError(
          "NOT_READY",
          "Presentation controls are not mounted.",
        );
      }
      const state = await document.presentationController.execute({
        action: action as PresentationControlCommand["action"],
        ...(args.slideId === undefined
          ? {}
          : { slideId: stringArgument(args.slideId, "slideId") }),
      });
      assertActive();
      return { documentId: document.id, ...state };
    }
    if (
      request.command === "save_canvas" ||
      request.command === "save_presentation"
    ) {
      assertCommandAvailable(document);
      if (
        !(await saveDocument(document, false, undefined, false, true, () => {
          assertActive();
          assertCommandAvailable(document);
        }))
      ) {
        throw new CanvasCommandError(
          "SAVE_FAILED",
          "The document could not be saved.",
        );
      }
      assertActive();
      return document.presentation
        ? presentationDescriptor(document)
        : canvasDescriptor(document);
    }
    if (request.command === "export_presentation") {
      const deck: Presentation = JSON.parse(
        serializePresentation(document.presentation!),
      );
      const revision = document.revision;
      const exportSlideId =
        args.slideId === undefined
          ? document.activeSlideId
          : stringArgument(args.slideId, "slideId");
      const exportSlide = deck.slides.find(
        (slide) => slide.id === exportSlideId,
      );
      if (!exportSlide) {
        throw new CanvasCommandError("NOT_FOUND", "Slide does not exist.");
      }
      let blob: Blob;
      if (args.format === "pdf") {
        const pages = await renderPresentationPdfPages(
          args.slideId === undefined
            ? deck
            : { ...deck, slides: [exportSlide] },
          ownerDocument,
        );
        assertActive();
        const [first, ...remaining] = pages;
        const bytes = await desktop.exportPdf({
          name: document.title,
          ...first,
          ...(remaining.length ? { pages: remaining } : {}),
        });
        blob = new ownerWindow.Blob([bytes], { type: "application/pdf" });
      } else if (args.format === "png" || args.format === "svg") {
        const scale =
          args.format === "png"
            ? canvasExportDimensions(deck.width, deck.height).scale
            : 1;
        blob =
          args.format === "png"
            ? await renderSlidePng(
                {
                  ...exportSlide,
                  bounds: getSlideBounds(exportSlide, deck.width, deck.height),
                },
                deck.width * scale,
                deck.height * scale,
                ownerDocument,
              )
            : new ownerWindow.Blob(
                [
                  (
                    await renderSlideSvg(
                      exportSlide,
                      deck.width,
                      deck.height,
                      ownerDocument,
                    )
                  ).outerHTML,
                ],
                { type: "image/svg+xml" },
              );
      } else {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "format must be png, svg or pdf.",
        );
      }
      const data = await blobData(blob);
      assertActive();
      return {
        documentId: document.id,
        revision,
        ...(args.format === "pdf"
          ? { file: { ...data, name: `${document.title}.pdf` } }
          : { slideId: exportSlideId, image: data }),
      };
    }
    if (request.command === "close_document") {
      assertCommandAvailable(document);
      if (document.saving) {
        throw new CanvasCommandError(
          "BUSY",
          "Wait for the current save before closing.",
        );
      }
      if (document.dirty || !document.path) {
        throw new CanvasCommandError(
          "UNSAVED_CHANGES",
          "Save the document before closing it through MCP.",
        );
      }
      assertActive();
      flushSync(() => detachDocument(document));
      return { documentId: document.id, path: document.path, closed: true };
    }
    if (request.command === "control_canvas") {
      assertCommandAvailable(document);
      const action = stringArgument(args.action, "action");
      if (!["undo", "redo", "select", "fit", "zoom"].includes(action)) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Unknown canvas control action.",
        );
      }
      if (args.subsceneId !== undefined) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "Canvas controls do not accept subsceneId.",
        );
      }
      commandSnapshot(document, args);
      if (
        args.slideId !== undefined &&
        document.activeSlideId !== args.slideId
      ) {
        assertCommandAvailable();
        flushSync(() => {
          activate(document.id);
          selectSlide(document, String(args.slideId));
        });
        await waitForCanvas(document, assertActive);
        assertCommandAvailable(document);
        if (document.activeSlideId !== args.slideId) {
          throw new CanvasCommandError(
            "BUSY",
            "The active slide changed while its editor was initializing. Retry the command.",
          );
        }
      }
      const targetApi = document.api!;
      const elements = targetApi
        .getSceneElementsIncludingDeleted()
        .filter((element) => !element.isDeleted);
      const ids = args.ids === undefined ? undefined : args.ids;
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.some(
            (id) =>
              typeof id !== "string" ||
              !elements.some((element) => element.id === id),
          ))
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "ids must contain existing element IDs.",
        );
      }
      if (action === "select" && !Array.isArray(ids)) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "select requires ids (use [] to clear).",
        );
      }
      if (
        action === "zoom" &&
        (typeof args.zoom !== "number" ||
          !Number.isFinite(args.zoom) ||
          args.zoom < 0.1 ||
          args.zoom > 10)
      ) {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "zoom must be between 0.1 and 10.",
        );
      }
      assertActive();
      flushSync(() => {
        if (action === "undo" || action === "redo") {
          const operation = targetApi.history[action];
          if (!operation) {
            throw new CanvasCommandError(
              "UNSUPPORTED_TARGET",
              "History control is unavailable in this editor.",
            );
          }
          operation();
        } else if (action === "select") {
          targetApi.selection.select(ids as string[]);
        } else if (action === "fit") {
          const selected = ids
            ? elements.filter((element) =>
                (ids as string[]).includes(element.id),
              )
            : elements;
          const slide = document.presentation?.slides.find(
            (slide) => slide.id === document.activeSlideId,
          );
          targetApi.setViewport({
            target:
              !ids && slide
                ? getSlideBounds(
                    slide,
                    document.presentation!.width,
                    document.presentation!.height,
                  )
                : selected,
            fit: "contain",
            animation: false,
          });
        } else {
          targetApi.updateScene({
            appState: {
              ...targetApi.getAppState(),
              zoom: { value: getNormalizedZoom(Number(args.zoom)) },
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      });
      captureAPI(document);
      return {
        ...canvasDescriptor(document),
        slideId: document.activeSlideId,
        selectedElementIds: Object.keys(
          targetApi.getAppState().selectedElementIds,
        ),
        zoom: targetApi.getAppState().zoom.value,
      };
    }
    const target = commandSnapshot(document, args);
    const { snapshot } = target;
    const targetDescriptor = {
      ...canvasDescriptor(document),
      ...(target.slide ? { slideId: target.slide.id } : {}),
      ...(target.subsceneId ? { subsceneId: target.subsceneId } : {}),
    };
    if (request.command === "read_canvas") {
      return {
        ...targetDescriptor,
        elements: snapshot.elements.filter((element) => !element.isDeleted),
        appState: {
          viewBackgroundColor: snapshot.appState.viewBackgroundColor,
          gridModeEnabled: snapshot.appState.gridModeEnabled,
          gridSize: snapshot.appState.gridSize,
          objectsSnapModeEnabled: snapshot.appState.objectsSnapModeEnabled,
        },
        files: Object.values(snapshot.files).map(({ id, mimeType }) => ({
          id,
          mimeType,
        })),
        subscenes: Object.entries(
          collectSubcanvasScenes(
            snapshot.elements,
            snapshot.appState.subscenes,
          ),
        ).map(([id, scene]) => ({
          id,
          title: scene.title,
          elementCount: scene.elements.filter((element) => !element.isDeleted)
            .length,
        })),
      };
    }
    if (request.command === "apply_operations") {
      assertCommandAvailable(document);
      assertRevision(document, args);
      const preflight = prepareCanvasOperations(
        snapshot.elements,
        args.operations,
        snapshot.appState,
        { files: snapshot.files, subscenes: snapshot.appState.subscenes },
      );
      await loadCanvasOperationFonts(preflight.elements, ownerDocument);
      assertActive();
      commandDocument(args.documentId);
      assertCommandAvailable(document);
      captureAPI(document);
      assertRevision(document, args);
      const writeTarget = commandSnapshot(document, args);
      if (writeTarget.slide?.id !== target.slide?.id) {
        throw new CanvasCommandError(
          "BUSY",
          "The active slide changed while preparing the operation. Retry with an explicit slideId.",
        );
      }
      const writeSnapshot = writeTarget.snapshot;
      const prepared = prepareCanvasOperations(
        writeSnapshot.elements,
        args.operations,
        writeSnapshot.appState,
        {
          files: writeSnapshot.files,
          subscenes: writeSnapshot.appState.subscenes,
        },
      );
      const writeApi = document.api!;
      let next: SceneSnapshot = {
        elements: prepared.elements,
        files: prepared.files,
        appState: {
          ...writeSnapshot.appState,
          ...prepared.appState,
          subscenes: prepared.subscenes,
        },
      };
      if (writeTarget.subsceneId) {
        const original =
          writeTarget.rootSnapshot.appState.subscenes[writeTarget.subsceneId];
        next = {
          ...writeTarget.rootSnapshot,
          files: prepared.files,
          appState: {
            ...writeTarget.rootSnapshot.appState,
            subscenes: {
              ...prepared.subscenes,
              [writeTarget.subsceneId]: {
                ...original,
                elements: next.elements,
                appState: { ...original.appState, ...prepared.appState },
              },
            },
          },
        };
      }
      if (
        writeTarget.slide &&
        writeTarget.slide.id !== document.activeSlideId
      ) {
        writeTarget.slide.scene = next;
        document.slideRuntime?.delete(writeTarget.slide.id);
        recordContent(document, serializePresentation(document.presentation!));
      } else {
        document.invalidateSubsceneHistory?.(
          Object.keys(next.appState.subscenes),
        );
        flushSync(() => {
          const addedFiles = Object.values(next.files).filter(
            (file) => writeApi.getFiles()[file.id] !== file,
          );
          if (addedFiles.length) {
            writeApi.addFiles(addedFiles);
          }
          writeApi.updateScene({
            elements: next.elements,
            appState: {
              ...writeApi.getAppState(),
              ...(!writeTarget.subsceneId ? prepared.appState : {}),
              subscenes: next.appState.subscenes,
            },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
        });
        captureAPI(document);
      }
      return {
        ...targetDescriptor,
        revision: document.revision,
        dirty: document.dirty,
        idMap: prepared.idMap,
      };
    }
    if (request.command === "export_canvas") {
      if (args.format !== "png" && args.format !== "svg") {
        throw new CanvasCommandError(
          "INVALID_ARGUMENT",
          "format must be png or svg.",
        );
      }
      const elements = JSON.parse(
        JSON.stringify(getNonDeletedElements(snapshot.elements)),
      );
      const appState = { ...snapshot.appState, exportEmbedScene: false };
      let blob: Blob;
      if (args.format === "svg") {
        const svg = await exportScene({
          type: "svg",
          data: { elements, appState, files: snapshot.files },
          config: {
            ...getExportConfigFromAppState(appState),
            environment: { document: ownerDocument },
          },
        });
        blob = new ownerWindow.Blob([svg.outerHTML], { type: "image/svg+xml" });
      } else {
        const canvas = await exportScene({
          type: "canvas",
          data: { elements, appState, files: snapshot.files },
          config: {
            ...getExportConfigFromAppState(appState),
            scale: (width, height) =>
              canvasExportDimensions(width, height).scale,
            environment: {
              document: ownerDocument,
              createCanvas: () => ownerDocument.createElement("canvas"),
              createImage: () => new ownerWindow.Image(),
            },
          },
        });
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) =>
              result
                ? resolve(result)
                : reject(
                    new CanvasCommandError(
                      "EXPORT_FAILED",
                      "PNG encoding failed.",
                    ),
                  ),
            "image/png",
          ),
        );
      }
      const image = await blobData(blob);
      assertActive();
      return { ...targetDescriptor, image };
    }
    throw new CanvasCommandError("UNKNOWN_COMMAND", "Unknown canvas command.");
  };

  const handlePluginRequest = (request: PluginRequest) => {
    const idempotent = ["apply_operations", "update_presentation"].includes(
      request.command,
    );
    const key = idempotent
      ? `${request.command}:${String(
          request.arguments.documentId,
        )}:${stringArgument(request.arguments.requestId, "requestId")}`
      : `request:${request.requestId}`;
    // Up to 10,000 idempotent requests are remembered and their arguments may
    // embed images, so keep a digest rather than the canonical JSON itself.
    const fingerprint = stringDigest(
      JSON.stringify([request.command, request.arguments], (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    );
    const previous = pluginRequests.current.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new CanvasCommandError(
          "REQUEST_ID_CONFLICT",
          "requestId was already used with different arguments.",
        );
      }
      return previous.task;
    }
    if (idempotent && pluginRequests.current.size >= 10000) {
      throw new CanvasCommandError(
        "BUSY",
        "Idempotent request history is full. Save and close documents, then reopen them to release their history.",
      );
    }
    const write =
      ![
        "get_capabilities",
        "list_canvases",
        "read_canvas",
        "read_presentation",
        "export_canvas",
        "export_presentation",
      ].includes(request.command) &&
      !(
        request.command === "control_presentation" &&
        request.arguments.action === "status"
      );
    const writeKey = String(request.arguments.documentId ?? "workspace");
    if (write && pluginWrites.current.has(writeKey)) {
      throw new CanvasCommandError(
        "BUSY",
        "Another command is modifying this document. Retry after it completes.",
      );
    }
    if (write) {
      pluginWrites.current.add(writeKey);
    }
    const task = runCanvasCommand(request).finally(() => {
      if (write) {
        pluginWrites.current.delete(writeKey);
      }
      if (!idempotent && pluginRequests.current.get(key)?.task === task) {
        pluginRequests.current.delete(key);
      }
    });
    pluginRequests.current.set(key, {
      fingerprint,
      task,
      documentId:
        typeof request.arguments.documentId === "string"
          ? request.arguments.documentId
          : undefined,
    });
    void task.catch(() => {
      if (pluginRequests.current.get(key)?.task === task) {
        pluginRequests.current.delete(key);
      }
    });
    return task;
  };

  return {
    handlePluginRequest,
  };
};

export type PluginRequestActions = ReturnType<
  typeof createPluginRequestActions
>;
