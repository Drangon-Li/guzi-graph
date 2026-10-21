import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@excalidraw/excalidraw";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  ArrowIcon,
  CloseIcon,
  DotsHorizontalIcon,
  ExternalLinkIcon,
  PenModeIcon,
  TrashIcon,
  ExcalLogo,
  LoadIcon,
  PlusIcon,
  searchIcon,
  settingsIcon,
} from "@excalidraw/excalidraw/components/icons";

import { fileTitle } from "../../shared/model/document";
import { translate } from "../../shared/i18n/i18n";
import { DesktopSelect } from "../../shared/ui/DesktopControls";

import { FilePreview } from "./FilePreview";
import { ProjectContextMenu } from "./ProjectContextMenu";

import type { ReactNode } from "react";

import type { ProjectFile, RecentFile } from "../../../shared/desktop-api";
import type { Workspace } from "../workspace/workspace";

const isInDefaultDirectory = (file: ProjectFile, directory: string | null) =>
  !!directory && file.path.startsWith(`${directory.replace(/\/$/, "")}/`);

const parentDirectory = (path: string) =>
  path.slice(0, path.lastIndexOf("/")) || "/";

type FileMenu = {
  file: ProjectFile;
  anchor: HTMLButtonElement;
  left: number;
  top: number;
  align: "start" | "end";
};

export type ProjectEdit =
  | { kind: "folder" }
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
}: {
  examples?: ReactNode;
  root: HTMLElement;
  theme: "light" | "dark";
  active?: boolean;
  workspace: Workspace;
  onEdit: (edit: ProjectEdit) => void;
  onSettings: () => void;
  onRecovery: () => void;
  onRemove: (file: ProjectFile, mode: "remove" | "trash") => void;
}) => {
  const t = (message: string, params?: Record<string, string | number>) =>
    translate(workspace.settings.language, message, params);
  const [historyVisible, setHistoryVisible] = useState(true);
  const [examplesVisible, setExamplesVisible] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("modified");
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<FileMenu | null>(null);
  const menuId = useId();
  const closeMenu = (restoreFocus = false) => {
    setMenu(null);
    if (restoreFocus && menu?.anchor.isConnected) {
      menu.anchor.focus({ preventScroll: true });
    }
  };
  useEffect(() => {
    setMenu(null);
  }, [
    active,
    historyVisible,
    examplesVisible,
    category,
    query,
    sort,
    workspace.projectsVisible,
    workspace.index,
  ]);
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
            `${file.name} ${file.category} ${parentDirectory(file.path)}`
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
  ]);
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
          <span>{ExcalLogo}</span>
          <strong>Excalidraw</strong>
        </div>
        <div className="desktop-sidebar-section">{t("本地画布")}</div>
        <Button
          selected={!examplesVisible && historyVisible}
          onSelect={() => {
            setExamplesVisible(false);
            setHistoryVisible(true);
          }}
        >
          <span>{t("历史画布")}</span>
          <small>{workspace.index.history.length}</small>
        </Button>
        <Button
          selected={!examplesVisible && !historyVisible && category === null}
          onSelect={() => {
            setExamplesVisible(false);
            setHistoryVisible(false);
            setCategory(null);
          }}
        >
          <span>{t("全部画布")}</span>
          <small>{workspace.index.files.length}</small>
        </Button>
        <Button
          selected={!examplesVisible && !historyVisible && category === ""}
          onSelect={() => {
            setExamplesVisible(false);
            setHistoryVisible(false);
            setCategory("");
          }}
        >
          <span>{t("未分类")}</span>
          <small>{count("")}</small>
        </Button>
        {examples && (
          <Button
            selected={examplesVisible}
            onSelect={() => setExamplesVisible(true)}
          >
            <span>{t("示例库")}</span>
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
          {workspace.index.folders.map((folder) => (
            <Button
              key={folder}
              selected={
                !examplesVisible && !historyVisible && category === folder
              }
              onSelect={() => {
                setExamplesVisible(false);
                setHistoryVisible(false);
                setCategory(folder);
              }}
              title={folder}
            >
              <span className="desktop-category-name">{folder}</span>
              <small>{count(folder)}</small>
            </Button>
          ))}
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
            {t("文件保存在这台 Mac 上")}
          </span>
        </div>
      </aside>
      <main className="desktop-project-content">
        <header className="desktop-project-heading">
          <div>
            <h1>
              {examplesVisible
                ? t("示例库")
                : historyVisible
                ? t("历史画布")
                : category === null
                ? t("全部画布")
                : category || t("未分类")}
            </h1>
            <p>
              {examplesVisible
                ? t("打开示例副本自由编辑，保存时选择自己的位置。")
                : historyVisible
                ? t("打开或保存过的画布，随时回来继续。")
                : t("默认文件夹中的画布，按分类整理。")}
            </p>
          </div>
          <div className="desktop-project-actions">
            <Button onSelect={workspace.openFiles}>
              {LoadIcon}
              <span>{t("打开文件")}</span>
              <kbd>⌘O</kbd>
            </Button>
            <Button
              className="desktop-primary"
              onSelect={workspace.newDocument}
            >
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
        {examplesVisible ? (
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
                        )
                          ? file.category || t("默认文件夹")
                          : parentDirectory(file.path)
                      }
                    >
                      {isInDefaultDirectory(file, workspace.index.rootDirectory)
                        ? file.category || t("未分类")
                        : parentDirectory(file.path)}
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
                <span>{ExcalLogo}</span>
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
                    onSelect={workspace.newDocument}
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
              label: t("在 Finder 中显示"),
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
              label: t("彻底删除"),
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
