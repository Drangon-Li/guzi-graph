const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { translate } = require("./i18n/i18n.cjs");

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THEMES = new Set(["light", "dark", "system"]);
const EXPORT_EXTENSIONS = new Set([
  "png",
  "svg",
  "json",
  "md",
  "excalidraw",
  "excalidrawlib",
]);
const inside = (root, target) =>
  target === root ||
  (!path.relative(root, target).startsWith(`..${path.sep}`) &&
    path.relative(root, target) !== ".." &&
    !path.isAbsolute(path.relative(root, target)));
const fail = (message, code = "INVALID_PATH") =>
  Object.assign(new Error(message), { code });

function fileName(value, extension = "excalidraw", language = "zh-CN") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    // eslint-disable-next-line no-control-regex -- Control characters are intentionally rejected in user-supplied names.
    /[\\/\x00-\x1f]/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw fail(translate(language, "请输入有效的文件名。"));
  }
  return value.toLowerCase().endsWith(`.${extension}`)
    ? value
    : `${value}.${extension}`;
}

function categoryParts(value) {
  if (
    typeof value !== "string" ||
    path.isAbsolute(value) ||
    // eslint-disable-next-line no-control-regex -- Control characters are intentionally rejected in user-supplied names.
    /[\\\x00-\x1f]/.test(value)
  ) {
    throw fail("分类必须是根目录内的相对路径。");
  }
  if (!value) {
    return [];
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part !== part.trim(),
    )
  ) {
    throw fail("分类路径无效。");
  }
  return parts;
}

function documentPath(value, language = "zh-CN") {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.extname(value).toLowerCase() !== ".excalidraw"
  ) {
    throw fail(translate(language, "请选择 .excalidraw 文件。"));
  }
  return path.resolve(value);
}

