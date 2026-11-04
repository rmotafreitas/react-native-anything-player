#!/usr/bin/env node
/**
 * Every check CI runs, with one summary at the end: each step runs even after
 * a failure, so one pass shows all that is broken.
 *
 * `check:ci` (GitHub CI and Jenkins) and `check:quality` (the app's submodule
 * check, run in a copy without Git history) are this script, so CI and a
 * local run cannot drift apart. Steps of a stage run at once (half the cores
 * at a time, each step's output printed whole when it ends); stages run in
 * order. The build comes first: the
 * tests check the lib/ it writes.
 *
 * usage: yarn verify               every step (as check:ci)
 *        yarn verify --fast        skips the slow ones (secrets, audit, React Doctor)
 *        yarn verify --no-secrets  every step but the history scan (as check:quality)
 *        yarn verify --serial      one step at a time, its output live
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * A package script; `slow` steps are skipped by `--fast`, `history` ones by
 * `--no-secrets`. Within a stage the longest come first, so they start first.
 */
export const STEPS = [
  // First: the package-contents and CLI tests check this build's lib/.
  { label: "build (lib, CLI)", script: "prepare" },
  { label: "secrets", script: "check:secrets", slow: true, history: true },
  { label: "dependency audit", script: "check:audit", slow: true },
  { label: "unit tests + coverage", script: "test:coverage", stage: 1 },
  { label: "eslint", script: "lint:eslint", stage: 1 },
  { label: "typecheck", script: "typecheck", stage: 1 },
  { label: "react doctor", script: "doctor:gate", slow: true, stage: 1 },
  { label: "tooling tests", script: "test:tooling", stage: 1 },
  { label: "API docs", script: "docs:api", stage: 1 },
  { label: "oxlint (type-aware)", script: "lint:types", stage: 1 },
  { label: "knip + sherif", script: "lint:deps", stage: 1 },
];

const FLAGS = new Set(["--fast", "--no-secrets", "--serial"]);

/** The steps `args` select, or `null` for an unknown argument. */
export function plan(args) {
  if (args.some((arg) => !FLAGS.has(arg))) return null;
  return STEPS.filter(
    (step) => !(args.includes("--fast") && step.slow) && !(args.includes("--no-secrets") && step.history),
  );
}

/** `steps` grouped by stage, in stage order. */
export function stages(steps) {
  const byStage = new Map();
  for (const step of steps) {
    const stage = step.stage ?? 0;
    byStage.set(stage, [...(byStage.get(stage) ?? []), step]);
  }
  return [...byStage.keys()].sort((a, b) => a - b).map((stage) => byStage.get(stage));
}

/** How many steps run at once: half the cores, at least two (one with `--serial`). */
export function concurrency(args, cores = availableParallelism()) {
  return args.includes("--serial") ? 1 : Math.max(2, Math.floor(cores / 2));
}

/**
 * The package manager this script runs under, as `yarn run` named it in
 * npm_execpath (a JS file, as pnpm's, runs on this Node; a launcher, as
 * Yarn's, runs as is), or `yarn` from PATH.
 */
export function runner(env = process.env) {
  const execPath = env.npm_execpath;
  if (!execPath) return ["yarn"];
  return /\.[cm]?js$/.test(execPath) ? [process.execPath, execPath] : [execPath];
}

/** Runs one step; its output goes live to the terminal, or is kept to print whole. */
function run(step, live) {
  const [command, ...prefix] = runner();
  const started = Date.now();
  return new Promise((resolve) => {
    const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
    const child = spawn(command, [...prefix, "run", step.script], {
      stdio: live ? "inherit" : ["ignore", "pipe", "pipe"],
      env,
    });
    const output = [];
    child.stdout?.on("data", (chunk) => output.push(chunk));
    child.stderr?.on("data", (chunk) => output.push(chunk));
    // A command that could not start prints nothing itself.
    child.on("error", (error) => output.push(Buffer.from(`  ${command}: ${error.message}\n`)));
    child.on("close", (status) => {
      resolve({ ok: status === 0, seconds: Math.round((Date.now() - started) / 1000), output: Buffer.concat(output) });
    });
  });
}

/** Runs `task` on every item, at most `limit` at a time. */
async function pool(items, limit, task) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await task(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main(args) {
  const steps = plan(args);
  if (!steps) {
    console.error("usage: yarn verify [--fast] [--no-secrets] [--serial]");
    return 2;
  }
  const limit = concurrency(args);
  const live = limit === 1;
  const results = new Map();
  for (const stage of stages(steps)) {
    await pool(stage, limit, async (step) => {
      const header = `\n▶ ${step.label} (${step.script})`;
      if (live) console.log(header);
      else console.log(`· ${step.label} started`);
      const result = await run(step, live);
      if (!live) {
        console.log(header);
        process.stdout.write(result.output);
      }
      results.set(step, result);
    });
  }

  console.log("\nverify summary");
  for (const step of steps) {
    const { ok, seconds } = results.get(step);
    console.log(`  ${ok ? "✓" : "✗"} ${step.label.padEnd(24)} ${String(seconds).padStart(4)} s`);
  }
  const failed = steps.filter((step) => !results.get(step).ok);
  console.log(failed.length ? `\n${failed.length} step(s) failed.` : "\nAll steps passed.");
  return failed.length ? 1 : 0;
}

// Run as a script (not imported by its test), however the path reached it:
// through a symlink, process.argv[1] is the link and import.meta.url the file.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
