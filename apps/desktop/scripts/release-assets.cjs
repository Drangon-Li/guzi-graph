const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");

const desktop = path.resolve(__dirname, "..");
const metadata = require("../package.json");
const repository = "Drangon-Li/guzi-graph";
const stableVersion = /^\d+\.\d+\.\d+$/;
const hash = (file, algorithm, encoding = "hex") =>
  crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

function assetNames(version) {
  assert.equal(version, version.trim());
  assert.match(version, stableVersion, "A stable release version is required");
  return {
    mac: `Excalidraw-Guzi-${version}-arm64.zip`,
    dmg: `Excalidraw-Guzi-${version}-arm64.dmg`,
    windows: `Excalidraw-Guzi-${version}-win-x64.exe`,
    unpacked: `Excalidraw-Guzi-${version}-win-x64-unpacked.zip`,
  };
}

function publicKey() {
  const raw = Buffer.from(
    metadata.build.mac.extendInfo.SUPublicEDKey,
    "base64",
  );
  assert.equal(raw.length, 32, "Invalid Sparkle public key");
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    type: "spki",
    format: "der",
  });
}

function verifyWindows(directory, version) {
  const expected = assetNames(version).windows;
  const info = yaml.load(
    fs.readFileSync(path.join(directory, "latest.yml"), "utf8"),
  );
  assert.equal(info.version, version, "Windows metadata version mismatch");
  assert.equal(info.path, expected, "Windows metadata installer mismatch");
  assert.equal(info.files.length, 1, "Exactly one x64 installer is expected");
  const file = info.files[0];
  assert.equal(file.url, expected);
  const installer = path.join(directory, expected);
  assert.equal(file.sha512, hash(installer, "sha512", "base64"));
  assert.equal(info.sha512, file.sha512);
  assert.equal(file.size, fs.statSync(installer).size);
  assert.ok(fs.statSync(`${installer}.blockmap`).size > 0);
  return info;
}

function signMac(directory, version) {
  const seed = process.env.SPARKLE_ED25519_PRIVATE_KEY?.trim();
  assert.ok(
    seed,
    "SPARKLE_ED25519_PRIVATE_KEY is required for release signing",
  );
  const raw = Buffer.from(seed, "base64");
  assert.equal(raw.length, 32, "Sparkle signing key must be a 32-byte seed");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      raw,
    ]),
    format: "der",
    type: "pkcs8",
  });
  assert.deepEqual(
    crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }),
    publicKey().export({ format: "der", type: "spki" }),
    "Signing Secret does not match the public key embedded in the app",
  );
  const name = assetNames(version).mac;
  const file = path.join(directory, name);
  const environment = { ...process.env };
  delete environment.SPARKLE_ED25519_PRIVATE_KEY;
  const signature = execFileSync(
    path.join(desktop, "vendor/updater/bin/sign_update"),
    ["--ed-key-file", "-", "-p", file],
    {
      input: seed,
      encoding: "utf8",
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
  assert.ok(
    crypto.verify(
      null,
      fs.readFileSync(file),
      publicKey(),
      Buffer.from(signature, "base64"),
    ),
  );
  const url = `https://github.com/${repository}/releases/download/v${version}/${name}`;
  const appcast = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Excalidraw-Guzi</title>
    <item>
      <title>Excalidraw-Guzi ${version}</title>
      <sparkle:version>${version}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>
      <enclosure url="${url}" length="${
    fs.statSync(file).size
  }" type="application/octet-stream" sparkle:edSignature="${signature}" />
    </item>
  </channel>
</rss>
`;
  fs.writeFileSync(path.join(directory, "mac-arm64-appcast.xml"), appcast);
}

function verifyRelease(directory, version, { checksums = true } = {}) {
  const names = assetNames(version);
  const files = [
    names.dmg,
    names.mac,
    names.windows,
    `${names.windows}.blockmap`,
    names.unpacked,
    "latest.yml",
    "mac-arm64-appcast.xml",
  ];
  for (const file of files)
    assert.ok(
      fs.statSync(path.join(directory, file)).size > 0,
      `Missing release asset: ${file}`,
    );
  verifyWindows(directory, version);
  const appcast = fs.readFileSync(
    path.join(directory, "mac-arm64-appcast.xml"),
    "utf8",
  );
  assert.ok(appcast.includes(`<sparkle:version>${version}</sparkle:version>`));
  const expectedURL = `https://github.com/${repository}/releases/download/v${version}/${names.mac}`;
  assert.ok(appcast.includes(`url="${expectedURL}"`));
  const zip = path.join(directory, names.mac);
  assert.ok(appcast.includes(`length="${fs.statSync(zip).size}"`));
  const signature = appcast.match(
    /sparkle:edSignature="([A-Za-z0-9+/=]+)"/,
  )?.[1];
  assert.ok(
    signature &&
      crypto.verify(
        null,
        fs.readFileSync(zip),
        publicKey(),
        Buffer.from(signature, "base64"),
      ),
    "Invalid Mac update signature",
  );
  const sums =
    files
      .sort()
      .map((name) => `${hash(path.join(directory, name), "sha256")}  ${name}`)
      .join("\n") + "\n";
  if (checksums)
    assert.equal(
      fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"),
      sums,
      "Release checksum mismatch",
    );
  else fs.writeFileSync(path.join(directory, "SHA256SUMS"), sums);
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [...files, "SHA256SUMS"].sort(),
    "Unexpected release assets",
  );
  return [...files, "SHA256SUMS"];
}

