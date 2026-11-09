// Every pre-commit-stage hook .pre-commit-config.yaml declares is covered by
// pre-commit.yml. The `static` job bootstraps pinned Python and prepared hook
// environments, falls back to pip only when the hook archive is unavailable,
// and explicitly runs pre-commit. Local hooks that need runner programs are
// skipped there and run as their own required lane. Hooks at other stages
// (`dco-signoff`, at `commit-msg`) are outside this workflow and test.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

const TOOL_BOOTSTRAP_ACTION = "./.github/actions/bootstrap-ci-tools";

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
const hookJob = jobs.find((job) =>
  job.steps.some(({ name }) => name === "Run pinned pre-commit hooks"),
);
const hookRunStep = hookJob.steps.find(
  ({ name }) => name === "Run pinned pre-commit hooks",
);
const bootstrapStep = hookJob.steps.find(
  ({ uses }) => uses === "./.github/actions/bootstrap-ci-tools",
);
const fallbackInstallStep = hookJob.steps.find(
  ({ name }) =>
    name === "Install pre-commit when the hook archive is unavailable",
);
// The required check: it passes only when every job it needs passed, so a job
// it does not need can fail unseen.
const required = workflow.jobs["pre-commit"].needs;
const skipped = new Set(
  String(hookRunStep.env?.SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== ""),
);

