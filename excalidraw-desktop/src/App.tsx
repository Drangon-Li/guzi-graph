import { useEffect, useMemo, useRef, useState } from "react";

import { Button, MainMenu, useHandleLibrary } from "@excalidraw/excalidraw";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  CloseIcon,
  ExcalLogo,
  ExportIcon,
  exportToFileIcon,
  LoadIcon,
  PlusIcon,
  saveAs,
  settingsIcon,
} from "@excalidraw/excalidraw/components/icons";

import type { PreferenceSection } from "@excalidraw/excalidraw/types";

import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";

import { fileTitle } from "./document";
import { translate } from "./i18n";
import { DesktopSelect } from "./DesktopControls";
import { StructuredExportDialog } from "./StructuredExportDialog";
import { exportCanvasPdf } from "./structuredExport";
import { InlineTabTitle } from "./InlineTabTitle";
import { Projects } from "./Projects";
import { useWorkspace } from "./workspace";
import { PreferencePanel } from "./PreferencePanel";
import { resolveEditorPreferences } from "./editorPreferences";
import { SubcanvasEditor } from "./SubcanvasEditor";
import { SettingsPanel } from "./SettingsPanel";
import {
  DEFAULT_STYLE_PRESETS,
  applyStylePreset,
  getStyleShortcut,
} from "./stylePresets";

import "./styles.scss";

import type { ProjectEdit } from "./Projects";
import type { DesktopLanguage } from "./i18n";
import type { ProjectFile } from "./shared";
import type { CanvasDocument, Workspace } from "./workspace";
import type { ReactNode } from "react";

