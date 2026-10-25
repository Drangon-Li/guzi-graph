const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");
const { assetNames, verifyWindows, hash } = require("./release-assets.cjs");

test("release names reject prereleases and path-like versions", () => {
  assert.equal(assetNames("0.8.0").mac, "Excalidraw-Guzi-0.8.0-arm64.zip");
  for (const version of ["../0.8.0", "0.8.0-beta", "v0.8.0", "0.8.0\n"]) {
    assert.throws(() => assetNames(version));
  }
});

test("Windows release verification rejects changed installer bytes and mismatched metadata", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "guzi-release-test-"),
  );
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const name = assetNames("0.8.0").windows;
  const file = path.join(directory, name);
  fs.writeFileSync(file, "fixture installer");
  fs.writeFileSync(`${file}.blockmap`, "fixture blockmap");
  const info = {
    version: "0.8.0",
    path: name,
    sha512: hash(file, "sha512", "base64"),
    files: [
      {
        url: name,
        sha512: hash(file, "sha512", "base64"),
        size: fs.statSync(file).size,
      },
    ],
  };
  const save = () =>
    fs.writeFileSync(path.join(directory, "latest.yml"), yaml.dump(info));
  save();
  assert.equal(verifyWindows(directory, "0.8.0").version, "0.8.0");
  fs.appendFileSync(file, "tampered");
  assert.throws(() => verifyWindows(directory, "0.8.0"));
  fs.writeFileSync(file, "fixture installer");
  info.version = "0.7.4";
  save();
  assert.throws(() => verifyWindows(directory, "0.8.0"), /version mismatch/);
  info.version = "0.8.0";
  info.path = "https://another-host.invalid/installer.exe";
  save();
  assert.throws(() => verifyWindows(directory, "0.8.0"), /installer mismatch/);
});
