const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const metadata = require("../package.json");
const {
  assetNames,
  releaseFiles,
  validateVersions,
  verifyChecksums,
  verifyWindows,
} = require("./release-assets.cjs");

const repository = "Drangon-Li/guzi-graph";

function reuseWindowsRelease(
  directory,
  {
    version = metadata.version,
    windowsVersion = metadata.windowsReleaseVersion,
    run = execFileSync,
  } = {},
) {
  validateVersions(version, windowsVersion);
  const tag = `v${windowsVersion}`;
  const names = assetNames(windowsVersion);
  const files = [
    names.windows,
    `${names.windows}.blockmap`,
    names.unpacked,
    "latest.yml",
  ];
  const expectedAssets = [...releaseFiles(windowsVersion), "SHA256SUMS"].sort();
  const gh = (args) =>
    run("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const release = JSON.parse(
    gh([
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,isDraft,isPrerelease,assets",
    ]),
  );
  assert.equal(release.tagName, tag, "Windows source release tag mismatch");
  assert.equal(
    release.isDraft,
    false,
    "Windows source release must be published",
  );
  assert.equal(
    release.isPrerelease,
    false,
    "Windows source release must be stable",
  );
  assert.deepEqual(
    release.assets.map(({ name }) => name).sort(),
    expectedAssets,
    "Missing or unexpected Windows source release assets",
  );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "guzi-windows-reuse-"),
  );
  try {
    gh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--dir",
      temporary,
      ...[...files, "SHA256SUMS"].flatMap((name) => ["--pattern", name]),
    ]);
    assert.deepEqual(
      fs.readdirSync(temporary).sort(),
      [...files, "SHA256SUMS"].sort(),
      "Missing or unexpected downloaded Windows assets",
    );
    verifyChecksums(temporary, files, releaseFiles(windowsVersion));
    verifyWindows(temporary, windowsVersion);
    for (const name of files) {
      assert.ok(
        fs.statSync(path.join(temporary, name)).size > 0,
        `Empty Windows asset: ${name}`,
      );
      assert.ok(
        !fs.existsSync(path.join(directory, name)),
        `Refusing to replace existing asset: ${name}`,
      );
    }
    fs.mkdirSync(directory, { recursive: true });
    for (const name of files) {
      fs.copyFileSync(
        path.join(temporary, name),
        path.join(directory, name),
        fs.constants.COPYFILE_EXCL,
      );
    }
    return files;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "Usage: reuse-windows-release.cjs <directory>",
    );
    const files = reuseWindowsRelease(path.resolve(process.argv[2]));
    console.log(
      `Reused Windows ${metadata.windowsReleaseVersion}: ${files.join(", ")}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { reuseWindowsRelease };
