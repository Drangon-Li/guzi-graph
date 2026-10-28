const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");
const metadata = require("../package.json");
const {
  assetNames,
  releaseFiles,
  verifyWindows,
  verifyRelease,
  hash,
} = require("./release-assets.cjs");

test("release names reject prereleases and path-like versions", () => {
  assert.equal(assetNames("0.8.0").mac, "Excalidraw-Guzi-0.8.0-arm64.zip");
  for (const version of [
    "../0.8.0",
    "0.8.0-beta",
    "v0.8.0",
    "0.8.0\n",
    "00.8.0",
    "0.8.0+build",
  ]) {
    assert.throws(() => assetNames(version));
  }
});

function releaseFixture(context, version = "0.8.4", windowsVersion = "0.8.3") {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "guzi-mixed-release-"),
  );
  const previousKey = metadata.build.mac.extendInfo.SUPublicEDKey;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  metadata.build.mac.extendInfo.SUPublicEDKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  context.after(() => {
    metadata.build.mac.extendInfo.SUPublicEDKey = previousKey;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const names = assetNames(version, windowsVersion);
  for (const file of releaseFiles(version, windowsVersion))
    fs.writeFileSync(path.join(directory, file), `fixture ${file}`);
  const installer = path.join(directory, names.windows);
  const sha512 = hash(installer, "sha512", "base64");
  fs.writeFileSync(
    path.join(directory, "latest.yml"),
    yaml.dump({
      version: windowsVersion,
      path: names.windows,
      sha512,
      files: [
        { url: names.windows, sha512, size: fs.statSync(installer).size },
      ],
    }),
  );
  const mac = path.join(directory, names.mac);
  const signature = crypto
    .sign(null, fs.readFileSync(mac), privateKey)
    .toString("base64");
  fs.writeFileSync(
    path.join(directory, "mac-arm64-appcast.xml"),
    `<sparkle:version>${version}</sparkle:version><enclosure url="https://github.com/Drangon-Li/guzi-graph/releases/download/v${version}/${
      names.mac
    }" length="${fs.statSync(mac).size}" sparkle:edSignature="${signature}" />`,
  );
  verifyRelease(directory, version, { windowsVersion, checksums: false });
  return {
    directory,
    names,
    verify: () => verifyRelease(directory, version, { windowsVersion }),
  };
}

for (const windowsVersion of ["0.8.4", "0.8.3"]) {
  test(`complete release supports macOS 0.8.4 / Windows ${windowsVersion}`, (context) => {
    const fixture = releaseFixture(context, "0.8.4", windowsVersion);
    assert.equal(fixture.verify().length, 8);
    assert.match(
      fs.readFileSync(path.join(fixture.directory, "SHA256SUMS"), "utf8"),
      new RegExp(
        `Excalidraw-Guzi-${windowsVersion.replaceAll(
          ".",
          "\\.",
        )}-win-x64\\.exe`,
      ),
    );
  });
}

test("mixed releases require the correct independent Windows version", (context) => {
  const { directory } = releaseFixture(context);
  assert.throws(() => verifyRelease(directory, "0.8.4"));
  for (const windowsVersion of [
    "0.8.5",
    "0.8.3-beta",
    "0.8.3+build",
    "00.8.3",
  ]) {
    assert.throws(() => verifyRelease(directory, "0.8.4", { windowsVersion }));
  }
});

test("mixed release rejects mismatched Windows YAML", (context) => {
  const { directory, verify } = releaseFixture(context);
  const file = path.join(directory, "latest.yml");
  const info = yaml.load(fs.readFileSync(file, "utf8"));
  info.version = "0.8.4";
  fs.writeFileSync(file, yaml.dump(info));
  assert.throws(verify, /Windows metadata version mismatch/);
});

for (const name of releaseFiles("0.8.4", "0.8.3")) {
  test(`mixed release rejects tampered ${name}`, (context) => {
    const { directory, verify } = releaseFixture(context);
    fs.appendFileSync(path.join(directory, name), "tampered");
    assert.throws(verify);
  });
  test(`mixed release rejects missing ${name}`, (context) => {
    const { directory, verify } = releaseFixture(context);
    fs.unlinkSync(path.join(directory, name));
    assert.throws(verify);
  });
}

test("mixed release rejects extra assets and incomplete checksum manifests", (context) => {
  const { directory, verify } = releaseFixture(context);
  const extra = path.join(directory, "unexpected.exe");
  fs.writeFileSync(extra, "extra");
  assert.throws(verify, /Unexpected release assets/);
  fs.unlinkSync(extra);
  const sums = path.join(directory, "SHA256SUMS");
  const original = fs.readFileSync(sums, "utf8");
  fs.writeFileSync(sums, original.split("\n").slice(1).join("\n"));
  assert.throws(verify, /checksum entries/);
  fs.writeFileSync(sums, original + original.split("\n")[0] + "\n");
  assert.throws(verify, /checksum entries/);
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
