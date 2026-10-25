const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const SPARKLE_VERSION = "2.10.1";
const SPARKLE_SHA256 =
  "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27";
const SPARKLE_SOURCE_COMMIT = "ab7d71291238df6e0492143b120c9b696a35f603";
const SPARKLE_URL = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`;
const DESKTOP_ROOT = path.resolve(__dirname, "..");

function verifyArchive(archivePath) {
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(archivePath))
    .digest("hex");
  if (digest !== SPARKLE_SHA256) {
    throw new Error(
      `Sparkle archive SHA256 mismatch: expected ${SPARKLE_SHA256}, received ${digest}`,
    );
  }
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function prepareUpdater(options = {}) {
  if (process.platform !== "darwin")
    throw new Error("The Sparkle updater must be built on macOS.");
  const outputDir = path.resolve(
    options.outputDir || path.join(DESKTOP_ROOT, "vendor/updater"),
  );
  const cacheDir = path.resolve(
    options.cacheDir ||
      path.join(os.homedir(), "Library/Caches/Guzi/Sparkle", SPARKLE_VERSION),
  );
  const archivePath = path.resolve(
    options.archivePath ||
      path.join(cacheDir, `Sparkle-${SPARKLE_VERSION}.tar.xz`),
  );
  const architectures = options.architectures || ["arm64", "x86_64"];
  if (
    !architectures.length ||
    architectures.some((value) => !["arm64", "x86_64"].includes(value))
  ) {
    throw new Error("Supported updater architectures: arm64, x86_64.");
  }
  if (!fs.existsSync(archivePath)) {
    if (options.archivePath)
      throw new Error(`Sparkle archive does not exist: ${archivePath}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    const temporaryArchive = `${archivePath}.${process.pid}.download`;
    try {
      const response = await fetch(SPARKLE_URL);
      if (!response.ok || !response.body)
        throw new Error(`Sparkle download failed: HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(temporaryArchive, { flags: "wx" }),
      );
      verifyArchive(temporaryArchive);
      fs.renameSync(temporaryArchive, archivePath);
    } finally {
      fs.rmSync(temporaryArchive, { force: true });
    }
  }
  verifyArchive(archivePath);
  fs.mkdirSync(outputDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outputDir, ".build-"));
  try {
    const releaseDir = path.join(staging, "sparkle");
    fs.mkdirSync(releaseDir);
    run("/usr/bin/tar", ["-xJf", archivePath, "-C", releaseDir]);
    const appPath = path.join(staging, "Guzi Updater.app");
    const contents = path.join(appPath, "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "Frameworks"));
    fs.mkdirSync(path.join(contents, "Resources"));
    const sourceDir = path.join(DESKTOP_ROOT, "native/updater");
    fs.copyFileSync(
      path.join(sourceDir, "Info.plist"),
      path.join(contents, "Info.plist"),
    );
    fs.copyFileSync(
      path.join(sourceDir, "LICENSE.Sparkle"),
      path.join(contents, "Resources/LICENSE.Sparkle"),
    );
    // Preserve the upstream framework's signatures and nested XPC services.
    run("/usr/bin/ditto", [
      path.join(releaseDir, "Sparkle.framework"),
      path.join(contents, "Frameworks/Sparkle.framework"),
    ]);
    run("/usr/bin/xcrun", [
      "clang",
      "-fobjc-arc",
      "-fblocks",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-mmacosx-version-min=12.0",
      ...architectures.flatMap((arch) => ["-arch", arch]),
      "-F",
      releaseDir,
      path.join(sourceDir, "main.m"),
      "-framework",
      "Cocoa",
      "-framework",
      "Sparkle",
      "-Wl,-rpath,@loader_path/../Frameworks",
      "-o",
      path.join(contents, "MacOS/guzi-updater"),
    ]);
    run("/usr/bin/codesign", ["--force", "--sign", "-", appPath]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    const installedApp = path.join(outputDir, "Guzi Updater.app");
    fs.rmSync(installedApp, { recursive: true, force: true });
    fs.renameSync(appPath, installedApp);
    const toolsDir = path.join(outputDir, "bin");
    fs.mkdirSync(toolsDir, { recursive: true });
    for (const name of ["sign_update", "generate_appcast"]) {
      fs.copyFileSync(
        path.join(releaseDir, "bin", name),
        path.join(toolsDir, name),
      );
      fs.chmodSync(path.join(toolsDir, name), 0o755);
    }
    fs.copyFileSync(
      path.join(releaseDir, "LICENSE"),
      path.join(outputDir, "LICENSE.Sparkle"),
    );
    const provenance = {
      sparkleVersion: SPARKLE_VERSION,
      archiveURL: SPARKLE_URL,
      archiveSHA256: SPARKLE_SHA256,
      sourceCommit: SPARKLE_SOURCE_COMMIT,
      architectures,
    };
    fs.writeFileSync(
      path.join(outputDir, "provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    return {
      appPath: installedApp,
      executable: path.join(installedApp, "Contents/MacOS/guzi-updater"),
      signUpdate: path.join(toolsDir, "sign_update"),
      generateAppcast: path.join(toolsDir, "generate_appcast"),
      ...provenance,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const options = {};
  const names = {
    "--archive": "archivePath",
    "--output": "outputDir",
    "--cache": "cacheDir",
  };
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1])
        throw new Error(
          "Usage: prepare-updater.cjs [--archive archive.tar.xz] [--output directory] [--cache directory]",
        );
      options[key] = process.argv[index + 1];
    }
    prepareUpdater(options)
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error.stderr?.toString() || error.message);
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  prepareUpdater,
  verifyArchive,
  SPARKLE_VERSION,
  SPARKLE_SHA256,
  SPARKLE_SOURCE_COMMIT,
  SPARKLE_URL,
};
