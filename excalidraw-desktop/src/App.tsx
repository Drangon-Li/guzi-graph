import { useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Excalidraw,
  MainMenu,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  CloseIcon,
  DeviceDesktopIcon,
  ExcalLogo,
  LoadIcon,
  MoonIcon,
  PlusIcon,
  saveAs,
  settingsIcon,
  SunIcon,
} from "@excalidraw/excalidraw/components/icons";

import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";

import { fileTitle } from "./document";
import { InlineTabTitle } from "./InlineTabTitle";
import { Projects } from "./Projects";
import { useWorkspace } from "./workspace";

import "./styles.scss";

import type { ProjectEdit } from "./Projects";
import type { CanvasDocument, Workspace } from "./workspace";
import type { ReactNode } from "react";

const Modal = ({
  root,
  title,
  children,
  onClose,
}: {
  root: HTMLElement;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const ownerDocument = root.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    const previous = ownerDocument.activeElement as HTMLElement | null;
    const node = container.current!;
    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select, [tabindex='0']",
        ),
      );
    const frame = ownerWindow.requestAnimationFrame(() => {
      const initial =
        node.querySelector<HTMLElement>("input, select") || focusable()[0];
      initial?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        if (event.shiftKey && ownerDocument.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          ownerDocument.activeElement === items.at(-1)
        ) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      ownerWindow.cancelAnimationFrame(frame);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      previous?.isConnected && previous.focus();
    };
  }, [root]);
  return (
    <div
      className="desktop-modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="desktop-modal"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <Button aria-label="关闭对话框" title="关闭" onSelect={onClose}>
            {CloseIcon}
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
};

