import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { concurrency, plan, runner, stages, STEPS } from "../verify.mjs";

const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts;
const labels = (steps) => steps.map((step) => step.label);

test("every step is a package script", () => {
  for (const { script } of STEPS) assert.ok(scripts[script], `no "${script}" script`);
});

test("CI runs every step, and the app's submodule check all but the history scan", () => {
  assert.equal(scripts["check:ci"], "node scripts/verify.mjs");
  assert.equal(scripts["check:quality"], "node scripts/verify.mjs --no-secrets");
  assert.deepEqual(labels(plan([])), labels(STEPS));
  assert.deepEqual(
    labels(plan(["--no-secrets"])),
    labels(STEPS.filter((step) => step.script !== "check:secrets")),
  );
});

test("`yarn lint` runs the same linters as verify", () => {
  const linters = STEPS.filter((step) => step.script.startsWith("lint:")).map((step) => `yarn run ${step.script}`);
  assert.deepEqual(scripts.lint.split(" && "), linters);
});

test("--fast skips the slow steps; an unknown flag is refused", () => {
  assert.ok(plan(["--fast"]).every((step) => !step.slow));
  assert.ok(plan(["--fast"]).some((step) => step.script === "test:coverage"));
  assert.equal(plan(["--fats"]), null);
});

test("steps run under the package manager that started verify", () => {
  assert.deepEqual(runner({ npm_execpath: "/x/pnpm.cjs" }), [process.execPath, "/x/pnpm.cjs"]);
  assert.deepEqual(runner({ npm_execpath: "/tmp/xfs-1/yarn" }), ["/tmp/xfs-1/yarn"]);
  assert.deepEqual(runner({}), ["yarn"]);
});

test("run as a script, it runs, through a symlink too (an unknown flag exits 2)", () => {
  const script = fileURLToPath(new URL("../verify.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    const link = join(dir, "verify.mjs");
    symlinkSync(script, link);
    for (const path of [script, link]) {
      const run = spawnSync(process.execPath, [path, "--bogus"], { encoding: "utf8" });
      assert.equal(run.status, 2, path);
      assert.match(run.stderr, /usage: yarn verify/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stages run in order, every step in one; half the cores at a time, one with --serial", () => {
  const order = stages(plan([])).map((stage) => stage[0].stage ?? 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(stages(plan([])).flat().length, STEPS.length);
  assert.equal(concurrency([], 12), 6);
  assert.equal(concurrency([], 2), 2);
  assert.equal(concurrency(["--serial"], 12), 1);
});

test("the build runs before every step that may read lib/", () => {
  const [firstStage, ...later] = stages(plan([]));
  assert.ok(firstStage.some((step) => step.script === "prepare"));
  for (const script of ["test:tooling", "test:coverage", "typecheck", "doctor:gate", "docs:api", "lint:deps"])
    assert.ok(later.flat().some((step) => step.script === script), script);
});
