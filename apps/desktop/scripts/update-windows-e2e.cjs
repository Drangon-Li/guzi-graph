const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const desktopDirectory = path.resolve(__dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");

function observeChild(child, entry) {
  let stdout = "";
  let stderr = "";
  const update = () => Object.assign(entry, { stdout, stderr });
  child.stdout?.on("data", (data) => {
    stdout = (stdout + data).slice(-1024 * 1024);
    update();
  });
  child.stderr?.on("data", (data) => {
    stderr = (stderr + data).slice(-1024 * 1024);
    update();
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      Object.assign(entry, { exitCode: code, signal, stdout, stderr });
      resolve({ code, signal, stdout, stderr });
    });
  });
  completed.catch(() => {});
  return {
    completed,
    release() {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    },
  };
}

function commandOutput(result, command) {
  assert.equal(
    result.code,
    0,
    `${command} exited ${result.code}:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

async function cleanupStages(stages, onError) {
  for (const [name, action] of stages) {
    try {
      await action();
    } catch (error) {
      onError(name, error);
    }
  }
}

function devToolsEndpoint(contents) {
  const [port, browserPath] = contents.trim().split(/\r?\n/);
  assert.match(port, /^\d+$/);
  assert.ok(Number(port) > 0 && Number(port) < 65536);
  assert.match(browserPath, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
  return `ws://127.0.0.1:${Number(port)}${browserPath}`;
}

function options(argv) {
  const result = {
    appDirectory: path.join(desktopDirectory, "release/win-unpacked"),
    outputDirectory: path.join(
      repositoryDirectory,
      "output/update-e2e/windows",
    ),
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    assert.ok(
      ["--app-dir", "--output-dir"].includes(flag),
      `Unknown option: ${flag}`,
    );
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), `${flag} requires a path`);
    result[flag === "--app-dir" ? "appDirectory" : "outputDirectory"] =
      path.resolve(repositoryDirectory, value);
  }
  return result;
}

