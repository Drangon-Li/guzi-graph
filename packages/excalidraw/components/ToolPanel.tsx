import { useEffect, useId, useRef, useState } from "react";

import clsx from "clsx";

import { PinIcon, sidebarRightIcon } from "./icons";

import "./ToolPanel.scss";

import type { ExcalidrawProps, UIAppState } from "../types";
import type { CSSProperties, ReactNode } from "react";

type ToolPanelOptions = NonNullable<
  NonNullable<ExcalidrawProps["desktopIntegration"]>["toolPanel"]
>;

export const COLLAPSED_TOOL_PANEL_WIDTH = 0;
const MIN_TOOL_PANEL_WIDTH = 260;
const DEFAULT_TOOL_PANEL_WIDTH = 280;
const getMaxToolPanelWidth = (viewportWidth: number) =>
  Math.max(MIN_TOOL_PANEL_WIDTH, Math.min(480, viewportWidth - 600));
export const getToolPanelWidth = (width: number, viewportWidth: number) =>
  Math.max(
    MIN_TOOL_PANEL_WIDTH,
    Math.min(getMaxToolPanelWidth(viewportWidth), width),
  );

export const getToolPanelDock = (
  options: ToolPanelOptions | undefined,
  appState: UIAppState,
  isPhone: boolean,
) =>
  !options || isPhone || appState.zenModeEnabled || appState.width < 900
    ? "floating"
    : options.dock;

export const ToolPanelDockControls = ({
  options,
  onChange = options.onDockChange,
  onToggle,
  collapsed = false,
  contentId,
}: {
  options: ToolPanelOptions;
  onChange?: ToolPanelOptions["onDockChange"];
  onToggle?: () => void;
  collapsed?: boolean;
  contentId?: string;
}) => (
  <div
    className="tool-panel-dock-controls"
    role="group"
    aria-label={options.labels.title}
  >
    {(["left", "right"] as const).map((side) => {
      const active = options.dock === side;
      const togglesPanel = active && !!onToggle;
      const label = togglesPanel
        ? collapsed
          ? options.labels.expand
          : options.labels.collapse
        : side === "left"
        ? options.labels.pinLeft
        : options.labels.pinRight;
      return (
        <button
          key={side}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={active}
          aria-expanded={togglesPanel ? !collapsed : undefined}
          aria-controls={togglesPanel ? contentId : undefined}
          hidden={collapsed && !active}
          onClick={() => (togglesPanel ? onToggle() : onChange(side))}
        >
          <span
            className={side === "left" ? "tool-panel-left-icon" : undefined}
          >
            {sidebarRightIcon}
          </span>
        </button>
      );
    })}
    {options.dock !== "floating" && (
      <button
        type="button"
        aria-label={options.labels.unpin}
        title={options.labels.unpin}
        hidden={collapsed}
        onClick={() => onChange("floating")}
      >
        {PinIcon}
      </button>
    )}
  </div>
);

