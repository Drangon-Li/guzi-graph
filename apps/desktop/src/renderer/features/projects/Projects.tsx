import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@excalidraw/excalidraw";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  ArrowIcon,
  CloseIcon,
  DotsHorizontalIcon,
  ExternalLinkIcon,
  PenModeIcon,
  PinIcon,
  TrashIcon,
  LoadIcon,
  PlusIcon,
  searchIcon,
  settingsIcon,
} from "@excalidraw/excalidraw/components/icons";

import { fileTitle } from "../../shared/model/document";
import { isPathInDirectory, parentDirectory } from "../../shared/model/path";
import { translate } from "../../shared/i18n/i18n";
import { DesktopSelect } from "../../shared/ui/DesktopControls";
import { GuziLogo } from "../../shared/ui/GuziLogo";
import { desktopShortcut } from "../../shared/ui/desktopShortcut";

import { FilePreview } from "./FilePreview";
import { ProjectContextMenu } from "./ProjectContextMenu";

import type { DragEvent, ReactNode } from "react";

import type { ProjectFile, RecentFile } from "../../../shared/desktop-api";
import type { Workspace } from "../workspace/workspace";

const isInDefaultDirectory = (
  file: ProjectFile,
  directory: string | null,
  platform: string,
) => isPathInDirectory(file.path, directory, platform);

type FileMenu = {
  file: ProjectFile;
  anchor: HTMLButtonElement;
  left: number;
  top: number;
  align: "start" | "end";
};

export type ProjectEdit =
  | { kind: "folder"; parent?: string }
  | { kind: "moveFolder"; folder: string }
  | { kind: "rename" | "move"; file: ProjectFile };