// A setup step counts only before the step that runs the hook, and only with
// no `if` of its own, which may prevent it from running when the job does.
const setsUpBefore = (job, step, tool) =>
  job.steps.slice(0, job.steps.indexOf(step)).some(
    (setup) =>
      setup.if === undefined &&
      setup.uses === TOOL_BOOTSTRAP_ACTION &&
      String(setup.with?.tools ?? "")
        .split(/\s+/u)
        .includes(tool),
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

  // The explicit command covers the pre-commit stage; only the separately
  // gated local checks are skipped and covered by their own required lanes.
  it("runs the pinned hook command on every run of static", () => {
    expect(hookRunStep.if).toBeUndefined();
    expect(hookRunStep["continue-on-error"]).toBeUndefined();
    expect(hookJob.continueOnError).toBeUndefined();
    expect(required).toContain(hookJob.id);
    expect(String(hookRunStep.run).trim().split("\n").map(normalize)).toEqual([
      "pre-commit run --all-files --show-diff-on-failure",
      'echo "executed=true" >> "$GITHUB_OUTPUT"',
    ]);
    expect([...skipped].sort()).toEqual([
      "local-definition-ratchet",
      "workspace-checks",
    ]);
    expect(
      hookJob.steps.some(({ uses }) =>
        String(uses ?? "").startsWith("pre-commit/action@"),
      ),
    ).toBe(false);
  });

  it("bootstraps pinned Python and hook environments, with a pinned pip fallback", () => {
    expect(bootstrapStep).toBeDefined();
    expect(hookJob.steps.indexOf(bootstrapStep)).toBeLessThan(
      hookJob.steps.indexOf(hookRunStep),
    );
    expect(bootstrapStep.id).toBe("ci_tool_1");
    expect(bootstrapStep.with?.tools).toBe("python-312 hooks");
    expect(fallbackInstallStep.if).toBe(
      "steps.ci_tool_1.outputs.hooks == 'fallback'",
    );
    expect(fallbackInstallStep.run).toBe("pip install pre-commit==4.7.0");
    expect(hookJob.steps.indexOf(fallbackInstallStep)).toBeLessThan(
      hookJob.steps.indexOf(hookRunStep),
    );
  });

  it("passes a mirror source to every workflow tool bootstrap", () => {
    const workflowDir = join(REPO_ROOT, ".github", "workflows");
    const variableSource = "${{ vars.CI_TOOLS_MIRROR_BASE_URL }}";
    const dispatchSource =
      "${{ inputs.mirror_base_url || vars.CI_TOOLS_MIRROR_BASE_URL }}";
    const matrixSource =
      "${{ matrix.origin == 'mirror' && (inputs.mirror_base_url || vars.CI_TOOLS_MIRROR_BASE_URL) || '' }}";
    const callers = readdirSync(workflowDir)
      .filter((fileName) => /\.ya?ml$/u.test(fileName))
      .flatMap((fileName) => {
        const document = parse(
          readFileSync(join(workflowDir, fileName), "utf8"),
        );
        const dispatchInputs = document.on?.workflow_dispatch?.inputs;
        const source =
          dispatchInputs !== null &&
          typeof dispatchInputs === "object" &&
          Object.hasOwn(dispatchInputs, "mirror_base_url")
            ? dispatchSource
            : variableSource;
        return Object.entries(document.jobs ?? {}).flatMap(([jobId, job]) =>
          (job.steps ?? [])
            .filter(
              ({ uses }) => uses === "./.github/actions/bootstrap-ci-tools",
            )
            .map((step) => ({
              fileName,
              jobId,
              step,
              source:
                fileName === "test.yml" && jobId === "bootstrap-proof"
                  ? matrixSource
                  : source,
            })),
        );
      });

    expect(callers.length).toBeGreaterThan(0);
    for (const { fileName, jobId, step, source } of callers) {
      expect(
        step.with?.["mirror-base-url"],
        `${fileName}:${jobId} bootstrap caller`,
      ).toBe(source);
    }

    const bootstrap = parse(
      readFileSync(
        join(
          REPO_ROOT,
          ".github",
          "actions",
          "bootstrap-ci-tools",
          "action.yml",
        ),
        "utf8",
      ),
    );
    expect(bootstrap.inputs["mirror-base-url"].default).toBe("");
    const install = bootstrap.runs.steps.find(({ id }) => id === "install");
    expect(install.env.CI_TOOLS_MIRROR).toBe("${{ inputs.mirror-base-url }}");
  });

  it("installs Electron after dependency setup and before each executed marker", () => {
    let installSteps = 0;
    for (const fileName of ["pre-commit.yml", "test.yml"]) {
      const document = parse(
        readFileSync(join(REPO_ROOT, ".github", "workflows", fileName), "utf8"),
      );
      for (const job of Object.values(document.jobs)) {
        for (const step of job.steps ?? []) {
          const lines = String(step.run ?? "")
            .trim()
            .split("\n")
            .map(normalize);
          const installIndex = lines.indexOf("bun install --frozen-lockfile");
          if (installIndex === -1) continue;

          const electronIndex = lines.indexOf(
            "bunx --no-install install-electron",
          );
          const executedIndex = lines.indexOf(
            'echo "executed=true" >> "$GITHUB_OUTPUT"',
          );
          expect(electronIndex, `${fileName} dependency install`).toBe(
            installIndex + 1,
          );
          expect(
            executedIndex,
            `${fileName} acquisition marker`,
          ).toBeGreaterThan(electronIndex);
          installSteps += 1;
        }
      }
    }
    expect(installSteps).toBeGreaterThan(0);
  });

  it("limits the cold bootstrap proof to explicit dispatch across every platform and origin", () => {
    const testWorkflow = parse(
      readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8"),
    );
    const dispatchInputs = testWorkflow.on.workflow_dispatch.inputs;
    expect(dispatchInputs.bootstrap_matrix).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(dispatchInputs.mirror_base_url).toMatchObject({
      type: "string",
      default: "",
    });

    const proof = testWorkflow.jobs["bootstrap-proof"];
    expect(normalize(proof.if)).toBe(
      "(github.event_name != 'pull_request' || (github.base_ref != 'main' && !startsWith(github.base_ref, 'integration/') && !startsWith(github.base_ref, 'land/')) || github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.type == 'Bot' ) && github.event_name == 'workflow_dispatch' && inputs.bootstrap_matrix",
    );
    expect(proof.strategy.matrix.platform).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
    ]);
    expect(proof.strategy.matrix.origin).toEqual(["mirror", "upstream"]);
    expect(proof.strategy.matrix.include).toEqual([
      { platform: "linux-x64", runner: "ubuntu-24.04" },
      { platform: "linux-arm64", runner: "ubuntu-24.04-arm" },
      { platform: "darwin-x64", runner: "macos-15-intel" },
      { platform: "darwin-arm64", runner: "macos-latest" },
      { platform: "win32-x64", runner: "windows-latest" },
    ]);

    const cold = proof.steps.find(({ id }) => id === "ci_cold");
    const bootstrap = proof.steps.find(({ id }) => id === "bootstrap");
    const originAssertion = proof.steps.find(
      ({ name }) =>
        typeof name === "string" &&
        name.startsWith("Assert the acquired runtimes execute"),
    );
    expect(cold.env.COLD_BLACKHOLE).toBe("${{ matrix.origin == 'mirror' }}");
    expect(cold.env.COLD_MIRROR_BASE_URL).toBe(
      "${{ matrix.origin == 'mirror' && (inputs.mirror_base_url || vars.CI_TOOLS_MIRROR_BASE_URL) || '' }}",
    );
    expect(cold.run).toBe(
      'node scripts/ci-cold.cjs prepare true "$COLD_BLACKHOLE" "$COLD_MIRROR_BASE_URL"',
    );
    expect(bootstrap.uses).toBe(TOOL_BOOTSTRAP_ACTION);
    expect(bootstrap.with).toMatchObject({
      tools: "node bun buf electron",
      "mirror-base-url":
        "${{ matrix.origin == 'mirror' && (inputs.mirror_base_url || vars.CI_TOOLS_MIRROR_BASE_URL) || '' }}",
      cold: "true",
    });
    expect(
      Object.entries(testWorkflow.jobs).some(
        ([jobId, job]) =>
          jobId !== "bootstrap-proof" &&
          (job.steps ?? []).some(({ uses }) => uses === TOOL_BOOTSTRAP_ACTION),
      ),
    ).toBe(true);
    expect(originAssertion.env.NODE_ORIGIN).toBe(
      "${{ steps.ci_cold.outputs.node-origin }}",
    );
    expect(originAssertion.env.BUN_ORIGIN).toBe(
      "${{ steps.bootstrap.outputs.bun-origin }}",
    );
    expect(originAssertion.run).toContain(
      'test "$NODE_ORIGIN" = "$EXPECTED_ORIGIN"',
    );
    expect(originAssertion.run).toContain(
      'test "$BUN_ORIGIN" = "$EXPECTED_ORIGIN"',
    );
    expect(originAssertion.run).toContain(
      'test "$(bunx --no-install node --version)" = v24.20.0',
    );

    const aggregate = testWorkflow.jobs.tests;
    expect(aggregate.needs).toContain("bootstrap-proof");
    const aggregateStep = aggregate.steps.find(
      ({ name }) => name === "Every test leg passed",
    );
    expect(aggregateStep.env.PROOF_REQUESTED).toContain(
      "inputs.bootstrap_matrix",
    );
    expect(aggregateStep.run).toContain('test "$PROOF_RESULT" = success');
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
      setsUpBefore(runner.job, runner.step, "bun"),
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
          const runner = runnerOf(hook);
          expect(
            runner !== undefined &&
              setsUpBefore(runner.job, runner.step, executable),
            `${runner?.job.id} sets up ${executable}`,
          ).toBe(true);
        });
      }
    });
  }
});
