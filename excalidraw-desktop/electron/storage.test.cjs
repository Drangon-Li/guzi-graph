const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const {
  DesktopStorage,
  atomicWrite,
  fileName,
  categoryParts,
} = require("./storage.cjs");

async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-storage-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "projects");
  await fs.mkdir(root);
  const storage = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  await storage.chooseRoot(root);
  const create = async (name, content = '{"type":"excalidraw"}') => {
    const candidate = path.join(root, name);
    await fs.writeFile(candidate, content);
    return storage.readFile(candidate);
  };
  return { base, root, storage, create };
}

const request = (document, content) => ({
  documentId: randomUUID(),
  path: document.path,
  name: "drawing",
  content,
  expectedModifiedAt: document.modifiedAt,
});

test("defaults require explicit project directory selection", async (t) => {
  const { base } = await fixture(t);
  const storage = await new DesktopStorage(
    path.join(base, "otherData"),
  ).initialize();
  assert.deepEqual(storage.getSettings(), {
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
  });
  assert.deepEqual(await storage.listProjects(), {
    rootDirectory: null,
    files: [],
    folders: [],
    history: [],
  });
  await assert.rejects(
    storage.updateSettings({ rootDirectory: base }),
    /选择器/,
  );
  await storage.updateSettings({ theme: "dark" });
  const reopened = await new DesktopStorage(
    path.join(base, "otherData"),
  ).initialize();
  assert.equal(reopened.getSettings().theme, "dark");
});

test("atomic save replaces complete content and leaves no temporary files", async (t) => {
  const { root, storage, create } = await fixture(t);
  const original = await create("drawing.excalidraw", "before");
  const saved = await storage.saveFile(request(original, "after\n完整内容"));
  assert.equal(saved.content, "after\n完整内容");
  assert.equal(await fs.readFile(original.path, "utf8"), saved.content);
  assert.deepEqual(await fs.readdir(root), ["drawing.excalidraw"]);
  assert.equal(saved.size, Buffer.byteLength(saved.content));
  await fs.mkdir(path.join(root, "directory.excalidraw"));
  await assert.rejects(
    atomicWrite(path.join(root, "directory.excalidraw"), "broken"),
  );
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "directory.excalidraw",
    "drawing.excalidraw",
  ]);
});

test("external changes and deletion require explicit overwrite", async (t) => {
  const { storage, create } = await fixture(t);
  const original = await create("drawing.excalidraw", "first");
  await fs.writeFile(original.path, "external");
  await fs.utimes(
    original.path,
    new Date(),
    new Date(original.modifiedAt + 2000),
  );
  await assert.rejects(storage.saveFile(request(original, "local")), {
    code: "EXTERNAL_MODIFICATION",
  });
  assert.equal(await fs.readFile(original.path, "utf8"), "external");
  const saved = await storage.saveFile(request(original, "local"), {
    overwrite: true,
  });
  assert.equal(saved.content, "local");
  await fs.unlink(saved.path);
  await assert.rejects(storage.saveFile(request(saved, "resurrect")), {
    code: "EXTERNAL_MODIFICATION",
  });
});

test("project index uses real nested folders and only drawing files", async (t) => {
  const { root, storage, create } = await fixture(t);
  await storage.createFolder("研究/草图");
  await storage.createFolder("空分类");
  await create("研究/草图/a.excalidraw");
  await create("b.EXCALIDRAW");
  await fs.writeFile(path.join(root, "ignored.svg"), "<svg/>");
  const index = await storage.listProjects();
  assert.equal(index.rootDirectory, root);
  assert.deepEqual(
    new Set(index.folders),
    new Set(["研究", "研究/草图", "空分类"]),
  );
  assert.deepEqual(
    new Set(index.files.map((file) => file.relativePath)),
    new Set(["研究/草图/a.excalidraw", "b.EXCALIDRAW"]),
  );
  assert.equal(
    index.files.find((file) => file.name === "a.excalidraw").category,
    "研究/草图",
  );
});

test("rejects filename and category traversal", async (t) => {
  const { storage, create } = await fixture(t);
  const original = await create("a.excalidraw");
  for (const name of ["../bad", "a/b", "a\\b", "", "..", "/tmp/pwn"]) {
    assert.throws(() => fileName(name));
  }
  for (const category of ["../bad", "/tmp/bad", "a/../b", "a//b", "a\\b"]) {
    assert.throws(() => categoryParts(category));
  }
  assert.throws(() => storage.renameFile(original.path, "../bad"));
  await assert.rejects(storage.createFolder("../bad"));
  await assert.rejects(storage.moveFile(original.path, "/tmp"));
});

