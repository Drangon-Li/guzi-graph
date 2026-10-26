const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const asar = require("@electron/asar");
const { _electron } = require("playwright");
const semver = require("semver");

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  assert(
    ["--from", "--to", "--artifacts"].includes(key) &&
      value &&
      !options.has(key),
    "Usage: release-update-mac.cjs --from 0.8.0 --to 0.8.1 --artifacts output-directory",
  );
  options.set(key, value);
}
assert(options.has("--artifacts"), "--artifacts is required");
const artifacts = path.resolve(options.get("--artifacts"));
fs.mkdirSync(artifacts, { recursive: true });
const from = options.get("--from");
const to = options.get("--to");
const repository = "Drangon-Li/guzi-graph";
const feed = `https://github.com/${repository}/releases/latest/download/mac-arm64-appcast.xml`;
const profile = path.join(
  os.homedir(),
  "Library/Application Support/Excalidraw Local",
);
const report = {
  from,
  to,
  repository,
  feed,
  profile,
  passed: false,
  manualLaunches: [],
  processes: [],
  screenshots: [],
};
const owned = new Map();
let runDir;
let installed;
let executable;
let nativeEvidence;
let application;
let page;
let monitor;
let stopping = false;
let finalizing;

const command = (binary, args, timeout = 120000) =>
  execFileSync(binary, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const writeReport = () =>
  fs.writeFileSync(
    path.join(artifacts, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
function progress(stage) {
  report.stage = stage;
  writeReport();
  process.stdout.write(`${JSON.stringify({ stage })}\n`);
}
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
    assert(!stopping, "Test is stopping");
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
const plist = (bundle, key) =>
  command("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    path.join(bundle, "Contents/Info.plist"),
  ]);
function bundleEvidence(bundle, version) {
  assert.equal(plist(bundle, "CFBundleVersion"), version);
  assert.equal(plist(bundle, "CFBundleShortVersionString"), version);
  const archive = path.join(bundle, "Contents/Resources/app.asar");
  asar.uncache(archive);
  const metadata = JSON.parse(asar.extractFile(archive, "package.json"));
  assert.equal(metadata.version, version);
  assert.equal(metadata.main, "src/main/main.cjs");
  assert(!metadata.buildChannel, "A production build is required");
  assert(
    asar
      .extractFile(archive, "src/main/update-mac.cjs")
      .toString()
      .includes(feed),
    "Official production feed is required",
  );
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  const executableName = plist(bundle, "CFBundleExecutable");
  return {
    version,
    bundleID: plist(bundle, "CFBundleIdentifier"),
    publicKey: plist(bundle, "SUPublicEDKey"),
    executableName,
    hashes: Object.fromEntries(
      [
        "Contents/Info.plist",
        "Contents/Resources/app.asar",
        "Contents/_CodeSignature/CodeResources",
        `Contents/MacOS/${executableName}`,
        "Contents/Resources/updater/Guzi Updater.app/Contents/MacOS/guzi-updater",
      ].map((file) => [file, digest(path.join(bundle, file))]),
    ),
  };
}
function taskProcesses() {
  if (!installed) {
    return [];
  }
  const rows = command("/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,comm="])
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parent: Number(match[2]),
      started: match[3],
      executable: match[4],
    }));
  const current = new Map(rows.map((row) => [row.pid, row]));
  const matches = (row) => {
    const known = owned.get(row.pid);
    return (
      known?.started === row.started && known.executable === row.executable
    );
  };
  let added;
  do {
    added = false;
    for (const row of rows) {
      if (row.pid === process.pid || matches(row)) {
        continue;
      }
      const parent = current.get(row.parent);
      if (
        row.executable.startsWith(`${installed}/`) ||
        (parent && matches(parent))
      ) {
        const evidence = { ...row, firstSeenAt: new Date().toISOString() };
        owned.set(row.pid, evidence);
        report.processes.push(evidence);
        added = true;
      }
    }
  } while (added);
  return rows.filter(matches);
}
const windowsFor = (pid) =>
  JSON.parse(command(nativeEvidence, ["windows", String(pid)]));
