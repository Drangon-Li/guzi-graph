const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const { options: releaseOptions } = require("./release-update-windows.cjs");

const {
  observeChild,
  commandOutput,
  cleanupStages,
  devToolsEndpoint,
} = require("./update-windows-e2e.cjs");

test("production Windows validation keeps the installed version separate from the latest Release tag", () => {
  const base = [
    "--from",
    "0.8.2",
    "--to",
    "0.8.3",
    "--artifacts",
    "output/test",
  ];
  const defaults = releaseOptions(base);
  assert.equal(defaults.latestRelease, "0.8.3");
  const reused = releaseOptions([...base, "--latest-release", "0.8.4"]);
  assert.equal(reused.from, "0.8.2");
  assert.equal(reused.to, "0.8.3");
  assert.equal(reused.latestRelease, "0.8.4");
  assert.equal(reused.artifacts, defaults.artifacts);
});

test("production Windows validation rejects malformed latest Release versions", () => {
  const base = [
    "--from",
    "0.8.2",
    "--to",
    "0.8.3",
    "--artifacts",
    "output/test",
  ];
  for (const version of [
    "v0.8.4",
    "0.8.4-beta.1",
    "0.8.4; echo injected",
    "0.8",
    "00.8.4",
  ]) {
    assert.throws(() => releaseOptions([...base, "--latest-release", version]));
  }
  assert.throws(
    () => releaseOptions([...base, "--latest-release"]),
    /requires a value/,
  );
  assert.throws(
    () =>
      releaseOptions([
        ...base,
        "--latest-release",
        "0.8.4",
        "--latest-release",
        "0.8.4",
      ]),
    /Duplicate option/,
  );
  assert.throws(
    () =>
      releaseOptions([
        "--from",
        "0.8.3",
        "--to",
        "0.8.3",
        "--artifacts",
        "output/test",
        "--latest-release",
        "0.8.4",
      ]),
    /--from must be older/,
  );
});

test("DevToolsActivePort identifies the actual endpoint of each restarted browser", () => {
  const first = devToolsEndpoint(
    "53461\n/devtools/browser/1202e4ff-0e91-43c6-8290-a07bc2b6e732",
  );
  const restarted = devToolsEndpoint(
    "53469\r\n/devtools/browser/301e31ad-cc9f-44c6-85a0-e32cac6709e4\r\n",
  );
  assert.equal(
    first,
    "ws://127.0.0.1:53461/devtools/browser/1202e4ff-0e91-43c6-8290-a07bc2b6e732",
  );
  assert.notEqual(restarted, first);
  assert.throws(() => devToolsEndpoint("0\n/devtools/browser/stale"));
  assert.throws(() =>
    devToolsEndpoint("53469\nws://other-host/devtools/browser/stale"),
  );
});

test("PowerShell progress on stderr cannot corrupt stdout JSON", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.stderr.write('#< CLIXML\\r\\n<Objs><S>Preparing modules for first use.</S></Objs>');
    process.stdout.write(JSON.stringify({ remaining: [], stopped: [] }));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const entry = {};
  const result = await observeChild(child, entry).completed;
  assert.deepEqual(JSON.parse(commandOutput(result, "powershell.exe")), {
    remaining: [],
    stopped: [],
  });
  assert.match(entry.stderr, /^#< CLIXML/);
  assert.equal(entry.stdout, result.stdout);
  assert.throws(
    () => commandOutput({ ...result, code: 1 }, "powershell.exe"),
    /Preparing modules for first use/,
  );
});

test("cleanup continues to process termination, uninstall and verification after a parse failure", async () => {
  const completed = [];
  const errors = [];
  await cleanupStages(
    [
      ["process-discovery", async () => JSON.parse("#< CLIXML")],
      ["tracked-processes", async () => completed.push("terminated")],
      ["uninstall", async () => completed.push("uninstalled")],
      ["verify-cleanup", async () => completed.push("verified")],
    ],
    (stage, error) => errors.push({ stage, error }),
  );
  assert.deepEqual(completed, ["terminated", "uninstalled", "verified"]);
  assert.equal(errors[0].stage, "process-discovery");
  assert.ok(errors[0].error instanceof SyntaxError);
});

test("partial command output survives failure cleanup and owned pipes can be released", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.stdout.write('fixture started');
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const entry = {};
  const observed = observeChild(child, entry);
  try {
    await once(child.stdout, "data");
    assert.equal(entry.stdout, "fixture started");
    observed.release();
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    child.ref();
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await observed.completed;
  }
});
