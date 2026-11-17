import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { KEYS } from "@excalidraw/common";

import { useTunnels } from "../context/tunnels";
import { t } from "../i18n";

import { TableInsertButton } from "../features/table/TableInsertButton";
import {
  FormulaInsertButton,
  FormulaMenuItem,
} from "../features/formula/FormulaMenuItem";

import { useEditorInterface, useStylesPanelMode } from "./App";
import { HintViewer } from "./HintViewer";
import { hideTooltip, showTooltip } from "./Tooltip";
import { Island } from "./Island";
import { LockButton } from "./LockButton";
import { PenModeButton } from "./PenModeButton";
import Stack from "./Stack";
import DropdownMenu from "./dropdownMenu/DropdownMenu";
import {
  drawShapeToolIcon,
  EmbedIcon,
  frameToolIcon,
  ImageIcon,
  LassoIcon,
  laserPointerToolIcon,
  bucketFillIcon,
  MagicIcon,
  mermaidLogoIcon,
  DotsIcon,
  chevronRight,
} from "./icons";
import {
  ArrowToolButton,
  AutoshapeToolButton,
  BucketFillToolButton,
  DiamondToolButton,
  EllipseToolButton,
  EmbeddableToolButton,
  EraserToolButton,
  FrameToolButton,
  FreedrawToolPopover,
  FreedrawToolButton,
  getToolShortcut,
  HandToolButton,
  ImageToolButton,
  isToolButtonDisabled,
  LaserToolButton,
  LassoToolButton,
  LineToolButton,
  RectangleToolButton,
  SelectionToolButton,
  SelectionToolPopover,
  StickyNoteToolButton,
  TextToolButton,
} from "./Tools";

import type {
  AppClassProperties,
  AppProps,
  AppState,
  UIAppState,
} from "../types";

