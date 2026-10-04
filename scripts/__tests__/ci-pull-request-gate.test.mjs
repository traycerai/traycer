// Pins the contract of the pull-request gate: a team PR into `main` starts no
// CI job (the merge to `main` runs everything once), and a fork PR, a bot PR
// or a PR into any other branch runs every check. The workflows are PARSED,
// never pattern-matched, so a reformat of the YAML cannot hide a job that
// lost its gate.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

// The single source of truth. Every job in a workflow that triggers on
// `pull_request` carries this text in its `if`, verbatim.
const GATE =
  "github.event_name != 'pull_request' || github.base_ref != 'main' || github.event.pull_request.head.repo.fork || github.event.pull_request.user.type == 'Bot'";

// What a concurrency group may contain: the pull-request branch of the
// expression, and nothing else that names a ref.
const PR_KEYED =
  "github.event_name == 'pull_request' && github.ref || github.run_id";

const normalize = (expression) =>
  String(expression)
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();

const triggers = (workflow) => {
  const on = workflow.on;
  if (typeof on === "string") return { [on]: {} };
  if (Array.isArray(on))
    return Object.fromEntries(on.map((name) => [name, {}]));
  return on ?? {};
};

const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => ({
    file,
    workflow: parse(readFileSync(join(WORKFLOWS_DIR, file), "utf8")),
  }));

const pullRequestWorkflows = workflows.filter(
  ({ workflow }) => "pull_request" in triggers(workflow),
);

const pushesToMain = ({ workflow }) => {
  const push = triggers(workflow).push;
  if (push === undefined) return false;
  const branches = push?.branches;
  return branches === undefined || branches.includes("main");
};

describe("the gate expression", () => {
  it("skips a team PR only when its base is main", () => {
    expect(GATE).toContain("github.base_ref != 'main'");
  });

  it("lets fork PRs and bot PRs through", () => {
    expect(GATE).toContain("github.event.pull_request.head.repo.fork");
    expect(GATE).toContain("github.event.pull_request.user.type == 'Bot'");
  });
});

describe("every job of a workflow that runs on pull_request", () => {
  it("covers the eight workflows the design names", () => {
    expect(pullRequestWorkflows.map(({ file }) => file).sort()).toEqual([
      "browser-regressions.yml",
      "codeql.yml",
      "dco.yml",
      "pre-commit.yml",
      "protocol-compat.yml",
      "real-supervisor.yml",
      "secret-scan.yml",
      "test.yml",
    ]);
  });

  for (const { file, workflow } of pullRequestWorkflows) {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      describe(`${file} / ${jobId}`, () => {
        const condition = normalize(job.if ?? "");

        it("carries the gate in its if", () => {
          expect(condition).toContain(GATE);
        });

        it("parenthesises the gate when it shares the if with anything else", () => {
          expect(condition === GATE || condition.includes(`(${GATE})`)).toBe(
            true,
          );
        });

        it("is skipped, not run, when it is an always() aggregator", () => {
          if (condition.includes("always()")) {
            expect(condition.startsWith(`always() && (${GATE})`)).toBe(true);
          }
        });
      });
    }
  }
});

describe("concurrency", () => {
  for (const entry of workflows.filter(
    ({ workflow }) => workflow.concurrency !== undefined,
  )) {
    const { file, workflow } = entry;
    if (!pullRequestWorkflows.includes(entry)) continue;
    it(`${file} cannot cancel a push run`, () => {
      const group = String(workflow.concurrency.group);
      expect(group).toContain(`\${{ ${PR_KEYED} }}`);
      // Whatever remains once the PR-keyed segment is removed must name no
      // ref: a bare `github.ref` would key a push by branch and cancel the
      // previous merge's run.
      const rest = group.replace(PR_KEYED, "");
      expect(rest).not.toMatch(/github\.(ref|head_ref|base_ref|sha)\b/);
      expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    });
  }
});

describe("test.yml `tests`", () => {
  const { workflow } = workflows.find(({ file }) => file === "test.yml");
  const job = workflow.jobs.tests;

  it("is the single check for the whole test matrix", () => {
    expect(job.name).toBe("tests");
    expect(job.needs).toEqual(["test"]);
    expect(normalize(job.if).startsWith(`always() && (${GATE})`)).toBe(true);
  });

  it("is one bash step with no checkout, failing unless the matrix passed", () => {
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].uses).toBeUndefined();
    expect(job.steps[0].env.RESULT).toBe("${{ needs.test.result }}");
    expect(job.steps[0].run).toContain('test "$RESULT" = success');
  });
});

describe("trunk-red.yml", () => {
  const trunkRed = workflows.find(({ file }) => file === "trunk-red.yml");
  const { workflow } = trunkRed;

  it("watches every workflow that runs on a push to main", () => {
    const expected = pullRequestWorkflows
      .filter(pushesToMain)
      .map(({ workflow: w }) => w.name)
      .sort();
    expect([...workflow.on.workflow_run.workflows].sort()).toEqual(expected);
    expect(workflow.on.workflow_run.branches).toEqual(["main"]);
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
  });

  it("holds no permission at the top and actions: write on its one job", () => {
    expect(workflow.permissions).toEqual({});
    const jobs = Object.values(workflow.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].permissions).toEqual({ actions: "write" });
  });

  it("acts only on a failed push run", () => {
    const condition = normalize(Object.values(workflow.jobs)[0].if);
    expect(condition).toContain("github.event.workflow_run.event == 'push'");
    // Its own retry is attempt two: the job that started it waits for it, so
    // a second run of this workflow must not retry or post again.
    expect(condition).toContain("github.event.workflow_run.run_attempt == 1");
    expect(condition).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(condition).toContain(
      "github.event.workflow_run.conclusion == 'timed_out'",
    );
  });

  it("interpolates no expression into a run body", () => {
    for (const step of Object.values(workflow.jobs)[0].steps) {
      expect(String(step.run ?? "")).not.toContain("${{");
    }
  });
});