async function atomicWrite(target, content) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    const existing = await fs.stat(target).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return null;
    });
    handle = await fs.open(
      temporary,
      "wx",
      existing ? existing.mode & 0o777 : 0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

class DesktopStorage {
  constructor(userData) {
    this.userData = userData;
    this.settings = {
      rootDirectory: null,
      theme: "system",
      toolPanelDock: "floating",
      toolPanelWidth: 280,
      toolPanelPinned: false,
      toolbarTooltips: true,
      selectionToolbar: true,
      stickyNoteMode: "note",
      stylePresets: [
        {
          id: "solid-arrow",
          name: "实线箭头",
          shortcut: "Alt+1",
          tool: "arrow",
          strokeStyle: "solid",
          strokeWidth: 2,
          strokeColor: "#1e1e1e",
          endArrowhead: "arrow",
        },
        {
          id: "dashed-arrow",
          name: "虚线箭头",
          shortcut: "Alt+2",
          tool: "arrow",
          strokeStyle: "dashed",
          strokeWidth: 2,
          strokeColor: "#1e1e1e",
          endArrowhead: "arrow",
        },
      ],
      editorPreferences: {
        defaultFontFamily: 5,
        defaultBackground: "#ffffff",
        defaultStrokeColor: "#1e1e1e",
        defaultElementBackground: "transparent",
        elementStrokeTopPicks: [
          "#1e1e1e",
          "#e03131",
          "#2f9e44",
          "#1971c2",
          "#f08c00",
        ],
        elementBackgroundTopPicks: [
          "transparent",
          "#ffc9c9",
          "#b2f2bb",
          "#a5d8ff",
          "#ffec99",
        ],
        fontSizePresets: { sm: 16, md: 20, lg: 28, xl: 36 },
        fontTopPicks: [5, 6, 8],
        backgroundTopPicks: [
          "#ffffff",
          "#f8f9fa",
          "#f5faff",
          "#fffce8",
          "#fdf8f6",
        ],
        systemFonts: [],
      },
      language: "zh-CN",
      structuredExportFormat: "json",
      includeInferredStructure: true,
      skipRemoveConfirmation: false,
      skipTrashConfirmation: false,
    };
    this.hiddenPaths = new Set();
    this.session = { paths: [], activePath: null };
    this.recentFiles = new Map();
    this.authorized = new Set();
    this.copiedVersions = new Map();
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.userData, { recursive: true });
    await fs.mkdir(path.join(this.userData, "drafts"), { recursive: true });
    const readJson = async (name) => {
      try {
        return JSON.parse(
          await fs.readFile(path.join(this.userData, name), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
        return null;
      }
    };
    const settings = await readJson("settings.json");
    for (const key of [
      "toolPanelDock",
      "toolPanelWidth",
      "toolPanelPinned",
      "toolbarTooltips",
      "selectionToolbar",
      "stickyNoteMode",
      "editorPreferences",
      "stylePresets",
      "language",
      "structuredExportFormat",
      "includeInferredStructure",
      "skipRemoveConfirmation",
      "skipTrashConfirmation",
    ]) {
      if (this.validSetting(key, settings?.[key])) {
        this.settings[key] =
          key === "editorPreferences"
            ? { ...this.settings.editorPreferences, ...settings[key] }
            : settings[key];
      }
    }
    const hidden = await readJson("hidden-files.json");
    for (const candidate of Array.isArray(hidden) ? hidden : []) {
      try {
        this.hiddenPaths.add(this.documentPath(candidate));
      } catch {}
    }
    if (THEMES.has(settings?.theme)) {
      this.settings.theme = settings.theme;
    }
    if (
      typeof settings?.rootDirectory === "string" &&
      path.isAbsolute(settings.rootDirectory)
    ) {
      const root = await fs.realpath(settings.rootDirectory).catch(() => null);
      if (root && (await fs.stat(root)).isDirectory()) {
        this.settings.rootDirectory = root;
      }
    }
    const session = await readJson("session.json");
    if (Array.isArray(session?.paths)) {
      for (const candidate of session.paths) {
        try {
          const target = this.documentPath(candidate);
          if (!this.hiddenPaths.has(target)) {
            this.authorized.add(target);
          }
        } catch {
          /* Ignore a malformed persisted entry. */
        }
      }
      this.session.paths = [...this.authorized];
      this.session.activePath = this.authorized.has(session.activePath)
        ? session.activePath
        : null;
    }
    const recentFiles = await readJson("recent-files.json");
    if (Array.isArray(recentFiles)) {
      for (const entry of recentFiles) {
        try {
          const candidate = this.documentPath(entry?.path);
          if (this.hiddenPaths.has(candidate)) {
            continue;
          }
          if (!Number.isFinite(entry.lastOpenedAt) || entry.lastOpenedAt < 0) {
            continue;
          }
          this.recentFiles.set(
            candidate,
            Math.max(this.recentFiles.get(candidate) || 0, entry.lastOpenedAt),
          );
          this.authorized.add(candidate);
        } catch {
          /* Ignore a malformed persisted entry. */
        }
      }
    } else if (this.session.paths.length) {
      const lastOpenedAt = Date.now();
      await this.persistRecentFiles(
        new Map(
          this.session.paths.map((candidate) => [candidate, lastOpenedAt]),
        ),
      );
    }
    return this;
  }

  async persistRecentFiles(recentFiles) {
    await atomicWrite(
      path.join(this.userData, "recent-files.json"),
      JSON.stringify(
        [...recentFiles].map(([path, lastOpenedAt]) => ({
          path,
          lastOpenedAt,
        })),
      ),
    );
    this.recentFiles = recentFiles;
  }

  async recordRecentFile(target) {
    const recentFiles = new Map(this.recentFiles);
    recentFiles.set(target, Date.now());
    await this.persistRecentFiles(recentFiles);
  }

  recordOpenedFile(candidate) {
    return this.serialize(async () => {
      const target = await this.allowedPath(candidate);
      if (!(await fs.stat(target)).isFile()) {
        throw this.fail("目标不是文件。");
      }
      if (this.hiddenPaths.has(target)) {
        await this.persistHiddenPaths(
          new Set([...this.hiddenPaths].filter((item) => item !== target)),
        );
      }
      await this.recordRecentFile(target);
    });
  }

  serialize(action) {
    const work = this.queue.then(action).catch((error) => {
      error.message = translate(this.settings.language, error.message);
      throw error;
    });
    this.queue = work.catch(() => {});
    return work;
  }

  documentPath(value) {
    return documentPath(value, this.settings.language);
  }

  fail(message, code) {
    return fail(translate(this.settings.language, message), code);
  }

  validSetting(key, value) {
    if (key === "stylePresets") {
      if (!Array.isArray(value) || value.length > 30) {
        return false;
      }
      const ids = new Set();
      const shortcuts = new Set();
      for (const preset of value) {
        if (
          !preset ||
          typeof preset.id !== "string" ||
          !preset.id ||
          preset.id.length > 80 ||
          ids.has(preset.id) ||
          typeof preset.name !== "string" ||
          !preset.name.trim() ||
          preset.name.length > 100 ||
          typeof preset.shortcut !== "string" ||
          (preset.shortcut !== "" &&
            !/^(Ctrl\+)?(Meta\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down))$/.test(
              preset.shortcut,
            )) ||
          (preset.shortcut &&
            (!/^(Ctrl|Meta|Alt)\+/.test(preset.shortcut) ||
              shortcuts.has(preset.shortcut))) ||
          /^(Ctrl|Meta)\+(Shift\+)?(S|O|N|W|Q|Z|X|C|V|A|F|P)$/.test(
            preset.shortcut,
          ) ||
          !["arrow", "line", "rectangle", "ellipse"].includes(preset.tool) ||
          !["solid", "dashed", "dotted"].includes(preset.strokeStyle) ||
          ![1, 2, 4].includes(preset.strokeWidth) ||
          typeof preset.strokeColor !== "string" ||
          !/^#[a-fA-F0-9]{6}$/.test(preset.strokeColor) ||
          (preset.endArrowhead !== undefined &&
            preset.endArrowhead !== null &&
            preset.endArrowhead !== "arrow")
        ) {
          return false;
        }
        ids.add(preset.id);
        if (preset.shortcut) {
          shortcuts.add(preset.shortcut);
        }
      }
      return true;
    }
    if (key === "editorPreferences") {
      const validFamily = (family) =>
        typeof family === "string" &&
        family.trim().length > 0 &&
        family.length <= 200 &&
        // eslint-disable-next-line no-control-regex -- Control characters are intentionally rejected in user-supplied names.
        !/[\u0000-\u001f\u007f]/.test(family);
      const validId = (id) => Number.isSafeInteger(id) && id > 0;
      const validColor = (color) =>
        typeof color === "string" && /^#[a-fA-F0-9]{6}$/.test(color);
      const validElementColor = (color) =>
        color === "transparent" || validColor(color);
      const validPicks = (picks) =>
        Array.isArray(picks) &&
        picks.length > 0 &&
        picks.length <= 5 &&
        picks.every(validElementColor);
      const validFontSizes = (sizes) =>
        sizes &&
        typeof sizes === "object" &&
        !Array.isArray(sizes) &&
        ["sm", "md", "lg", "xl"].every(
          (key, index, keys) =>
            Number.isFinite(sizes[key]) &&
            sizes[key] >= 1 &&
            (!index || sizes[key] > sizes[keys[index - 1]]),
        );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Array.isArray(value.systemFonts) ||
        value.systemFonts.length > 500
      ) {
        return false;
      }
      const ids = new Map();
      for (const font of value.systemFonts) {
        if (
          !font ||
          !validId(font.id) ||
          font.id < 100000 ||
          !validFamily(font.family) ||
          ids.has(font.id)
        ) {
          return false;
        }
        ids.set(font.id, font.family);
      }
      const knownId = (id) =>
        validId(id) &&
        ([1, 2, 3, 5, 6, 7, 8, 9, 10].includes(id) || ids.has(id));
      return (
        knownId(value.defaultFontFamily) &&
        (value.defaultFontName === undefined ||
          (validFamily(value.defaultFontName) &&
            (!ids.has(value.defaultFontFamily) ||
              ids.get(value.defaultFontFamily) === value.defaultFontName))) &&
        validColor(value.defaultBackground) &&
        (value.defaultStrokeColor === undefined ||
          validElementColor(value.defaultStrokeColor)) &&
        (value.defaultElementBackground === undefined ||
          validElementColor(value.defaultElementBackground)) &&
        (value.elementStrokeTopPicks === undefined ||
          validPicks(value.elementStrokeTopPicks)) &&
        (value.elementBackgroundTopPicks === undefined ||
          validPicks(value.elementBackgroundTopPicks)) &&
        (value.fontSizePresets === undefined ||
          validFontSizes(value.fontSizePresets)) &&
        Array.isArray(value.fontTopPicks) &&
        value.fontTopPicks.length > 0 &&
        value.fontTopPicks.length <= 3 &&
        value.fontTopPicks.every(knownId) &&
        new Set(value.fontTopPicks).size === value.fontTopPicks.length &&
        Array.isArray(value.backgroundTopPicks) &&
        value.backgroundTopPicks.length > 0 &&
        value.backgroundTopPicks.length <= 5 &&
        value.backgroundTopPicks.every(validColor)
      );
    }
    if (key === "toolPanelWidth") {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 260 &&
        value <= 480
      );
    }
    if (key === "toolPanelDock") {
      return ["floating", "left", "right"].includes(value);
    }
    if (key === "language") {
      return ["zh-CN", "en"].includes(value);
    }
    if (key === "stickyNoteMode") {
      return ["note", "subcanvas"].includes(value);
    }
    if (key === "structuredExportFormat") {
      return ["json", "md"].includes(value);
    }
    return typeof value === "boolean";
  }

  async persistHiddenPaths(paths) {
    await atomicWrite(
      path.join(this.userData, "hidden-files.json"),
      JSON.stringify([...paths]),
    );
    this.hiddenPaths = paths;
  }

  getSettings() {
    return { ...this.settings };
  }

  async updateSettings(update) {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw this.fail("设置无效。");
    }
    if ("theme" in update && !THEMES.has(update.theme)) {
      throw this.fail("主题无效。");
    }
    if (
      "rootDirectory" in update &&
      update.rootDirectory !== null &&
      update.rootDirectory !== this.settings.rootDirectory
    ) {
      throw this.fail("请通过目录选择器设置项目目录。");
    }
    const preferences = {};
    for (const key of [
      "toolPanelDock",
      "toolPanelWidth",
      "toolPanelPinned",
      "toolbarTooltips",
      "selectionToolbar",
      "stickyNoteMode",
      "editorPreferences",
      "stylePresets",
      "language",
      "structuredExportFormat",
      "includeInferredStructure",
      "skipRemoveConfirmation",
      "skipTrashConfirmation",
    ]) {
      if (key in update) {
        if (!this.validSetting(key, update[key])) {
          throw this.fail("设置无效。");
        }
        preferences[key] =
          key === "editorPreferences"
            ? { ...this.settings.editorPreferences, ...update[key] }
            : update[key];
      }
    }
    return this.serialize(async () => {
      const next = {
        ...this.settings,
        ...preferences,
        ...("theme" in update ? { theme: update.theme } : {}),
        ...("rootDirectory" in update
          ? { rootDirectory: update.rootDirectory }
          : {}),
      };
      await atomicWrite(
        path.join(this.userData, "settings.json"),
        JSON.stringify(next),
      );
      this.settings = next;
      return this.getSettings();
    });
  }

  async chooseRoot(directory) {
    const root = await fs.realpath(directory);
    if (!(await fs.stat(root)).isDirectory()) {
      throw this.fail("项目目录无效。");
    }
    return this.serialize(async () => {
      const next = { ...this.settings, rootDirectory: root };
      await atomicWrite(
        path.join(this.userData, "settings.json"),
        JSON.stringify(next),
      );
      this.settings = next;
      return this.getSettings();
    });
  }

  async grantFile(candidate) {
    const resolved = this.documentPath(candidate);
    const real = await fs.realpath(resolved).catch(async (error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return path.join(
        await fs.realpath(path.dirname(resolved)),
        path.basename(resolved),
      );
    });
    const canonical = this.documentPath(real);
    this.authorized.add(canonical);
    return canonical;
  }

  async allowedPath(candidate, { writing = false } = {}) {
    const resolved = this.documentPath(candidate);
    const root = this.settings.rootDirectory;
    const parent = await fs.realpath(path.dirname(resolved));
    let real;
    try {
      real = await fs.realpath(resolved);
    } catch (error) {
      if (!writing || error.code !== "ENOENT") {
        throw error;
      }
      real = path.join(parent, path.basename(resolved));
    }
    if (root && inside(root, resolved) && !inside(root, real)) {
      throw this.fail("符号链接不能越过项目根目录。", "NOT_AUTHORIZED");
    }
    if (!this.authorized.has(real) && !(root && inside(root, real))) {
      throw this.fail("文件未经授权。", "NOT_AUTHORIZED");
    }
    return this.documentPath(real);
  }

  async readFile(candidate) {
    const target = await this.allowedPath(candidate);
    const handle = await fs.open(target, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw this.fail("目标不是文件。");
      }
      const content = await handle.readFile("utf8");
      this.authorized.add(target);
      return {
        path: target,
        content,
        modifiedAt: stat.mtimeMs,
        size: stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  async listProjects() {
    const rootDirectory = this.settings.rootDirectory;
    const history = [];
    for (const [candidate, lastOpenedAt] of this.recentFiles) {
      try {
        if (this.hiddenPaths.has(candidate)) {
          continue;
        }
        const target = await this.allowedPath(candidate);
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          continue;
        }
        const relativePath =
          rootDirectory && inside(rootDirectory, target)
            ? path.relative(rootDirectory, target)
            : target;
        history.push({
          path: target,
          relativePath,
          name: path.basename(target),
          category:
            rootDirectory && inside(rootDirectory, target)
              ? path.dirname(relativePath) === "."
                ? ""
                : path.dirname(relativePath)
              : "",
          modifiedAt: stat.mtimeMs,
          size: stat.size,
          lastOpenedAt,
        });
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "NOT_AUTHORIZED"].includes(
            error.code,
          )
        ) {
          throw error;
        }
      }
    }
    history.sort(
      (a, b) => b.lastOpenedAt - a.lastOpenedAt || a.path.localeCompare(b.path),
    );
    if (!rootDirectory) {
      return { rootDirectory: null, files: [], folders: [], history };
    }
    if ((await fs.realpath(rootDirectory)) !== rootDirectory) {
      throw this.fail("项目根目录已变更，请重新选择。");
    }
    const files = [];
    const folders = [];
    const visit = async (directory, category) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const relative = category ? `${category}/${entry.name}` : entry.name;
          folders.push(relative);
          await visit(absolute, relative);
        } else if (
          entry.isFile() &&
          !this.hiddenPaths.has(absolute) &&
          path.extname(entry.name).toLowerCase() === ".excalidraw"
        ) {
          const stat = await fs.stat(absolute);
          files.push({
            path: absolute,
            relativePath: category ? `${category}/${entry.name}` : entry.name,
            name: entry.name,
            category,
            modifiedAt: stat.mtimeMs,
            size: stat.size,
          });
        }
      }
    };
    await visit(rootDirectory, "");
    files.sort(
      (a, b) =>
        b.modifiedAt - a.modifiedAt ||
        a.relativePath.localeCompare(b.relativePath),
    );
    folders.sort((a, b) => a.localeCompare(b));
    return { rootDirectory, files, folders, history };
  }

  async saveFile(request, { overwrite = false } = {}) {
    if (
      !request ||
      !UUID.test(request.documentId) ||
      typeof request.content !== "string"
    ) {
      throw this.fail("保存请求无效。");
    }
    return this.serialize(async () => {
      const target = await this.allowedPath(request.path, { writing: true });
      if (this.hiddenPaths.has(target)) {
        throw this.fail(
          "画布已从项目移除，请重新打开后再保存。",
          "REMOVED_FILE",
        );
      }
      if (request.occupiedPaths !== undefined) {
        if (!Array.isArray(request.occupiedPaths)) {
          throw this.fail("已打开文件列表无效。");
        }
        const key = (value) =>
          process.platform === "darwin" ? value.toLowerCase() : value;
        for (const candidate of request.occupiedPaths) {
          const resolved = this.documentPath(candidate);
          const canonical = await fs.realpath(resolved).catch((error) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
            return resolved;
          });
          if (key(canonical) === key(target)) {
            throw this.fail(
              "此文件已在其他标签中打开，请选择其他保存位置。",
              "OPEN_DOCUMENT_CONFLICT",
            );
          }
        }
      }
      const stat = await fs.stat(target).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
        return null;
      });
      if (stat && !stat.isFile()) {
        throw this.fail("目标不是文件。");
      }
      const copiedVersion = this.copiedVersions.get(target);
      const unchangedCopy =
        copiedVersion &&
        copiedVersion.before === request.expectedModifiedAt &&
        copiedVersion.after === stat?.mtimeMs;
      if (
        !overwrite &&
        stat &&
        (typeof request.expectedModifiedAt !== "number" ||
          (stat.mtimeMs !== request.expectedModifiedAt && !unchangedCopy))
      ) {
        throw Object.assign(
          this.fail("文件已被其他程序修改。", "EXTERNAL_MODIFICATION"),
          { actualModifiedAt: stat.mtimeMs },
        );
      }
      if (
        !overwrite &&
        !stat &&
        typeof request.expectedModifiedAt === "number"
      ) {
        throw this.fail("文件已被移走或删除。", "EXTERNAL_MODIFICATION");
      }
      await atomicWrite(target, request.content);
      this.copiedVersions.delete(target);
      this.authorized.add(target);
      const document = await this.readFile(target);
      await this.recordRecentFile(target);
      return document;
    });
  }

  async categoryDirectory(category, create = false) {
    const root = this.settings.rootDirectory;
    if (!root) {
      throw this.fail("请先选择项目目录。");
    }
    if ((await fs.realpath(root)) !== root) {
      throw this.fail("项目根目录已变更，请重新选择。");
    }
    let current = root;
    for (const part of categoryParts(category)) {
      current = path.join(current, part);
      if (create) {
        await fs.mkdir(current).catch((error) => {
          if (error.code !== "EEXIST") {
            throw error;
          }
        });
      }
      const real = await fs.realpath(current);
      if (!inside(root, real) || !(await fs.stat(real)).isDirectory()) {
        throw this.fail("分类不能越过项目根目录。");
      }
      current = real;
    }
    return current;
  }

  async relocate(candidate, destination) {
    const source = await this.allowedPath(candidate);
    if (source === destination) {
      return this.readFile(source);
    }
    const parent = await fs.realpath(path.dirname(destination));
    if (parent !== path.dirname(destination)) {
      throw this.fail("目标目录不能是符号链接。");
    }
    const priorCopy = this.copiedVersions.get(source);
    let copiedTimes = null;
    await fs.link(source, destination).catch(async (error) => {
      if (error.code === "EEXIST") {
        throw this.fail("已有同名文件，请使用其他名称。", "NAME_CONFLICT");
      }
      if (error.code === "EXDEV") {
        copiedTimes = await fs.stat(source);
        await fs
          .copyFile(
            source,
            destination,
            require("node:fs").constants.COPYFILE_EXCL,
          )
          .catch((copyError) => {
            if (copyError.code === "EEXIST") {
              throw this.fail(
                "已有同名文件，请使用其他名称。",
                "NAME_CONFLICT",
              );
            }
            throw copyError;
          });
        // Node utimes truncates to microseconds; use the midpoint to avoid losing
        // one microsecond when a macOS timestamp is converted through a double.
        const seconds = (milliseconds) => milliseconds / 1000 + 0.0000005;
        try {
          await fs.utimes(
            destination,
            seconds(copiedTimes.atimeMs),
            seconds(copiedTimes.mtimeMs),
          );
        } catch (timeError) {
          await fs.unlink(destination);
          throw timeError;
        }
        return;
      }
      throw error;
    });
    try {
      await fs.unlink(source);
    } catch (error) {
      await fs.unlink(destination);
      throw error;
    }
    this.copiedVersions.delete(source);
    this.authorized.delete(path.resolve(candidate));
    this.authorized.delete(source);
    this.authorized.add(destination);
    if (this.recentFiles.has(source)) {
      const recentFiles = new Map(this.recentFiles);
      const lastOpenedAt = recentFiles.get(source);
      recentFiles.delete(source);
      recentFiles.set(
        destination,
        Math.max(recentFiles.get(destination) || 0, lastOpenedAt),
      );
      await this.persistRecentFiles(recentFiles);
    }
    this.session.paths = this.session.paths.map((item) =>
      item === candidate || item === source ? destination : item,
    );
    if (
      this.session.activePath === candidate ||
      this.session.activePath === source
    ) {
      this.session.activePath = destination;
    }
    await atomicWrite(
      path.join(this.userData, "session.json"),
      JSON.stringify(this.session),
    );
    const document = await this.readFile(destination);
    if (copiedTimes) {
      await fs.utimes(
        destination,
        copiedTimes.atimeMs / 1000 + 0.0000005,
        copiedTimes.mtimeMs / 1000 + 0.0000005,
      );
      // fs.utimes has microsecond precision. Keep an exact before/after alias
      // for this move so the renderer can retain its pre-move conflict baseline.
      this.copiedVersions.set(destination, {
        before:
          priorCopy?.after === copiedTimes.mtimeMs
            ? priorCopy.before
            : copiedTimes.mtimeMs,
        after: document.modifiedAt,
      });
    } else if (priorCopy?.after === document.modifiedAt) {
      this.copiedVersions.set(destination, priorCopy);
    }
    return document;
  }

  renameFile(candidate, name) {
    const nextName = fileName(name, "excalidraw", this.settings.language);
    return this.serialize(async () => {
      const source = await this.allowedPath(candidate);
      return this.relocate(source, path.join(path.dirname(source), nextName));
    });
  }

  moveFile(candidate, category) {
    return this.serialize(async () => {
      const destination = await this.categoryDirectory(category);
      return this.relocate(
        candidate,
        path.join(destination, path.basename(this.documentPath(candidate))),
      );
    });
  }

  removeFile(candidate, mode, trashItem) {
    return this.serialize(async () => {
      if (!["remove", "trash"].includes(mode)) {
        throw this.fail("移除方式无效。");
      }
      const target = await this.allowedPath(candidate);
      if (
        path.resolve(candidate) !== target ||
        (await fs.lstat(candidate)).isSymbolicLink()
      ) {
        throw this.fail("不能通过符号链接移除画布。", "NOT_AUTHORIZED");
      }
      if (!(await fs.stat(target)).isFile()) {
        throw this.fail("目标不是文件。");
      }
      if (mode === "trash") {
        if (typeof trashItem !== "function") {
          throw this.fail("废纸篓不可用。");
        }
        await trashItem(target);
      }
      await this.persistHiddenPaths(new Set([...this.hiddenPaths, target]));
      const recent = new Map(this.recentFiles);
      recent.delete(target);
      await this.persistRecentFiles(recent);
      const next = {
        paths: this.session.paths.filter((item) => item !== target),
        activePath:
          this.session.activePath === target ? null : this.session.activePath,
      };
      await atomicWrite(
        path.join(this.userData, "session.json"),
        JSON.stringify(next),
      );
      this.session = next;
      this.copiedVersions.delete(target);
    });
  }

  createFolder(category) {
    return this.serialize(() =>
      this.categoryDirectory(category, true).then(() => undefined),
    );
  }

  getSession() {
    return {
      paths: [...this.session.paths],
      activePath: this.session.activePath,
    };
  }

  setSession(session) {
    return this.serialize(async () => {
      if (
        !session ||
        !Array.isArray(session.paths) ||
        session.paths.some((item) => typeof item !== "string") ||
        (session.activePath !== null && typeof session.activePath !== "string")
      ) {
        throw this.fail("会话无效。");
      }
      const paths = [];
      for (const item of session.paths) {
        if (this.hiddenPaths.has(path.resolve(item))) {
          continue;
        }
        const target = await this.allowedPath(item);
        if (!this.hiddenPaths.has(target)) {
          paths.push(target);
        }
      }
      let activePath =
        session.activePath === null ||
        this.hiddenPaths.has(path.resolve(session.activePath))
          ? null
          : await this.allowedPath(session.activePath);
      if (this.hiddenPaths.has(activePath)) {
        activePath = null;
      }
      if (activePath !== null && !paths.includes(activePath)) {
        throw this.fail("活动文件不在会话中。");
      }
      const next = { paths: [...new Set(paths)], activePath };
      await atomicWrite(
        path.join(this.userData, "session.json"),
        JSON.stringify(next),
      );
      this.session = next;
    });
  }

  draftPath(id) {
    if (typeof id !== "string" || !UUID.test(id)) {
      throw this.fail("恢复草稿 ID 无效。");
    }
    return path.join(this.userData, "drafts", `${id}.json`);
  }

  async listDrafts() {
    const drafts = [];
    for (const name of await fs.readdir(path.join(this.userData, "drafts"))) {
      if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) {
        continue;
      }
      try {
        const draft = JSON.parse(
          await fs.readFile(this.draftPath(name.slice(0, -5)), "utf8"),
        );
        if (
          draft.id === name.slice(0, -5) &&
          typeof draft.content === "string" &&
          typeof draft.title === "string" &&
          Number.isFinite(draft.modifiedAt) &&
          (draft.path === null || typeof draft.path === "string")
        ) {
          drafts.push(draft);
        }
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return drafts.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  writeDraft(draft) {
    const destination = this.draftPath(draft?.id);
    if (
      typeof draft.content !== "string" ||
      typeof draft.title !== "string" ||
      !Number.isFinite(draft.modifiedAt) ||
      (draft.path !== null && typeof draft.path !== "string")
    ) {
      throw this.fail("恢复草稿无效。");
    }
    return this.serialize(async () => {
      let canonicalPath = draft.path;
      if (draft.path !== null) {
        canonicalPath = await this.allowedPath(draft.path, { writing: true });
        if (this.hiddenPaths.has(canonicalPath)) {
          return;
        }
      }
      await atomicWrite(
        destination,
        JSON.stringify({
          id: draft.id,
          path: canonicalPath,
          title: draft.title,
          content: draft.content,
          modifiedAt: draft.modifiedAt,
        }),
      );
    });
  }

  deleteDraft(id) {
    const destination = this.draftPath(id);
    return this.serialize(() =>
      fs.unlink(destination).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }),
    );
  }
}

module.exports = {
  DesktopStorage,
  atomicWrite,
  fileName,
  categoryParts,
  EXPORT_EXTENSIONS,
};