const Modal = ({
  root,
  title,
  language,
  children,
  onClose,
  className = "",
}: {
  root: HTMLElement;
  title: string;
  language: DesktopLanguage;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) => {
  const t = (message: string) => translate(language, message);
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
          "button:not(:disabled):not([tabindex='-1']), input:not(:disabled):not([tabindex='-1']), [tabindex='0']",
        ),
      );
    const frame = ownerWindow.requestAnimationFrame(() => {
      const initial =
        node.querySelector<HTMLElement>(
          "input:not(:disabled):not([tabindex='-1'])",
        ) || focusable()[0];
      initial?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (root.querySelector(".desktop-select-content[data-state='open']")) {
        return;
      }
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
        className={`desktop-modal ${className}`}
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <Button
            aria-label={t("关闭对话框")}
            title={t("关闭")}
            onSelect={onClose}
          >
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
  const t = (message: string) =>
    translate(workspace.settings.language, message);
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
      ? t("新建分类")
      : edit.kind === "move"
      ? t("移动到分类")
      : t("重命名画布");
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
    <Modal
      root={root}
      title={title}
      language={workspace.settings.language}
      onClose={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="desktop-modal-body">
          {edit.kind === "move" ? (
            <div className="desktop-form-label">
              <span>{t("目标文件夹")}</span>
              <DesktopSelect
                root={root}
                label={t("目标文件夹")}
                value={value}
                onValueChange={setValue}
                options={[
                  { value: "", label: t("未分类（默认文件夹）") },
                  ...workspace.index.folders.map((folder) => ({
                    value: folder,
                    label: folder,
                  })),
                ]}
              />
            </div>
          ) : (
            <label className="desktop-form-label">
              <TextField
                value={value}
                onChange={setValue}
                label={edit.kind === "folder" ? t("文件夹名称") : t("画布名称")}
                fullWidth
                selectOnRender
              />
            </label>
          )}
          <p>
            {edit.kind === "folder"
              ? t("分类会在默认文件夹内创建真实文件夹。")
              : edit.kind === "rename"
              ? t("文件名会同步更新，扩展名保持 .excalidraw。")
              : t("文件会移入默认文件夹下所选的分类，原位置将不再保留。")}
          </p>
          {failed && (
            <p className="desktop-inline-error" role="alert">
              {workspace.error || t("操作失败，请重试。")}
            </p>
          )}
        </div>
        <footer>
          <Button onSelect={close} disabled={busy}>
            {t("取消")}
          </Button>
          <Button
            type="submit"
            onSelect={() => {}}
            className="desktop-primary"
            disabled={busy || (edit.kind !== "move" && !value.trim())}
          >
            {busy ? t("处理中…") : t("确定")}
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
  onPreferences,
  onStructuredExport,
}: {
  document: CanvasDocument;
  active: boolean;
  blocked: boolean;
  theme: "light" | "dark";
  root: HTMLElement;
  workspace: Workspace;
  onSettings: () => void;
  onPreferences: (section: PreferenceSection) => void;
  onStructuredExport: () => void;
}) => {
  const t = (message: string) =>
    translate(workspace.settings.language, message);
  return (
    <section
      className={`desktop-editor-pane${active ? " is-active" : ""}`}
      data-document-id={document.id}
      aria-hidden={!active}
      inert={!active || blocked}
    >
      <SubcanvasEditor
        document={document}
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
          onConfigurePreferences: onPreferences,
          backgroundTopPicks:
            workspace.settings.editorPreferences?.backgroundTopPicks,
          fontSizePresets: resolveEditorPreferences(
            workspace.settings.editorPreferences,
          ).fontSizePresets,
          toolbarTooltips: workspace.settings.toolbarTooltips ?? true,
          selectionToolbar: workspace.settings.selectionToolbar ?? true,
          onStickyNoteModeChange: (stickyNoteMode) =>
            void workspace.updateSettings({ stickyNoteMode }),
          toolPanel: {
            dock:
              workspace.settings.toolPanelDock === "right" ? "right" : "left",
            pinned: workspace.settings.toolPanelPinned ?? false,
            onPinnedChange: (pinned) =>
              void workspace.updateSettings({ toolPanelPinned: pinned }),
            width: workspace.settings.toolPanelWidth ?? 280,
            onWidthChange: (width) =>
              void workspace.updateSettings({ toolPanelWidth: width }),
            onDockChange: (dock) =>
              void workspace.updateSettings({ toolPanelDock: dock }),
            labels: {
              title: t("工具侧栏"),
              canvas: t("画布"),
              properties: t("元素"),
              pin: t("保持工具侧栏展开"),
              pinLeft: t("放到左侧"),
              pinRight: t("放到右侧"),
              unpin: t("取消固定"),
              collapse: t("收起工具侧栏"),
              expand: t("展开工具侧栏"),
              resize: t("调整工具侧栏宽度"),
            },
          },
          save: (snapshot, saveAs) =>
            workspace.editorSave(document, snapshot, saveAs),
          open: workspace.openFiles,
        }}
        interaction={active && !blocked}
        handleKeyboardGlobally={active && !blocked}
        autoFocus={active}
        langCode={workspace.settings.language}
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
            {t("新建画布")}
          </MainMenu.Item>
          <MainMenu.Item
            icon={LoadIcon}
            shortcut="⌘O"
            onSelect={() => void workspace.openFiles()}
          >
            {t("打开文件…")}
          </MainMenu.Item>
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.Item
            icon={saveAs}
            shortcut="⌘⇧S"
            onSelect={() => void workspace.requestSave(document, true)}
          >
            {t("另存为…")}
          </MainMenu.Item>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.Item icon={exportToFileIcon} onSelect={onStructuredExport}>
            {t("导出结构化信息…")}
          </MainMenu.Item>
          <MainMenu.Item
            icon={ExportIcon}
            onSelect={() => {
              if (document.api) {
                document.flushEditing?.();
                void exportCanvasPdf(
                  document.api,
                  document.title,
                  root.ownerDocument.defaultView!.desktop,
                  { snapshot: document.getSnapshot?.() },
                ).catch(workspace.reportError);
              }
            }}
          >
            {t("导出 PDF…")}
          </MainMenu.Item>
          <MainMenu.Item
            icon={ExportIcon}
            onSelect={() => {
              if (document.api) {
                document.flushEditing?.();
                void exportCanvasPdf(
                  document.api,
                  document.title,
                  root.ownerDocument.defaultView!.desktop,
                  { includeSubcanvases: true },
                ).catch(workspace.reportError);
              }
            }}
          >
            {workspace.settings.language === "en"
              ? "Export PDF with subcanvases…"
              : "导出 PDF（包含子画布）…"}
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Preferences />
          <MainMenu.DefaultItems.Help />
          <MainMenu.Separator />
          <MainMenu.Item icon={ExcalLogo} onSelect={workspace.showProjects}>
            {t("返回项目页")}
          </MainMenu.Item>
          <MainMenu.Item icon={settingsIcon} onSelect={onSettings}>
            {t("桌面设置")}
          </MainMenu.Item>
        </MainMenu>
      </SubcanvasEditor>
    </section>
  );
};