function archiveMac(directory) {
  assert.equal(process.platform, "darwin");
  const app = path.join(directory, "mac-arm64/Excalidraw-Guzi.app");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const plist = path.join(app, "Contents/Info.plist");
  for (const [key, expected] of [
    ["CFBundleShortVersionString", metadata.version],
    ["SUPublicEDKey", metadata.build.mac.extendInfo.SUPublicEDKey],
  ]) {
    const value = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plist],
      { encoding: "utf8" },
    ).trim();
    assert.equal(value, expected, `Packaged ${key} mismatch`);
  }
  assert.ok(
    fs.existsSync(
      path.join(
        app,
        "Contents/Resources/updater/Guzi Updater.app/Contents/MacOS/guzi-updater",
      ),
    ),
  );
  const zip = path.join(directory, assetNames(metadata.version).mac);
  assert.ok(
    !fs.existsSync(zip),
    "Refusing to replace an existing update archive",
  );
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    zip,
  ]);
  console.log(`Created ${path.basename(zip)}`);
}

function archiveWindows(directory) {
  verifyWindows(directory, metadata.version);
  const config = yaml.load(
    fs.readFileSync(
      path.join(directory, "win-unpacked/resources/app-update.yml"),
      "utf8",
    ),
  );
  assert.equal(config.provider, "github");
  assert.equal(`${config.owner}/${config.repo}`, repository);
  const zip = path.join(directory, assetNames(metadata.version).unpacked);
  assert.ok(
    !fs.existsSync(zip),
    "Refusing to replace an existing unpacked archive",
  );
  execFileSync(require("7zip-bin").path7za, ["a", "-tzip", zip, "."], {
    cwd: path.join(directory, "win-unpacked"),
    stdio: "ignore",
  });
  console.log(`Created ${path.basename(zip)}`);
}

if (require.main === module) {
  const [command, input] = process.argv.slice(2);
  const directory = path.resolve(input || path.join(desktop, "release"));
  try {
    if (command === "mac-archive") archiveMac(directory);
    else if (command === "windows-archive") archiveWindows(directory);
    else if (command === "sign") {
      const tag = process.env.GITHUB_REF_NAME;
      assert.equal(
        tag,
        `v${metadata.version}`,
        "Release tag must match package version",
      );
      verifyWindows(directory, metadata.version);
      signMac(directory, metadata.version);
      verifyRelease(directory, metadata.version, { checksums: false });
      console.log(`Signed and validated ${tag}`);
    } else if (command === "verify") {
      verifyRelease(directory, metadata.version);
      console.log(`Validated release ${metadata.version}`);
    } else
      throw new Error(
        "Usage: release-assets.cjs mac-archive|windows-archive|sign|verify [directory]",
      );
  } catch (error) {
    // Never echo a child's command/environment or the signing seed.
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { assetNames, verifyWindows, verifyRelease, hash };