const ProjectEditModal = ({
  root,
  workspace,
  edit,
  onClose,
}: {
  root: HTMLElement;
  workspace: Workspace;
  edit: ProjectEdit;
  onClose: () => void;
}) => {
  const [value, setValue] = useState(
    edit.kind === "folder"
      ? ""
      : edit.kind === "move"
      ? edit.file.category
      : fileTitle(edit.file.name),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const title =
    edit.kind === "folder"
      ? "新建分类"
      : edit.kind === "move"
      ? "移动到分类"
      : "重命名画布";
  const close = () => !busy && onClose();
  const submit = async () => {
    if (busy || (edit.kind !== "move" && !value.trim())) {
      return;
    }
    setBusy(true);
    setFailed(false);
    const success =
      edit.kind === "folder"
        ? await workspace.createFolder(value.trim())
        : await workspace.mutateFile(edit.kind, edit.file, value.trim());
    setBusy(false);
    if (success) {
      onClose();
    } else {
      setFailed(true);
    }
  };
  return (
    <Modal root={root} title={title} onClose={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="desktop-modal-body">
          {edit.kind === "move" ? (
            <label className="desktop-form-label">
              目标文件夹
              <select
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">未分类（默认文件夹）</option>
                {workspace.index.folders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="desktop-form-label">
              <TextField
                value={value}
                onChange={setValue}
                label={edit.kind === "folder" ? "文件夹名称" : "画布名称"}
                fullWidth
                selectOnRender
              />
            </label>
          )}
          <p>
            {edit.kind === "folder"
              ? "分类会在默认文件夹内创建真实文件夹。"
              : edit.kind === "rename"
              ? "文件名会同步更新，扩展名保持 .excalidraw。"
              : "文件会移入默认文件夹下所选的分类，原位置将不再保留。"}
          </p>
          {failed && (
            <p className="desktop-inline-error" role="alert">
              {workspace.error || "操作失败，请重试。"}
            </p>
          )}
        </div>
        <footer>
          <Button onSelect={close} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            onSelect={() => {}}
            className="desktop-primary"
            disabled={busy || (edit.kind !== "move" && !value.trim())}
          >
            {busy ? "处理中…" : "确定"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
};

const Editor = ({
  document,
  active,
  blocked,
  theme,
  root,
  workspace,
  onSettings,
}: {
  document: CanvasDocument;
  active: boolean;
  blocked: boolean;
  theme: "light" | "dark";
  root: HTMLElement;
  workspace: Workspace;
  onSettings: () => void;
}) => (
  <section
    className={`desktop-editor-pane${active ? " is-active" : ""}`}
    data-document-id={document.id}
    aria-hidden={!active}
    inert={!active || blocked}
  >
    <Excalidraw
      ownerDocument={root.ownerDocument}
      initialData={document.initialData}
      onExcalidrawAPI={(api) => {
        document.api = api;
      }}
      onInitialize={(api) => workspace.initialize(document, api)}
      onChange={(elements, appState, files) =>
        workspace.capture(document, { elements, appState, files })
      }
      desktopIntegration={{
        localOnly: true,
        save: (snapshot, saveAs) =>
          workspace.editorSave(document, snapshot, saveAs),
        open: workspace.openFiles,
      }}
      interaction={active && !blocked}
      handleKeyboardGlobally={active && !blocked}
      autoFocus={active}
      langCode="zh-CN"
      theme={theme}
      name={document.title}
      UIOptions={{ canvasActions: { toggleTheme: false } }}
    >
      <MainMenu>
        <MainMenu.Item
          icon={PlusIcon}
          shortcut="⌘N"
          onSelect={workspace.newDocument}
        >
          新建画布
        </MainMenu.Item>
        <MainMenu.Item
          icon={LoadIcon}
          shortcut="⌘O"
          onSelect={() => void workspace.openFiles()}
        >
          打开文件…
        </MainMenu.Item>
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.Item
          icon={saveAs}
          shortcut="⌘⇧S"
          onSelect={() => void workspace.requestSave(document, true)}
        >
          另存为…
        </MainMenu.Item>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.Preferences />
        <MainMenu.DefaultItems.Help />
        <MainMenu.Separator />
        <MainMenu.Item icon={ExcalLogo} onSelect={workspace.showProjects}>
          返回项目页
        </MainMenu.Item>
        <MainMenu.Item icon={settingsIcon} onSelect={onSettings}>
          桌面设置
        </MainMenu.Item>
      </MainMenu>
    </Excalidraw>
  </section>
);

export const App = ({ root }: { root: HTMLElement }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [edit, setEdit] = useState<ProjectEdit | null>(null);
  const workspace = useWorkspace(root, settingsOpen || recoveryOpen || !!edit);
  const { projectsVisible, openFiles, closing } = workspace;
  const [systemDark, setSystemDark] = useState(
    () =>
      root.ownerDocument.defaultView!.matchMedia("(prefers-color-scheme: dark)")
        .matches,
  );
  const theme =
    workspace.settings.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : workspace.settings.theme;
  const active = workspace.documents.find(
    (document) => document.id === workspace.activeId,
  );
  const modalOpen =
    settingsOpen || recoveryOpen || !!edit || !!workspace.closePrompt;
  const libraryAdapter = useMemo<LibraryPersistenceAdapter>(
    () => ({
      load: () => {
        const value = root.ownerDocument.defaultView!.localStorage.getItem(
          "excalidraw-desktop-library",
        );
        return value ? JSON.parse(value) : null;
      },
      save: (data) =>
        root.ownerDocument.defaultView!.localStorage.setItem(
          "excalidraw-desktop-library",
          JSON.stringify(data),
        ),
    }),
    [root],
  );
  useHandleLibrary({
    excalidrawAPI: active?.api || null,
    adapter: libraryAdapter,
    validateLibraryUrl: () => false,
  });

  useEffect(() => {
    const media = root.ownerDocument.defaultView!.matchMedia(
      "(prefers-color-scheme: dark)",
    );
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [root]);

  useEffect(() => {
    if (!projectsVisible || modalOpen || closing) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openFiles();
      }
    };
    root.ownerDocument.addEventListener("keydown", onKeyDown);
    return () => root.ownerDocument.removeEventListener("keydown", onKeyDown);
  }, [root, projectsVisible, modalOpen, closing, openFiles]);

  return (
    <div
      className={`excalidraw desktop-shell${
        theme === "dark" ? " theme--dark" : ""
      }`}
    >
      <header
        className="desktop-titlebar"
        inert={workspace.closing || modalOpen}
      >
        <Button
          className={`desktop-home-button${
            workspace.projectsVisible ? " selected" : ""
          }`}
          onSelect={workspace.showProjects}
          title="项目页 · ⌘⇧P"
          aria-label="返回项目页"
        >
          {ExcalLogo}
          <span>项目</span>
        </Button>
        <nav className="desktop-tabs" aria-label="已打开的画布" role="tablist">
          {workspace.documents.map((document) => (
            <div
              className={`desktop-tab${
                !workspace.projectsVisible && workspace.activeId === document.id
                  ? " is-active"
                  : ""
              }`}
              key={document.id}
            >
              <InlineTabTitle
                document={document}
                selected={
                  !workspace.projectsVisible &&
                  workspace.activeId === document.id
                }
                onActivate={workspace.activate}
                onRename={workspace.renameDocument}
              />
              <button
                className="desktop-tab-close"
                onClick={() => void workspace.closeDocument(document.id)}
                aria-label={`关闭 ${document.title}`}
                title="关闭画布"
              >
                {CloseIcon}
              </button>
            </div>
          ))}
        </nav>
        <Button
          className="desktop-titlebar-new"
          onSelect={workspace.newDocument}
          aria-label="新建画布"
          title="新建画布 · ⌘N"
        >
          {PlusIcon}
        </Button>
        {active && !workspace.projectsVisible && (
          <span className="desktop-save-status">
            {active.saving
              ? "正在保存…"
              : active.dirty
              ? "未保存"
              : active.path
              ? "已保存"
              : "新画布"}
          </span>
        )}
      </header>
      {workspace.error && (
        <div className="desktop-error-banner" role="alert">
          <span>{workspace.error}</span>
          <Button onSelect={workspace.clearError} aria-label="关闭错误提示">
            {CloseIcon}
          </Button>
        </div>
      )}
      <div className="desktop-workspace">
        {workspace.loading ? (
          <div className="desktop-loading">正在打开本地工作区…</div>
        ) : (
          <>
            <div
              className={`desktop-project-pane${
                workspace.projectsVisible ? " is-active" : ""
              }`}
              aria-hidden={!workspace.projectsVisible}
              inert={
                !workspace.projectsVisible || modalOpen || workspace.closing
              }
            >
              <Projects
                root={root}
                workspace={workspace}
                theme={theme}
                active={workspace.projectsVisible && !modalOpen && !closing}
                onEdit={setEdit}
                onSettings={() => setSettingsOpen(true)}
                onRecovery={() => setRecoveryOpen(true)}
              />
            </div>
            {workspace.documents.map((document) => (
              <Editor
                key={document.id}
                root={root}
                document={document}
                workspace={workspace}
                theme={theme}
                blocked={modalOpen || workspace.closing}
                active={
                  !workspace.projectsVisible &&
                  document.id === workspace.activeId
                }
                onSettings={() => setSettingsOpen(true)}
              />
            ))}
          </>
        )}
      </div>
      {settingsOpen && (
        <Modal
          root={root}
          title="桌面设置"
          onClose={() => setSettingsOpen(false)}
        >
          <div className="desktop-modal-body">
            <h3>外观</h3>
            <div className="desktop-theme-options">
              {(
                [
                  ["light", "浅色", SunIcon],
                  ["dark", "深色", MoonIcon],
                  ["system", "跟随系统", DeviceDesktopIcon],
                ] as const
              ).map(([value, label, icon]) => (
                <Button
                  key={value}
                  selected={workspace.settings.theme === value}
                  onSelect={() => void workspace.changeTheme(value)}
                >
                  {icon}
                  {label}
                </Button>
              ))}
            </div>
            <h3>默认文件夹</h3>
            <p className="desktop-settings-path">
              {workspace.settings.rootDirectory || "尚未设置"}
            </p>
            <p>这里的 .excalidraw 文件显示在项目页，子文件夹对应分类。</p>
            <Button onSelect={workspace.changeDirectory}>选择文件夹…</Button>
          </div>
          <footer>
            <Button
              className="desktop-primary"
              onSelect={() => setSettingsOpen(false)}
            >
              完成
            </Button>
          </footer>
        </Modal>
      )}
      {recoveryOpen && (
        <Modal
          root={root}
          title="恢复未保存的画布"
          onClose={() => setRecoveryOpen(false)}
        >
          <div className="desktop-modal-body">
            <p>恢复草稿会打开成独立画布，保存时由你选择文件位置。</p>
            <div className="desktop-draft-list">
              {workspace.drafts.map((draft) => (
                <article key={draft.id}>
                  <div>
                    <strong>{draft.title}</strong>
                    <small>
                      {new Date(draft.modifiedAt).toLocaleString("zh-CN")}
                    </small>
                    {draft.path && (
                      <small title={draft.path}>{draft.path}</small>
                    )}
                  </div>
                  <Button
                    onSelect={() => void workspace.discardDraft(draft.id)}
                  >
                    放弃
                  </Button>
                  <Button
                    className="desktop-primary"
                    onSelect={async () => {
                      if (await workspace.recover(draft)) {
                        setRecoveryOpen(false);
                      }
                    }}
                  >
                    恢复
                  </Button>
                </article>
              ))}
              {!workspace.drafts.length && <p>没有待恢复的草稿。</p>}
            </div>
          </div>
          <footer>
            <Button onSelect={() => setRecoveryOpen(false)}>稍后处理</Button>
          </footer>
        </Modal>
      )}
      {edit && (
        <ProjectEditModal
          key={
            edit.kind === "folder" ? "folder" : `${edit.kind}:${edit.file.path}`
          }
          root={root}
          workspace={workspace}
          edit={edit}
          onClose={() => setEdit(null)}
        />
      )}
      {workspace.closePrompt && (
        <Modal
          root={root}
          title="保存画布更改？"
          onClose={() => workspace.closePrompt?.resolve("cancel")}
        >
          <div className="desktop-modal-body">
            <p>「{workspace.closePrompt.title}」有未保存的更改。</p>
            <p>放弃后，这些更改将不会保留。</p>
          </div>
          <footer>
            <Button onSelect={() => workspace.closePrompt?.resolve("discard")}>
              放弃更改
            </Button>
            <Button onSelect={() => workspace.closePrompt?.resolve("cancel")}>
              取消
            </Button>
            <Button
              className="desktop-primary"
              onSelect={() => workspace.closePrompt?.resolve("save")}
            >
              保存
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
};