const RemoveConfirmation = ({
  root,
  workspace,
  file,
  mode,
  onClose,
  onConfirm,
}: {
  root: HTMLElement;
  workspace: Workspace;
  file: ProjectFile;
  mode: "remove" | "trash";
  onClose: () => void;
  onConfirm: (skip: boolean) => void;
}) => {
  const [skip, setSkip] = useState(false);
  const t = (message: string, params?: Record<string, string | number>) =>
    translate(workspace.settings.language, message, params);
  return (
    <Modal
      root={root}
      language={workspace.settings.language}
      title={t(mode === "remove" ? "删除画布？" : "彻底删除画布？")}
      onClose={onClose}
    >
      <div className="desktop-modal-body">
        <p>
          {t(
            mode === "remove"
              ? "「{title}」将从软件中隐藏，原文件会保留在当前位置。"
              : "「{title}」将移到 macOS 废纸篓，并从项目页移除。",
            { title: fileTitle(file.name) },
          )}
        </p>
        <p>
          {t(
            mode === "remove"
              ? "以后可通过打开原文件将它重新加入项目页。"
              : "可从废纸篓恢复；清空废纸篓后将无法恢复。",
          )}
        </p>
        <label className="desktop-checkbox-label">
          <input
            type="checkbox"
            checked={skip}
            onChange={(event) => setSkip(event.target.checked)}
          />
          {t("不再提示此操作")}
        </label>
      </div>
      <footer>
        <Button onSelect={onClose}>{t("取消")}</Button>
        <Button className="desktop-danger" onSelect={() => onConfirm(skip)}>
          {t(mode === "remove" ? "删除" : "移到废纸篓")}
        </Button>
      </footer>
    </Modal>
  );
};

