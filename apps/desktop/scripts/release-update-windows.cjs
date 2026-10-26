// Temporary script-only CI timing fixture; this branch is not merged.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const semver = require("semver");

const repository = "Drangon-Li/guzi-graph";
// electron-builder's UUID v5 of the production appId, local.excalidraw.desktop.
const nsisGuid = "e9e7d04b-d3a3-5a55-a794-21d35b07b267";
const desktopDirectory = path.resolve(__dirname, "..");

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help") {
      return { help: true };
    }
    assert.ok(
      ["--from", "--to", "--artifacts"].includes(flag),
      `Unknown option: ${flag}`,
    );
    const key = flag.slice(2);
    assert.ok(!result[key], `Duplicate option: ${flag}`);
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), `${flag} requires a value`);
    result[key] = value;
  }
  for (const key of ["from", "to"]) {
    assert.match(
      result[key] || "",
      /^\d+\.\d+\.\d+$/,
      `--${key} must be a stable version`,
    );
    assert.equal(semver.valid(result[key]), result[key]);
  }
  assert.ok(
    semver.lt(result.from, result.to),
    "--from must be older than --to",
  );
  assert.ok(result.artifacts, "--artifacts is required");
  result.artifacts = path.resolve(result.artifacts);
  return result;
}

async function hash(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function execute(configuration) {
  const { from, to, artifacts } = configuration;
  await fs.mkdir(artifacts, { recursive: true });
  const report = {
    from,
    to,
    repository,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date().toISOString(),
    passed: false,
    processes: [],
    updateStates: [],
    screenshots: [],
    cleanupErrors: [],
  };
  const abort = new AbortController();
  const onInterrupt = () => abort.abort(new Error("Interrupted by SIGINT"));
  const onTerminate = () => abort.abort(new Error("Interrupted by SIGTERM"));
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const children = new Set();
  let temporary;
  let executable;
  let installDirectory;
  let cache;
  let profile;
  let ownsProfile = false;
  let ownsCache = false;
  let application;
  let page;

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
          if (abort.signal.aborted) {
            onAbort();
          } else {
            abort.signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) {
        abort.signal.removeEventListener("abort", onAbort);
      }
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
      if (!ignoreAbort) {
        abort.signal.throwIfAborted();
      }
      const result = await inspect();
      if (result) {
        return result;
      }
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      await delay(500);
    }
  };
  const run = async (
    command,
    args,
    extra = {},
    timeout = 180000,
    ignoreAbort = false,
  ) => {
    if (!ignoreAbort) {
      abort.signal.throwIfAborted();
    }
    const child = spawn(command, args, {
      cwd: desktopDirectory,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...extra,
    });
    children.add(child);
    const entry = {
      command,
      args,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
    };
    report.processes.push(entry);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        entry[stream] = (entry[stream] + chunk).slice(-128 * 1024);
      });
    }
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        Object.assign(entry, { exitCode: code, signal });
        resolve(code);
      });
    });
    const code = await bounded(completed, timeout, command, ignoreAbort);
    assert.equal(
      code,
      0,
      `${command} exited ${code}:\n${entry.stdout}\n${entry.stderr}`,
    );
    return entry.stdout;
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
  const parse = (output) => JSON.parse(output.replace(/^\uFEFF/, "").trim());
  const registrations = async (ignoreAbort = false) =>
    parse(
      await powershell(
        `
$keys = @()
foreach ($hive in @('HKCU:', 'HKLM:')) {
  foreach ($prefix in @('Software', 'Software\\WOW6432Node')) {
    foreach ($suffix in @('${nsisGuid}', 'Microsoft\\Windows\\CurrentVersion\\Uninstall\\${nsisGuid}')) {
      $key = $hive + '\\' + $prefix + '\\' + $suffix
      if (Test-Path -LiteralPath $key) { $keys += $key }
    }
  }
}
ConvertTo-Json -InputObject @($keys) -Compress
`,
        {},
        ignoreAbort,
      ),
    );
  const appProcesses = async (ignoreAbort = false) => {
    const items = parse(
      await powershell(
        `
$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $env:GUZI_RELEASE_EXE } | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate)
ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
`,
        { GUZI_RELEASE_EXE: executable },
        ignoreAbort,
      ),
    );
    assert.ok(Array.isArray(items), "Expected an application process array");
    for (const item of items) {
      assert.ok(
        Number.isInteger(item.ProcessId) && item.ProcessId > 0,
        "Expected a numeric application process ID",
      );
    }
    return items;
  };
  const bridge = (method, value) =>
    bounded(
      page
        .locator(".desktop-workspace")
        .evaluate(
          (mounted, { method, value }) =>
            mounted.ownerDocument.defaultView.desktop[method](value),
          { method, value },
        ),
      30000,
      `desktop.${method}`,
    );
  const screenshot = async (name) => {
    const destination = path.join(artifacts, `${name}.png`);
    if (page && !page.isClosed()) {
      await bounded(
        page.screenshot({ path: destination, fullPage: true }),
        10000,
        "screenshot",
        true,
      );
    } else if (process.platform === "win32") {
      await powershell(
        `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$image = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($image)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $image.Save($env:GUZI_RELEASE_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $image.Dispose() }
`,
        { GUZI_RELEASE_SCREENSHOT: destination },
        true,
      );
    } else {
      return;
    }
    report.screenshots.push(path.basename(destination));
  };
  const state = async () => {
    const current = await bridge("getUpdateState");
    const previous = report.updateStates.at(-1)?.state;
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      report.updateStates.push({
        at: new Date().toISOString(),
        state: current,
      });
    }
    return current;
  };
  const waitState = (status, timeout) =>
    waitFor(
      async () => {
        const current = await state();
        assert.ok(
          !["error", "unavailable"].includes(current.status),
          JSON.stringify(current),
        );
        return current.status === status && current;
      },
      `update ${status}`,
      timeout,
    );
  const openSettings = async () => {
    await page.getByRole("button", { name: "返回项目页", exact: true }).click();
    await page.locator(".desktop-project-pane.is-active").waitFor();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("dialog", { name: "桌面设置", exact: true }).waitFor();
    await page.locator(".desktop-update-panel").waitFor();
  };
  const clickUpdate = (name) =>
    page
      .locator(".desktop-update-panel")
      .getByRole("button", { name, exact: true })
      .click();
  const closeNormally = async (pid) => {
    await powershell(
      `
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $env:GUZI_RELEASE_PID"
if (-not $target -or $target.ExecutablePath -ine $env:GUZI_RELEASE_EXE) { throw 'Close PID/path mismatch' }
$process = Get-Process -Id $target.ProcessId
if (-not $process.CloseMainWindow()) { throw 'App has no closable main window' }
`,
      { GUZI_RELEASE_PID: String(pid), GUZI_RELEASE_EXE: executable },
    );
    await waitFor(
      async () =>
        !(await appProcesses()).some((item) => item.ProcessId === pid),
      "normal application exit",
    );
    application = undefined;
    page = undefined;
  };

  try {
    assert.equal(
      process.platform,
      "win32",
      "Production NSIS validation requires Windows",
    );
    assert.equal(process.arch, "x64");
    assert.equal(process.env.CI, "true");
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
    assert.equal(process.env.GH_REPO, repository);
    const asar = require("@electron/asar");
    const { _electron: playwrightElectron } = require("playwright");
    report.runner = {
      name: process.env.RUNNER_NAME,
      image: process.env.ImageOS,
      runId: process.env.GITHUB_RUN_ID,
    };
    const latest = parse(
      await run("gh", ["api", `repos/${repository}/releases/latest`]),
    );
    assert.equal(
      latest.tag_name,
      `v${to}`,
      "Latest public Release must be the requested target",
    );
    assert.equal(latest.draft, false);
    assert.equal(latest.prerelease, false);
    report.latest = {
      id: latest.id,
      tag: latest.tag_name,
      url: latest.html_url,
    };

    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "guzi-production-update-")),
    );
    installDirectory = path.join(temporary, "installed");
    executable = path.join(installDirectory, "Excalidraw-Guzi.exe");
    profile = path.join(process.env.APPDATA, "Excalidraw Local");
    report.profile = profile;
    report.installDirectory = installDirectory;
    const download = async (version, name) => {
      const directory = path.join(temporary, `release-${version}`);
      await fs.mkdir(directory);
      const release = parse(
        await run("gh", [
          "api",
          `repos/${repository}/releases/tags/v${version}`,
        ]),
      );
      assert.equal(release.tag_name, `v${version}`);
      assert.equal(release.draft, false);
      assert.equal(release.prerelease, false);
      for (const asset of [name, "SHA256SUMS"]) {
        assert.equal(
          release.assets.filter((item) => item.name === asset).length,
          1,
          `Missing/ambiguous ${asset}`,
        );
      }
      await run("gh", [
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
      ]);
      const sums = (
        await fs.readFile(path.join(directory, "SHA256SUMS"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      const matches = sums
        .map((line) => line.match(/^([a-f0-9]{64}) {2}(.+)$/))
        .filter((item) => item?.[2] === name);
      assert.equal(matches.length, 1, `Missing/ambiguous checksum for ${name}`);
      const filename = path.join(directory, name);
      const sha256 = await hash(filename);
      assert.equal(
        sha256,
        matches[0][1],
        `Official checksum mismatch: ${name}`,
      );
      report.assets ||= [];
      report.assets.push({
        version,
        name,
        sha256,
        release: release.html_url,
        url: release.assets.find((item) => item.name === name)
          .browser_download_url,
      });
      return filename;
    };
    const installer = await download(
      from,
      `Excalidraw-Guzi-${from}-win-x64.exe`,
    );
    const zip = await download(
      to,
      `Excalidraw-Guzi-${to}-win-x64-unpacked.zip`,
    );
    const targetDirectory = path.join(temporary, "target");
    await powershell(
      "Expand-Archive -LiteralPath $env:GUZI_RELEASE_ZIP -DestinationPath $env:GUZI_RELEASE_TARGET",
      { GUZI_RELEASE_ZIP: zip, GUZI_RELEASE_TARGET: targetDirectory },
    );
    const targetArchive = path.join(targetDirectory, "resources/app.asar");
    const targetPackage = JSON.parse(
      asar.extractFile(targetArchive, "package.json").toString(),
    );
    assert.equal(targetPackage.version, to);
    assert.ok(!targetPackage.buildChannel);
    const targetUpdateConfig = await fs.readFile(
      path.join(targetDirectory, "resources/app-update.yml"),
      "utf8",
    );
    assert.match(targetUpdateConfig, /^provider: github\r?$/m);
    assert.match(targetUpdateConfig, /^owner: Drangon-Li\r?$/m);
    assert.match(targetUpdateConfig, /^repo: guzi-graph\r?$/m);
    const cacheName = targetUpdateConfig.match(
      /^updaterCacheDirName: ([a-zA-Z0-9._-]+)\r?$/m,
    )?.[1];
    assert.ok(
      cacheName && cacheName !== "." && cacheName !== "..",
      "Expected production updater cache name",
    );
    cache = path.join(process.env.LOCALAPPDATA, cacheName);
    for (const directory of [profile, cache]) {
      await assert.rejects(
        fs.lstat(directory),
        { code: "ENOENT" },
        `Refusing existing production data: ${directory}`,
      );
    }
    assert.deepEqual(
      await registrations(),
      [],
      "Refusing an existing production NSIS registration",
    );
    const existingProcesses = parse(
      await powershell(`
$items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFileName($_.ExecutablePath) -ieq 'Excalidraw-Guzi.exe') } | Select-Object ProcessId, ExecutablePath)
ConvertTo-Json -InputObject $items -Compress
`),
    );
    assert.deepEqual(
      existingProcesses,
      [],
      "Refusing an existing production app process",
    );
    report.cleanRunner = true;
    ownsCache = true;
    ownsProfile = true;
    await fs.mkdir(profile);
    const drawings = path.join(temporary, "drawings");
    await fs.mkdir(drawings);
    const canvasPath = path.join(
      drawings,
      "Production release update.excalidraw",
    );
    const elementId = `production-update-${randomUUID()}`;
    const canvas = {
      type: "excalidraw",
      version: 2,
      source: "production-release-validation",
      elements: [
        {
          id: elementId,
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
    };
    await fs.writeFile(canvasPath, JSON.stringify(canvas));
    const canvasHash = await hash(canvasPath);
    const sentinel = randomUUID();
    await fs.writeFile(
      path.join(profile, "release-update-sentinel.txt"),
      sentinel,
    );
    await fs.writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({
        rootDirectory: drawings,
        language: "zh-CN",
        theme: "light",
      }),
    );
    await fs.writeFile(
      path.join(profile, "session.json"),
      JSON.stringify({ paths: [canvasPath], activePath: canvasPath }),
    );
    process.stdout.write(`Installing official v${from} Release\n`);
    // NSIS requires /D to be the final, unquoted remainder of its command line.
    await run(installer, ["/S", "/currentuser", `/D=${installDirectory}`], {
      windowsVerbatimArguments: true,
    });
    const installedArchive = path.join(installDirectory, "resources/app.asar");
    const oldPackage = JSON.parse(
      asar.extractFile(installedArchive, "package.json").toString(),
    );
    assert.equal(oldPackage.version, from);
    assert.ok(!oldPackage.buildChannel);
    assert.equal(
      await fs.readFile(
        path.join(installDirectory, "resources/app-update.yml"),
        "utf8",
      ),
      targetUpdateConfig,
      "Production provider/cache configuration must remain unchanged",
    );
    report.beforeArchiveSha256 = await hash(installedArchive);
    report.expectedArchiveSha256 = await hash(targetArchive);
    const expectedExeHash = await hash(
      path.join(targetDirectory, "Excalidraw-Guzi.exe"),
    );
    const launch = async (version) => {
      const environment = { ...process.env, EXCALIDRAW_DESKTOP_DEV_URL: "" };
      delete environment.EXCALIDRAW_DESKTOP_USER_DATA;
      delete environment.ELECTRON_RUN_AS_NODE;
      application = await bounded(
        playwrightElectron.launch({
          executablePath: executable,
          args: [],
          env: environment,
          timeout: 60000,
        }),
        70000,
        "production app launch",
      );
      // On Windows Playwright may expose a launcher instead of Electron's main PID.
      const launcherPid = application.process().pid;
      const facts = await application.evaluate(({ app }) => ({
        pid: process.pid,
        version: app.getVersion(),
        profile: app.getPath("userData"),
        packaged: app.isPackaged,
        executable: app.getPath("exe"),
      }));
      assert.equal(facts.version, version);
      assert.equal(facts.profile.toLowerCase(), profile.toLowerCase());
      assert.equal(facts.executable.toLowerCase(), executable.toLowerCase());
      assert.equal(facts.packaged, true);
      const pid = facts.pid;
      assert.ok(Number.isInteger(pid) && pid > 0);
      const mainProcess = (await appProcesses()).find(
        (item) => item.ProcessId === pid,
      );
      assert.ok(
        mainProcess,
        "Electron main PID must match the installed EXE path",
      );
      assert.ok(
        mainProcess.CommandLine &&
          !/(?:^|\s)--type=/.test(mainProcess.CommandLine),
        "Electron main PID must identify the browser process",
      );
      report.launches ||= [];
      const entry = {
        launcherPid,
        ...facts,
        mainProcess,
        at: new Date().toISOString(),
        stdout: "",
        stderr: "",
      };
      report.launches.push(entry);
      for (const stream of ["stdout", "stderr"]) {
        application.process()[stream]?.on("data", (chunk) => {
          entry[stream] = (entry[stream] + chunk).slice(-64 * 1024);
        });
      }
      page = await application.firstWindow();
      page.setDefaultTimeout(30000);
      await page.locator(".desktop-workspace").waitFor();
      await page
        .getByRole("tab", { name: "Production release update", exact: true })
        .waitFor();
      assert.equal((await state()).currentVersion, version);
      return pid;
    };
    let expectedSession = null;
    const verifyPreserved = async () => {
      const settings = await bridge("getSettings");
      assert.equal(settings.rootDirectory, drawings);
      assert.equal(settings.language, "zh-CN");
      assert.equal(settings.theme, "light");
      const session = await bridge("getSession");
      assert.ok(session.paths.includes(canvasPath));
      if (expectedSession) {
        assert.deepEqual(session, expectedSession);
      }
      const saved = await bridge("readFile", canvasPath);
      assert.ok(
        JSON.parse(saved.content).elements.some(
          (element) => element.id === elementId,
        ),
      );
      assert.equal(await hash(canvasPath), canvasHash);
      assert.equal(
        await fs.readFile(
          path.join(profile, "release-update-sentinel.txt"),
          "utf8",
        ),
        sentinel,
      );
      report.preserved = {
        settings,
        session,
        canvasPath,
        canvasSha256: canvasHash,
        elementId,
      };
    };
    const oldPid = await launch(from);
    await verifyPreserved();
    await openSettings();
    await screenshot("before-check");
    await clickUpdate("检查更新");
    const available = await waitState("available", 180000);
    assert.equal(available.availableVersion, to);
    await screenshot("update-available");
    await clickUpdate("下载更新");
    await waitState("downloaded", 10 * 60 * 1000);
    await screenshot("update-downloaded");
    const beforeInstall = await appProcesses();
    const oldPids = new Set(beforeInstall.map((item) => item.ProcessId));
    assert.ok(oldPids.has(oldPid));
    expectedSession = await bridge("getSession");
    assert.ok(expectedSession.paths.includes(canvasPath));
    report.beforeInstallSession = expectedSession;
    const installStarted = Date.now();
    const closed = page.waitForEvent("close", { timeout: 180000 });
    closed.catch(() => {});
    await clickUpdate("安装并重启");
    await bounded(closed, 180000, "old app closes for NSIS update");
    application = undefined;
    page = undefined;
    // Do not launch anything until an external observer proves NSIS restarted the replacement.
    const restarted = await waitFor(
      async () => {
        const processes = await appProcesses();
        if (processes.some((item) => item.ProcessId === oldPid)) {
          return false;
        }
        for (const item of processes) {
          if (
            oldPids.has(item.ProcessId) ||
            /(?:^|\s)--type=/.test(item.CommandLine || "")
          ) {
            continue;
          }
          const details = parse(
            await powershell(
              `
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $env:GUZI_RELEASE_PID"
if (-not $target -or $target.ExecutablePath -ine $env:GUZI_RELEASE_EXE) { throw 'Restart PID/path changed' }
$process = Get-Process -Id $target.ProcessId
@{ pid = $target.ProcessId; executable = $target.ExecutablePath; createdAt = $target.CreationDate.ToUniversalTime().ToString('o'); productVersion = $process.MainModule.FileVersionInfo.ProductVersion; fileVersion = $process.MainModule.FileVersionInfo.FileVersion; mainWindowHandle = $process.MainWindowHandle.ToInt64(); commandLine = $target.CommandLine } | ConvertTo-Json -Compress
`,
              {
                GUZI_RELEASE_PID: String(item.ProcessId),
                GUZI_RELEASE_EXE: executable,
              },
            ),
          );
          if (
            !details.mainWindowHandle ||
            Date.parse(details.createdAt) < installStarted
          ) {
            continue;
          }
          assert.equal(semver.coerce(details.productVersion)?.version, to);
          assert.equal(semver.coerce(details.fileVersion)?.version, to);
          assert.equal(
            await hash(installedArchive),
            report.expectedArchiveSha256,
          );
          assert.equal(await hash(executable), expectedExeHash);
          return details;
        }
        return false;
      },
      "official target automatically restarted by NSIS",
      240000,
    );
    report.automaticRestart = {
      ...restarted,
      observedAt: new Date().toISOString(),
      oldPid,
      archiveSha256: await hash(installedArchive),
      executableSha256: await hash(executable),
      expectedExecutableSha256: expectedExeHash,
    };
    await screenshot("automatic-restart");
    await closeNormally(restarted.pid);
    const targetPid = await launch(to);
    await verifyPreserved();
    await openSettings();
    await clickUpdate("检查更新");
    await waitState("up-to-date", 180000);
    await screenshot("after-update");
    assert.equal(await hash(installedArchive), report.expectedArchiveSha256);
    const settings = page.getByRole("dialog", {
      name: "桌面设置",
      exact: true,
    });
    await settings.getByRole("button", { name: "完成", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await closeNormally(targetPid);
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    console.error(report.error);
    await screenshot("failure").catch((cause) => {
      report.screenshotError = String(cause);
    });
  } finally {
    const cleanup = async (stage, action) => {
      try {
        await action();
      } catch (error) {
        report.passed = false;
        report.cleanupErrors.push({
          stage,
          error: error.stack || String(error),
        });
      }
    };
    const roots = [temporary, ownsCache && cache].filter(Boolean);
    if (temporary) {
      await cleanup("owned-processes", async () => {
        report.cleanup = parse(
          await powershell(
            `
$roots = ConvertFrom-Json -InputObject $env:GUZI_RELEASE_ROOTS
function Get-OwnedProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $candidate = $_.ExecutablePath
    $owned = $false
    foreach ($root in $roots) {
      if ($candidate -and $candidate.StartsWith($root.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)) { $owned = $true }
    }
    $owned
  })
}
$owned = @(Get-OwnedProcesses)
foreach ($item in $owned) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)"
  if ($current -and $current.ExecutablePath -ieq $item.ExecutablePath -and $current.CreationDate -eq $item.CreationDate) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $remaining = @(Get-OwnedProcesses)
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
@{ stopped = @($owned | Select-Object ProcessId, ExecutablePath); remaining = @($remaining | Select-Object ProcessId, ExecutablePath) } | ConvertTo-Json -Depth 4 -Compress
if ($remaining.Count) { throw 'Owned processes remain' }
`,
            { GUZI_RELEASE_ROOTS: JSON.stringify(roots) },
            true,
          ),
        );
      });
      await cleanup("uninstall", async () => {
        const names = await fs.readdir(installDirectory).catch((error) => {
          if (error.code === "ENOENT") {
            return [];
          }
          throw error;
        });
        const uninstallers = names.filter((name) =>
          /^Uninstall .*\.exe$/i.test(name),
        );
        assert.ok(uninstallers.length <= 1, "Ambiguous owned uninstaller");
        if (uninstallers.length) {
          await run(
            path.join(installDirectory, uninstallers[0]),
            ["/S", "/currentuser", `_?=${installDirectory}`],
            { windowsVerbatimArguments: true },
            60000,
            true,
          );
        }
      });
      await cleanup("verify-uninstalled", async () => {
        if (report.cleanRunner) {
          assert.deepEqual(
            await registrations(true),
            [],
            "Production NSIS registration remains",
          );
          assert.deepEqual(
            await appProcesses(true),
            [],
            "Installed app processes remain",
          );
          await assert.rejects(
            fs.stat(executable),
            { code: "ENOENT" },
            "Installed app remains after uninstall",
          );
        }
      });
    }
    for (const child of children) {
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    if (!report.cleanupErrors.length) {
      for (const directory of [
        temporary,
        ownsProfile && profile,
        ownsCache && cache,
      ].filter(Boolean)) {
        await cleanup(`remove ${directory}`, () =>
          fs.rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 300,
          }),
        );
      }
    }
    report.completedAt = new Date().toISOString();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    await fs.writeFile(
      path.join(artifacts, "report.json"),
      JSON.stringify(report, null, 2),
    );
    if (!report.passed) {
      process.exitCode = 1;
    }
    process.stdout.write(
      `Production Windows update ${
        report.passed ? "passed" : "failed"
      }: ${path.join(artifacts, "report.json")}\n`,
    );
  }
}

async function main() {
  const configuration = options(process.argv.slice(2));
  if (configuration.help) {
    process.stdout.write(
      "node release-update-windows.cjs --from 0.8.0 --to 0.8.1 --artifacts output/release-update-validation/windows\n",
    );
  } else {
    await execute(configuration);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