const ExtraToolsDropdown = ({
  app,
  activeTool,
  setAppState,
  UIOptions,
}: {
  app: AppClassProperties;
  activeTool: UIAppState["activeTool"];
  setAppState: React.Component<any, AppState>["setState"];
  UIOptions: AppProps["UIOptions"];
}) => {
  const [isExtraToolsMenuOpen, setIsExtraToolsMenuOpen] = useState(false);
  const isFullStylesPanel = useStylesPanelMode() === "full";
  const { TTDDialogTriggerTunnel } = useTunnels();

  const imageToolSelected = activeTool.type === "image";
  const frameToolSelected = activeTool.type === "frame";
  const drawShapeToolSelected = activeTool.type === "autoshape";
  const laserToolSelected = activeTool.type === "laser";
  const bucketFillToolSelected = activeTool.type === "bucketfill";
  const lassoToolSelected =
    isFullStylesPanel &&
    activeTool.type === "lasso" &&
    app.state.preferredSelectionTool.type !== "lasso";
  const embeddableToolSelected = activeTool.type === "embeddable";

  return (
    <DropdownMenu open={isExtraToolsMenuOpen}>
      <DropdownMenu.Trigger
        className={clsx("App-toolbar__extra-tools-trigger", {
          "App-toolbar__extra-tools-trigger--selected":
            imageToolSelected ||
            frameToolSelected ||
            embeddableToolSelected ||
            (isFullStylesPanel && drawShapeToolSelected) ||
            lassoToolSelected ||
            bucketFillToolSelected ||
            // in collab we're already highlighting the laser button
            // outside toolbar, so let's not highlight extra-tools button
            // on top of it
            (laserToolSelected && !app.props.isCollaborating),
        })}
        onToggle={() => {
          hideTooltip();
          setIsExtraToolsMenuOpen(!isExtraToolsMenuOpen);
          setAppState({ openMenu: null, openPopup: null });
        }}
        aria-label={t("toolBar.extraTools")}
        onPointerEnter={(event) => {
          if (app.props.desktopIntegration?.toolbarTooltips !== false) {
            showTooltip(event.currentTarget, t("toolBar.extraTools"), {
              delay: true,
            });
          }
        }}
        onPointerLeave={hideTooltip}
        onFocus={(event) => {
          if (app.props.desktopIntegration?.toolbarTooltips !== false) {
            showTooltip(event.currentTarget, t("toolBar.extraTools"));
          }
        }}
        onBlur={hideTooltip}
      >
        {imageToolSelected
          ? ImageIcon
          : frameToolSelected
          ? frameToolIcon
          : embeddableToolSelected
          ? EmbedIcon
          : isFullStylesPanel && drawShapeToolSelected
          ? drawShapeToolIcon
          : laserToolSelected && !app.props.isCollaborating
          ? laserPointerToolIcon
          : lassoToolSelected
          ? LassoIcon
          : bucketFillToolSelected
          ? bucketFillIcon
          : DotsIcon}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        onClickOutside={() => setIsExtraToolsMenuOpen(false)}
        onSelect={() => setIsExtraToolsMenuOpen(false)}
        className="App-toolbar__extra-tools-dropdown"
      >
        <FormulaMenuItem app={app} />
        {UIOptions.tools?.image !== false && (
          <DropdownMenu.Item
            onSelect={() => app.setActiveTool({ type: "image" })}
            icon={ImageIcon}
            shortcut={KEYS["9"]}
            data-testid="menu-tool-image"
            selected={imageToolSelected}
            disabled={isToolButtonDisabled(app, "image")}
          >
            {t("toolBar.image")}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "frame" })}
          icon={frameToolIcon}
          shortcut={KEYS.F.toLocaleUpperCase()}
          data-testid="menu-tool-frame"
          selected={frameToolSelected}
          disabled={isToolButtonDisabled(app, "frame")}
        >
          {t("toolBar.frame")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "embeddable" })}
          icon={EmbedIcon}
          data-testid="menu-tool-embeddable"
          selected={embeddableToolSelected}
          disabled={isToolButtonDisabled(app, "embeddable")}
        >
          {t("toolBar.embeddable")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "autoshape" })}
          icon={drawShapeToolIcon}
          shortcut={getToolShortcut("autoshape")}
          data-testid="menu-tool-autoshape"
          selected={drawShapeToolSelected}
          disabled={isToolButtonDisabled(app, "autoshape")}
        >
          {t("toolBar.autoshape")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "laser" })}
          icon={laserPointerToolIcon}
          data-testid="menu-tool-laser"
          selected={laserToolSelected}
          shortcut={KEYS.K.toLocaleUpperCase()}
          disabled={isToolButtonDisabled(app, "laser")}
        >
          {t("toolBar.laser")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onSelect={() => app.setActiveTool({ type: "bucketfill" })}
          icon={bucketFillIcon}
          data-testid="menu-tool-bucketfill"
          selected={bucketFillToolSelected}
          shortcut={KEYS.B.toLocaleUpperCase()}
          disabled={isToolButtonDisabled(app, "bucketfill")}
        >
          {t("toolBar.bucketfill")}
        </DropdownMenu.Item>
        {isFullStylesPanel && (
          <DropdownMenu.Item
            onSelect={() => app.setActiveTool({ type: "lasso" })}
            icon={LassoIcon}
            data-testid="menu-tool-lasso"
            selected={lassoToolSelected}
            disabled={isToolButtonDisabled(app, "lasso")}
          >
            {t("toolBar.lasso")}
          </DropdownMenu.Item>
        )}
        <div style={{ margin: "6px 0", fontSize: 14, fontWeight: 600 }}>
          Generate
        </div>
        {app.props.aiEnabled !== false && <TTDDialogTriggerTunnel.Out />}
        <DropdownMenu.Item
          onSelect={() => app.setOpenDialog({ name: "ttd", tab: "mermaid" })}
          icon={mermaidLogoIcon}
          data-testid="menu-mermaid"
        >
          {t("toolBar.mermaidToExcalidraw")}
        </DropdownMenu.Item>
        {app.props.aiEnabled !== false && app.plugins.diagramToCode && (
          <DropdownMenu.Item
            onSelect={() => app.onMagicframeToolSelect()}
            icon={MagicIcon}
            data-testid="toolbar-magicframe"
            badge={<DropdownMenu.Item.Badge>AI</DropdownMenu.Item.Badge>}
            disabled={isToolButtonDisabled(app, "magicframe")}
          >
            {t("toolBar.magicframe")}
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};

const ToolbarScroll = ({
  gap,
  children,
}: {
  gap: number;
  children: React.ReactNode;
}) => {
  const areaRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [directions, setDirections] = useState<
    "none" | "left" | "right" | "both"
  >("none");

  useEffect(() => {
    const area = areaRef.current!;
    const row = scrollRef.current!;
    const content = contentRef.current!;
    const ownerWindow = row.ownerDocument.defaultView!;
    const isRtl = () => ownerWindow.getComputedStyle(row).direction === "rtl";
    const updateDirections = () => {
      // Measure against the whole area, so the buttons can disappear again
      // once all tools would fit without them.
      if (content.offsetWidth <= area.clientWidth) {
        setDirections("none");
        return;
      }
      const range = row.scrollWidth - row.clientWidth;
      const offset = isRtl() ? range + row.scrollLeft : row.scrollLeft;
      const left = offset > 0.5;
      const right = offset < range - 0.5;
      setDirections(
        left ? (right ? "both" : "left") : right ? "right" : "none",
      );
    };
    const onWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.deltaX ||
        !event.deltaY ||
        row.scrollWidth <= row.clientWidth
      ) {
        return;
      }

      const { deltaMode, deltaY } = event;
      const { WheelEvent } = ownerWindow;
      const unit =
        deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? row.clientWidth
          : 1;
      const previous = row.scrollLeft;
      row.scrollLeft += (isRtl() ? -1 : 1) * unit * deltaY;
      if (row.scrollLeft !== previous) {
        event.preventDefault();
        hideTooltip();
      }
    };
    const observer =
      typeof ownerWindow.ResizeObserver === "function"
        ? new ownerWindow.ResizeObserver(updateDirections)
        : undefined;
    observer?.observe(area);
    observer?.observe(row);
    observer?.observe(content);
    updateDirections();
    row.addEventListener("scroll", updateDirections, { passive: true });
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer?.disconnect();
      row.removeEventListener("scroll", updateDirections);
      row.removeEventListener("wheel", onWheel);
    };
  }, []);

  const scroll = (direction: -1 | 1) => {
    const row = scrollRef.current!;
    const ownerWindow = row.ownerDocument.defaultView!;
    const reducedMotion = ownerWindow.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row.scrollBy({
      left: direction * row.clientWidth * 0.8,
      behavior: reducedMotion ? "instant" : "smooth",
    });
  };

  return (
    <div
      className={clsx("App-toolbar__scroll-area", {
        "App-toolbar__scroll-area--overflowing": directions !== "none",
      })}
      ref={areaRef}
    >
      {directions !== "none" && (
        <button
          className="App-toolbar__scroll-arrow App-toolbar__scroll-arrow--left"
          type="button"
          aria-label={t("toolBar.scrollToolsLeft")}
          disabled={directions === "right"}
          onClick={() => scroll(-1)}
        >
          {chevronRight}
        </button>
      )}
      <div className="App-toolbar__scroll" ref={scrollRef}>
        <Stack.Row className="App-toolbar__buttons" gap={gap} ref={contentRef}>
          {children}
        </Stack.Row>
      </div>
      {directions !== "none" && (
        <button
          className="App-toolbar__scroll-arrow App-toolbar__scroll-arrow--right"
          type="button"
          aria-label={t("toolBar.scrollToolsRight")}
          disabled={directions === "left"}
          onClick={() => scroll(1)}
        >
          {chevronRight}
        </button>
      )}
    </div>
  );
};