async function execute(configuration) {
  assert.equal(
    process.platform,
    "win32",
    "The NSIS update E2E must run on Windows",
  );
  const asar = require("@electron/asar");
  const { chromium } = require("playwright");
  const { appDirectory, outputDirectory } = configuration;
  await fs.mkdir(outputDirectory, { recursive: true });
  const report = {
    platform: process.platform,
    startedAt: new Date().toISOString(),
    passed: false,
    appDirectory,
    scenarios: [],
    launches: [],
    updates: [],
    requests: [],
    processes: [],
    devToolsConnections: [],
    limitations: [
      "Dirty-document cancellation is covered by main/renderer tests, not this installed-app scenario.",
    ],
  };
  const ownedChildren = new Map();
  const abort = new AbortController();
  const onSignal = (signal) =>
    abort.abort(new Error(`Interrupted by ${signal}`));
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let isolated;
  let server;
  let browser;
  let page;
  let installDirectory;
  let executablePath;
  let cacheDirectory;
  let bootstrapLog;
  let initialArchiveHash;

  const hash = async (filename) => {
    const digest = createHash("sha512");
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    return digest.digest("base64");
  };
  const bounded = (promise, milliseconds, description, ignoreAbort = false) => {
    let timer;
    let onAbort;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${description}`)),
          milliseconds,
        );
        if (!ignoreAbort) {
          onAbort = () => reject(abort.signal.reason);
          if (abort.signal.aborted) onAbort();
          else abort.signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) abort.signal.removeEventListener("abort", onAbort);
    });
  };
  const waitFor = async (
    inspect,
    description,
    timeout = 60000,
    ignoreAbort = false,
  ) => {
    const deadline = Date.now() + timeout;
    while (true) {
      if (!ignoreAbort) abort.signal.throwIfAborted();
      const result = await inspect();
      if (result) return result;
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      await delay(300);
    }
  };
  const start = (command, args, extra = {}) => {
    const child = spawn(command, args, {
      cwd: desktopDirectory,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...extra,
    });
    const entry = {
      command,
      args,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
    report.processes.push(entry);
    const observed = observeChild(child, entry);
    ownedChildren.set(child, observed);
    const completed = observed.completed.finally(() =>
      ownedChildren.delete(child),
    );
    // A long-lived fixture can fail while the test is waiting for its bootstrap log.
    completed.catch(() => {});
    return { child, completed };
  };
  const run = async (
    command,
    args,
    extra = {},
    timeout = 180000,
    ignoreAbort = false,
  ) => {
    const result = await bounded(
      start(command, args, extra).completed,
      timeout,
      command,
      ignoreAbort,
    );
    return commandOutput(result, command);
  };
  const powershell = (script, env = {}, ignoreAbort = false) =>
    run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(
          `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`,
          "utf16le",
        ).toString("base64"),
      ],
      { env: { ...process.env, ...env } },
      30000,
      ignoreAbort,
    );
  const readEvents = async () => {
    const contents = await fs.readFile(bootstrapLog, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const bridge = (method) =>
    bounded(
      page
        .locator(".desktop-workspace")
        .evaluate(
          (mounted, method) =>
            mounted.ownerDocument.defaultView.desktop[method](),
          method,
        ),
      180000,
      `desktop.${method}`,
    );
  const captureStates = async (scenario) => {
    const states = await page
      .locator(".desktop-workspace")
      .evaluate(
        (mounted) => mounted.ownerDocument.defaultView.__guziUpdateE2EStates,
      );
    report.updates.push({ scenario, states });
    return states;
  };
  const connect = async (launch) => {
    const connection = {
      pid: launch.pid,
      version: launch.version,
      attempts: 0,
    };
    report.devToolsConnections.push(connection);
    const endpoint = await waitFor(async () => {
      connection.attempts++;
      try {
        const endpoint = devToolsEndpoint(
          await fs.readFile(launch.devToolsActivePortFile, "utf8"),
        );
        assert.ok(
          !report.devToolsConnections.some(
            (previous) =>
              previous.pid !== launch.pid && previous.endpoint === endpoint,
          ),
          "DevToolsActivePort still belongs to an earlier fixture process",
        );
        const address = new URL(endpoint);
        const response = await fetch(`http://${address.host}/json/version`, {
          signal: AbortSignal.timeout(1500),
        });
        assert.equal(
          response.ok,
          true,
          `DevTools HTTP status ${response.status}`,
        );
        assert.equal((await response.json()).webSocketDebuggerUrl, endpoint);
        return endpoint;
      } catch (error) {
        connection.lastError = `${error.message}${
          error.cause?.code ? ` (${error.cause.code})` : ""
        }`;
        return false;
      }
    }, `fixture DevTools endpoint for PID ${launch.pid}`);
    connection.endpoint = endpoint;
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 });
    page = await waitFor(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === "app://local/index.html"),
      "production renderer",
    );
    page.setDefaultTimeout(30000);
    await page.locator(".desktop-workspace").waitFor();
    await page
      .getByRole("tab", { name: "NSIS update canvas", exact: true })
      .waitFor();
    await page.locator(".desktop-workspace").evaluate((mounted) => {
      const ownerWindow = mounted.ownerDocument.defaultView;
      ownerWindow.__guziUpdateE2EStates = [];
      ownerWindow.desktop.onUpdateState((state) =>
        ownerWindow.__guziUpdateE2EStates.push(state),
      );
    });
  };
  const disconnect = async () => {
    if (browser)
      await bounded(browser.close(), 10000, "CDP disconnect", true).catch(
        () => {},
      );
    browser = undefined;
    page = undefined;
  };
  const launch = async (version) => {
    const offset = (await readEvents()).length;
    const launched = start(executablePath, [], {
      env: {
        ...process.env,
        EXCALIDRAW_DESKTOP_DEV_URL: "",
      },
    });
    const event = await waitFor(
      async () =>
        (await readEvents())
          .slice(offset)
          .find(
            (event) =>
              event.type === "renderer-loaded" && event.version === version,
          ),
      `${version} renderer bootstrap`,
    );
    assert.equal(event.execPath.toLowerCase(), executablePath.toLowerCase());
    assert.equal(event.userData, report.profile);
    assert.equal(event.isPackaged, true);
    assert.equal(event.url, "app://local/index.html");
    assert.equal(event.pid, launched.child.pid);
    report.launches.push(event);
    await connect(event);
    assert.equal((await bridge("getUpdateState")).currentVersion, version);
    return event;
  };
  const closeNormally = async (pid) => {
    const window = (await readEvents()).findLast(
      (event) =>
        event.type === "renderer-loaded" &&
        event.pid === pid &&
        event.url === "app://local/index.html",
    );
    assert.match(
      window?.nativeWindowHandle || "",
      /^\d+$/,
      "Fixture must report its actual native window handle",
    );
    await powershell(
      `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class GuziE2EClose {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static void Close(IntPtr window, uint expectedPid) {
    uint actualPid;
    if (GetWindowThreadProcessId(window, out actualPid) == 0 || actualPid != expectedPid) {
      throw new InvalidOperationException("Fixture HWND/PID mismatch");
    }
    if (!PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
$targetPid = [int]$env:GUZI_E2E_PID
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid"
if (-not $target -or $target.ExecutablePath -ine $env:GUZI_E2E_EXECUTABLE) { throw 'Fixture PID/path mismatch' }
[GuziE2EClose]::Close([IntPtr]([long]::Parse($env:GUZI_E2E_HWND)), [uint32]$targetPid)
`,
      {
        GUZI_E2E_PID: String(pid),
        GUZI_E2E_EXECUTABLE: executablePath,
        GUZI_E2E_HWND: window.nativeWindowHandle,
      },
    );
    await waitFor(
      async () =>
        (
          await readEvents()
        ).some((event) => event.type === "quit" && event.pid === pid),
      "normal quit",
    );
    await disconnect();
    await waitFor(async () => {
      const result = await powershell(
        `$target = Get-CimInstance Win32_Process -Filter "ProcessId = $env:GUZI_E2E_PID"; if ($target -and $target.ExecutablePath -ieq $env:GUZI_E2E_EXECUTABLE) { 'running' }`,
        { GUZI_E2E_PID: String(pid), GUZI_E2E_EXECUTABLE: executablePath },
      );
      return !result.trim();
    }, "fixture exit");
  };

  try {
    isolated = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "guzi-nsis-update-e2e-")),
    );
    const id = randomUUID().replaceAll("-", "");
    report.fixtureId = id;
    report.profile = path.join(isolated, "profile");
    const cacheName = `guzi-update-e2e-${id}-updater`;
    cacheDirectory = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
      cacheName,
    );
    bootstrapLog = path.join(isolated, "bootstrap.jsonl");
    const sourceArchive = path.join(appDirectory, "resources/app.asar");
    initialArchiveHash = await hash(sourceArchive);
    report.productionArchiveSha512 = initialArchiveHash;
    const originalPackage = JSON.parse(
      asar.extractFile(sourceArchive, "package.json").toString(),
    );
    assert.ok(
      !originalPackage.buildChannel,
      "Supply a production package, without buildChannel",
    );
    const version = originalPackage.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    assert.ok(version, "The source version must be a stable major.minor.patch");
    report.oldVersion = originalPackage.version;
    report.newVersion = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
    const executables = (await fs.readdir(appDirectory)).filter((name) =>
      name.toLowerCase().endsWith(".exe"),
    );
    assert.equal(
      executables.length,
      1,
      "Expected one application EXE in win-unpacked",
    );
    const executableName = `GuziUpdateE2E-${id}`;
    installDirectory = path.join(isolated, "installed app", executableName);
    executablePath = path.join(installDirectory, `${executableName}.exe`);
    report.installDirectory = installDirectory;
    const drawings = path.join(isolated, "drawings");
    const canvasPath = path.join(drawings, "NSIS update canvas.excalidraw");
    await fs.mkdir(report.profile, { recursive: true });
    await fs.mkdir(drawings);
    const sentinel = randomUUID();
    await fs.writeFile(path.join(report.profile, "e2e-sentinel.txt"), sentinel);
    await fs.writeFile(
      path.join(report.profile, "settings.json"),
      JSON.stringify({
        rootDirectory: drawings,
        language: "zh-CN",
        theme: "light",
      }),
    );
    await fs.writeFile(
      path.join(report.profile, "session.json"),
      JSON.stringify({ paths: [canvasPath], activePath: canvasPath }),
    );
    await fs.writeFile(
      canvasPath,
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "guzi-nsis-update-e2e",
        elements: [
          {
            id: "nsis-preserved-rectangle",
            type: "rectangle",
            x: 80,
            y: 80,
            width: 240,
            height: 120,
            angle: 0,
            strokeColor: "#1e1e1e",
            backgroundColor: "#b2f2bb",
            fillStyle: "solid",
            strokeWidth: 2,
            strokeStyle: "solid",
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            index: "a0",
            roundness: null,
            seed: 1,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
          },
        ],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    );
    const canvasHash = await hash(canvasPath);

    let manifest;
    let badDigest = true;
    let installer;
    const feed = http.createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const entry = {
        pathname,
        method: request.method,
        badDigest,
        at: new Date().toISOString(),
      };
      report.requests.push(entry);
      response.setHeader("Cache-Control", "no-store");
      if (pathname === "/latest.yml" && manifest) {
        const digest = badDigest
          ? Buffer.alloc(64, 0x42).toString("base64")
          : manifest.sha512;
        const body = `version: ${
          report.newVersion
        }\nfiles:\n  - url: ${JSON.stringify(
          manifest.filename,
        )}\n    sha512: ${digest}\n    size: ${
          manifest.size
        }\npath: ${JSON.stringify(
          manifest.filename,
        )}\nsha512: ${digest}\nreleaseDate: ${JSON.stringify(
          new Date().toISOString(),
        )}\n`;
        entry.status = 200;
        response.writeHead(200, {
          "Content-Type": "application/yaml",
          "Content-Length": Buffer.byteLength(body),
        });
        response.end(body);
      } else if (manifest && pathname === `/${manifest.filename}`) {
        // Return a full installer; unavailable blockmaps exercise the updater's normal full-download fallback.
        entry.status = 200;
        entry.bytes = manifest.size;
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": manifest.size,
        });
        if (request.method === "HEAD") response.end();
        else {
          const stream = createReadStream(installer);
          stream.on("error", (error) => response.destroy(error));
          response.on("close", () => stream.destroy());
          stream.pipe(response);
        }
      } else {
        entry.status = 404;
        response.writeHead(404);
        response.end();
      }
    });
    server = feed;
    await new Promise((resolve, reject) => {
      feed.once("error", reject);
      feed.listen(0, "127.0.0.1", resolve);
    });
    const feedURL = `http://127.0.0.1:${feed.address().port}/`;
    report.feedURL = feedURL;
    const extracted = path.join(isolated, "asar-source");
    asar.extractAll(sourceArchive, extracted);
    const productName = `Guzi Update E2E ${id}`;
    const appId = `local.excalidraw.update.e2e.${id}`;
    const guid = randomUUID();
    report.fixtureAppId = appId;
    report.fixtureNsisGuid = guid;
    const fixture = {
      profile: report.profile,
      log: bootstrapLog,
      productName,
      appId,
    };
    const originalMain = originalPackage.main;
    assert.ok(originalMain, "Packaged application must declare its main entry");
    await fs.writeFile(
      path.join(extracted, "update-e2e-bootstrap.cjs"),
      `
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const fixture = ${JSON.stringify(fixture)};
process.env.EXCALIDRAW_DESKTOP_USER_DATA = fixture.profile;
process.env.EXCALIDRAW_DESKTOP_DEV_URL = "";
app.setName(fixture.productName);
app.setAppUserModelId(fixture.appId);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", "0");
const record = (type, extra = {}) => fs.appendFileSync(fixture.log, JSON.stringify({
  type, pid: process.pid, version: app.getVersion(), execPath: process.execPath,
  userData: app.getPath("userData"), isPackaged: app.isPackaged, at: new Date().toISOString(), ...extra,
  argv: process.argv,
  remoteDebuggingPort: app.commandLine.getSwitchValue("remote-debugging-port"),
  remoteDebuggingPipe: app.commandLine.hasSwitch("remote-debugging-pipe"),
  sessionData: app.getPath("sessionData"),
  devToolsActivePortFile: require("node:path").join(app.getPath("sessionData"), "DevToolsActivePort"),
}) + "\\n");
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-finish-load", () => {
    const window = BrowserWindow.fromWebContents(contents);
    const handle = window?.getNativeWindowHandle();
    record("renderer-loaded", {
      url: contents.getURL(),
      nativeWindowHandle: handle ? (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString() : null,
    });
  });
});
app.on("quit", () => record("quit"));
ipcMain.on("desktop:confirm-close", () => record("confirm-close"));
ipcMain.on("desktop:cancel-close", () => record("cancel-close"));
require(${JSON.stringify(`./${originalMain}`)});
// Electron starts its HTTP handler after main returns; discard the previous process's endpoint first.
fs.rmSync(require("node:path").join(app.getPath("sessionData"), "DevToolsActivePort"), { force: true });
const updater = require("electron-updater").autoUpdater;
updater.on("error", (error) => record("updater-error", { message: error.message, code: error.code }));
require("electron").autoUpdater.on("before-quit-for-update", () => record("before-quit-for-update"));
record("bootstrap");
`,
    );
    const builderCLI = path.join(
      path.dirname(require.resolve("electron-builder/package.json")),
      "cli.js",
    );
    for (const fixtureVersion of [report.oldVersion, report.newVersion]) {
      const fixturePackage = {
        ...originalPackage,
        name: `guzi-update-e2e-${id}`,
        productName,
        version: fixtureVersion,
        main: "update-e2e-bootstrap.cjs",
      };
      delete fixturePackage.build;
      delete fixturePackage.buildChannel;
      const prepackaged = path.join(isolated, `win-unpacked-${fixtureVersion}`);
      const project = path.join(isolated, `project-${fixtureVersion}`);
      const output = path.join(isolated, `installer-${fixtureVersion}`);
      await fs.cp(appDirectory, prepackaged, { recursive: true });
      await fs.rename(
        path.join(prepackaged, executables[0]),
        path.join(prepackaged, `${executableName}.exe`),
      );
      await fs.mkdir(project);
      await fs.writeFile(
        path.join(project, "package.json"),
        JSON.stringify(fixturePackage),
      );
      await fs.writeFile(
        path.join(extracted, "package.json"),
        JSON.stringify(fixturePackage),
      );
      await asar.createPackageWithOptions(
        extracted,
        path.join(prepackaged, "resources/app.asar"),
        {
          unpack: "**/*.{node,dll,exe}",
        },
      );
      await fs.writeFile(
        path.join(prepackaged, "resources/app-update.yml"),
        `provider: generic\nurl: ${feedURL}\nupdaterCacheDirName: ${cacheName}\n`,
      );
      const build = {
        extends: null,
        appId,
        productName,
        executableName,
        electronVersion: require("electron/package.json").version,
        directories: {
          output,
          buildResources: path.join(desktopDirectory, "resources"),
        },
        extraMetadata: { version: fixtureVersion },
        fileAssociations: [],
        publish: [{ provider: "generic", url: feedURL }],
        win: {
          target: [{ target: "nsis", arch: ["x64"] }],
          signAndEditExecutable: false,
          icon: path.join(desktopDirectory, "resources/icon.ico"),
          artifactName: "fixture-${version}-${arch}.${ext}",
        },
        nsis: {
          ...require("../package.json").build.nsis,
          guid,
          createDesktopShortcut: false,
          createStartMenuShortcut: false,
          deleteAppDataOnUninstall: false,
        },
      };
      const config = path.join(project, "electron-builder.json");
      await fs.writeFile(config, JSON.stringify(build));
      console.log(`Building isolated NSIS ${fixtureVersion}`);
      await run(
        process.execPath,
        [
          builderCLI,
          "--projectDir",
          project,
          "--config",
          config,
          "--prepackaged",
          prepackaged,
          "--win",
          "nsis",
          "--x64",
          "--publish",
          "never",
        ],
        {
          env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
        },
        10 * 60 * 1000,
      );
      const builtInstaller = path.join(
        output,
        `fixture-${fixtureVersion}-x64.exe`,
      );
      await fs.access(builtInstaller);
      if (fixtureVersion === report.oldVersion) {
        report.oldFixtureArchiveSha512 = await hash(
          path.join(prepackaged, "resources/app.asar"),
        );
        console.log(`Installing isolated NSIS ${fixtureVersion}`);
        // NSIS parses /D as the final, unquoted remainder of the command line.
        await run(
          builtInstaller,
          ["/S", "/currentuser", `/D=${installDirectory}`],
          {
            windowsVerbatimArguments: true,
          },
        );
        await fs.access(executablePath);
      } else {
        report.newFixtureArchiveSha512 = await hash(
          path.join(prepackaged, "resources/app.asar"),
        );
        installer = builtInstaller;
        manifest = {
          filename: path.basename(installer),
          size: (await fs.stat(installer)).size,
          sha512: await hash(installer),
        };
      }
    }
    const installedArchive = path.join(installDirectory, "resources/app.asar");
    assert.equal(await hash(installedArchive), report.oldFixtureArchiveSha512);
    assert.equal(
      await hash(sourceArchive),
      initialArchiveHash,
      "Production app.asar changed while preparing fixtures",
    );
    let old = await launch(report.oldVersion);
    assert.equal((await bridge("checkForUpdates")).status, "available");
    const refused = await bridge("downloadUpdate");
    assert.equal(
      refused.status,
      "error",
      "A bad SHA-512 must reject the download",
    );
    const errors = (await readEvents()).filter(
      (event) => event.type === "updater-error",
    );
    assert.ok(
      errors.some((event) =>
        /sha512|checksum|digest/i.test(`${event.code} ${event.message}`),
      ),
      `Expected an updater checksum error: ${JSON.stringify(errors)}`,
    );
    assert.equal(await hash(installedArchive), report.oldFixtureArchiveSha512);
    assert.equal(
      (await bridge("getUpdateState")).currentVersion,
      report.oldVersion,
    );
    assert.ok(
      report.requests.some(
        (request) =>
          request.badDigest &&
          request.pathname === `/${manifest.filename}` &&
          request.status === 200,
      ),
    );
    const refusedStates = await captureStates("bad-sha512");
    assert.ok(
      !refusedStates.some((state) =>
        ["downloaded", "installing"].includes(state.status),
      ),
    );
    await closeNormally(old.pid);
    assert.equal(await hash(installedArchive), report.oldFixtureArchiveSha512);
    report.scenarios.push(
      "Corrupt SHA-512 rejected by real electron-updater; installation unchanged after normal quit",
    );

    badDigest = false;
    old = await launch(report.oldVersion);
    assert.equal((await bridge("checkForUpdates")).status, "available");
    assert.equal((await bridge("downloadUpdate")).status, "downloaded");
    await captureStates("download-then-normal-quit");
    await closeNormally(old.pid);
    assert.equal(
      await hash(installedArchive),
      report.oldFixtureArchiveSha512,
      "Ordinary quit must not install a downloaded update",
    );
    report.scenarios.push(
      "Downloaded update does not install on ordinary quit",
    );

    old = await launch(report.oldVersion);
    assert.equal((await bridge("checkForUpdates")).status, "available");
    assert.equal((await bridge("downloadUpdate")).status, "downloaded");
    await page.screenshot({
      path: path.join(outputDirectory, "before-update.png"),
      fullPage: true,
    });
    await captureStates("install");
    const offset = (await readEvents()).length;
    const closed = page.waitForEvent("close", { timeout: 180000 });
    closed.catch(() => {});
    await bridge("installUpdate");
    await bounded(
      closed,
      180000,
      "old renderer closes after install confirmation",
    );
    await disconnect();
    const replacement = await waitFor(
      async () =>
        (await readEvents())
          .slice(offset)
          .find(
            (event) =>
              event.type === "renderer-loaded" &&
              event.version === report.newVersion,
          ),
      "NSIS automatic restart of new version",
      180000,
    );
    assert.notEqual(replacement.pid, old.pid);
    assert.equal(
      replacement.execPath.toLowerCase(),
      executablePath.toLowerCase(),
    );
    assert.equal(replacement.userData, report.profile);
    assert.equal(replacement.isPackaged, true);
    assert.equal(replacement.url, "app://local/index.html");
    const transition = (await readEvents()).slice(offset);
    assert.ok(
      transition.some(
        (event) => event.type === "confirm-close" && event.pid === old.pid,
      ),
      "Production renderer must confirm the normal save/close path",
    );
    assert.ok(
      transition.some(
        (event) =>
          event.type === "before-quit-for-update" && event.pid === old.pid,
      ),
    );
    assert.ok(
      transition.some(
        (event) => event.type === "quit" && event.pid === old.pid,
      ),
    );
    report.launches.push(replacement);
    await connect(replacement);
    assert.equal(
      (await bridge("getUpdateState")).currentVersion,
      report.newVersion,
    );
    assert.equal(await hash(installedArchive), report.newFixtureArchiveSha512);
    assert.equal(
      await fs.readFile(path.join(report.profile, "e2e-sentinel.txt"), "utf8"),
      sentinel,
    );
    assert.equal(await hash(canvasPath), canvasHash);
    const session = await bridge("getSession");
    assert.ok(session.paths.includes(canvasPath));
    assert.equal(session.activePath, canvasPath);
    const saved = await page
      .locator(".desktop-workspace")
      .evaluate(
        (mounted, canvasPath) =>
          mounted.ownerDocument.defaultView.desktop.readFile(canvasPath),
        canvasPath,
      );
    assert.ok(
      JSON.parse(saved.content).elements.some(
        (element) => element.id === "nsis-preserved-rectangle",
      ),
    );
    await page.screenshot({
      path: path.join(outputDirectory, "after-update.png"),
      fullPage: true,
    });
    assert.equal((await bridge("checkForUpdates")).status, "up-to-date");
    await captureStates("new-version");
    await closeNormally(replacement.pid);
    assert.equal(await hash(sourceArchive), initialArchiveHash);
    report.scenarios.push(
      "Production desktop bridge checks, downloads, confirms saved documents, installs NSIS, and restarts higher version at same path",
    );
    report.scenarios.push(
      "Isolated user profile sentinel, open session, and saved canvas bytes survive replacement",
    );
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    console.error(report.error);
    await page
      ?.screenshot({
        path: path.join(outputDirectory, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  } finally {
    await disconnect();
    const cleanupFailure = (stage, error) => {
      report.passed = false;
      report.cleanupErrors ||= [];
      report.cleanupErrors.push({ stage, error: error.stack || String(error) });
      report.cleanupError = report.cleanupErrors
        .map((item) => `${item.stage}: ${item.error}`)
        .join("\n");
      console.error(report.cleanupError);
    };
    const roots = await Promise.all(
      [isolated, cacheDirectory]
        .filter(Boolean)
        .map((root) => fs.realpath(root).catch(() => root)),
    );
    await cleanupStages(
      [
        [
          "fixture-processes",
          async () => {
            // Restrict discovery to canonical paths in this fixture's temporary/cache roots.
            if (isolated) {
              const cleanup = await powershell(
                `
$roots = ConvertFrom-Json -InputObject $env:GUZI_E2E_ROOTS
function Get-OwnedFixtureProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $candidate = $_.ExecutablePath
    $owned = $false
    foreach ($root in $roots) {
      if ($candidate -and ($candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($root.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase))) { $owned = $true }
    }
    $owned
  })
}
$owned = @(Get-OwnedFixtureProcesses)
foreach ($item in $owned) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $remaining = @(Get-OwnedFixtureProcesses)
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
@{ stopped = @($owned | Select-Object ProcessId, ExecutablePath); remaining = @($remaining | Select-Object ProcessId, ExecutablePath) } | ConvertTo-Json -Depth 4 -Compress
if ($remaining.Count -ne 0) { throw 'Fixture processes remain after cleanup' }
`,
                { GUZI_E2E_ROOTS: JSON.stringify(roots) },
                true,
              );
              report.cleanup = JSON.parse(cleanup);
            }
          },
        ],
        [
          "tracked-processes",
          async () => {
            await cleanupStages(
              Array.from(ownedChildren.keys(), (child) => [
                String(child.pid),
                async () => {
                  if (child.exitCode === null && child.signalCode === null) {
                    await new Promise((resolve, reject) =>
                      execFile(
                        "taskkill.exe",
                        ["/PID", String(child.pid), "/T", "/F"],
                        { timeout: 10000, windowsHide: true },
                        (error) => (error ? reject(error) : resolve()),
                      ),
                    );
                  }
                },
              ]),
              cleanupFailure,
            );
          },
        ],
        [
          "uninstall",
          async () => {
            if (installDirectory) {
              const names = await fs
                .readdir(installDirectory)
                .catch((error) => {
                  if (error.code === "ENOENT") return [];
                  throw error;
                });
              const uninstaller = names.find((name) =>
                /^Uninstall .*\.exe$/i.test(name),
              );
              if (uninstaller) {
                await run(
                  path.join(installDirectory, uninstaller),
                  ["/S", "/currentuser", `_?=${installDirectory}`],
                  { windowsVerbatimArguments: true },
                  60000,
                  true,
                );
              }
            }
          },
        ],
        [
          "verify-cleanup",
          async () => {
            if (installDirectory) {
              const verified = await powershell(
                `
$roots = ConvertFrom-Json -InputObject $env:GUZI_E2E_ROOTS
$remaining = @(Get-CimInstance Win32_Process | Where-Object {
  $candidate = $_.ExecutablePath
  $owned = $false
  foreach ($root in $roots) {
    if ($candidate -and $candidate.StartsWith($root.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)) { $owned = $true }
  }
  $owned
} | Select-Object ProcessId, ExecutablePath)
$registry = @()
if ($env:GUZI_E2E_GUID) {
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    foreach ($prefix in @('Software', 'Software\\WOW6432Node')) {
      foreach ($suffix in @($env:GUZI_E2E_GUID, ('Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $env:GUZI_E2E_GUID))) {
        $key = $hive + '\\' + $prefix + '\\' + $suffix
        if (Test-Path $key) { $registry += $key }
      }
    }
  }
}
@{ remainingProcesses = $remaining; remainingRegistryKeys = $registry } | ConvertTo-Json -Depth 4 -Compress
if ($remaining.Count -or $registry.Count) { throw 'Fixture process or registry registration remains after uninstall' }
`,
                {
                  GUZI_E2E_ROOTS: JSON.stringify(roots),
                  GUZI_E2E_GUID: report.fixtureNsisGuid || "",
                },
                true,
              );
              report.cleanup ||= {};
              Object.assign(report.cleanup, JSON.parse(verified));
            }
          },
        ],
      ],
      cleanupFailure,
    );
    for (const observed of ownedChildren.values()) observed.release();
    if (server) {
      server.closeAllConnections();
      await bounded(
        new Promise((resolve) => server.close(resolve)),
        10000,
        "feed server shutdown",
        true,
      ).catch((error) => {
        report.passed = false;
        report.serverCleanupError = String(error);
      });
    }
    if (bootstrapLog) {
      report.bootstrap = await readEvents().catch((error) => [
        { error: String(error) },
      ]);
      await fs
        .copyFile(bootstrapLog, path.join(outputDirectory, "bootstrap.jsonl"))
        .catch(() => {});
    }
    report.completedAt = new Date().toISOString();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (isolated && !report.cleanupError) {
      await fs
        .rm(isolated, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 300,
        })
        .catch((error) => {
          report.passed = false;
          report.cleanupError = String(error);
        });
      if (cacheDirectory)
        await fs
          .rm(cacheDirectory, { recursive: true, force: true })
          .catch((error) => {
            report.passed = false;
            report.cacheCleanupError = String(error);
          });
    }
    await fs.writeFile(
      path.join(outputDirectory, "report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  assert.ok(
    report.passed,
    `Windows updater E2E failed; see ${path.join(
      outputDirectory,
      "report.json",
    )}`,
  );
  console.log(
    `Windows updater E2E passed; report: ${path.join(
      outputDirectory,
      "report.json",
    )}`,
  );
}

if (require.main === module) {
  const configuration = options(process.argv.slice(2));
  if (configuration.help) {
    console.log(
      "Usage: node apps/desktop/scripts/update-windows-e2e.cjs [--app-dir apps/desktop/release/win-unpacked] [--output-dir output/update-e2e/windows]",
    );
  } else {
    execute(configuration).catch((error) => {
      console.error(error.stack || String(error));
      process.exitCode = 1;
      // Cleanup and the diagnostic report finish before this bounds any leaked external handle.
      setTimeout(() => process.exit(1), 1000).unref();
    });
  }
}

module.exports = {
  options,
  observeChild,
  commandOutput,
  cleanupStages,
  devToolsEndpoint,
};