test("root symlinks cannot expose or create files outside root", async (t) => {
  const { base, root, storage } = await fixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  const external = path.join(outside, "secret.excalidraw");
  await fs.writeFile(external, "outside");
  await fs.symlink(outside, path.join(root, "escape"));
  await fs.symlink(external, path.join(root, "linked.excalidraw"));
  await assert.rejects(storage.readFile(path.join(root, "linked.excalidraw")), {
    code: "NOT_AUTHORIZED",
  });
  await assert.rejects(
    storage.readFile(path.join(root, "escape", "secret.excalidraw")),
    { code: "NOT_AUTHORIZED" },
  );
  await assert.rejects(storage.createFolder("escape/new"));
  await assert.rejects(
    storage.saveFile({
      documentId: randomUUID(),
      path: path.join(root, "escape", "new.excalidraw"),
      content: "no",
    }),
  );
  assert.deepEqual((await storage.listProjects()).files, []);
  assert.deepEqual(await fs.readdir(outside), ["secret.excalidraw"]);
});

test("external files require native grant and cannot retarget symlinks", async (t) => {
  const { base, storage } = await fixture(t);
  const external = path.join(base, "external.excalidraw");
  await fs.writeFile(external, "external");
  await assert.rejects(storage.readFile(external), { code: "NOT_AUTHORIZED" });
  await storage.grantFile(external);
  assert.equal((await storage.readFile(external)).content, "external");
  await fs.unlink(external);
  const other = path.join(base, "other.excalidraw");
  await fs.writeFile(other, "secret");
  await fs.symlink(other, external);
  await assert.rejects(storage.readFile(external), { code: "NOT_AUTHORIZED" });
});

test("rename and move reject existing destinations without changing either file", async (t) => {
  const { root, storage, create } = await fixture(t);
  const original = await create("a.excalidraw", "a");
  await create("b.excalidraw", "b");
  await assert.rejects(storage.renameFile(original.path, "b"), {
    code: "NAME_CONFLICT",
  });
  assert.equal(await fs.readFile(original.path, "utf8"), "a");
  assert.equal(await fs.readFile(path.join(root, "b.excalidraw"), "utf8"), "b");
  await storage.createFolder("category");
  await create("category/a.excalidraw", "category a");
  await assert.rejects(storage.moveFile(original.path, "category"), {
    code: "NAME_CONFLICT",
  });
  const renamed = await storage.renameFile(original.path, "renamed");
  await assert.rejects(fs.stat(original.path), { code: "ENOENT" });
  const moved = await storage.moveFile(renamed.path, "category");
  assert.equal(moved.path, path.join(root, "category", "renamed.excalidraw"));
  assert.equal(moved.content, "a");
});

test("session only persists authorized files and follows renamed paths", async (t) => {
  const { base, storage, create } = await fixture(t);
  const original = await create("a.excalidraw");
  await assert.rejects(
    storage.setSession({
      paths: [path.join(base, "unauthorized.excalidraw")],
      activePath: null,
    }),
  );
  await storage.setSession({
    paths: [original.path],
    activePath: original.path,
  });
  const renamed = await storage.renameFile(original.path, "b");
  assert.deepEqual(storage.getSession(), {
    paths: [renamed.path],
    activePath: renamed.path,
  });
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(reopened.getSession(), storage.getSession());
});

test("drafts are UUID scoped, reloadable and cannot delete arbitrary files", async (t) => {
  const { storage } = await fixture(t);
  const draft = {
    id: randomUUID(),
    path: null,
    title: "未命名",
    content: "draft",
    modifiedAt: Date.now(),
  };
  await storage.writeDraft(draft);
  assert.deepEqual(await storage.listDrafts(), [draft]);
  assert.throws(() => storage.deleteDraft("../settings"));
  assert.throws(() => storage.writeDraft({ ...draft, id: "../../escape" }));
  await storage.deleteDraft(draft.id);
  assert.deepEqual(await storage.listDrafts(), []);
});

