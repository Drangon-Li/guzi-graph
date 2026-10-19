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
  for (const name of ["../bad", "a/b", "a\\b", "", "..", "/tmp/pwn"])
    assert.throws(() => fileName(name));
  for (const category of ["../bad", "/tmp/bad", "a/../b", "a//b", "a\\b"])
    assert.throws(() => categoryParts(category));
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
