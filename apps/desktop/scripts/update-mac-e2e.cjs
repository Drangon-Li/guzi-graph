const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const { _electron } = require("playwright");

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--app", "--artifacts"].includes(key) || !value || options.has(key)) {
    throw new Error(
      "Usage: update-mac-e2e.cjs --app /absolute/Application.app [--artifacts /absolute/report-directory]",
    );
  }
  options.set(key, path.resolve(value));
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This update test requires macOS arm64.");
const sourceApp = options.get("--app");
if (!sourceApp?.endsWith(".app"))
  throw new Error("--app must identify a packaged application bundle.");
const runDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "guzi-update-e2e-")),
);
const artifacts = options.get("--artifacts") || runDir;
fs.mkdirSync(artifacts, { recursive: true });
const profile = path.join(runDir, "profile");
const drawings = path.join(runDir, "drawings");
const installed = path.join(runDir, "installed", path.basename(sourceApp));
const eventsPath = path.join(runDir, "events.jsonl");
const bundleID = `local.guzi.update-e2e.${crypto
  .randomBytes(6)
  .toString("hex")}`;
const report = {
  runDir,
  sourceApp,
  installed,
  profile,
  bundleID,
  cases: {},
  requests: [],
  passed: false,
};
const knownPids = new Set();
let application;
let page;
let server;
let archive;
let badArchive;
let signature;
let feedMode = "good";
let sourceBefore;
const command = (binary, args, input) =>
  execFileSync(binary, args, {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
  }).trim();
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const headerHash = (file) => {
  asar.uncache(file);
  return crypto
    .createHash("sha256")
    .update(asar.getRawHeader(file).headerString)
    .digest("hex");
};
const readPlist = (file) =>
  JSON.parse(
    command("/usr/bin/python3", [
      "-c",
      "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))",
      file,
    ]),
  );