test("save refuses another opened document before overwriting it", async (t) => {
  const { root, storage, create } = await fixture(t);
  const original = await create("a.excalidraw", "untouched");
  await assert.rejects(
    storage.saveFile(
      { ...request(original, "wrong tab"), occupiedPaths: [original.path] },
      { overwrite: true },
    ),
    { code: "OPEN_DOCUMENT_CONFLICT" },
  );
  assert.equal(await fs.readFile(original.path, "utf8"), "untouched");
  const alias = path.join(root, "alias.excalidraw");
  await fs.symlink(original.path, alias);
  await assert.rejects(
    storage.saveFile(
      { ...request(original, "wrong alias"), occupiedPaths: [alias] },
      { overwrite: true },
    ),
    { code: "OPEN_DOCUMENT_CONFLICT" },
  );
  assert.equal(await fs.readFile(original.path, "utf8"), "untouched");
});

test("opened documents remain authorized after changing project root", async (t) => {
  const { base, root, storage, create } = await fixture(t);
  const opened = await create("opened.excalidraw", "old root document");
  const unopened = path.join(root, "unopened.excalidraw");
  await fs.writeFile(unopened, "not opened");
  const nextRoot = path.join(base, "next-projects");
  await fs.mkdir(nextRoot);
  await storage.chooseRoot(nextRoot);
  assert.equal((await storage.readFile(opened.path)).content, opened.content);
  const draft = {
    id: randomUUID(),
    path: opened.path,
    title: "opened",
    content: "draft",
    modifiedAt: Date.now(),
  };
  await storage.writeDraft(draft);
  assert.deepEqual(await storage.listDrafts(), [draft]);
  const saved = await storage.saveFile(request(opened, "saved in old root"));
  assert.equal(saved.content, "saved in old root");
  await assert.rejects(storage.readFile(unopened), { code: "NOT_AUTHORIZED" });
});