export const ToolPanel = ({
  options,
  dock,
  width,
  collapsed,
  resizing,
  onResize,
  onResizingChange,
  onCollapsedChange,
  appState,
  propertiesAvailable,
  canvasMenu,
  properties,
  hidden,
}: {
  options: ToolPanelOptions;
  dock: "left" | "right";
  width: number;
  collapsed: boolean;
  resizing: boolean;
  onResize: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  appState: UIAppState;
  propertiesAvailable: boolean;
  canvasMenu: ReactNode;
  properties: ReactNode;
  hidden: boolean;
}) => {
  const id = useId();
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    target: HTMLDivElement;
  } | null>(null);
  const [view, setView] = useState<"canvas" | "properties">(
    propertiesAvailable ? "properties" : "canvas",
  );
  const selectionKey = Object.keys(appState.selectedElementIds)
    .filter((key) => appState.selectedElementIds[key])
    .sort()
    .join(",");
  useEffect(() => {
    setView(propertiesAvailable ? "properties" : "canvas");
  }, [selectionKey, appState.activeTool.type, propertiesAvailable]);

  const finishResize = (commit: boolean) => {
    const current = drag.current;
    if (!current) {
      return;
    }
    drag.current = null;
    if (current.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
    onResizingChange(false);
    onResize(commit ? current.width : current.startWidth);
    if (commit && current.width !== current.startWidth) {
      options.onWidthChange?.(current.width);
    }
  };

  const commitWidth = (next: number) => {
    const bounded = getToolPanelWidth(next, appState.width);
    onResize(bounded);
    options.onWidthChange?.(bounded);
  };

  return (
    <aside
      className={clsx("tool-panel", `tool-panel--${dock}`, {
        "tool-panel--collapsed": collapsed,
        "tool-panel--resizing": resizing,
      })}
      style={
        {
          width: collapsed ? COLLAPSED_TOOL_PANEL_WIDTH : width,
          "--tool-panel-max-height": `${Math.max(0, appState.height - 148)}px`,
        } as CSSProperties
      }
      hidden={hidden}
      inert={hidden}
      aria-label={options.labels.title}
      data-viewport-ui={collapsed ? undefined : "side"}
      data-viewport-ui-name={collapsed ? undefined : "toolDock"}
    >
      <ToolPanelDockControls
        options={options}
        onToggle={() => onCollapsedChange(!collapsed)}
        collapsed={collapsed}
        contentId={`${id}-content`}
      />
      <div
        className="tool-panel-content"
        id={`${id}-content`}
        style={{ width }}
        inert={collapsed}
        aria-hidden={collapsed}
      >
        <header className="tool-panel-header">
          <strong>{options.labels.title}</strong>
        </header>
        <div
          className="tool-panel-tabs"
          role="tablist"
          aria-label={options.labels.title}
        >
          {(["canvas", "properties"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${id}-${tab}-tab`}
              aria-selected={view === tab}
              aria-controls={`${id}-${tab}`}
              tabIndex={view === tab ? 0 : -1}
              disabled={tab === "properties" && !propertiesAvailable}
              onClick={() => setView(tab)}
              onKeyDown={(event) => {
                if (
                  !propertiesAvailable ||
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                const next =
                  event.key === "Home"
                    ? "canvas"
                    : event.key === "End"
                    ? "properties"
                    : tab === "canvas"
                    ? "properties"
                    : "canvas";
                setView(next);
                event.currentTarget.ownerDocument
                  .getElementById(`${id}-${next}-tab`)
                  ?.focus();
              }}
            >
              {options.labels[tab]}
            </button>
          ))}
        </div>
        <div
          className="tool-panel-body"
          role="tabpanel"
          id={`${id}-canvas`}
          aria-labelledby={`${id}-canvas-tab`}
          hidden={view !== "canvas"}
          inert={view !== "canvas"}
        >
          {canvasMenu}
        </div>
        {propertiesAvailable && (
          <div
            className="tool-panel-body"
            role="tabpanel"
            id={`${id}-properties`}
            aria-labelledby={`${id}-properties-tab`}
            hidden={view !== "properties"}
            inert={view !== "properties"}
          >
            {properties}
          </div>
        )}
      </div>
      {!collapsed && (
        <div
          className="tool-panel-resize-handle"
          role="separator"
          aria-label={options.labels.resize}
          aria-orientation="vertical"
          aria-valuemin={MIN_TOOL_PANEL_WIDTH}
          aria-valuemax={getMaxToolPanelWidth(appState.width)}
          aria-valuenow={width}
          aria-controls={`${id}-content`}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startWidth: width,
              width,
              target: event.currentTarget,
            };
            onResizingChange(true);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || event.pointerId !== current.pointerId) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            current.width = getToolPanelWidth(
              Math.round(
                current.startWidth +
                  (event.clientX - current.startX) * (dock === "left" ? 1 : -1),
              ),
              appState.width,
            );
            onResize(current.width);
          }}
          onPointerUp={(event) => {
            if (event.pointerId === drag.current?.pointerId) {
              event.stopPropagation();
              finishResize(true);
            }
          }}
          onPointerCancel={() => finishResize(false)}
          onLostPointerCapture={() => finishResize(false)}
          onDoubleClick={() => commitWidth(DEFAULT_TOOL_PANEL_WIDTH)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && drag.current) {
              event.preventDefault();
              event.stopPropagation();
              finishResize(false);
              return;
            }
            if (
              !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (drag.current) {
              return;
            }
            commitWidth(
              event.key === "Home"
                ? MIN_TOOL_PANEL_WIDTH
                : event.key === "End"
                ? getMaxToolPanelWidth(appState.width)
                : width +
                  (event.key === "ArrowRight" ? 16 : -16) *
                    (dock === "left" ? 1 : -1),
            );
          }}
        />
      )}
    </aside>
  );
};
