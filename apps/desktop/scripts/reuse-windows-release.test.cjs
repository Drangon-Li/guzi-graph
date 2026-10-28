const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");
const { assetNames, releaseFiles, hash } = require("./release-assets.cjs");
const { reuseWindowsRelease } = require("./reuse-windows-release.cjs");

function fixture(context) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "guzi-reuse-test-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  const destination = path.join(temporary, "destination");
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  const version = "0.8.3";
  const names = assetNames(version);
  const files = [
    names.windows,
    `${names.windows}.blockmap`,
    names.unpacked,
    "latest.yml",
  ];
  for (const name of releaseFiles(version))
    fs.writeFileSync(
      path.join(source, name),
      Buffer.from(`original\r\n${name}\u0000\u00ff`),
    );
  const installer = path.join(source, names.windows);
  const sha512 = hash(installer, "sha512", "base64");
  fs.writeFileSync(
    path.join(source, "latest.yml"),
    yaml
      .dump({
        version,
        path: names.windows,
        sha512,
        files: [
          { url: names.windows, sha512, size: fs.statSync(installer).size },
        ],
      })
      .replaceAll("\n", "\r\n"),
  );
  const checksum = () =>
    fs.writeFileSync(
      path.join(source, "SHA256SUMS"),
      releaseFiles(version)
        .sort()
        .map((name) => `${hash(path.join(source, name), "sha256")}  ${name}\n`)
        .join(""),
    );
  checksum();
  const release = {
    tagName: "v0.8.3",
    isDraft: false,
    isPrerelease: false,
    assets: [...releaseFiles(version), "SHA256SUMS"].map((name) => ({ name })),
  };
  const calls = [];
  let downloaded;
  const run = (command, args) => {
    calls.push([command, args]);
    assert.equal(command, "gh");
    assert.equal(args[2], "v0.8.3");
    assert.equal(args[args.indexOf("--repo") + 1], "Drangon-Li/guzi-graph");
    if (args[1] === "view") return JSON.stringify(release);
    assert.equal(args[1], "download", "Only read-only gh commands are allowed");
    downloaded = args[args.indexOf("--dir") + 1];
    const patterns = args.flatMap((arg, index) =>
      arg === "--pattern" ? [args[index + 1]] : [],
    );
    assert.deepEqual(patterns, [...files, "SHA256SUMS"]);
    for (const name of patterns) {
      if (fs.existsSync(path.join(source, name)))
        fs.copyFileSync(path.join(source, name), path.join(downloaded, name));
    }
    return "";
  };
  const reuse = () =>
    reuseWindowsRelease(destination, {
      version: "0.8.4",
      windowsVersion: version,
      run,
    });
  return {
    source,
    destination,
    files,
    names,
    release,
    checksum,
    calls,
    reuse,
    downloaded: () => downloaded,
  };
}

test("reuses only verified Windows assets from the exact published release, preserving bytes", (context) => {
  const f = fixture(context);
  fs.writeFileSync(
    path.join(f.destination, "mac-arm64-appcast.xml"),
    "existing Mac asset",
  );
  assert.deepEqual(f.reuse(), f.files);
  assert.equal(f.calls.length, 2);
  for (const name of f.files)
    assert.deepEqual(
      fs.readFileSync(path.join(f.destination, name)),
      fs.readFileSync(path.join(f.source, name)),
    );
  assert.deepEqual(
    fs.readdirSync(f.destination).sort(),
    [...f.files, "mac-arm64-appcast.xml"].sort(),
  );
  assert.equal(fs.existsSync(f.downloaded()), false);
});

for (const [field, value] of [
  ["isDraft", true],
  ["isPrerelease", true],
  ["tagName", "v0.8.4"],
]) {
  test(`refuses source release with ${field}=${value}`, (context) => {
    const f = fixture(context);
    f.release[field] = value;
    assert.throws(f.reuse);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(fs.readdirSync(f.destination), []);
  });
}

test("refuses missing or unexpected published assets before downloading", (context) => {
  const f = fixture(context);
  const original = [...f.release.assets];
  f.release.assets = original.filter(({ name }) => name !== f.names.windows);
  assert.throws(f.reuse, /source release assets/);
  f.release.assets = [...original, { name: "unexpected.exe" }];
  assert.throws(f.reuse, /source release assets/);
});

for (const name of [
  "Excalidraw-Guzi-0.8.3-win-x64.exe",
  "Excalidraw-Guzi-0.8.3-win-x64.exe.blockmap",
  "Excalidraw-Guzi-0.8.3-win-x64-unpacked.zip",
  "latest.yml",
  "SHA256SUMS",
]) {
  test(`refuses missing downloaded ${name}`, (context) => {
    const f = fixture(context);
    fs.unlinkSync(path.join(f.source, name));
    assert.throws(f.reuse, /downloaded Windows assets/);
    assert.deepEqual(fs.readdirSync(f.destination), []);
    assert.equal(fs.existsSync(f.downloaded()), false);
  });
  test(`refuses tampered source ${name}`, (context) => {
    const f = fixture(context);
    fs.appendFileSync(path.join(f.source, name), "tampered");
    assert.throws(f.reuse);
    assert.deepEqual(fs.readdirSync(f.destination), []);
    assert.equal(fs.existsSync(f.downloaded()), false);
  });
}

test("refuses Windows SHA512 or YAML version mismatch even with matching source SHA256", (context) => {
  const f = fixture(context);
  const file = path.join(f.source, "latest.yml");
  const original = yaml.load(fs.readFileSync(file, "utf8"));
  for (const info of [
    { ...original, version: "0.8.4" },
    { ...original, sha512: "invalid" },
    { ...original, path: "../installer.exe" },
  ]) {
    fs.writeFileSync(file, yaml.dump(info));
    f.checksum();
    assert.throws(f.reuse);
    assert.deepEqual(fs.readdirSync(f.destination), []);
  }
});

test("refuses incomplete source checksums and replacing existing destination assets", (context) => {
  const f = fixture(context);
  const sums = path.join(f.source, "SHA256SUMS");
  fs.writeFileSync(
    sums,
    fs.readFileSync(sums, "utf8").split("\n").slice(1).join("\n"),
  );
  assert.throws(f.reuse, /checksum entries/);
  f.checksum();
  fs.writeFileSync(path.join(f.destination, "latest.yml"), "preserve me");
  assert.throws(f.reuse, /Refusing to replace/);
  assert.deepEqual(fs.readdirSync(f.destination), ["latest.yml"]);
  assert.equal(
    fs.readFileSync(path.join(f.destination, "latest.yml"), "utf8"),
    "preserve me",
  );
});