export const App = ({ root }: { root: HTMLElement }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] =
    useState<PreferenceSection | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [edit, setEdit] = useState<ProjectEdit | null>(null);
  const [removal, setRemoval] = useState<{
    file: ProjectFile;
    mode: "remove" | "trash";
  } | null>(null);
  const [structuredExport, setStructuredExport] =
    useState<CanvasDocument | null>(null);
  const workspace = useWorkspace(
    root,
    settingsOpen ||
      !!preferencesSection ||
      recoveryOpen ||
      !!edit ||
      !!removal ||
      !!structuredExport,
  );
  const t = (message: string, params?: Record<string, string | number>) =>
    translate(workspace.settings.language, message, params);
  const removeFile = async (
    file: ProjectFile,
    mode: "remove" | "trash",
    skip = false,
  ) => {
    setRemoval(null);
    if (await workspace.removeFile(file, mode)) {
      if (skip) {
        await workspace.updateSettings(
          mode === "remove"
            ? { skipRemoveConfirmation: true }
            : { skipTrashConfirmation: true },
        );
      }
    }
  };
  const requestRemoval = (file: ProjectFile, mode: "remove" | "trash") => {
    if (
      mode === "remove"
        ? workspace.settings.skipRemoveConfirmation
        : workspace.settings.skipTrashConfirmation
    ) {
      void removeFile(file, mode);
    } else {
      setRemoval({ file, mode });
    }
  };
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
    settingsOpen ||
    !!preferencesSection ||
    recoveryOpen ||
    !!edit ||
    !!removal ||
    !!structuredExport ||
    !!workspace.closePrompt;
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

  useEffect(() => {
    if (projectsVisible || modalOpen || closing || !active) {
      return;
    }
    const ownerDocument = root.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    const handlePreset = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) {
        return;
      }
      const target = event.target;
      if (
        target instanceof ownerWindow.Element &&
        target.closest(
          "input, textarea, select, [contenteditable='true'], [role='textbox']",
        )
      ) {
        return;
      }
      const shortcut = getStyleShortcut(event);
      const preset = (
        workspace.settings.stylePresets ?? DEFAULT_STYLE_PRESETS
      ).find(
        (candidate) => candidate.shortcut && candidate.shortcut === shortcut,
      );
      const api = active.activeEditor?.() ?? active.api;
      if (!preset || !api) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyStylePreset(api, preset);
    };
    ownerDocument.addEventListener("keydown", handlePreset, true);
    return () =>
      ownerDocument.removeEventListener("keydown", handlePreset, true);
  }, [
    root,
    projectsVisible,
    modalOpen,
    closing,
    active,
    workspace.settings.stylePresets,
  ]);

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
          title={t("项目页 · ⌘⇧P")}
          aria-label={t("返回项目页")}
        >
          {ExcalLogo}
          <span>Excalidraw-Guzi</span>
        </Button>
        <nav
          className="desktop-tabs"
          aria-label={t("已打开的画布")}
          role="tablist"
        >
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
                language={workspace.settings.language}
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
                aria-label={t("关闭 {title}", { title: document.title })}
                title={t("关闭画布")}
              >
                {CloseIcon}
              </button>
            </div>
          ))}
        </nav>
        <Button
          className="desktop-titlebar-new"
          onSelect={workspace.newDocument}
          aria-label={t("新建画布")}
          title={t("新建画布 · ⌘N")}
        >
          {PlusIcon}
        </Button>
        {active && !workspace.projectsVisible && (
          <span className="desktop-save-status">
            {active.saving
              ? t("正在保存…")
              : active.dirty
              ? t("未保存")
              : active.path
              ? t("已保存")
              : t("新画布")}
          </span>
        )}
      </header>
      {workspace.error && (
        <div className="desktop-error-banner" role="alert">
          <span>{workspace.error}</span>
          <Button
            onSelect={workspace.clearError}
            aria-label={t("关闭错误提示")}
          >
            {CloseIcon}
          </Button>
        </div>
      )}
      <div className="desktop-workspace">
        {workspace.loading ? (
          <div className="desktop-loading">{t("正在打开本地工作区…")}</div>
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
                onRemove={requestRemoval}
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
                onPreferences={setPreferencesSection}
                onStructuredExport={() => {
                  document.flushEditing?.();
                  setStructuredExport(document);
                }}
              />
            ))}
          </>
        )}
      </div>
      {settingsOpen && (
        <Modal
          root={root}
          language={workspace.settings.language}
          title={t("桌面设置")}
          className="desktop-settings-dialog"
          onClose={() => setSettingsOpen(false)}
        >
          <SettingsPanel
            root={root}
            settings={workspace.settings}
            onChange={workspace.updateSettings}
            onChangeDirectory={workspace.changeDirectory}
          />
          <footer>
            <span>
              {workspace.settings.language === "en"
                ? "Settings are saved on this device"
                : "设置保存在此设备"}
            </span>
            <Button
              className="desktop-primary"
              onSelect={() => setSettingsOpen(false)}
            >
              {t("完成")}
            </Button>
          </footer>
        </Modal>
      )}
      {preferencesSection && (
        <Modal
          root={root}
          language={workspace.settings.language}
          title={
            {
              fonts:
                workspace.settings.language === "en"
                  ? "Fonts and shortcuts"
                  : "字体与快捷项",
              background:
                workspace.settings.language === "en"
                  ? "Canvas backgrounds"
                  : "画布背景",
              elementStroke:
                workspace.settings.language === "en"
                  ? "Stroke colors"
                  : "描边颜色",
              elementBackground:
                workspace.settings.language === "en"
                  ? "Fill colors"
                  : "填充颜色",
              fontSizes:
                workspace.settings.language === "en"
                  ? "Font sizes"
                  : "字号快捷项",
            }[preferencesSection]
          }
          onClose={() => setPreferencesSection(null)}
        >
          <div className="desktop-modal-body">
            <PreferencePanel
              root={root}
              preferences={workspace.settings.editorPreferences}
              section={preferencesSection}
              language={workspace.settings.language}
              onChange={async (editorPreferences) => {
                if (!(await workspace.updateSettings({ editorPreferences }))) {
                  throw new Error(
                    workspace.error ||
                      (workspace.settings.language === "en"
                        ? "Unable to save preferences"
                        : "偏好保存失败"),
                  );
                }
              }}
            />
          </div>
          <footer>
            <Button onSelect={() => setPreferencesSection(null)}>
              {t("完成")}
            </Button>
          </footer>
        </Modal>
      )}
      {recoveryOpen && (
        <Modal
          root={root}
          language={workspace.settings.language}
          title={t("恢复未保存的画布")}
          onClose={() => setRecoveryOpen(false)}
        >
          <div className="desktop-modal-body">
            <p>{t("恢复草稿会打开成独立画布，保存时由你选择文件位置。")}</p>
            <div className="desktop-draft-list">
              {workspace.drafts.map((draft) => (
                <article key={draft.id}>
                  <div>
                    <strong>{draft.title}</strong>
                    <small>
                      {new Date(draft.modifiedAt).toLocaleString(
                        workspace.settings.language,
                      )}
                    </small>
                    {draft.path && (
                      <small title={draft.path}>{draft.path}</small>
                    )}
                  </div>
                  <Button
                    onSelect={() => void workspace.discardDraft(draft.id)}
                  >
                    {t("放弃")}
                  </Button>
                  <Button
                    className="desktop-primary"
                    onSelect={async () => {
                      if (await workspace.recover(draft)) {
                        setRecoveryOpen(false);
                      }
                    }}
                  >
                    {t("恢复")}
                  </Button>
                </article>
              ))}
              {!workspace.drafts.length && <p>{t("没有待恢复的草稿。")}</p>}
            </div>
          </div>
          <footer>
            <Button onSelect={() => setRecoveryOpen(false)}>
              {t("稍后处理")}
            </Button>
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
      {removal && (
        <RemoveConfirmation
          root={root}
          workspace={workspace}
          file={removal.file}
          mode={removal.mode}
          onClose={() => setRemoval(null)}
          onConfirm={(skip) =>
            void removeFile(removal.file, removal.mode, skip)
          }
        />
      )}
      {structuredExport?.api && (
        <StructuredExportDialog
          root={root}
          api={structuredExport.api}
          getSnapshot={structuredExport.getSnapshot}
          title={structuredExport.title}
          language={workspace.settings.language}
          defaultFormat={workspace.settings.structuredExportFormat}
          includeInferredStructure={workspace.settings.includeInferredStructure}
          onClose={() => setStructuredExport(null)}
        />
      )}
      {workspace.closePrompt && (
        <Modal
          root={root}
          language={workspace.settings.language}
          title={t("保存画布更改？")}
          onClose={() => workspace.closePrompt?.resolve("cancel")}
        >
          <div className="desktop-modal-body">
            <p>
              {t("「{title}」有未保存的更改。", {
                title: workspace.closePrompt.title,
              })}
            </p>
            <p>{t("放弃后，这些更改将不会保留。")}</p>
          </div>
          <footer>
            <Button onSelect={() => workspace.closePrompt?.resolve("discard")}>
              {t("放弃更改")}
            </Button>
            <Button onSelect={() => workspace.closePrompt?.resolve("cancel")}>
              {t("取消")}
            </Button>
            <Button
              className="desktop-primary"
              onSelect={() => workspace.closePrompt?.resolve("save")}
            >
              {t("保存")}
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
};