function treeManifest(root, directory = "", result = {}) {
  for (const entry of fs.readdirSync(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name);
    const file = path.join(root, relative);
    if (entry.isSymbolicLink())
      result[relative] = `symlink:${fs.readlinkSync(file)}`;
    else if (entry.isDirectory()) treeManifest(root, relative, result);
    else result[relative] = digest(file);
  }
  return result;
}
const events = () => {
  if (!fs.existsSync(eventsPath)) return [];
  const text = fs.readFileSync(eventsPath, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n"))
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
};
function bounded(promise, timeout, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out: ${label}`)),
        timeout,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
async function until(predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function progress(stage) {
  report.stage = stage;
  fs.writeFileSync(
    path.join(artifacts, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify({ stage, runDir }));
}
function fixtureBootstrap(config) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { app } = require("electron");
  process.env.EXCALIDRAW_DESKTOP_USER_DATA = config.profile;
  fs.mkdirSync(config.profile, { recursive: true });
  app.setPath("userData", config.profile);
  const record = (event, details = {}) => {
    try {
      fs.appendFileSync(
        config.eventsPath,
        `${JSON.stringify({
          event,
          at: Date.now(),
          pid: process.pid,
          version: app.getVersion(),
          bundlePath: path.resolve(process.execPath, "../../.."),
          profile: app.getPath("userData"),
          ...details,
        })}\n`,
      );
    } catch {}
  };
  record("bootstrap");
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  childProcess.spawn = function (file, args, options) {
    const child = spawn.call(this, file, args, options);
    if (file.endsWith("/guzi-updater")) {
      record("helper-start", { helperPid: child.pid, args });
      let pending = "";
      child.stdout.on("data", (data) => {
        pending += data;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            record("helper-event", {
              helperPid: child.pid,
              value: JSON.parse(line),
            });
          } catch {}
        }
      });
      child.on("exit", (code, signal) =>
        record("helper-exit", { helperPid: child.pid, code, signal }),
      );
    }
    return child;
  };
  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-finish-load", async () => {
      try {
        const renderer = await window.webContents
          .executeJavaScript(`(async () => {
          const deadline = Date.now() + 30000;
          while (!document.querySelector('.desktop-workspace') && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return {url: location.href, workspace: !!document.querySelector('.desktop-workspace'),
            update: await window.desktop.getUpdateState(), settings: await window.desktop.getSettings(),
            session: await window.desktop.getSession()};
        })()`);
        record("renderer-loaded", { renderer });
      } catch (error) {
        record("renderer-error", { message: error.message });
      }
    });
    window.webContents.on("render-process-gone", (_event, details) =>
      record("renderer-gone", details),
    );
    window.webContents.on(
      "did-fail-load",
      (_event, code, description, url, mainFrame) =>
        record("load-error", { code, description, url, mainFrame }),
    );
  });
  app.on("before-quit", () => record("before-quit"));
  app.on("will-quit", () => record("will-quit"));
  process.on("uncaughtException", (error) => {
    record("uncaught-exception", { message: error.stack });
    app.exit(1);
  });
  require("./src/main/main.cjs");
}
async function fixtures(feedURL) {
  const sourceArchive = path.join(sourceApp, "Contents/Resources/app.asar");
  const sourcePlist = readPlist(path.join(sourceApp, "Contents/Info.plist"));
  assert.equal(
    sourcePlist.ElectronAsarIntegrity["Resources/app.asar"].hash,
    headerHash(sourceArchive),
  );
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", sourceApp]);
  const entitlements = command("/usr/bin/codesign", [
    "--display",
    "--entitlements",
    ":-",
    sourceApp,
  ]);
  assert(entitlements.includes("com.apple.security.cs.allow-jit"));
  const entitlementsPath = path.join(runDir, "entitlements.plist");
  fs.writeFileSync(entitlementsPath, entitlements);
  const extracted = path.join(runDir, "source-asar");
  const rawHeader = asar.getRawHeader(sourceArchive).header;
  const checkPacked = (files) => {
    for (const entry of Object.values(files)) {
      assert(
        !entry.unpacked,
        "The fixture builder requires an entirely packed source ASAR",
      );
      if (entry.files) checkPacked(entry.files);
    }
  };
  checkPacked(rawHeader.files);
  asar.extractAll(sourceArchive, extracted);
  const packagePath = path.join(extracted, "package.json");
  const sourcePackage = JSON.parse(fs.readFileSync(packagePath));
  assert.equal(sourcePackage.main, "src/main/main.cjs");
  assert(
    !sourcePackage.buildChannel,
    "Use the production build for update tests",
  );
  const currentVersion = sourcePackage.version;
  const pieces = currentVersion.split(".").map(Number);
  assert(pieces.length === 3 && pieces.every(Number.isSafeInteger));
  const targetVersion = `${pieces[0]}.${pieces[1]}.${pieces[2] + 1}`;
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateSeed = keys.privateKey
    .export({ format: "der", type: "pkcs8" })
    .subarray(-32);
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const keyPath = path.join(runDir, "fixture-private-seed.b64");
  fs.writeFileSync(keyPath, privateSeed.toString("base64"), { mode: 0o600 });
  const adapterPath = path.join(extracted, "src/main/update-mac.cjs");
  const adapter = fs.readFileSync(adapterPath, "utf8");
  const feedDeclaration = /const MAC_UPDATE_FEED\s*=\s*"[^"]+";/g;
  assert.equal([...adapter.matchAll(feedDeclaration)].length, 1);
  fs.writeFileSync(
    adapterPath,
    adapter.replace(
      feedDeclaration,
      `const MAC_UPDATE_FEED = ${JSON.stringify(feedURL)};`,
    ),
  );
  fs.writeFileSync(
    path.join(extracted, "update-fixture-bootstrap.cjs"),
    `(${fixtureBootstrap.toString()})(${JSON.stringify({
      profile,
      eventsPath,
    })});\n`,
  );
  const built = [];
  for (const [directory, version] of [
    ["v1", currentVersion],
    ["v2", targetVersion],
  ]) {
    const app = path.join(runDir, directory, path.basename(sourceApp));
    command("/usr/bin/ditto", [sourceApp, app]);
    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        ...sourcePackage,
        version,
        main: "update-fixture-bootstrap.cjs",
      }),
    );
    const appArchive = path.join(app, "Contents/Resources/app.asar");
    await asar.createPackage(extracted, appArchive);
    const hash = headerHash(appArchive);
    const plistPath = path.join(app, "Contents/Info.plist");
    command(
      "/usr/bin/python3",
      [
        "-c",
        `import json,plistlib,sys
p=sys.argv[1]
v=json.load(sys.stdin)
with open(p,'rb') as f: d=plistlib.load(f)
d['CFBundleIdentifier']=v['bundleID']
d['CFBundleVersion']=v['version']
d['CFBundleShortVersionString']=v['version']
d['SUPublicEDKey']=v['publicKey']
d['SUEnableAutomaticChecks']=False
d['SUAutomaticallyUpdate']=False
for k in ['CFBundleDocumentTypes','CFBundleURLTypes']: d.pop(k,None)
d['ElectronAsarIntegrity']['Resources/app.asar']['hash']=v['hash']
with open(p,'wb') as f: plistlib.dump(d,f,sort_keys=False)
`,
        plistPath,
      ],
      JSON.stringify({ bundleID, version, publicKey, hash }),
    );
    const plist = readPlist(plistPath);
    assert.equal(plist.CFBundleName, sourcePlist.CFBundleName);
    assert.equal(plist.CFBundleExecutable, sourcePlist.CFBundleExecutable);
    command("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--entitlements",
      entitlementsPath,
      app,
    ]);
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    built.push({ app, version, hash });
  }
  command("/usr/bin/ditto", [built[0].app, installed]);
  archive = path.join(runDir, "update.zip");
  command("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    built[1].app,
    archive,
  ]);
  const signUpdate = path.resolve(
    __dirname,
    "../vendor/updater/bin/sign_update",
  );
  signature = command(signUpdate, ["--ed-key-file", keyPath, "-p", archive]);
  assert(
    crypto.verify(
      null,
      fs.readFileSync(archive),
      keys.publicKey,
      Buffer.from(signature, "base64"),
    ),
  );
  badArchive = path.join(runDir, "tampered.zip");
  fs.copyFileSync(archive, badArchive);
  fs.appendFileSync(badArchive, "GUZI-E2E-TAMPERED");
  return {
    currentVersion,
    targetVersion,
    executable: path.join(
      installed,
      "Contents/MacOS",
      sourcePlist.CFBundleExecutable,
    ),
    built,
  };
}
async function launch(executable, document) {
  const env = { ...process.env, EXCALIDRAW_DESKTOP_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: executable,
    args: [document],
    env,
    timeout: 45000,
  });
  knownPids.add(application.process().pid);
  page = await application.firstWindow();
  await page.locator(".desktop-workspace").waitFor({ timeout: 45000 });
  await page
    .locator(".desktop-tab")
    .filter({ hasText: path.basename(document, ".excalidraw") })
    .waitFor();
  assert.equal(page.url(), "app://local/index.html");
  return application.process().pid;
}
async function dirtyCanvas() {
  await page.locator(".desktop-tab").first().click();
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  const box = await canvas.boundingBox();
  assert(box && box.width > 400 && box.height > 300);
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
    steps: 8,
  });
  await page.mouse.up();
  await page
    .locator(".desktop-save-status")
    .filter({ hasText: "未保存" })
    .waitFor();
}
const state = () => page.evaluate(() => window.desktop.getUpdateState());
const readSession = () =>
  page
    .locator(".desktop-workspace")
    .evaluate((mounted) =>
      mounted.ownerDocument.defaultView.desktop.getSession(),
    );
async function installFromSettings(screenshotName) {
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.locator(".desktop-project-pane.is-active").waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "桌面设置", exact: true });
  await settings.locator(".desktop-update-panel").waitFor();
  const beforeInstallSession = await until(async () => {
    const value = await readSession();
    return value.activePath === null && value;
  }, "project-view session persistence");
  await page.screenshot({
    path: path.join(artifacts, `${screenshotName}.png`),
  });
  await settings
    .getByRole("button", { name: "安装并重启", exact: true })
    .click();
  await settings.waitFor({ state: "hidden" });
  return beforeInstallSession;
}
async function download() {
  const checked = await bounded(
    page.evaluate(() => window.desktop.checkForUpdates()),
    60000,
    "check update",
  );
  assert.equal(checked.status, "available");
  const downloaded = await bounded(
    page.evaluate(() => window.desktop.downloadUpdate()),
    120000,
    "download update",
  );
  assert.equal(downloaded.status, "downloaded");
}
function taskProcesses() {
  const rows = command("/bin/ps", ["-axo", "pid=,ppid=,command="])
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parent: Number(match[2]),
      command: match[3],
    }));
  for (const event of events())
    if (event.helperPid) knownPids.add(event.helperPid);
  for (let pass = 0; pass < 4; pass++)
    for (const row of rows) {
      if (
        row.command.includes(runDir) ||
        row.command.includes(bundleID) ||
        knownPids.has(row.parent)
      )
        knownPids.add(row.pid);
    }
  return rows.filter(
    (row) => row.pid !== process.pid && knownPids.has(row.pid),
  );
}
async function main() {
  sourceBefore = Object.fromEntries(
    [
      "Contents/Info.plist",
      "Contents/Resources/app.asar",
      "Contents/_CodeSignature/CodeResources",
    ].map((file) => [file, digest(path.join(sourceApp, file))]),
  );
  const helperRelative = "Contents/Resources/updater/Guzi Updater.app";
  const helperBefore = treeManifest(path.join(sourceApp, helperRelative));
  fs.mkdirSync(profile);
  fs.mkdirSync(drawings);
  const document = path.join(drawings, "更新保存验证.excalidraw");
  fs.writeFileSync(
    document,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "guzi-update-e2e",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
  const sentinel = path.join(profile, "update-e2e-sentinel.txt");
  fs.writeFileSync(sentinel, crypto.randomBytes(32));
  const sentinelHash = digest(sentinel);
  fs.writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
    }),
  );
  let fixture;
  server = http.createServer((req, res) => {
    const request = {
      path: req.url,
      mode: feedMode,
      bytes: 0,
      completed: false,
    };
    report.requests.push(request);
    if (req.url === "/appcast.xml") {
      const file = feedMode === "bad" ? badArchive : archive;
      const size = fs.statSync(file).size;
      res.writeHead(200, {
        "Content-Type": "application/rss+xml",
        "Cache-Control": "no-store",
      });
      res.end(
        `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Isolated update test</title><item><sparkle:version>${
          fixture.targetVersion
        }</sparkle:version><enclosure url="http://127.0.0.1:${
          server.address().port
        }/${feedMode}.zip" sparkle:edSignature="${signature}" length="${size}" type="application/octet-stream"/></item></channel></rss>`,
      );
      request.completed = true;
    } else if (["/good.zip", "/bad.zip"].includes(req.url)) {
      const file = req.url === "/bad.zip" ? badArchive : archive;
      const size = fs.statSync(file).size;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": size,
      });
      const stream = fs.createReadStream(file);
      stream.on("data", (data) => {
        request.bytes += data.length;
      });
      res.on("finish", () => {
        request.completed = request.bytes === size;
      });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  progress("building-isolated-fixtures");
  fixture = await fixtures(
    `http://127.0.0.1:${server.address().port}/appcast.xml`,
  );
  report.versions = {
    current: fixture.currentVersion,
    target: fixture.targetVersion,
  };
  progress("rejecting-tampered-archive");
  let pid = await launch(fixture.executable, document);
  assert.equal((await state()).currentVersion, fixture.currentVersion);
  feedMode = "bad";
  assert.equal(
    (await page.evaluate(() => window.desktop.checkForUpdates())).status,
    "available",
  );
  assert.equal(
    (
      await bounded(
        page.evaluate(() => window.desktop.downloadUpdate()),
        120000,
        "reject tampered archive",
      )
    ).status,
    "error",
  );
  assert.equal(
    readPlist(path.join(installed, "Contents/Info.plist")).CFBundleVersion,
    fixture.currentVersion,
  );
  assert(
    report.requests.some(
      (request) => request.path === "/bad.zip" && request.completed,
    ),
  );
  report.cases.tamperedArchive = { passed: true, originalPid: pid };
  feedMode = "good";
  progress("cancel-install-then-ordinary-quit");
  await download();
  await dirtyCanvas();
  const checkpoint = events().length;
  const cancelledInstallSession = await installFromSettings(
    "cancel-install-settings",
  );
  assert.deepEqual(cancelledInstallSession.paths, [document]);
  const prompt = page.getByRole("dialog").filter({ hasText: "保存画布更改？" });
  await prompt.waitFor();
  const cancelledSaveSession = await until(async () => {
    const value = await readSession();
    return value.activePath === document && value;
  }, "dirty-document session activation before cancel");
  assert.deepEqual(cancelledSaveSession.paths, [document]);
  assert(
    !events()
      .slice(checkpoint)
      .some(
        (event) =>
          event.event === "helper-event" && event.value.event === "installing",
      ),
  );
  await page.screenshot({
    path: path.join(artifacts, "save-confirmation.png"),
  });
  await prompt.getByRole("button", { name: "取消", exact: true }).click();
  await until(
    async () => (await state()).status === "available",
    "cancelled install state",
  );
  await until(
    () =>
      events()
        .slice(checkpoint)
        .some(
          (event) =>
            event.event === "helper-event" &&
            event.value.event === "done" &&
            event.value.status === "cancelled",
        ),
    "Sparkle cancellation cleanup",
  );
  const cancelledProcess = application.process();
  await application.evaluate(({ app }) => app.quit());
  await prompt.waitFor();
  await prompt.getByRole("button", { name: "保存", exact: true }).click();
  await until(
    () => cancelledProcess.exitCode !== null,
    "ordinary quit after cancellation",
  );
  application = undefined;
  assert.equal(
    readPlist(path.join(installed, "Contents/Info.plist")).CFBundleVersion,
    fixture.currentVersion,
  );
  assert(JSON.parse(fs.readFileSync(document)).elements.length > 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(profile, "session.json"), "utf8")),
    cancelledSaveSession,
  );
  report.cases.cancelThenQuit = {
    passed: true,
    originalPid: pid,
    version: fixture.currentVersion,
    savedDocument: true,
    beforeInstallSession: cancelledInstallSession,
    beforeSaveSession: cancelledSaveSession,
    sessionPreserved: true,
  };
  progress("save-install-relaunch");
  pid = await launch(fixture.executable, document);
  await download();
  await dirtyCanvas();
  const beforeSave = digest(document);
  const installCheckpoint = events().length;
  const beforeInstallSession = await installFromSettings(
    "save-install-settings",
  );
  assert.deepEqual(beforeInstallSession.paths, [document]);
  const savePrompt = page
    .getByRole("dialog")
    .filter({ hasText: "保存画布更改？" });
  await savePrompt.waitFor();
  const beforeSaveSession = await until(async () => {
    const value = await readSession();
    return value.activePath === document && value;
  }, "dirty-document session activation before install");
  assert.deepEqual(beforeSaveSession.paths, [document]);
  assert(
    !events()
      .slice(installCheckpoint)
      .some(
        (event) =>
          event.event === "helper-event" && event.value.event === "installing",
      ),
  );
  const oldProcess = application.process();
  await savePrompt.getByRole("button", { name: "保存", exact: true }).click();
  await until(() => oldProcess.exitCode !== null, "old application exit");
  application = undefined;
  const relaunched = await until(
    () =>
      events().find(
        (event) =>
          event.event === "renderer-loaded" &&
          event.version === fixture.targetVersion &&
          event.renderer.workspace,
      ),
    "updated renderer load",
    120000,
  );
  knownPids.add(relaunched.pid);
  assert.notEqual(relaunched.pid, pid);
  assert.equal(relaunched.bundlePath, installed);
  assert.equal(relaunched.profile, profile);
  assert.equal(relaunched.renderer.url, "app://local/index.html");
  assert.equal(
    relaunched.renderer.update.currentVersion,
    fixture.targetVersion,
  );
  assert.equal(relaunched.renderer.settings.rootDirectory, drawings);
  assert.deepEqual(relaunched.renderer.session, beforeSaveSession);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(profile, "session.json"), "utf8")),
    beforeSaveSession,
  );
  assert.notEqual(digest(document), beforeSave);
  assert.equal(digest(sentinel), sentinelHash);
  assert.equal(
    headerHash(path.join(installed, "Contents/Resources/app.asar")),
    fixture.built[1].hash,
  );
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
  command("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    path.join(installed, helperRelative),
  ]);
  assert.deepEqual(
    treeManifest(path.join(installed, helperRelative)),
    helperBefore,
  );
  assert(
    !events().some((event) =>
      [
        "uncaught-exception",
        "renderer-gone",
        "renderer-error",
        "load-error",
      ].includes(event.event),
    ),
  );
  report.cases.installAndRelaunch = {
    passed: true,
    originalPid: pid,
    newPid: relaunched.pid,
    sameInstallPath: true,
    sameProfile: true,
    rendererURL: relaunched.renderer.url,
    savedDocument: true,
    beforeInstallSession,
    beforeSaveSession,
    relaunchedSession: relaunched.renderer.session,
    sessionPreserved: true,
    sentinelPreserved: true,
    signatureVerified: true,
    nativeHelperFilesPreserved: Object.keys(helperBefore).length,
    nativeHelperSignatureVerified: true,
  };
  report.passed = true;
}
let cleaning;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (application)
      await bounded(application.close(), 10000, "test application close").catch(
        () => {},
      );
    for (const item of taskProcesses()) {
      try {
        process.kill(item.pid, "SIGTERM");
      } catch {}
    }
    await until(
      () => taskProcesses().length === 0,
      "test processes exit",
      10000,
    ).catch(() => {
      for (const item of taskProcesses()) {
        try {
          process.kill(item.pid, "SIGKILL");
        } catch {}
      }
    });
    await until(
      () => taskProcesses().length === 0,
      "test process cleanup",
      5000,
    );
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    report.remainingTestProcesses = taskProcesses();
    report.cleanupPassed = report.remainingTestProcesses.length === 0;
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    report.error = `Interrupted by ${signal}`;
    report.passed = false;
    void cleanup().finally(() => {
      fs.writeFileSync(
        path.join(artifacts, "report.json"),
        JSON.stringify(report, null, 2),
      );
      process.exit(1);
    });
  });
main()
  .catch((error) => {
    report.error = error.stack;
    report.passed = false;
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      report.cleanupError = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
    if (sourceBefore) {
      report.sourceApplicationUnchanged = Object.entries(sourceBefore).every(
        ([file, hash]) => digest(path.join(sourceApp, file)) === hash,
      );
      if (!report.sourceApplicationUnchanged) {
        report.passed = false;
        process.exitCode = 1;
      }
    }
    const artifactEvents = path.join(artifacts, "events.jsonl");
    if (fs.existsSync(eventsPath) && artifactEvents !== eventsPath)
      fs.copyFileSync(eventsPath, artifactEvents);
    fs.writeFileSync(
      path.join(artifacts, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        passed: report.passed,
        reportPath: path.join(artifacts, "report.json"),
        cleanupPassed: report.cleanupPassed,
        error: report.error,
      }),
    );
  });
