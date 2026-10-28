const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const yaml = require("js-yaml");

const workflows = path.resolve(__dirname, "../../../.github/workflows");
const release = yaml.load(
  fs.readFileSync(path.join(workflows, "desktop-release.yml"), "utf8"),
);
const validation = yaml.load(
  fs.readFileSync(
    path.join(workflows, "release-update-validation.yml"),
    "utf8",
  ),
);

function evaluate(expression, context) {
  return vm.runInNewContext(
    expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""),
    context,
  );
}

test("release preparation validates the tag and explicit Windows version before either build", () => {
  const prepare = release.jobs.prepare;
  const check = prepare.steps.find(({ id }) => id === "versions");
  assert.match(check.run, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.equal(prepare.steps[0].with["fetch-depth"], 0);
  assert.equal(release.jobs.macos.needs, "prepare");
  assert.equal(release.jobs.windows.needs, "prepare");
  assert.deepEqual(Object.keys(prepare.outputs).sort(), [
    "app_version",
    "rebuild_windows",
    "windows_version",
  ]);
  const script = check.run.match(/node <<'NODE'\n([\s\S]+)\nNODE\s*$/)?.[1];
  assert.ok(script, "Expected the version check to execute before building");
  const run = (version, windowsReleaseVersion, tag = `v${version}`) => {
    let output = "";
    vm.runInNewContext(script, {
      process: { env: { GITHUB_REF_NAME: tag, GITHUB_OUTPUT: "outputs" } },
      require(name) {
        if (name === "./apps/desktop/package.json") {
          return { version, windowsReleaseVersion };
        }
        if (name === "node:fs") {
          return {
            appendFileSync(filename, value) {
              assert.equal(filename, "outputs");
              output += value;
            },
          };
        }
        return require(name);
      },
    });
    return output;
  };
  assert.equal(
    run("0.8.4", "0.8.3"),
    "app_version=0.8.4\nwindows_version=0.8.3\nrebuild_windows=false\n",
  );
  assert.match(run("0.9.0", "0.9.0"), /rebuild_windows=true\n$/);
  assert.throws(() => run("0.8.4", "0.8.3", "v0.8.3"), /Tag must match/);
  for (const windowsVersion of [
    undefined,
    "0.8.5",
    "0.9.0",
    "1.0.0",
    "0.8.3-beta.1",
  ]) {
    assert.throws(() => run("0.8.4", windowsVersion));
  }
  assert.throws(() => run("0.8.4-beta.1", "0.8.3"));
});

test("publish accepts only successful Mac and the expected successful or skipped Windows job", () => {
  const publish = release.jobs.publish;
  assert.deepEqual(publish.needs, ["prepare", "macos", "windows"]);
  assert.match(publish.if, /always\(\)/);
  const results = ["success", "failure", "cancelled", "skipped"];
  for (const rebuild of ["true", "false", ""]) {
    for (const prepare of results) {
      for (const macos of results) {
        for (const windows of results) {
          const needs = {
            prepare: { result: prepare, outputs: { rebuild_windows: rebuild } },
            macos: { result: macos },
            windows: { result: windows },
          };
          const expected =
            prepare === "success" &&
            macos === "success" &&
            ((rebuild === "true" && windows === "success") ||
              (rebuild === "false" && windows === "skipped"));
          assert.equal(
            evaluate(publish.if, { always: () => true, needs }),
            expected,
            JSON.stringify(needs),
          );
        }
      }
    }
  }
});

test("Windows build and official asset reuse select mutually exclusive release paths", () => {
  const steps = release.jobs.publish.steps;
  const download = steps.find(
    ({ with: options }) => options?.name === "Excalidraw-Guzi-windows-x64",
  );
  const reuse = steps.find(({ run }) =>
    run?.includes("reuse-windows-release.cjs"),
  );
  assert.equal(
    reuse.run,
    "node apps/desktop/scripts/reuse-windows-release.cjs release-assets",
  );
  for (const rebuild of ["true", "false"]) {
    const needs = { prepare: { outputs: { rebuild_windows: rebuild } } };
    assert.equal(
      evaluate(release.jobs.windows.if, { needs }),
      rebuild === "true",
    );
    assert.equal(evaluate(download.if, { needs }), rebuild === "true");
    assert.equal(evaluate(reuse.if, { needs }), rebuild === "false");
  }
  assert.equal(reuse.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(
    steps.some(
      ({ env }) =>
        env?.SPARKLE_ED25519_PRIVATE_KEY ===
        "${{ secrets.SPARKLE_ED25519_PRIVATE_KEY }}",
    ),
  );
  assert.ok(
    steps.some(
      ({ run }) =>
        run === "node apps/desktop/scripts/publish-release.cjs release-assets",
    ),
  );
});

test("published update validation dispatch selects exactly the requested platforms", () => {
  const inputs = validation.on.workflow_dispatch.inputs;
  assert.equal(inputs.platform.type, "choice");
  assert.deepEqual(inputs.platform.options, ["both", "mac", "windows"]);
  assert.equal(inputs.platform.default, "both");
  assert.equal(inputs.latest_release_version.required, false);
  for (const platform of ["both", "mac", "windows"]) {
    const matrix = evaluate(validation.jobs.update.strategy.matrix.include, {
      inputs: { platform },
      fromJSON: JSON.parse,
    });
    assert.deepEqual(
      matrix,
      platform === "both"
        ? [
            { os: "macos-15", platform: "mac" },
            { os: "windows-latest", platform: "windows" },
          ]
        : [
            {
              os: platform === "mac" ? "macos-15" : "windows-latest",
              platform,
            },
          ],
    );
  }
});

test("dispatch versions stay literal shell arguments and only Windows receives the latest Release tag", () => {
  const bash =
    process.platform === "win32"
      ? path.join(process.env.ProgramFiles, "Git/bin/bash.exe")
      : "bash";
  const step = validation.jobs.update.steps.find(
    ({ env }) => env?.GUZI_FROM_VERSION,
  );
  assert.doesNotMatch(step.run, /\$\{\{/);
  for (const platform of ["mac", "windows"]) {
    const from = "0.8.2";
    const to = "0.8.3";
    const latest = "0.8.4";
    const context = { inputs: { latest_release_version: "", to_version: to } };
    assert.equal(evaluate(step.env.GUZI_LATEST_RELEASE_VERSION, context), to);
    context.inputs.latest_release_version = latest;
    assert.equal(
      evaluate(step.env.GUZI_LATEST_RELEASE_VERSION, context),
      latest,
    );
    for (const target of [to, '0.8.3; echo "$(printf injected)"']) {
      const result = spawnSync(
        bash,
        ["-c", `node() { printf '%s\\0' "$@"; }\n${step.run}`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GUZI_PLATFORM: platform,
            GUZI_FROM_VERSION: from,
            GUZI_TO_VERSION: target,
            GUZI_LATEST_RELEASE_VERSION: latest,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split("\0").slice(0, -1), [
        `apps/desktop/scripts/release-update-${platform}.cjs`,
        "--from",
        from,
        "--to",
        target,
        "--artifacts",
        `output/release-update-validation/${platform}`,
        ...(platform === "windows" ? ["--latest-release", latest] : []),
      ]);
    }
  }
});