/** the main (desktop/tablet) toolbar island */
export const Toolbar = ({
  app,
  appState,
  setAppState,
  UIOptions,
  onPenModeToggle,
  onLockToggle,
  heading,
}: {
  app: AppClassProperties;
  appState: UIAppState;
  setAppState: React.Component<any, AppState>["setState"];
  UIOptions: AppProps["UIOptions"];
  onPenModeToggle: AppClassProperties["togglePenMode"];
  onLockToggle: () => void;
  heading: React.ReactNode;
}) => {
  const editorInterface = useEditorInterface();
  const isCompactStylesPanel = useStylesPanelMode() === "compact";

  const activeTool = appState.activeTool;
  const toolProps = { app, activeTool };

  return (
    <Island
      padding={1}
      className={clsx("App-toolbar App-toolbar--scrollable", {
        "zen-mode": appState.zenModeEnabled,
        "App-toolbar--compact": isCompactStylesPanel,
      })}
      data-viewport-ui="top"
    >
      <HintViewer
        appState={appState}
        isMobile={editorInterface.formFactor === "phone"}
        editorInterface={editorInterface}
        app={app}
      />
      {heading}
      <ToolbarScroll gap={isCompactStylesPanel ? 0.5 : 1}>
        {/* in compact UI the pen mode button is rendered as a separate
            floating button below the compact actions menu */}
        {!isCompactStylesPanel && (
          <PenModeButton
            checked={appState.penMode}
            onChange={() => onPenModeToggle(null)}
            title={t("toolBar.penMode")}
            penDetected={appState.penDetected}
          />
        )}
        {app.props.activeTool == null && (
          <>
            <LockButton
              checked={appState.activeTool.locked}
              onChange={onLockToggle}
              title={t("toolBar.lock")}
              // the active tool — including its lock state — is host-controlled
              disabled={app.props.activeTool != null}
            />

            <div
              className="App-toolbar__divider"
              style={{ marginRight: "0.25rem" }}
            />
          </>
        )}

        <HandToolButton {...toolProps} hideKeyBinding />
        {isCompactStylesPanel ? (
          <SelectionToolPopover {...toolProps} setAppState={setAppState} />
        ) : appState.preferredSelectionTool.type === "lasso" ? (
          <LassoToolButton {...toolProps} />
        ) : (
          <SelectionToolButton {...toolProps} />
        )}
        <RectangleToolButton {...toolProps} />
        <DiamondToolButton {...toolProps} />
        <EllipseToolButton {...toolProps} />
        <ArrowToolButton {...toolProps} />
        <LineToolButton {...toolProps} />
        {isCompactStylesPanel ? (
          <FreedrawToolPopover {...toolProps} />
        ) : (
          <FreedrawToolButton {...toolProps} />
        )}
        <TextToolButton {...toolProps} />
        <FormulaInsertButton app={app} />
        <StickyNoteToolButton {...toolProps} />
        <TableInsertButton app={app} />
        <EraserToolButton {...toolProps} />
        <div className="App-toolbar__divider" />
        {UIOptions.tools?.image !== false && <ImageToolButton {...toolProps} />}
        <FrameToolButton {...toolProps} />
        <EmbeddableToolButton {...toolProps} />
        <AutoshapeToolButton {...toolProps} />
        <BucketFillToolButton {...toolProps} />
        {!app.props.isCollaborating && <LaserToolButton {...toolProps} />}
        {(isCompactStylesPanel ||
          appState.preferredSelectionTool.type !== "lasso") && (
          <LassoToolButton {...toolProps} hideShortcut />
        )}
      </ToolbarScroll>
      <div className="App-toolbar__divider App-toolbar__divider--end" />
      <ExtraToolsDropdown
        app={app}
        activeTool={activeTool}
        setAppState={setAppState}
        UIOptions={UIOptions}
      />
    </Island>
  );
};
