// Every pre-commit-stage hook .pre-commit-config.yaml declares runs in
// pre-commit.yml, in a job that can execute it, on every run that runs the
// hooks.
//
// The `static` job runs the hooks through `pre-commit/action`. It provisions
// only Python, from which pre-commit builds the remote hooks' environments
// itself; it has no bun and no node_modules. So a local hook that runs a
// program from the runner (`language: system` or `script`, or their pre-commit
// 4.4 names `unsupported` and `unsupported_script`) is skipped there and
// runs as its own `entry` in a step of another job, one that runs whenever
// `static` does and sets up the executable a `system` hook calls. Hooks at
// other stages (`dco-signoff`, at `commit-msg`) are outside `pre-commit/action`
// and this test.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const config = parse(
  readFileSync(join(REPO_ROOT, ".pre-commit-config.yaml"), "utf8"),
);
const workflow = parse(
  readFileSync(
    join(REPO_ROOT, ".github", "workflows", "pre-commit.yml"),
    "utf8",
  ),
);

// The action that puts each system executable a local hook calls on PATH.
const SETUP_ACTION = {
  bun: "oven-sh/setup-bun@",
  node: "actions/setup-node@",
  python: "actions/setup-python@",
  python3: "actions/setup-python@",
};

const normalize = (text) => String(text).replace(/\s+/g, " ").trim();

const defaultStages = config.default_stages ?? ["pre-commit"];
const hooks = config.repos.flatMap((repo) =>
  repo.hooks.map((hook) => ({ ...hook, local: repo.repo === "local" })),
);
const preCommitHooks = hooks.filter((hook) =>
  (hook.stages ?? defaultStages).includes("pre-commit"),
);
// pre-commit 4.4 renamed `system` to `unsupported` and `script` to
// `unsupported_script`, and accepts both names.
const SYSTEM = new Set(["system", "unsupported"]);
const RUNNER_PROGRAM = new Set([...SYSTEM, "script", "unsupported_script"]);
const runsRunnerProgram = (hook) =>
  hook.local && RUNNER_PROGRAM.has(hook.language);

const jobs = Object.entries(workflow.jobs).map(([id, job]) => ({
  id,
  if: normalize(job.if ?? ""),
  steps: job.steps ?? [],
}));
const isHookStep = (step) =>
  String(step.uses ?? "").startsWith("pre-commit/action@");
const hookJob = jobs.find((job) => job.steps.some(isHookStep));
const skipped = new Set(
  String(hookJob.steps.find(isHookStep).env?.SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== ""),
);

// A step with its own `if` may not run when the job does: `static` sets node up
// only for pull requests.
const setsUp = (job, action) =>
  job.steps.some(
    (step) =>
      step.if === undefined && String(step.uses ?? "").startsWith(action),
  );

// The job and step that run a skipped hook: the step whose `run` holds the
// hook's own entry.
function runnerOf(hook) {
  const entry = normalize(hook.entry);
  for (const job of jobs) {
    const step = job.steps.find((candidate) =>
      normalize(candidate.run ?? "").includes(entry),
    );
    if (step !== undefined) return { job, step };
  }
  return undefined;
}

describe("every pre-commit hook runs in a pre-commit.yml job that can execute it", () => {
  it("finds the hook job and the hooks", () => {
    expect(hookJob.id).toBe("static");
    expect(preCommitHooks.map((hook) => hook.id)).toContain("workspace-checks");
  });

  it("skips only hooks the config declares", () => {
    const declared = new Set(hooks.map((hook) => hook.id));
    expect([...skipped].filter((id) => !declared.has(id))).toEqual([]);
  });

  it("skips every local hook that runs a program from the runner", () => {
    const run = preCommitHooks.filter(
      (hook) => runsRunnerProgram(hook) && !skipped.has(hook.id),
    );
    expect(run.map((hook) => hook.id)).toEqual([]);
  });

  for (const hook of preCommitHooks.filter((hook) => skipped.has(hook.id))) {
    describe(hook.id, () => {
      it("runs as its own entry in a step of a job that runs whenever static does", () => {
        const runner = runnerOf(hook);
        expect(runner, `no step runs: ${normalize(hook.entry)}`).toBeDefined();
        expect(runner.job.id).not.toBe(hookJob.id);
        expect(runner.job.if).toBe(hookJob.if);
        expect(runner.step.if).toBeUndefined();
      });

      if (hook.local && SYSTEM.has(hook.language)) {
        it("runs in a job that sets up its executable", () => {
          const executable = normalize(hook.entry).split(" ")[0];
          const action = SETUP_ACTION[executable];
          expect(
            action,
            `no setup action known for ${executable}`,
          ).toBeDefined();
          const runner = runnerOf(hook);
          expect(
            runner !== undefined && setsUp(runner.job, action),
            `${runner?.job.id} sets up ${executable}`,
          ).toBe(true);
        });
      }
    });
  }
});
