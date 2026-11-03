// Every hook .pre-commit-config.yaml declares runs on every push to `main`,
// through pre-commit.yml, and every job that runs one can execute it.
//
// The `static` job runs the hooks through `pre-commit/action` and skips the
// ones named in its `SKIP`; a skipped hook must then run in another job of the
// same workflow, as its own `entry` in a step's `run`. A `language: system`
// hook calls an executable on the runner's PATH, so the job that runs it must
// set that executable up. Hooks that run at another stage (the DCO sign-off at
// `commit-msg`) are not run by `pre-commit/action`; dco.yml checks those.

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

const jobs = Object.entries(workflow.jobs).map(([id, job]) => ({
  id,
  steps: job.steps ?? [],
}));
const hookJob = jobs.find((job) =>
  job.steps.some((step) =>
    String(step.uses ?? "").startsWith("pre-commit/action@"),
  ),
);
const hookStep = hookJob.steps.find((step) =>
  String(step.uses ?? "").startsWith("pre-commit/action@"),
);
const skipped = new Set(
  String(hookStep.env?.SKIP ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== ""),
);

const setsUp = (job, action) =>
  job.steps.some((step) => String(step.uses ?? "").startsWith(action));

// The job that runs `hook`: the hook job unless it is skipped there, else the
// job with a step whose `run` holds the hook's own entry.
function jobRunning(hook) {
  if (!skipped.has(hook.id)) return hookJob;
  const entry = normalize(hook.entry);
  return jobs.find((job) =>
    job.steps.some((step) => normalize(step.run ?? "").includes(entry)),
  );
}

describe("every hook .pre-commit-config.yaml declares runs in pre-commit.yml", () => {
  it("finds the hook job and the hooks", () => {
    expect(hookJob.id).toBe("static");
    expect(preCommitHooks.map((hook) => hook.id)).toContain("workspace-checks");
  });

  it("skips only hooks the config declares", () => {
    const declared = new Set(hooks.map((hook) => hook.id));
    expect([...skipped].filter((id) => !declared.has(id))).toEqual([]);
  });

  for (const hook of preCommitHooks) {
    describe(hook.id, () => {
      it("runs in some job", () => {
        expect(jobRunning(hook)?.id).toBeDefined();
      });

      if (hook.local && hook.language === "system") {
        it("runs in a job that sets up its executable", () => {
          const executable = normalize(hook.entry).split(" ")[0];
          const action = SETUP_ACTION[executable];
          expect(
            action,
            `no setup action known for ${executable}`,
          ).toBeDefined();
          const job = jobRunning(hook);
          expect(
            job && setsUp(job, action),
            `${job?.id} sets up ${executable}`,
          ).toBe(true);
        });
      }
    });
  }
});