export const Projects = ({
  root,
  theme,
  active = true,
  workspace,
  onEdit,
  onSettings,
  onRecovery,
  onRemove,
  examples,
  market,
}: {
  examples?: ReactNode;
  market?: ReactNode;
  root: HTMLElement;
  theme: "light" | "dark";
  active?: boolean;
  workspace: Workspace;
  onEdit: (edit: ProjectEdit) => void;
  onSettings: () => void;
  onRecovery: () => void;
  onRemove: (file: ProjectFile, mode: "remove" | "trash") => void;
}) => {
  const platform = root.ownerDocument.defaultView!.desktop.platform;
  const t = (message: string, params?: Record<string, string | number>) =>
    translate(workspace.settings.language, message, params);
  const [view, setView] = useState<"history" | "files" | "examples" | "market">(
    "history",
  );
  const historyVisible = view === "history";
  const examplesVisible = view === "examples";
  const [category, setCategory] = useState<string | null>(null);
  const requestNewDocument = () => {
    const { rootDirectory } = workspace.index;
    workspace.requestNewDocument(
      view === "files" && category && rootDirectory
        ? { rootDirectory, category }
        : undefined,
    );
  };
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("modified");
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<FileMenu | null>(null);
  const [folderMenu, setFolderMenu] = useState<{
    folder: string;
    anchor: HTMLButtonElement;
    left: number;
    top: number;
    align: "start" | "end";
  } | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [renaming, setRenaming] = useState<{
    folder: string;
    value: string;
    pending: boolean;
    error: boolean;
  } | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renamePhase = useRef<"idle" | "editing" | "pending">("idle");
  const renameFocus = useRef<string | null>(null);
  const renamingFolder = renaming?.folder;
  const composing = useRef(false);
  const lastRoot = useRef(workspace.index.rootDirectory);
  const lastRelocation = useRef<number | null>(null);
  const [dragging, setDragging] = useState<
    | { kind: "file"; file: ProjectFile }
    | { kind: "folder"; folder: string }
    | null
  >(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragPreview = useRef<{ node: HTMLElement; timer: number } | null>(null);
  const clearDragPreview = () => {
    const preview = dragPreview.current;
    if (preview) {
      preview.node.ownerDocument.defaultView!.clearTimeout(preview.timer);
      preview.node.remove();
      dragPreview.current = null;
    }
  };
  useEffect(() => clearDragPreview, []);
  const [moving, setMoving] = useState(false);
  const menuId = useId();
  const closeMenu = (restoreFocus = false) => {
    setMenu(null);
    if (restoreFocus && menu?.anchor.isConnected) {
      menu.anchor.focus({ preventScroll: true });
    }
  };
  useEffect(() => {
    setMenu(null);
    setFolderMenu(null);
  }, [
    active,
    historyVisible,
    view,
    category,
    query,
    sort,
    workspace.projectsVisible,
  ]);
  useEffect(() => setMenu(null), [workspace.index]);
  useLayoutEffect(() => {
    if (renamingFolder) {
      renameInput.current?.focus();
      renameInput.current?.select();
    } else if (renameFocus.current) {
      const folder = renameFocus.current;
      renameFocus.current = null;
      Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          ".desktop-category-row > button[title]",
        ),
      )
        .find((button) => button.title === folder)
        ?.focus({ preventScroll: true });
    }
  }, [renamingFolder, root]);
  useEffect(() => {
    if (!active || !workspace.projectsVisible) {
      renamePhase.current = "idle";
      setRenaming(null);
    }
  }, [active, workspace.projectsVisible]);
  const files = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const source = historyVisible
      ? workspace.index.history
      : workspace.index.files;
    const timestamp = (file: ProjectFile | RecentFile) =>
      historyVisible && "lastOpenedAt" in file
        ? file.lastOpenedAt
        : file.modifiedAt;
    return source
      .filter(
        (file) =>
          (historyVisible || category === null || file.category === category) &&
          (!search ||
            `${file.name} ${file.category} ${parentDirectory(
              file.path,
              platform,
            )}`
              .toLocaleLowerCase()
              .includes(search)),
      )
      .sort((left, right) =>
        sort === "name"
          ? left.name.localeCompare(right.name, workspace.settings.language, {
              numeric: true,
            })
          : sort === "oldest"
          ? timestamp(left) - timestamp(right)
          : timestamp(right) - timestamp(left),
      );
  }, [
    workspace.index,
    workspace.settings.language,
    historyVisible,
    category,
    query,
    sort,
    platform,
  ]);
  useEffect(() => {
    if (lastRoot.current !== workspace.index.rootDirectory) {
      lastRoot.current = workspace.index.rootDirectory;
      setCategory(null);
      setCollapsed(new Set());
      setFolderMenu(null);
      setRenaming(null);
      renamePhase.current = "idle";
      return;
    }
    const relocation = workspace.folderRelocation;
    const remap = (path: string) =>
      relocation &&
      (path === relocation.source || path.startsWith(`${relocation.source}/`))
        ? relocation.destination + path.slice(relocation.source.length)
        : path;
    const relocated =
      relocation &&
      relocation.id !== lastRelocation.current &&
      relocation.rootDirectory === workspace.index.rootDirectory;
    if (relocated) {
      lastRelocation.current = relocation.id;
      setCollapsed((current) => new Set(Array.from(current, remap)));
    }
    setCategory((current) => {
      const next = current && relocated ? remap(current) : current;
      return next && !workspace.index.folders.includes(next) ? null : next;
    });
    setFolderMenu((current) =>
      current && !workspace.index.folders.includes(current.folder)
        ? null
        : current,
    );
  }, [
    category,
    workspace.index.rootDirectory,
    workspace.index.folders,
    workspace.folderRelocation,
  ]);
  const beginRename = (folder: string) => {
    if (renamePhase.current === "pending") {
      return;
    }
    renamePhase.current = "editing";
    composing.current = false;
    setFolderMenu(null);
    setRenaming({
      folder,
      value: folder.split("/").pop()!,
      pending: false,
      error: false,
    });
  };
  const finishRename = (folder = renaming?.folder) => {
    if (
      renameInput.current?.ownerDocument.activeElement === renameInput.current
    ) {
      renameFocus.current = folder || null;
    }
    renamePhase.current = "idle";
    setRenaming(null);
  };
  const submitRename = async () => {
    if (!renaming || renamePhase.current !== "editing") {
      return;
    }
    const edit = renaming;
    const rootDirectory = workspace.index.rootDirectory;
    if (edit.value.trim() === edit.folder.split("/").pop()) {
      finishRename();
      return;
    }
    renamePhase.current = "pending";
    setRenaming({ ...edit, pending: true, error: false });
    const succeeded = await workspace.renameFolder(
      edit.folder,
      edit.value.trim(),
    );
    if (
      renamePhase.current !== "pending" ||
      lastRoot.current !== rootDirectory
    ) {
      return;
    }
    if (succeeded) {
      finishRename(
        [...edit.folder.split("/").slice(0, -1), edit.value.trim()].join("/"),
      );
    } else {
      renamePhase.current = "editing";
      setRenaming({ ...edit, pending: false, error: true });
      renameInput.current?.focus();
    }
  };
  const canDrop = (target: string) =>
    !!workspace.index.rootDirectory &&
    !moving &&
    !!dragging &&
    (dragging.kind === "file" ||
      (target !== dragging.folder &&
        !target.startsWith(`${dragging.folder}/`)));
  const dropEvents = (target: string) => ({
    onDragOver: (event: DragEvent) => {
      if (canDrop(target)) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(target);
      }
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropTarget((current) => (current === target ? null : current));
      }
    },
    onDrop: async (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearDragPreview();
      setDropTarget(null);
      if (!canDrop(target) || !dragging) {
        return;
      }
      const item = dragging;
      setDragging(null);
      setMoving(true);
      try {
        if (item.kind === "file") {
          await workspace.mutateFile("move", item.file, target);
        } else {
          await workspace.moveFolder(item.folder, target);
        }
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(target);
          return next;
        });
      } finally {
        setMoving(false);
      }
    },
  });
  const startDrag = (event: DragEvent, item: NonNullable<typeof dragging>) => {
    event.stopPropagation();
    clearDragPreview();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "application/x-guzi-project",
      JSON.stringify(
        item.kind === "file" ? { kind: item.kind, path: item.file.path } : item,
      ),
    );
    if (item.kind === "file") {
      const ownerDocument = root.ownerDocument;
      const ownerWindow = ownerDocument.defaultView!;
      const host = ownerDocument.createElement("div");
      host.className = "desktop-drag-preview-host";
      host.setAttribute("aria-hidden", "true");
      const preview = ownerDocument.createElement("div");
      preview.className = "desktop-drag-preview";
      const source = event.currentTarget.querySelector(".desktop-file-preview");
      if (source) {
        preview.append(source.cloneNode(true));
      }
      const title = ownerDocument.createElement("div");
      title.className = "desktop-drag-preview-title";
      title.textContent = fileTitle(item.file.name);
      const label = ownerDocument.createElement("div");
      label.className = "desktop-drag-preview-label";
      label.textContent = `↗ ${t("移动中")}`;
      preview.append(title, label);
      host.append(preview);
      event.currentTarget.closest(".excalidraw.desktop-shell")!.append(host);
      // Keep the rendered node alive until Chromium has captured the drag image.
      dragPreview.current = {
        node: host,
        timer: ownerWindow.setTimeout(clearDragPreview, 150),
      };
      event.dataTransfer.setDragImage(host, 0, 0);
    }
    setDragging(item);
    setMenu(null);
    setFolderMenu(null);
  };
  const endDrag = () => {
    clearDragPreview();
    setDragging(null);
    setDropTarget(null);
  };
  const showFolderMenu = (
    folder: string,
    anchor: HTMLButtonElement,
    position?: { left: number; top: number },
  ) => {
    const rect = anchor.getBoundingClientRect();
    setMenu(null);
    setFolderMenu({
      folder,
      anchor,
      left: position?.left ?? rect.right,
      top: position?.top ?? rect.bottom + 8,
      align: position ? "start" : "end",
    });
  };
  const pinned = new Set(
    workspace.settings.pinnedFoldersByRoot?.[
      workspace.index.rootDirectory || ""
    ] || [],
  );
  const folderTree = (parent: string): ReactNode => {
    const children = workspace.index.folders
      .filter((folder) => folder.split("/").slice(0, -1).join("/") === parent)
      .sort(
        (left, right) =>
          Number(pinned.has(right)) - Number(pinned.has(left)) ||
          left.localeCompare(right, workspace.settings.language, {
            numeric: true,
          }),
      );
    return children.length ? (
      <ul className="desktop-category-tree">
        {children.map((folder) => {
          const hasChildren = workspace.index.folders.some((candidate) =>
            candidate.startsWith(`${folder}/`),
          );
          const expanded = !collapsed.has(folder);
          const editing = renaming?.folder === folder;
          return (
            <li key={folder}>
              <div
                className={`desktop-category-row${
                  dropTarget === folder ? " desktop-drop-target" : ""
                }`}
                draggable={!moving && !renaming}
                onDragStart={(event) => {
                  if (renaming) {
                    event.preventDefault();
                    return;
                  }
                  startDrag(event, { kind: "folder", folder });
                }}
                onDragEnd={endDrag}
                {...dropEvents(folder)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (renaming) {
                    return;
                  }
                  showFolderMenu(
                    folder,
                    event.currentTarget.querySelector<HTMLButtonElement>(
                      ".desktop-category-menu",
                    )!,
                    { left: event.clientX, top: event.clientY },
                  );
                }}
                onKeyDown={(event) => {
                  if (renaming) {
                    return;
                  }
                  if (event.key === "F2") {
                    event.preventDefault();
                    beginRename(folder);
                    return;
                  }
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  ) {
                    event.preventDefault();
                    showFolderMenu(
                      folder,
                      event.currentTarget.querySelector<HTMLButtonElement>(
                        ".desktop-category-menu",
                      )!,
                    );
                  }
                }}
              >
                {hasChildren ? (
                  <button
                    className="desktop-category-toggle"
                    aria-label={t(expanded ? "收起 {name}" : "展开 {name}", {
                      name: folder,
                    })}
                    aria-expanded={expanded}
                    disabled={editing}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        expanded ? next.add(folder) : next.delete(folder);
                        return next;
                      })
                    }
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="desktop-category-toggle" />
                )}
                {editing ? (
                  <div className="desktop-category-rename">
                    <input
                      ref={renameInput}
                      className="desktop-category-rename-input"
                      aria-label={t("分类名称")}
                      aria-busy={renaming.pending}
                      aria-invalid={renaming.error}
                      value={renaming.value}
                      readOnly={renaming.pending}
                      onChange={(event) =>
                        setRenaming({
                          ...renaming,
                          value: event.target.value,
                          error: false,
                        })
                      }
                      onCompositionStart={() => {
                        composing.current = true;
                      }}
                      onCompositionEnd={() => {
                        composing.current = false;
                      }}
                      onBlur={() => void submitRename()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (
                          composing.current ||
                          event.nativeEvent.isComposing ||
                          event.keyCode === 229
                        ) {
                          return;
                        }
                        if (
                          event.key === "Escape" &&
                          renamePhase.current === "editing"
                        ) {
                          event.preventDefault();
                          finishRename();
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          void submitRename();
                        }
                      }}
                    />
                    {renaming.error && (
                      <span role="alert">{t("重命名失败，请重试。")}</span>
                    )}
                  </div>
                ) : (
                  <Button
                    selected={view === "files" && category === folder}
                    onSelect={() => {
                      setView("files");
                      setCategory(folder);
                    }}
                    title={folder}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      beginRename(folder);
                    }}
                  >
                    <span className="desktop-category-name">
                      {folder.split("/").pop()}
                    </span>
                    {pinned.has(folder) && (
                      <span
                        className="desktop-category-pin"
                        title={t("已置顶")}
                        aria-label={t("已置顶")}
                      >
                        {PinIcon}
                      </span>
                    )}
                    <small>{count(folder)}</small>
                  </Button>
                )}
                <button
                  className="desktop-category-menu"
                  aria-label={t("{name} 的分类操作", { name: folder })}
                  aria-haspopup="menu"
                  aria-expanded={folderMenu?.folder === folder}
                  disabled={editing}
                  onClick={(event) => {
                    if (folderMenu?.folder === folder) {
                      setFolderMenu(null);
                    } else {
                      showFolderMenu(folder, event.currentTarget);
                    }
                  }}
                >
                  {DotsHorizontalIcon}
                </button>
              </div>
              {hasChildren && expanded && folderTree(folder)}
            </li>
          );
        })}
      </ul>
    ) : null;
  };
  const count = (name: string) =>
    workspace.index.files.filter((file) => file.category === name).length;
  const refresh = async () => {
    setRefreshing(true);
    await workspace.refreshProjects();
    setRefreshing(false);
  };
  return (
    <div className="desktop-projects">
      <aside className="desktop-sidebar">
        <div className="desktop-brand">
          <span>
            <GuziLogo />
          </span>
          <strong>Excalidraw</strong>
        </div>
        <div className="desktop-sidebar-section">{t("本地画布")}</div>
        <Button
          selected={view === "history"}
          onSelect={() => {
            setView("history");
          }}
        >
          <span>{t("历史画布")}</span>
          <small>{workspace.index.history.length}</small>
        </Button>
        <Button
          selected={view === "files" && category === null}
          onSelect={() => {
            setView("files");
            setCategory(null);
          }}
        >
          <span>{t("全部画布")}</span>
          <small>{workspace.index.files.length}</small>
        </Button>
        <Button
          selected={view === "files" && category === ""}
          className={dropTarget === "" ? "desktop-drop-target" : undefined}
          {...dropEvents("")}
          onSelect={() => {
            setView("files");
            setCategory("");
          }}
        >
          <span>{t("未分类")}</span>
          <small>{count("")}</small>
        </Button>
        {examples && (
          <Button
            selected={examplesVisible}
            onSelect={() => setView("examples")}
          >
            <span>{t("示例库")}</span>
          </Button>
        )}
        {market && (
          <Button
            selected={view === "market"}
            onSelect={() => setView("market")}
          >
            <span>{t("插件市场")}</span>
          </Button>
        )}
        <div className="desktop-sidebar-heading">
          <span>{t("文件夹分类")}</span>
          <Button
            onSelect={() => onEdit({ kind: "folder" })}
            disabled={!workspace.index.rootDirectory}
            title={
              workspace.index.rootDirectory
                ? t("新建分类")
                : t("请先设置默认文件夹")
            }
            aria-label={t("新建分类")}
          >
            {PlusIcon}
          </Button>
        </div>
        <div className="desktop-categories">
          {folderTree("")}
          {!workspace.index.folders.length && (
            <p className="desktop-sidebar-hint">
              {t("新建文件夹，整理你的画布。")}
            </p>
          )}
        </div>
        <div className="desktop-sidebar-bottom">
          <Button onSelect={onSettings}>
            {settingsIcon}
            <span>{t("设置")}</span>
          </Button>
          <span className="desktop-local-label">
            {t("文件保存在这台电脑上")}
          </span>
        </div>
      </aside>
      <main className="desktop-project-content">
        <header className="desktop-project-heading">
          <div>
            <h1>
              {view === "market"
                ? "Guzi Market"
                : examplesVisible
                ? t("示例库")
                : historyVisible
                ? t("历史画布")
                : category === null
                ? t("全部画布")
                : category || t("未分类")}
            </h1>
            <p>
              {view === "market"
                ? t("管理本地 JavaScript 插件，扩展你的画布。")
                : examplesVisible
                ? t("打开示例副本自由编辑，保存时选择自己的位置。")
                : historyVisible
                ? t("打开或保存过的画布，随时回来继续。")
                : t("默认文件夹中的画布，按分类整理。")}
            </p>
          </div>
          <div className="desktop-project-actions">
            <Button onSelect={() => workspace.newPresentation()}>
              {PlusIcon}
              <span>{t("新建演示文稿")}</span>
            </Button>
            <Button onSelect={workspace.requestPdfImport}>
              {LoadIcon}
              <span>{t("导入 PDF")}</span>
            </Button>
            <Button onSelect={workspace.openFiles}>
              {LoadIcon}
              <span>{t("打开文件")}</span>
              <kbd>{desktopShortcut(platform, "O")}</kbd>
            </Button>
            <Button className="desktop-primary" onSelect={requestNewDocument}>
              {PlusIcon}
              <span>{t("新建画布")}</span>
            </Button>
          </div>
        </header>
        {workspace.drafts.length > 0 && (
          <div className="desktop-recovery-banner">
            <span>
              {t("发现 {count} 份未保存的恢复草稿。", {
                count: workspace.drafts.length,
              })}
            </span>
            <Button onSelect={onRecovery}>{t("查看并恢复")}</Button>
          </div>
        )}
        {view === "market" ? (
          market
        ) : examplesVisible ? (
          examples
        ) : (
          <>
            <div className="desktop-project-toolbar">
              <TextField
                value={query}
                onChange={setQuery}
                type="search"
                icon={searchIcon}
                placeholder={t("搜索画布、分类或文件夹")}
                className="desktop-search"
              />
              <DesktopSelect
                root={root}
                label={t("画布排序")}
                value={sort}
                onValueChange={setSort}
                options={[
                  {
                    value: "modified",
                    label: historyVisible ? t("最近打开") : t("最近修改"),
                  },
                  {
                    value: "oldest",
                    label: historyVisible ? t("最早打开") : t("最早修改"),
                  },
                  { value: "name", label: t("名称 A–Z") },
                ]}
              />
              <Button onSelect={refresh} disabled={refreshing}>
                {refreshing ? t("刷新中…") : t("刷新")}
              </Button>
            </div>
            <div className="desktop-project-grid">
              {files.map((file) => (
                <article
                  className="desktop-file-card"
                  key={file.path}
                  draggable={!moving}
                  onDragStart={(event) =>
                    startDrag(event, { kind: "file", file })
                  }
                  onDragEnd={endDrag}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({
                      file,
                      anchor:
                        event.currentTarget.querySelector<HTMLButtonElement>(
                          ".desktop-file-open",
                        )!,
                      left: event.clientX,
                      top: event.clientY,
                      align: "start",
                    });
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "ContextMenu" ||
                      (event.shiftKey && event.key === "F10")
                    ) {
                      event.preventDefault();
                      const anchor =
                        event.currentTarget.querySelector<HTMLButtonElement>(
                          ".desktop-file-open",
                        )!;
                      const rect = anchor.getBoundingClientRect();
                      setMenu({
                        file,
                        anchor,
                        left: rect.left,
                        top: rect.bottom,
                        align: "start",
                      });
                    }
                  }}
                >
                  <button
                    className="desktop-file-open"
                    onClick={() => void workspace.openProject(file)}
                    title={t("打开 {name}", { name: file.name })}
                  >
                    <FilePreview
                      file={file}
                      root={root}
                      theme={theme}
                      language={workspace.settings.language}
                    />
                    <span className="desktop-file-title">
                      {fileTitle(file.name)}
                    </span>
                    <span className="desktop-file-modified">
                      {new Intl.DateTimeFormat(workspace.settings.language, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(file.modifiedAt)}
                    </span>
                    <span
                      className="desktop-file-category"
                      title={
                        isInDefaultDirectory(
                          file,
                          workspace.index.rootDirectory,
                          platform,
                        )
                          ? file.category || t("默认文件夹")
                          : parentDirectory(file.path, platform)
                      }
                    >
                      {isInDefaultDirectory(
                        file,
                        workspace.index.rootDirectory,
                        platform,
                      )
                        ? file.category || t("未分类")
                        : parentDirectory(file.path, platform)}
                    </span>
                  </button>
                  <button
                    className="desktop-file-menu-trigger"
                    aria-label={t("{name} 的操作", { name: file.name })}
                    aria-haspopup="menu"
                    aria-expanded={menu?.file.path === file.path}
                    aria-controls={
                      menu?.file.path === file.path ? menuId : undefined
                    }
                    title={t("更多操作")}
                    onClick={(event) => {
                      if (menu?.file.path === file.path) {
                        closeMenu(true);
                        return;
                      }
                      const anchor = event.currentTarget;
                      const rect = anchor.getBoundingClientRect();
                      setMenu({
                        file,
                        anchor,
                        left: rect.right,
                        top: rect.bottom + 8,
                        align: "end",
                      });
                    }}
                  >
                    {DotsHorizontalIcon}
                  </button>
                </article>
              ))}
            </div>
            {!files.length && (
              <div className="desktop-empty">
                <span>
                  <GuziLogo />
                </span>
                <h2>
                  {query
                    ? t("没有找到匹配的画布")
                    : !historyVisible && !workspace.index.rootDirectory
                    ? t("设置默认文件夹以浏览画布")
                    : t("这里还没有画布")}
                </h2>
                <p>
                  {query
                    ? t("换个名称、分类或文件夹试试。")
                    : !historyVisible && !workspace.index.rootDirectory
                    ? t("外部打开和保存的文件会保留在历史画布中。")
                    : t("新建画布并保存，或打开已有的 .excalidraw 文件。")}
                </p>
                {!query && (
                  <Button
                    className="desktop-primary"
                    onSelect={requestNewDocument}
                  >
                    {PlusIcon}
                    {t("新建画布")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        <footer className="desktop-directory">
          <span title={workspace.settings.rootDirectory || ""}>
            {t("默认文件夹：{path}", {
              path: workspace.settings.rootDirectory || t("尚未设置"),
            })}
          </span>
          <Button onSelect={workspace.changeDirectory}>
            {t("更改文件夹")}
          </Button>
        </footer>
      </main>
      {active && folderMenu && (
        <ProjectContextMenu
          id={`${menuId}-folder`}
          root={root}
          anchor={folderMenu.anchor}
          label={t("{name} 的分类操作", { name: folderMenu.folder })}
          left={folderMenu.left}
          top={folderMenu.top}
          align={folderMenu.align}
          onClose={(restoreFocus) => {
            if (restoreFocus && folderMenu.anchor.isConnected) {
              folderMenu.anchor.focus({ preventScroll: true });
            }
            setFolderMenu(null);
          }}
          items={[
            {
              label: t("重命名"),
              icon: PenModeIcon,
              disabled: moving,
              onSelect: () => beginRename(folderMenu.folder),
            },
            {
              label: t(pinned.has(folderMenu.folder) ? "取消置顶" : "置顶"),
              icon: PinIcon,
              onSelect: () =>
                void workspace.setFolderPinned(
                  folderMenu.folder,
                  !pinned.has(folderMenu.folder),
                ),
            },
            {
              label: t("新建子分类"),
              icon: PlusIcon,
              onSelect: () =>
                onEdit({ kind: "folder", parent: folderMenu.folder }),
            },
            {
              label: t("移动到分类"),
              icon: ArrowIcon,
              disabled: moving,
              onSelect: () =>
                onEdit({ kind: "moveFolder", folder: folderMenu.folder }),
            },
          ]}
        />
      )}
      {active && menu && (
        <ProjectContextMenu
          id={menuId}
          root={root}
          anchor={menu.anchor}
          label={t("{name} 的操作", { name: menu.file.name })}
          left={menu.left}
          top={menu.top}
          align={menu.align}
          onClose={closeMenu}
          items={[
            {
              label: t("打开"),
              icon: LoadIcon,
              onSelect: () => void workspace.openProject(menu.file),
            },
            {
              label: t("重命名"),
              icon: PenModeIcon,
              separatorBefore: true,
              onSelect: () => onEdit({ kind: "rename", file: menu.file }),
            },
            {
              label: isInDefaultDirectory(
                menu.file,
                workspace.index.rootDirectory,
                platform,
              )
                ? t("移动到分类")
                : t("移入默认文件夹分类"),
              icon: ArrowIcon,
              disabled: !workspace.index.rootDirectory,
              title: workspace.index.rootDirectory
                ? undefined
                : t("请先设置默认文件夹"),
              onSelect: () => onEdit({ kind: "move", file: menu.file }),
            },
            {
              label: t("在文件管理器中显示"),
              icon: ExternalLinkIcon,
              separatorBefore: true,
              onSelect: () => {
                void root.ownerDocument
                  .defaultView!.desktop.revealFile(menu.file.path)
                  .catch(workspace.reportError);
              },
            },
            {
              label: t("删除"),
              icon: CloseIcon,
              danger: true,
              separatorBefore: true,
              onSelect: () => onRemove(menu.file, "remove"),
            },
            {
              label: t(platform === "win32" ? "移到回收站" : "彻底删除"),
              icon: TrashIcon,
              danger: true,
              onSelect: () => onRemove(menu.file, "trash"),
            },
          ]}
        />
      )}
    </div>
  );
};
