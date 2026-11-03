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

import { spawnSync } from "node:child_process";
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
  continueOnError: job["continue-on-error"],
  shell: job.defaults?.run?.shell ?? workflow.defaults?.run?.shell,
  steps: job.steps ?? [],
}));
const isHookStep = (step) =>
  String(step.uses ?? "").startsWith("pre-commit/action@");
const hookJob = jobs.find((job) => job.steps.some(isHookStep));
const hookStep = hookJob.steps.find(isHookStep);
// The required check: it passes only when every job it needs passed, so a job
// it does not need can fail unseen.
const required = workflow.jobs["pre-commit"].needs;
const skipped = new Set(
  String(hookStep.env?.SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== ""),
);

// A setup step counts only before the step that runs the hook, and only with
// no `if` of its own, which may not run when the job does: `static` sets node
// up only for pull requests.
const setsUpBefore = (job, step, action) =>
  job.steps
    .slice(0, job.steps.indexOf(step))
    .some(
      (setup) =>
        setup.if === undefined && String(setup.uses ?? "").startsWith(action),
    );

// The runner's implicit shell, `bash -e`, fails the step when any line's
// command fails, but not a command in a pipeline (no pipefail), in an `&&` or
// `||` list, or in the background. So a step runs a hook only on a line that is
// exactly the command pre-commit runs: its entry, then its `args`, with no
// filenames (a skipped hook passes none). Another argument can change what it
// checks (the ratchet's `--write` rewrites its baseline), and an `echo` of it, a
// comment or a quoted copy is another line. Only the workspace build marker
// may precede the command; arbitrary shell lines could disable exit-on-error.
const commandOf = (hook) =>
  normalize([hook.entry, ...(hook.args ?? [])].join(" "));
const runsCommand = (run, command) => {
  const lines = String(run ?? "")
    .trim()
    .split("\n")
    .map(normalize);
  if (
    command === "scripts/pre_commit_workspace_checks.sh" &&
    lines[0] === 'touch "$RUNNER_TEMP/build-start"'
  ) {
    lines.shift();
  }
  return lines.length === 1 && lines[0] === command;
};

// A step whose failure fails the required check on every run that runs the
// hooks: no `if` or `continue-on-error` of its own, the implicit shell, and a
// job that runs whenever static does and that the required check needs.
function expectFailsRequiredCheck({ job, step }) {
  expect(job.id).not.toBe(hookJob.id);
  expect(job.if).toBe(hookJob.if);
  expect(job.continueOnError).toBeUndefined();
  expect(required).toContain(job.id);
  expect(step.if).toBeUndefined();
  expect(step["continue-on-error"]).toBeUndefined();
  expect(step.shell ?? job.shell).toBeUndefined();
}

// The job and step that run a skipped hook.
function runnerOf(hook) {
  const command = commandOf(hook);
  for (const job of jobs) {
    const step = job.steps.find((candidate) =>
      runsCommand(candidate.run, command),
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

  // `extra_args` defaults to `--all-files`; a hook id or another stage there
  // would run other hooks than these.
  it("runs every hook on every run of static", () => {
    expect(hookStep.if).toBeUndefined();
    expect(hookStep["continue-on-error"]).toBeUndefined();
    expect(hookJob.continueOnError).toBeUndefined();
    expect(required).toContain(hookJob.id);
    expect(normalize(hookStep.with?.extra_args ?? "--all-files")).toBe(
      "--all-files",
    );
  });

  // This executes the Ubuntu runner's shell; native Windows has no /bin/bash.
  it.skipIf(process.platform === "win32")(
    "the required check fails when any dependency did not succeed",
    () => {
      const job = jobs.find(({ id }) => id === "pre-commit");
      const step = job.steps.find(({ name }) => name === "Require every job");
      expect(job.if).toBe(`always() && ( ${hookJob.if} )`);
      expect(job.continueOnError).toBeUndefined();
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.shell ?? job.shell).toBeUndefined();
      expect(step.env.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");

      const successful = required.map(() => "success");
      const cases = [successful];
      for (const result of ["failure", "cancelled", "skipped"]) {
        for (const index of required.keys()) {
          cases.push(
            successful.map((value, i) => (i === index ? result : value)),
          );
        }
      }
      for (const results of cases) {
        const execution = spawnSync("/bin/bash", ["-e", "-c", step.run], {
          env: { RESULTS: results.join(" ") },
          encoding: "utf8",
          timeout: 5000,
        });
        expect(execution.error).toBeUndefined();
        expect(execution.status, results.join(" ")).toBe(
          results.every((result) => result === "success") ? 0 : 1,
        );
      }
    },
  );

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

  // CI splits the hook into lanes: the matrix runs the script once per lane,
  // and the format check its `all` lane runs is its own job.
  it("workspace-checks runs every lane of its script", () => {
    const hook = hooks.find(({ id }) => id === "workspace-checks");
    const runner = runnerOf(hook);
    expect(
      setsUpBefore(runner.job, runner.step, SETUP_ACTION.bun),
      `${runner.job.id} sets up Bun`,
    ).toBe(true);
    expect(runner.step.env?.WORKSPACE_CHECK_LANE).toBe("${{ matrix.lane }}");
    const script = readFileSync(join(REPO_ROOT, normalize(hook.entry)), "utf8");
    const affected = script.slice(script.indexOf("\nrun_affected() {"));
    const lanes = [
      ...affected
        .slice(0, affected.indexOf("\n}\n"))
        .matchAll(/^\s+([a-z]+)\)/gm),
    ]
      .map(([, lane]) => lane)
      .filter((lane) => lane !== "all");
    const matrix = workflow.jobs[runner.job.id].strategy.matrix.include.map(
      ({ lane }) => lane,
    );
    expect([...matrix].sort()).toEqual([...lanes].sort());
    const formatJob = jobs.find((job) =>
      job.steps.some((step) => runsCommand(step.run, "bun run format:check")),
    );
    expect(formatJob, "no step runs: bun run format:check").toBeDefined();
    expectFailsRequiredCheck({
      job: formatJob,
      step: formatJob.steps.find((step) =>
        runsCommand(step.run, "bun run format:check"),
      ),
    });
  });

  for (const hook of preCommitHooks.filter((hook) => skipped.has(hook.id))) {
    describe(hook.id, () => {
      it("runs as exactly its command, and its failure fails the required check", () => {
        const runner = runnerOf(hook);
        expect(runner, `no step runs: ${commandOf(hook)}`).toBeDefined();
        expect(hook.pass_filenames).toBe(false);
        expectFailsRequiredCheck(runner);
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
            runner !== undefined &&
              setsUpBefore(runner.job, runner.step, action),
            `${runner?.job.id} sets up ${executable}`,
          ).toBe(true);
        });
      }
    });
  }
});