test("cross-volume move preserves file timestamps and original save baseline", async (t) => {
  const { root, storage, create } = await fixture(t);
  const original = await create("a.excalidraw", "drawing");
  await storage.createFolder("moved");
  const sourceStat = await fs.stat(original.path);
  t.mock.method(fs, "link", async () => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  const moved = await storage.moveFile(original.path, "moved");
  assert.equal(moved.path, path.join(root, "moved", "a.excalidraw"));
  const destinationStat = await fs.stat(moved.path);
  assert.ok(Math.abs(destinationStat.mtimeMs - sourceStat.mtimeMs) < 0.001);
  assert.ok(Math.abs(destinationStat.atimeMs - sourceStat.atimeMs) < 0.001);
  const saved = await storage.saveFile({
    ...request(original, "saved after move"),
    path: moved.path,
  });
  assert.equal(saved.content, "saved after move");
});

test("cross-volume move retains external modification conflict against old baseline", async (t) => {
  const { storage, create } = await fixture(t);
  const original = await create("a.excalidraw", "v1");
  await storage.createFolder("moved");
  await fs.writeFile(original.path, "external v2");
  await fs.utimes(
    original.path,
    new Date(),
    new Date(original.modifiedAt + 2000),
  );
  t.mock.method(fs, "link", async () => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  const moved = await storage.moveFile(original.path, "moved");
  await assert.rejects(
    storage.saveFile({ ...request(original, "local v1"), path: moved.path }),
    { code: "EXTERNAL_MODIFICATION" },
  );
  assert.equal(await fs.readFile(moved.path, "utf8"), "external v2");
});

test("cross-volume copy alias still rejects later external edits", async (t) => {
  const { storage, create } = await fixture(t);
  const original = await create("a.excalidraw", "v1");
  await storage.createFolder("moved");
  t.mock.method(fs, "link", async () => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  const moved = await storage.moveFile(original.path, "moved");
  await fs.writeFile(moved.path, "external after move");
  await fs.utimes(moved.path, new Date(), new Date(moved.modifiedAt + 2000));
  await assert.rejects(
    storage.saveFile({ ...request(original, "local v1"), path: moved.path }),
    { code: "EXTERNAL_MODIFICATION" },
  );
  assert.equal(await fs.readFile(moved.path, "utf8"), "external after move");
});

test("external opened drawings survive closed tabs and restart without a project root", async (t) => {
  const { base } = await fixture(t);
  const userData = path.join(base, "externalData");
  const storage = await new DesktopStorage(userData).initialize();
  const external = path.join(base, "external.excalidraw");
  const sibling = path.join(base, "sibling.excalidraw");
  await fs.writeFile(external, "external drawing");
  await fs.writeFile(sibling, "not granted");
  await assert.rejects(storage.recordOpenedFile(external), {
    code: "NOT_AUTHORIZED",
  });
  await storage.grantFile(external);
  await storage.readFile(external);
  await storage.recordOpenedFile(external);
  await storage.setSession({ paths: [external], activePath: external });
  await storage.setSession({ paths: [], activePath: null });
  const reopened = await new DesktopStorage(userData).initialize();
  const index = await reopened.listProjects();
  assert.equal(index.rootDirectory, null);
  assert.deepEqual(index.files, []);
  assert.deepEqual(reopened.getSession(), { paths: [], activePath: null });
  assert.deepEqual(
    index.history.map((file) => file.path),
    [external],
  );
  assert.equal(index.history[0].relativePath, external);
  assert.equal(index.history[0].category, "");
  assert.equal((await reopened.readFile(external)).content, "external drawing");
  await assert.rejects(reopened.readFile(sibling), { code: "NOT_AUTHORIZED" });
  await assert.rejects(reopened.recordOpenedFile(sibling), {
    code: "NOT_AUTHORIZED",
  });
});

test("project scans and thumbnail reads do not add unopened drawings to history", async (t) => {
  const { base, root, storage, create } = await fixture(t);
  await create("preview.excalidraw");
  const external = path.join(base, "external-preview.excalidraw");
  await fs.writeFile(external, "preview");
  await storage.grantFile(external);
  await storage.readFile(external);
  const index = await storage.listProjects();
  assert.equal(index.files.length, 1);
  assert.deepEqual(index.history, []);
  await assert.rejects(
    fs.stat(path.join(base, "userData", "recent-files.json")),
    {
      code: "ENOENT",
    },
  );
  const directory = path.join(root, "directory.excalidraw");
  await fs.mkdir(directory);
  await assert.rejects(storage.recordOpenedFile(directory), /不是文件/);
  assert.deepEqual((await storage.listProjects()).history, []);
});

test("legacy sessions migrate to independent history with no configured root", async (t) => {
  const { base } = await fixture(t);
  const userData = path.join(base, "legacyData");
  await fs.mkdir(userData);
  const external = path.join(base, "legacy.excalidraw");
  const missing = path.join(base, "missing.excalidraw");
  await fs.writeFile(external, "legacy drawing");
  await fs.writeFile(
    path.join(userData, "session.json"),
    JSON.stringify({
      paths: [
        external,
        missing,
        "relative.excalidraw",
        "/tmp/not-a-drawing.txt",
      ],
      activePath: null,
    }),
  );
  const storage = await new DesktopStorage(userData).initialize();
  assert.deepEqual(
    (await storage.listProjects()).history.map((file) => file.path),
    [external],
  );
  const persisted = JSON.parse(
    await fs.readFile(path.join(userData, "recent-files.json"), "utf8"),
  );
  assert.deepEqual(
    persisted.map((entry) => entry.path),
    [external, missing],
  );
  await storage.setSession({ paths: [], activePath: null });
  const reopened = await new DesktopStorage(userData).initialize();
  assert.deepEqual(
    (await reopened.listProjects()).history.map((file) => file.path),
    [external],
  );
  assert.equal((await reopened.readFile(external)).content, "legacy drawing");
});

test("history is deduplicated, ordered by opening time and skips missing files", async (t) => {
  const { base, storage, create } = await fixture(t);
  const first = await create("first.excalidraw");
  const second = await create("second.excalidraw");
  let now = 1000;
  t.mock.method(Date, "now", () => now++);
  await storage.recordOpenedFile(first.path);
  await storage.recordOpenedFile(second.path);
  await storage.recordOpenedFile(first.path);
  const history = (await storage.listProjects()).history;
  assert.deepEqual(
    history.map((file) => file.path),
    [first.path, second.path],
  );
  assert.deepEqual(
    history.map((file) => file.lastOpenedAt),
    [1002, 1001],
  );
  await fs.unlink(first.path);
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(
    (await reopened.listProjects()).history.map((file) => file.path),
    [second.path],
  );
});

test("rename and move update persisted history without changing opening time", async (t) => {
  const { base, root, storage, create } = await fixture(t);
  const original = await create("original.excalidraw");
  await storage.recordOpenedFile(original.path);
  const lastOpenedAt = (await storage.listProjects()).history[0].lastOpenedAt;
  await storage.createFolder("category");
  const renamed = await storage.renameFile(original.path, "renamed");
  const moved = await storage.moveFile(renamed.path, "category");
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  const history = (await reopened.listProjects()).history;
  assert.equal(history.length, 1);
  assert.equal(
    history[0].path,
    path.join(root, "category", "renamed.excalidraw"),
  );
  assert.equal(history[0].category, "category");
  assert.equal(history[0].relativePath, "category/renamed.excalidraw");
  assert.equal(history[0].lastOpenedAt, lastOpenedAt);
  assert.equal((await reopened.readFile(moved.path)).content, original.content);
});

test("saving new and Save As drawings records both paths while failed saves do not", async (t) => {
  const { base, storage } = await fixture(t);
  const originalPath = path.join(base, "new.excalidraw");
  const copyPath = path.join(base, "copy.excalidraw");
  await storage.grantFile(originalPath);
  const original = await storage.saveFile({
    documentId: randomUUID(),
    path: originalPath,
    content: "first",
  });
  await storage.grantFile(copyPath);
  await storage.saveFile({
    documentId: randomUUID(),
    path: copyPath,
    content: "copy",
  });
  await storage.saveFile(request(original, "saved again"));
  assert.deepEqual(
    new Set((await storage.listProjects()).history.map((file) => file.path)),
    new Set([originalPath, copyPath]),
  );
  await fs.writeFile(originalPath, "external");
  await fs.utimes(
    originalPath,
    new Date(),
    new Date(original.modifiedAt + 2000),
  );
  const before = (await storage.listProjects()).history.map(
    ({ path, lastOpenedAt }) => ({ path, lastOpenedAt }),
  );
  await assert.rejects(storage.saveFile(request(original, "must fail")), {
    code: "EXTERNAL_MODIFICATION",
  });
  assert.deepEqual(
    (await storage.listProjects()).history.map(({ path, lastOpenedAt }) => ({
      path,
      lastOpenedAt,
    })),
    before,
  );
  await storage.setSession({ paths: [], activePath: null });
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(
    new Set((await reopened.listProjects()).history.map((file) => file.path)),
    new Set([originalPath, copyPath]),
  );
});

test("persisted history does not authorize a symlink replacement or external siblings", async (t) => {
  const { base, storage } = await fixture(t);
  const opened = path.join(base, "opened.excalidraw");
  const secret = path.join(base, "secret.excalidraw");
  await fs.writeFile(opened, "opened");
  await fs.writeFile(secret, "secret");
  await storage.grantFile(opened);
  await storage.recordOpenedFile(opened);
  await fs.unlink(opened);
  await fs.symlink(secret, opened);
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual((await reopened.listProjects()).history, []);
  await assert.rejects(reopened.readFile(opened), { code: "NOT_AUTHORIZED" });
  await assert.rejects(reopened.recordOpenedFile(opened), {
    code: "NOT_AUTHORIZED",
  });
  await assert.rejects(reopened.readFile(secret), { code: "NOT_AUTHORIZED" });
});

test("new preferences migrate old settings, persist and validate exact field types", async (t) => {
  const { base, storage } = await fixture(t);
  const update = {
    language: "en",
    structuredExportFormat: "md",
    includeInferredStructure: false,
    skipRemoveConfirmation: true,
    skipTrashConfirmation: true,
    stickyNoteMode: "subcanvas",
  };
  await storage.updateSettings(update);
  const restored = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  for (const [key, value] of Object.entries(update)) {
    assert.equal(restored.getSettings()[key], value);
  }
  for (const update of [
    { language: "fr" },
    { structuredExportFormat: "html" },
    { includeInferredStructure: 1 },
    { skipTrashConfirmation: "true" },
    { stickyNoteMode: "other" },
  ]) {
    await assert.rejects(restored.updateSettings(update), /Invalid settings/);
  }
  await fs.writeFile(
    path.join(base, "userData", "settings.json"),
    JSON.stringify({ theme: "dark" }),
  );
  const legacy = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.equal(legacy.getSettings().toolPanelDock, "floating");
  assert.equal(legacy.getSettings().toolPanelWidth, 280);
  assert.equal(legacy.getSettings().language, "zh-CN");
  assert.equal(legacy.getSettings().includeInferredStructure, true);
  assert.equal(legacy.getSettings().skipRemoveConfirmation, false);
  assert.equal(legacy.getSettings().stickyNoteMode, "note");
});

test("tool panel dock persists each valid value and ignores invalid saved values", async (t) => {
  const { base, storage } = await fixture(t);
  const userData = path.join(base, "userData");
  for (const toolPanelDock of ["left", "right", "floating"]) {
    const updated = await storage.updateSettings({ toolPanelDock });
    assert.equal(updated.toolPanelDock, toolPanelDock);
    const reopened = await new DesktopStorage(userData).initialize();
    assert.equal(reopened.getSettings().toolPanelDock, toolPanelDock);
  }
  for (const toolPanelDock of ["top", "LEFT", "", true, null, 1, {}, []]) {
    await assert.rejects(storage.updateSettings({ toolPanelDock }));
    assert.equal(storage.getSettings().toolPanelDock, "floating");
    await fs.writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify({ toolPanelDock }),
    );
    const reopened = await new DesktopStorage(userData).initialize();
    assert.equal(reopened.getSettings().toolPanelDock, "floating");
  }
});

test("tool panel width persists finite values within its inclusive bounds", async (t) => {
  const { base, storage } = await fixture(t);
  const userData = path.join(base, "userData");
  for (const toolPanelWidth of [260, 480, 320.5]) {
    const updated = await storage.updateSettings({ toolPanelWidth });
    assert.equal(updated.toolPanelWidth, toolPanelWidth);
    const reopened = await new DesktopStorage(userData).initialize();
    assert.equal(reopened.getSettings().toolPanelWidth, toolPanelWidth);
  }
  for (const toolPanelWidth of [
    259.9,
    480.1,
    NaN,
    Infinity,
    -Infinity,
    "280",
    null,
    true,
    {},
    [],
  ]) {
    await assert.rejects(storage.updateSettings({ toolPanelWidth }), {
      code: "INVALID_PATH",
    });
    assert.equal(storage.getSettings().toolPanelWidth, 320.5);
    const reopened = await new DesktopStorage(userData).initialize();
    assert.equal(reopened.getSettings().toolPanelWidth, 320.5);
  }
});

test("invalid saved tool panel widths fall back to the default", async (t) => {
  const { base } = await fixture(t);
  const userData = path.join(base, "userData");
  for (const toolPanelWidth of [259, 481, "280", null, true, {}, []]) {
    await fs.writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify({ toolPanelWidth }),
    );
    const reopened = await new DesktopStorage(userData).initialize();
    assert.equal(reopened.getSettings().toolPanelWidth, 280);
  }
});

test("remove hides a drawing persistently and cleans history and session while preserving recovery drafts", async (t) => {
  const { base, storage, create } = await fixture(t);
  const drawing = await create("hidden.excalidraw", "keep this file");
  const other = await create("other.excalidraw");
  await storage.recordOpenedFile(drawing.path);
  await storage.setSession({
    paths: [drawing.path, other.path],
    activePath: drawing.path,
  });
  const draft = {
    id: randomUUID(),
    path: drawing.path,
    title: "removed",
    content: "draft",
    modifiedAt: Date.now(),
  };
  const kept = { ...draft, id: randomUUID(), path: other.path };
  await storage.writeDraft(draft);
  await storage.writeDraft(kept);
  await storage.removeFile(drawing.path, "remove");
  assert.equal(await fs.readFile(drawing.path, "utf8"), "keep this file");
  assert.deepEqual(storage.getSession(), {
    paths: [other.path],
    activePath: null,
  });
  assert.deepEqual(new Set(await storage.listDrafts()), new Set([draft, kept]));
  const restored = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(
    new Set(await restored.listDrafts()),
    new Set([draft, kept]),
  );
  assert.equal(
    (await restored.listProjects()).files.some(
      ({ path }) => path === drawing.path,
    ),
    false,
  );
  assert.equal((await restored.listProjects()).history.length, 0);
  await restored.readFile(drawing.path);
  assert.equal(
    (await restored.listProjects()).files.some(
      ({ path }) => path === drawing.path,
    ),
    false,
  );
  await restored.recordOpenedFile(drawing.path);
  assert.equal(
    (await restored.listProjects()).files.some(
      ({ path }) => path === drawing.path,
    ),
    true,
  );
  assert.equal((await restored.listProjects()).history[0].path, drawing.path);
});

test("trash commits cleanup only after the mocked system trash succeeds", async (t) => {
  const { base, storage, create } = await fixture(t);
  const drawing = await create("trash.excalidraw");
  await storage.recordOpenedFile(drawing.path);
  await storage.setSession({ paths: [drawing.path], activePath: drawing.path });
  const draft = {
    id: randomUUID(),
    path: drawing.path,
    title: "draft",
    content: "draft",
    modifiedAt: Date.now(),
  };
  await storage.writeDraft(draft);
  await assert.rejects(
    storage.removeFile(drawing.path, "trash", async () => {
      throw new Error("system refused");
    }),
    /system refused/,
  );
  assert.equal((await storage.listProjects()).history.length, 1);
  assert.equal(storage.getSession().activePath, drawing.path);
  assert.deepEqual(await storage.listDrafts(), [draft]);
  const afterFailure = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(await afterFailure.listDrafts(), [draft]);
  assert.equal((await afterFailure.listProjects()).history.length, 1);
  assert.equal(afterFailure.getSession().activePath, drawing.path);
  let trashed;
  await storage.removeFile(drawing.path, "trash", async (target) => {
    trashed = target;
    await fs.rename(target, `${target}.fixture-trash`);
  });
  assert.equal(trashed, drawing.path);
  assert.deepEqual(storage.getSession(), { paths: [], activePath: null });
  assert.deepEqual(await storage.listDrafts(), [draft]);
  assert.deepEqual((await storage.listProjects()).history, []);
  const restored = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(await restored.listDrafts(), [draft]);
  await restored.writeDraft({ ...draft, path: null });
  assert.deepEqual(await restored.listDrafts(), [{ ...draft, path: null }]);
});

test("remove rejects unauthorized files, symlinks and invalid modes before calling trash", async (t) => {
  const { root, base, storage, create } = await fixture(t);
  const drawing = await create("safe.excalidraw");
  const external = path.join(base, "external.excalidraw");
  await fs.writeFile(external, "outside");
  let count = 0;
  const trash = async () => {
    count++;
  };
  await assert.rejects(storage.removeFile(external, "trash", trash), {
    code: "NOT_AUTHORIZED",
  });
  for (const [name, target] of [
    ["inside", drawing.path],
    ["outside", external],
  ]) {
    const link = path.join(root, `${name}.excalidraw`);
    await fs.symlink(target, link);
    await assert.rejects(storage.removeFile(link, "trash", trash), {
      code: "NOT_AUTHORIZED",
    });
  }
  await assert.rejects(
    storage.removeFile(drawing.path, "delete", trash),
    /移除方式/,
  );
  assert.equal(count, 0);
  assert.equal(await fs.readFile(external, "utf8"), "outside");
});

test("queued stale saves, drafts and sessions cannot resurrect a removed drawing", async (t) => {
  const { storage, create } = await fixture(t);
  const drawing = await create("queued.excalidraw", "initial");
  const draft = {
    id: randomUUID(),
    path: drawing.path,
    title: "draft",
    content: "recoverable",
    modifiedAt: Date.now(),
  };
  await storage.writeDraft(draft);
  const removal = storage.removeFile(drawing.path, "remove");
  const staleSave = storage.saveFile(request(drawing, "stale"));
  const staleDraft = storage.writeDraft({ ...draft, content: "stale" });
  const staleSession = storage.setSession({
    paths: [drawing.path],
    activePath: drawing.path,
  });
  await removal;
  await assert.rejects(staleSave, { code: "REMOVED_FILE" });
  await Promise.all([staleDraft, staleSession]);
  assert.equal(await fs.readFile(drawing.path, "utf8"), "initial");
  assert.deepEqual(storage.getSession(), { paths: [], activePath: null });
  assert.deepEqual(await storage.listDrafts(), [draft]);
  await storage.recordOpenedFile(drawing.path);
  await storage.saveFile(request(drawing, "restored"));
  assert.equal(await fs.readFile(drawing.path, "utf8"), "restored");
});

for (const mode of ["remove", "trash"]) {
  test(`${mode} preserves legacy recovery drafts stored through a symbolic alias across restart`, async (t) => {
    const { root, base, storage, create } = await fixture(t);
    const drawing = await create("draft-source.excalidraw");
    const alias = path.join(root, "alias.excalidraw");
    await fs.symlink(drawing.path, alias);
    const draft = {
      id: randomUUID(),
      path: alias,
      title: "legacy",
      content: "draft",
      modifiedAt: Date.now(),
    };
    await fs.writeFile(
      path.join(base, "userData", "drafts", `${draft.id}.json`),
      JSON.stringify(draft),
    );
    await storage.removeFile(drawing.path, mode, async (target) =>
      fs.rename(target, `${target}.fixture-trash`),
    );
    assert.deepEqual(await storage.listDrafts(), [draft]);
    const restored = await new DesktopStorage(
      path.join(base, "userData"),
    ).initialize();
    assert.deepEqual(await restored.listDrafts(), [draft]);
    await restored.writeDraft({ ...draft, path: null });
    assert.deepEqual(await restored.listDrafts(), [{ ...draft, path: null }]);
  });
}

test("English storage validation includes direct non-serialized operations", async (t) => {
  const { storage } = await fixture(t);
  await storage.updateSettings({ language: "en" });
  await assert.rejects(
    storage.readFile("relative.excalidraw"),
    /Choose an .excalidraw file/,
  );
  assert.throws(
    () => storage.renameFile("relative.excalidraw", "../bad"),
    /valid file name/,
  );
});

test("editor preferences persist named local fonts and reject unknown ids", async (t) => {
  const { base, storage } = await fixture(t);
  const preferences = {
    defaultFontFamily: 123456,
    defaultFontName: "Songti SC",
    defaultBackground: "#fffce8",
    fontTopPicks: [123456, 5],
    backgroundTopPicks: ["#ffffff", "#fffce8"],
    systemFonts: [{ id: 123456, family: "Songti SC" }],
  };
  await storage.updateSettings({ editorPreferences: preferences });
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(reopened.getSettings().editorPreferences, {
    ...storage.getSettings().editorPreferences,
    ...preferences,
  });
  for (const invalid of [
    { ...preferences, defaultFontFamily: 987654 },
    { ...preferences, defaultFontName: "Different font" },
    { ...preferences, defaultBackground: "invalid" },
    { ...preferences, fontTopPicks: [1, 2, 3, 5] },
    { ...preferences, systemFonts: [{ id: 5, family: "Songti SC" }] },
  ]) {
    await assert.rejects(
      storage.updateSettings({ editorPreferences: invalid }),
    );
  }
});

test("style preset shortcuts persist and reject collisions and reserved editing keys", async (t) => {
  const { base, storage } = await fixture(t);
  const preset = {
    id: "test",
    name: "Dashed line",
    shortcut: "Alt+3",
    tool: "line",
    strokeStyle: "dashed",
    strokeWidth: 2,
    strokeColor: "#112233",
  };
  await storage.updateSettings({ stylePresets: [preset] });
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(reopened.getSettings().stylePresets, [preset]);
  for (const stylePresets of [
    [preset, { ...preset, id: "another" }],
    [{ ...preset, shortcut: "Meta+S" }],
    [{ ...preset, shortcut: "A" }],
    [{ ...preset, strokeWidth: 3 }],
  ]) {
    await assert.rejects(storage.updateSettings({ stylePresets }));
  }
});

test("element color and font size preferences persist and reject invalid shortcuts", async (t) => {
  const { base, storage } = await fixture(t);
  const preferences = {
    ...storage.getSettings().editorPreferences,
    defaultStrokeColor: "transparent",
    defaultElementBackground: "#123456",
    elementStrokeTopPicks: ["transparent", "#112233"],
    elementBackgroundTopPicks: ["#445566"],
    fontSizePresets: { sm: 12, md: 18, lg: 24, xl: 40 },
  };
  await storage.updateSettings({ editorPreferences: preferences });
  const reopened = await new DesktopStorage(
    path.join(base, "userData"),
  ).initialize();
  assert.deepEqual(reopened.getSettings().editorPreferences, preferences);
  for (const invalid of [
    { ...preferences, defaultStrokeColor: "invalid" },
    { ...preferences, elementStrokeTopPicks: [] },
    { ...preferences, elementBackgroundTopPicks: ["invalid"] },
    { ...preferences, fontSizePresets: { sm: 12, md: 12, lg: 24, xl: 40 } },
    { ...preferences, fontSizePresets: { sm: 0, md: 18, lg: 24, xl: 40 } },
    { ...preferences, fontSizePresets: { sm: 12, md: 18, lg: 24 } },
  ]) {
    await assert.rejects(
      storage.updateSettings({ editorPreferences: invalid }),
    );
  }
});