async function screenshot(name) {
  const file = path.join(artifacts, `${name}.png`);
  if (page && !page.isClosed()) {
    await bounded(page.screenshot({ path: file }), 10000, "screenshot");
  } else {
    const running = taskProcesses().find(
      (item) => item.executable === executable,
    );
    const window = running && windowsFor(running.pid).windows[0];
    if (!window) {
      assert.equal(name, "failure", "Expected an owned application window");
      report.screenshots.push({ name, skipped: "No owned application window" });
      return;
    }
    command("/usr/sbin/screencapture", ["-x", "-l", String(window.id), file]);
  }
  report.screenshots.push({ name, file });
}
const state = () =>
  page
    .locator(".desktop-workspace")
    .evaluate((mounted) =>
      mounted.ownerDocument.defaultView.desktop.getUpdateState(),
    );
async function waitForState(status, timeout) {
  return until(
    async () => {
      const value = await state();
      assert(
        !["error", "unavailable"].includes(value.status),
        JSON.stringify(value),
      );
      return value.status === status && value;
    },
    `update status ${status}`,
    timeout,
  );
}
async function launch() {
  assert(!stopping);
  application = await _electron.launch({
    executablePath: executable,
    args: [],
    env: { ...process.env },
    timeout: 60000,
  });
  report.manualLaunches.push({
    pid: application.process().pid,
    version: plist(installed, "CFBundleVersion"),
    at: new Date().toISOString(),
  });
  taskProcesses();
  assert.equal(
    await application.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.locator(".desktop-workspace").waitFor();
  await page
    .locator(".desktop-tab")
    .filter({ hasText: "公开升级保存验证" })
    .waitFor();
  assert.equal(page.url(), "app://local/index.html");
}
async function openSettings() {
  await page.getByRole("button", { name: "返回项目页", exact: true }).click();
  await page.locator(".desktop-project-pane.is-active").waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "桌面设置", exact: true });
  await settings.locator(".desktop-update-panel").waitFor();
  return settings;
}
async function snapshot() {
  return page.locator(".desktop-workspace").evaluate(async (mounted) => {
    const desktop = mounted.ownerDocument.defaultView.desktop;
    return {
      update: await desktop.getUpdateState(),
      settings: await desktop.getSettings(),
      session: await desktop.getSession(),
    };
  });
}
async function main() {
  progress("validating-clean-github-runner");
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(
    command("/usr/bin/sw_vers", ["-productVersion"]).split(".")[0],
    "15",
  );
  assert.equal(process.env.GH_REPO, repository);
  for (const key of [
    "EXCALIDRAW_DESKTOP_USER_DATA",
    "EXCALIDRAW_DESKTOP_DEV_URL",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    assert(!process.env[key], `Refusing environment override: ${key}`);
  }
  for (const version of [from, to]) {
    assert(
      /^\d+\.\d+\.\d+$/.test(version) && semver.valid(version) === version,
      "--from and --to must be stable semver versions",
    );
  }
  assert(semver.lt(from, to), "--from must be older than --to");
  assert(
    !fs.existsSync(profile),
    `Default production profile already exists: ${profile}`,
  );
  report.cleanDefaultProfile = true;
  const latest = JSON.parse(
    command("gh", [
      "release",
      "view",
      "--repo",
      repository,
      "--json",
      "tagName,isDraft,isPrerelease,url",
    ]),
  );
  report.latest = latest;
  assert.equal(latest.tagName, `v${to}`, "Latest release must match --to");
  assert.equal(latest.isDraft, false);
  assert.equal(latest.isPrerelease, false);

  runDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "guzi-public-update-")),
  );
  report.runDir = runDir;
  progress("downloading-official-release-assets");
  report.releases = {};
  for (const version of [from, to]) {
    const directory = path.join(runDir, version);
    fs.mkdirSync(directory);
    const name = `Excalidraw-Guzi-${version}-arm64.zip`;
    command(
      "gh",
      [
        "release",
        "download",
        `v${version}`,
        "--repo",
        repository,
        "--pattern",
        name,
        "--pattern",
        "SHA256SUMS",
        "--dir",
        directory,
      ],
      300000,
    );
    const checksums = fs.readFileSync(
      path.join(directory, "SHA256SUMS"),
      "utf8",
    );
    const expected = checksums
      .split("\n")
      .map((line) => line.match(/^([a-f0-9]{64}) [ *](.+)$/))
      .filter((match) => match?.[2] === name);
    assert.equal(expected.length, 1, `Missing unique checksum for ${name}`);
    const zip = path.join(directory, name);
    const hash = digest(zip);
    assert.equal(
      hash,
      expected[0][1],
      `Official ZIP checksum mismatch: ${name}`,
    );
    const unpacked = path.join(directory, "unpacked");
    command("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    const bundle = path.join(unpacked, "Excalidraw-Guzi.app");
    report.releases[version] = {
      zip: name,
      sha256: hash,
      checksumVerified: true,
      ...bundleEvidence(bundle, version),
    };
  }
  const old = report.releases[from];
  const target = report.releases[to];
  assert.equal(old.bundleID, target.bundleID);
  assert.equal(old.publicKey, target.publicKey);
  assert.equal(old.executableName, target.executableName);
  installed = path.join(runDir, "installed/Excalidraw-Guzi.app");
  command("/usr/bin/ditto", [
    path.join(runDir, from, "unpacked/Excalidraw-Guzi.app"),
    installed,
  ]);
  assert.deepEqual(bundleEvidence(installed, from).hashes, old.hashes);
  executable = path.join(installed, "Contents/MacOS", old.executableName);
  report.installed = installed;

  // NSRunningApplication observes and requests quit by PID; it never launches an app.
  const nativeSource = path.join(runDir, "native-evidence.swift");
  nativeEvidence = path.join(runDir, "native-evidence");
  fs.writeFileSync(
    nativeSource,
    `import AppKit
import CoreGraphics
import Foundation
let pid = pid_t(CommandLine.arguments[2])!
let app = NSRunningApplication(processIdentifier: pid)
if CommandLine.arguments[1] == "quit" {
  guard app?.terminate() == true else { exit(1) }
} else {
  let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let windows = all.filter {
    let bounds = $0[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 && (bounds["Width"] as? Double ?? 0) > 400 && (bounds["Height"] as? Double ?? 0) > 300
  }.map { ["id": $0[kCGWindowNumber as String]!, "title": $0[kCGWindowName as String] ?? "", "bounds": $0[kCGWindowBounds as String]!] }
  let result: [String: Any] = ["pid": Int(pid), "bundlePath": app?.bundleURL?.path ?? "", "executablePath": app?.executableURL?.path ?? "", "finishedLaunching": app?.isFinishedLaunching ?? false, "windows": windows]
  print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
}
`,
  );
  command("/usr/bin/xcrun", ["swiftc", nativeSource, "-o", nativeEvidence]);
  monitor = setInterval(() => {
    try {
      taskProcesses();
    } catch (error) {
      report.processMonitorError = error.message;
    }
  }, 500);

  assert(!fs.existsSync(profile), "Production profile appeared during setup");
  const drawings = path.join(runDir, "drawings");
  fs.mkdirSync(drawings);
  fs.mkdirSync(profile, { recursive: true });
  const document = path.join(drawings, "公开升级保存验证.excalidraw");
  fs.writeFileSync(
    document,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "guzi-public-release-update",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
  const session = { paths: [document], activePath: document };
  fs.writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({
      rootDirectory: drawings,
      language: "zh-CN",
      theme: "light",
      toolPanelWidth: 312,
      toolbarTooltips: false,
    }),
  );
  fs.writeFileSync(path.join(profile, "session.json"), JSON.stringify(session));
  const sentinel = path.join(profile, "public-update-sentinel.txt");
  fs.writeFileSync(sentinel, crypto.randomBytes(32));
  const sentinelHash = digest(sentinel);
  const initialDocumentHash = digest(document);

  progress("checking-update-through-old-application-ui");
  await launch();
  assert.equal((await state()).currentVersion, from);
  report.before = await snapshot();
  assert.equal(report.before.settings.rootDirectory, drawings);
  assert.deepEqual(report.before.session, session);
  let settings = await openSettings();
  await screenshot("old-version-before-check");
  await settings.getByRole("button", { name: "检查更新", exact: true }).click();
  report.check = await waitForState("available", 120000);
  assert.equal(report.check.availableVersion, to);
  await screenshot("update-available");
  progress("downloading-update-through-ui");
  await settings.getByRole("button", { name: "下载更新", exact: true }).click();
  report.download = await waitForState("downloaded", 600000);
  assert.equal(report.download.availableVersion, to);
  await screenshot("update-downloaded");
  await settings.getByRole("button", { name: "完成", exact: true }).click();
  await page
    .locator(".desktop-tab")
    .filter({ hasText: "公开升级保存验证" })
    .click();
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
  assert.equal(digest(document), initialDocumentHash);
  await screenshot("dirty-canvas-before-install");
  settings = await openSettings();
  report.beforeInstall = await until(async () => {
    const value = await snapshot();
    return value.session.activePath === null && value;
  }, "project-view session persistence");
  assert.deepEqual(report.beforeInstall.session.paths, [document]);
  const oldProcess = application.process();
  progress("installing-through-ui-and-saving-dirty-document");
  await settings
    .getByRole("button", { name: "安装并重启", exact: true })
    .click();
  const prompt = page.getByRole("dialog", {
    name: "保存画布更改？",
    exact: true,
  });
  await prompt.waitFor();
  report.beforeSave = await until(async () => {
    const value = await snapshot();
    return value.session.activePath === document && value;
  }, "dirty-document session activation before install");
  assert.deepEqual(report.beforeSave.session.paths, [document]);
  assert.equal(plist(installed, "CFBundleVersion"), from);
  assert.equal(oldProcess.exitCode, null);
  assert.equal(digest(document), initialDocumentHash);
  await screenshot("save-confirmation");
  report.installRequestedAt = new Date().toISOString();
  await prompt.getByRole("button", { name: "保存", exact: true }).click();
  await until(() => oldProcess.exitCode !== null, "old application exit");
  application = undefined;
  page = undefined;
  progress("observing-sparkle-automatic-relaunch");
  const restarted = await until(
    () => {
      const running = taskProcesses().find(
        (item) => item.pid !== oldProcess.pid && item.executable === executable,
      );
      if (!running || plist(installed, "CFBundleVersion") !== to) {
        return false;
      }
      const native = windowsFor(running.pid);
      return (
        native.finishedLaunching &&
        native.windows.length && { process: running, ...native }
      );
    },
    "automatic restart at the original install path",
    180000,
  );
  assert.equal(fs.realpathSync(restarted.bundlePath), installed);
  assert.equal(fs.realpathSync(restarted.executablePath), executable);
  assert.equal(report.manualLaunches.length, 1);
  report.automaticRestart = {
    oldPid: oldProcess.pid,
    observedAt: new Date().toISOString(),
    ...restarted,
    bundle: bundleEvidence(installed, to),
    manualLaunchesAtObservation: 1,
  };
  assert.deepEqual(report.automaticRestart.bundle.hashes, target.hashes);
  await screenshot("automatic-relaunch");
  assert.notEqual(digest(document), initialDocumentHash);
  const savedDocument = JSON.parse(fs.readFileSync(document, "utf8"));
  assert(
    savedDocument.elements.some(
      (element) => element.type === "rectangle" && !element.isDeleted,
    ),
  );
  const savedDocumentHash = digest(document);
  assert.equal(digest(sentinel), sentinelHash);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(profile, "session.json"), "utf8")),
    report.beforeSave.session,
  );
  writeReport();

  progress("reopening-target-to-verify-data-and-latest-state");
  assert(
    taskProcesses().some(
      (item) => item.pid === restarted.pid && item.executable === executable,
    ),
  );
  command(nativeEvidence, ["quit", String(restarted.pid)]);
  await until(
    () => !taskProcesses().some((item) => item.pid === restarted.pid),
    "automatic application normal quit",
  );
  await launch();
  report.after = await snapshot();
  assert.equal(report.after.update.currentVersion, to);
  assert.deepEqual(report.after.settings, report.before.settings);
  assert.deepEqual(report.after.session, report.beforeSave.session);
  assert.equal(digest(document), savedDocumentHash);
  assert.equal(digest(sentinel), sentinelHash);
  const reopenedDocument = await page
    .locator(".desktop-workspace")
    .evaluate(
      (mounted, file) =>
        mounted.ownerDocument.defaultView.desktop.readFile(file),
      document,
    );
  assert.equal(reopenedDocument.content, fs.readFileSync(document, "utf8"));
  report.reopenedDocument = {
    path: reopenedDocument.path,
    size: reopenedDocument.size,
    sha256: savedDocumentHash,
  };
  settings = await openSettings();
  await settings.getByRole("button", { name: "检查更新", exact: true }).click();
  report.finalCheck = await waitForState("up-to-date", 120000);
  assert.equal(report.finalCheck.currentVersion, to);
  await screenshot("target-version-up-to-date");
  assert(!report.processMonitorError, report.processMonitorError);
  report.dataPreserved = {
    document,
    savedDocumentHash,
    sentinelHash,
    settings: true,
    session: true,
    dirtyDocumentSaved: true,
  };
  report.passed = true;
}
async function cleanup() {
  if (monitor) {
    clearInterval(monitor);
  }
  if (application) {
    await bounded(
      application.close(),
      10000,
      "Playwright application close",
    ).catch(() => {});
    application = undefined;
  }
  const terminate = (signal) => {
    for (const item of taskProcesses()) {
      try {
        process.kill(item.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
  terminate("SIGTERM");
  let deadline = Date.now() + 10000;
  while (taskProcesses().length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  terminate("SIGKILL");
  deadline = Date.now() + 5000;
  while (taskProcesses().length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  report.remainingOwnedProcesses = taskProcesses();
  report.cleanupPassed = report.remainingOwnedProcesses.length === 0;
  assert(report.cleanupPassed, "Owned application processes remain");
}
async function finish() {
  if (finalizing) {
    return finalizing;
  }
  stopping = true;
  finalizing = (async () => {
    if (!report.passed) {
      try {
        await screenshot("failure");
      } catch (error) {
        report.screenshotError = error.message;
      }
    }
    try {
      await cleanup();
    } catch (error) {
      report.cleanupError = error.stack;
      report.passed = false;
    }
    report.finishedAt = new Date().toISOString();
    writeReport();
    if (!report.passed) {
      process.exitCode = 1;
    }
    process.stdout.write(
      `${JSON.stringify({
        passed: report.passed,
        cleanupPassed: report.cleanupPassed,
        reportPath: path.join(artifacts, "report.json"),
        error: report.error,
      })}\n`,
    );
  })();
  return finalizing;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    report.error = `Interrupted by ${signal}`;
    report.passed = false;
    void finish().finally(() => process.exit(1));
  });
}
void main().then(finish, (error) => {
  report.error = error.stack;
  report.passed = false;
  return finish();
});
