// Pins the contract of the pull-request gate: a team PR into `main`, an
// `integration/*` branch or a `land/*` branch starts no CI job but the CodeQL
// scan (the merge to `main` runs everything once), and a fork PR, a bot PR or
// a PR into any other branch runs every check. The
// workflows are PARSED, never pattern-matched, so a reformat of the YAML
// cannot hide a job that lost its gate. It also pins what keeps a merge run
// honest: no push run can be cancelled by a later one, every push run narrows
// against the last GREEN push (scripts/ci-last-green-sha.sh), and trunk-red
// watches every push workflow.

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
  "github.event_name != 'pull_request' || (github.base_ref != 'main' && !startsWith(github.base_ref, 'integration/') && !startsWith(github.base_ref, 'land/')) || github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.type == 'Bot'";

// What a concurrency group may contain: the pull-request branch of the
// expression, and nothing else that names a ref. On a push the expression is
// `github.run_id`.
const PR_KEYED =
  "github.event_name == 'pull_request' && github.ref || github.run_id";

// A job that only makes sense on a pull request (a check of the PR's own diff
// or labels) restricts itself to one, and still carries the gate: `PR_ONLY &&
// (gate)`.
const PR_ONLY = "github.event_name == 'pull_request'";
const TRIPWIRE = {
  file: "protocol-compat.yml",
  jobId: "guarded-files-tripwire",
};

// The one job exempt from the gate: the CodeQL scan runs on every pull
// request, so an alert shows on the PR that introduces it.
const SCAN = { file: "codeql.yml", jobId: "analyze" };
const isScan = (file, jobId) => file === SCAN.file && jobId === SCAN.jobId;

// The workflows AGENTS.md says can be run on a branch.
const DISPATCHABLE = [
  "browser-regressions.yml",
  "formal-regressions.yml",
  "gradle-wrapper.yml",
  "pre-commit.yml",
  "protocol-compat.yml",
  "real-supervisor.yml",
  "test.yml",
];

const LAST_GREEN = "scripts/ci-last-green-sha.sh";
const PUSH_SCOPE = "scripts/ci-push-scope.sh";

// The workflows whose push run decides inside itself, through a `changes` job
// that calls `ci-push-scope.sh` and job-level `if`s that read its answer.
const SCOPED = [
  {
    file: "protocol-compat.yml",
    changes: "changes",
    gated: ["protocol-compat"],
  },
  { file: "real-supervisor.yml", changes: "changes", gated: ["macos"] },
  { file: "gradle-wrapper.yml", changes: "changes", gated: ["validate"] },
];

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

// `pull_request_target` runs with a write token against the base: it is a
// pull-request trigger for every purpose here.
const PULL_REQUEST_TRIGGERS = ["pull_request", "pull_request_target"];

const pullRequestWorkflows = workflows.filter(({ workflow }) =>
  PULL_REQUEST_TRIGGERS.some((name) => name in triggers(workflow)),
);

// A workflow runs on a push to `main` when its `push` trigger names `main`, or
// names no branch filter and no tag filter (a tag-only push is not a push to a
// branch).
const pushesToMain = ({ workflow }) => {
  const push = triggers(workflow).push;
  if (push === undefined) return false;
  const branches = push?.branches;
  const ignored = push?.["branches-ignore"];
  if (Array.isArray(ignored)) return !ignored.includes("main");
  if (branches === undefined) return push?.tags === undefined;
  return branches.includes("main");
};

const pushWorkflows = workflows.filter(pushesToMain);

// True when `expression` has an `||` outside every parenthesis and string.
const hasTopLevelOr = (expression) => {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'") inString = !inString;
    if (inString) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && char === "|" && expression[index + 1] === "|") {
      return true;
    }
  }
  return false;
};

// The shapes under which the gate really gates: it is the whole `if`; it is
// the only thing an `always()` aggregator adds; or it is a top-level conjunct
// of an `if` with no `||` outside a parenthesis, either the first (`(gate) &&
// x`) or right after a pull-request-only restriction (`PR_ONLY && (gate)`).
// `(gate) || x` and `always() && (gate) || x` run on a team PR whenever `x`
// holds, and `PR_ONLY && (gate) || x` is `(PR_ONLY && (gate)) || x`.
const gates = (condition) => {
  if (condition === GATE) return true;
  if (condition === `always() && (${GATE})`) return true;
  if (condition === `${PR_ONLY} && (${GATE})`) return true;
  for (const lead of [`(${GATE})`, `${PR_ONLY} && (${GATE})`]) {
    if (condition.startsWith(`${lead} && `)) {
      const rest = condition.slice(`${lead} && `.length);
      return rest.length > 0 && !hasTopLevelOr(rest);
    }
  }
  return false;
};

// Every concurrency block of a workflow: its own, and each job's. A bare
// string is a group with no `cancel-in-progress`.
const concurrencyBlocks = (workflow) => {
  const blocks = [];
  const add = (where, value) => {
    if (value === undefined) return;
    blocks.push({
      where,
      group: String(typeof value === "string" ? value : value.group),
      cancel:
        typeof value === "string" ? undefined : value["cancel-in-progress"],
    });
  };
  add("workflow", workflow.concurrency);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    add(`job ${jobId}`, job.concurrency);
  }
  return blocks;
};

// The gate evaluated on the contexts GitHub gives it, so the expression is
// pinned by what it decides, not by the words in it. It is an `||` of terms,
// each a `<context> == 'x'` / `<context> != <context | 'x'>` comparison or a
// parenthesised `&&` of those and `!startsWith(<context>, 'x')`.
const gateRuns = (context) => {
  const lookup = {
    "github.event_name": context.event_name,
    "github.base_ref": context.base_ref,
    "github.event.pull_request.head.repo.full_name": context.head_repo,
    "github.repository": "traycerai/traycer",
    "github.event.pull_request.user.type": context.user_type,
  };
  // GitHub ignores case when it compares strings and when `startsWith`
  // matches a prefix.
  const fold = (value) =>
    typeof value === "string" ? value.toLowerCase() : value;
  const operand = (text) =>
    fold(text.startsWith("'") ? text.slice(1, -1) : lookup[text]);
  const term = (text) => {
    const prefix = /^!startsWith\(([\w.]+), ('[^']*')\)$/.exec(text);
    if (prefix) {
      return !String(operand(prefix[1]) ?? "").startsWith(operand(prefix[2]));
    }
    const [left, operator, right] = text.split(" ");
    if (operator === "==") return operand(left) === operand(right);
    if (operator === "!=") return operand(left) !== operand(right);
    throw new Error(`unsupported term in the gate: ${text}`);
  };
  const alternatives = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < GATE.length; index += 1) {
    if (GATE[index] === "(") depth += 1;
    if (GATE[index] === ")") depth -= 1;
    if (depth === 0 && GATE.startsWith(" || ", index)) {
      alternatives.push(GATE.slice(start, index));
      start = index + " || ".length;
    }
  }
  alternatives.push(GATE.slice(start));
  return alternatives.some((alternative) =>
    alternative.startsWith("(") && alternative.endsWith(")")
      ? alternative.slice(1, -1).split(" && ").every(term)
      : term(alternative),
  );
};

describe("the gate expression", () => {
  const team = {
    event_name: "pull_request",
    base_ref: "main",
    head_repo: "traycerai/traycer",
    user_type: "User",
  };

  it("skips a team PR into main", () => {
    expect(gateRuns(team)).toBe(false);
  });

  it("skips a team PR into an integration or land branch", () => {
    expect(gateRuns({ ...team, base_ref: "integration/sandboxes" })).toBe(
      false,
    );
    expect(gateRuns({ ...team, base_ref: "land/round-3" })).toBe(false);
  });

  it("matches the base the way GitHub does, ignoring case", () => {
    expect(gateRuns({ ...team, base_ref: "Main" })).toBe(false);
    expect(gateRuns({ ...team, base_ref: "Integration/sandboxes" })).toBe(
      false,
    );
    expect(gateRuns({ ...team, base_ref: "LAND/round-3" })).toBe(false);
  });

  it("runs a PR into any other branch, including one that only contains integration/ or land/", () => {
    expect(gateRuns({ ...team, base_ref: "release/1.4" })).toBe(true);
    expect(gateRuns({ ...team, base_ref: "fix/integration/x" })).toBe(true);
    expect(gateRuns({ ...team, base_ref: "integration" })).toBe(true);
  });

  it("runs a fork or bot PR into an integration or land branch", () => {
    expect(
      gateRuns({
        ...team,
        base_ref: "integration/sandboxes",
        head_repo: "someone/traycer",
      }),
    ).toBe(true);
    expect(
      gateRuns({ ...team, base_ref: "land/round-3", user_type: "Bot" }),
    ).toBe(true);
  });

  it("runs a fork PR, and a PR whose head repository no longer exists", () => {
    expect(gateRuns({ ...team, head_repo: "someone/traycer" })).toBe(true);
    // A deleted fork reports a null head repository: the comparison is false
    // for "is it this repository", so CI runs. The gate fails toward running.
    expect(gateRuns({ ...team, head_repo: undefined })).toBe(true);
  });

  it("runs a bot PR", () => {
    expect(gateRuns({ ...team, user_type: "Bot" })).toBe(true);
  });

  it("runs a push and a manual run", () => {
    expect(gateRuns({ ...team, event_name: "push" })).toBe(true);
    expect(gateRuns({ ...team, event_name: "workflow_dispatch" })).toBe(true);
  });
});

describe("every job of a workflow that runs on a pull request", () => {
  it("covers the ten workflows the design names", () => {
    expect(pullRequestWorkflows.map(({ file }) => file).sort()).toEqual([
      "browser-regressions.yml",
      "codeql.yml",
      "dco.yml",
      "formal-regressions.yml",
      "gradle-wrapper.yml",
      "pre-commit.yml",
      "protocol-compat.yml",
      "real-supervisor.yml",
      "secret-scan.yml",
      "test.yml",
    ]);
  });

  for (const { file, workflow } of pullRequestWorkflows) {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      if (isScan(file, jobId)) continue;
      describe(`${file} / ${jobId}`, () => {
        it("is gated: the gate is the whole if, an always() aggregator's only addition, or a top-level conjunct", () => {
          expect(gates(normalize(job.if ?? ""))).toBe(true);
        });
      });
    }
  }

  it("exempts only the CodeQL scan, which runs on every pull request", () => {
    const { workflow } = pullRequestWorkflows.find(
      ({ file }) => file === SCAN.file,
    );
    expect(workflow.jobs[SCAN.jobId].if).toBeUndefined();
  });
});

describe("what counts as gated", () => {
  const PR_ONLY_GATED = `${PR_ONLY} && (${GATE})`;

  it("accepts the whole gate, an aggregator, and a top-level conjunct", () => {
    expect(gates(GATE)).toBe(true);
    expect(gates(`always() && (${GATE})`)).toBe(true);
    expect(gates(`(${GATE}) && x`)).toBe(true);
    expect(gates(PR_ONLY_GATED)).toBe(true);
    expect(gates(`${PR_ONLY_GATED} && x`)).toBe(true);
  });

  it("rejects a gate that another term can bypass, or none at all", () => {
    expect(gates(`(${GATE}) || x`)).toBe(false);
    expect(gates(`${PR_ONLY_GATED} || x`)).toBe(false);
    expect(gates(`always() && (${GATE}) || x`)).toBe(false);
    expect(gates(PR_ONLY)).toBe(false);
    expect(gates("")).toBe(false);
  });
});

describe("protocol-compat.yml / guarded-files-tripwire", () => {
  const { workflow } = workflows.find(({ file }) => file === TRIPWIRE.file);

  it("exists", () => {
    expect(Object.keys(workflow.jobs)).toContain(TRIPWIRE.jobId);
  });

  it("runs only on a pull request, and only where CI runs on one: no team PR into main, integration/* or land/*", () => {
    expect(normalize(workflow.jobs[TRIPWIRE.jobId].if)).toBe(
      `${PR_ONLY} && (${GATE})`,
    );
  });
});

describe("concurrency", () => {
  for (const { file, workflow } of pushWorkflows) {
    for (const { where, group } of concurrencyBlocks(workflow)) {
      it(`${file} (${where}) cannot cancel a push run`, () => {
        // On a push the PR-keyed expression is the run id; whatever else the
        // group names must name no ref, or two merges would share a group and
        // the later one would cancel (or replace) the earlier one's run.
        const onPush = group.replace(PR_KEYED, "github.run_id");
        expect(onPush).toContain("github.run_id");
        expect(onPush).not.toMatch(
          /github\.(ref|ref_name|head_ref|base_ref|sha)\b/,
        );
      });
    }
  }

  for (const { file, workflow } of pullRequestWorkflows.filter(
    ({ workflow: w }) => w.concurrency !== undefined,
  )) {
    it(`${file} lets a newer PR push supersede the older one`, () => {
      expect(String(workflow.concurrency.group)).toContain(
        `\${{ ${PR_KEYED} }}`,
      );
      expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    });
  }
});

describe("workflows that can be run on a branch", () => {
  for (const file of DISPATCHABLE) {
    it(`${file} has workflow_dispatch`, () => {
      const { workflow } = workflows.find((entry) => entry.file === file);
      expect(triggers(workflow)).toHaveProperty("workflow_dispatch");
    });
  }
});

// A push run tests only what its range changed. The range starts at the last
// push this workflow PASSED on, so a red merge is not forgotten by the next
// one. A job that narrows a push run reads `github.event.before` or sets
// `NX_BASE`; each must get its base from the script, on a push, and nowhere
// else.
describe("a job that narrows a push run compares against the last green push", () => {
  const narrowing = [];
  for (const { file, workflow } of workflows) {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      const text = JSON.stringify(job);
      if (text.includes("github.event.before") || text.includes("NX_BASE")) {
        narrowing.push({ file, jobId, job });
      }
    }
  }

  it("finds the seven jobs that narrow today", () => {
    expect(
      narrowing.map(({ file, jobId }) => `${file}/${jobId}`).sort(),
    ).toEqual([
      "browser-regressions.yml/changes",
      "formal-regressions.yml/changes",
      "gradle-wrapper.yml/changes",
      "pre-commit.yml/workspace-checks",
      "protocol-compat.yml/changes",
      "real-supervisor.yml/changes",
      "test.yml/macos-packaging-changes",
    ]);
  });

  for (const { file, jobId, job } of narrowing) {
    describe(`${file} / ${jobId}`, () => {
      const steps = job.steps;
      const finder = steps.find((step) =>
        String(step.run ?? "").includes(LAST_GREEN),
      );

      it("runs the script in a step that only runs on a push", () => {
        expect(finder).toBeDefined();
        expect(normalize(finder.if)).toBe("github.event_name == 'push'");
      });

      it("hands it this workflow, the branch and the previous push, and nothing is interpolated into the run body", () => {
        expect(String(finder.run)).not.toContain("${{");
        expect(String(finder.run)).toContain(
          `${LAST_GREEN} ${file} "$BRANCH" "$BEFORE"`,
        );
        expect(finder.env.BEFORE).toBe("${{ github.event.before }}");
        expect(finder.env.BRANCH).toBe("${{ github.ref_name }}");
        expect(finder.env.GH_TOKEN).toBe("${{ github.token }}");
      });

      it("reads github.event.before in that step's env and nowhere else", () => {
        const others = JSON.stringify({
          ...job,
          steps: steps.filter((step) => step !== finder),
        });
        expect(others).not.toContain("github.event.before");
        expect(JSON.stringify(job.env ?? {})).not.toContain(
          "github.event.before",
        );
      });

      it("may list the workflow's runs, and checks out the history it tests ancestry against", () => {
        expect(job.permissions).toEqual({ contents: "read", actions: "read" });
        const checkout = steps.find((step) =>
          String(step.uses ?? "").startsWith("actions/checkout@"),
        );
        expect(checkout.with["fetch-depth"]).toBe(0);
        expect(steps.indexOf(finder)).toBeGreaterThan(steps.indexOf(checkout));
      });
    });
  }

  it("pre-commit.yml: the answer becomes NX_BASE through $GITHUB_ENV, and the job env names only the PR base", () => {
    const { workflow } = workflows.find(
      ({ file }) => file === "pre-commit.yml",
    );
    const job = workflow.jobs["workspace-checks"];
    expect(job.env.NX_BASE).toBe("${{ github.event.pull_request.base.sha }}");
    const finder = job.steps.find((step) =>
      String(step.run ?? "").includes(LAST_GREEN),
    );
    expect(finder.run).toContain('echo "NX_BASE=${base}" >> "$GITHUB_ENV"');
  });

  // The script answers the all-zero SHA when it has no base, and `nx affected`
  // cannot take that as `--base`. The step maps any answer that is not a commit
  // to the repository's first commit, which makes every project affected, and
  // does it BEFORE the answer is written to NX_BASE. Asserted on the parsed
  // step's `run` text, in order, so a reformat of the YAML cannot hide it.
  it("pre-commit.yml: an answer that is not a commit becomes the first commit, before NX_BASE is written", () => {
    const { workflow } = workflows.find(
      ({ file }) => file === "pre-commit.yml",
    );
    const finder = workflow.jobs["workspace-checks"].steps.find((step) =>
      String(step.run ?? "").includes(LAST_GREEN),
    );
    const run = String(finder.run);
    const verify = run.indexOf("git rev-parse --verify");
    const firstCommit = run.indexOf("git rev-list --max-parents=0 HEAD");
    const write = run.indexOf("NX_BASE=");
    expect(verify).toBeGreaterThan(-1);
    expect(firstCommit).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(run.indexOf(LAST_GREEN)).toBeLessThan(verify);
    expect(verify).toBeLessThan(firstCommit);
    expect(firstCommit).toBeLessThan(write);
    // The test is on the commit the answer names, and the fallback replaces
    // the answer itself.
    expect(run).toMatch(
      /if ! git rev-parse --verify --quiet "\$\{base\}\^\{commit\}" >\/dev\/null; then\s+base="\$\(git rev-list --max-parents=0 HEAD \| tail -n 1\)"\s+fi/,
    );
  });

  // Nx writes to `~/.nx` unless told otherwise, and a cache saved from a job that
  // failed on the dirty tree `--fix` leaves would pass that job on its re-run.
  it("pre-commit.yml: only a passing push saves the directory Nx writes to", () => {
    const { workflow } = workflows.find(
      ({ file }) => file === "pre-commit.yml",
    );
    const job = workflow.jobs["workspace-checks"];
    const restore = job.steps.find((step) => step.id === "nx-cache");
    const save = job.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/cache/save@"),
    );
    // A push runs only on `main`, so nothing a pull request or a dispatched
    // branch run builds becomes an entry `main` restores.
    expect(save.if).toBe("github.event_name == 'push'");
    expect(triggers(workflow).push).toEqual({ branches: ["main"] });
    expect(restore.with.path).toBe("${{ matrix.cache }}");
    expect(save.with.path).toBe(restore.with.path);
    const lanes = Object.fromEntries(
      job.strategy.matrix.include.map(({ lane, cache }) => [
        lane,
        cache.trim().split("\n"),
      ]),
    );
    expect(lanes.lint).toContain(job.env.NX_CACHE_DIRECTORY);
    expect(lanes.compile).toContain(job.env.NX_CACHE_DIRECTORY);
    expect(lanes.build).toEqual([".nx/react-compiler-cache"]);
  });

  it("browser-regressions.yml: the filter reads the answer from the step's output", () => {
    const { workflow } = workflows.find(
      ({ file }) => file === "browser-regressions.yml",
    );
    const job = workflow.jobs.changes;
    const finder = job.steps.find((step) =>
      String(step.run ?? "").includes(LAST_GREEN),
    );
    expect(finder.id).toBe("base");
    expect(finder.run).toContain('echo "sha=${base}" >> "$GITHUB_OUTPUT"');
    const filter = job.steps.find((step) => step.id === "filter");
    expect(filter.env.PUSH_BASE).toBe("${{ steps.base.outputs.sha }}");
  });
});

// A push to `main` must start a run of EVERY workflow that watches it, whatever
// the change: `scripts/ci-push-checks-green.sh` in the internal repository
// judges a pushed commit by each workflow's latest push run and refuses a commit
// whose own push started none, and Scorecard's Binary-Artifacts check exempts a
// committed `gradle-wrapper.jar` only while the latest commit has a successful
// run of `gradle-wrapper.yml`. A `paths:` filter on the trigger starts no run at
// all, so narrowing is only ever a job-level skip inside a run that happened.
describe("no workflow filters its own push trigger by path", () => {
  for (const { file, workflow } of pushWorkflows) {
    it(`${file} starts a run on every push to main`, () => {
      const push = triggers(workflow).push;
      expect(push?.paths).toBeUndefined();
      expect(push?.["paths-ignore"]).toBeUndefined();
    });
  }
});

// A CI decision that reads a path list from `git diff` reads it NUL-delimited,
// with rename detection off. `--name-only` alone applies git's display quoting
// (`core.quotePath`) to a path that is not plain ASCII: the record becomes
// `"protocol/src/caf\303\251.ts"`, quotes included, every anchored match fails
// on it, and the suite is skipped on a change to a file it reads. Rename
// detection prints only the new path, so a file moved OUT of a listed path
// escapes the same way.
describe("every path list a CI decision reads from git diff", () => {
  // A comment may name the command it explains, so only real statements count.
  const PATH_LIST_DIFF = /git diff[^|)]*--name-only/;
  const isStatement = (line) =>
    PATH_LIST_DIFF.test(line) && !line.trim().startsWith("#");
  const sites = [];
  for (const { file, workflow } of workflows) {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        for (const line of String(step.run ?? "").split("\n")) {
          if (isStatement(line)) {
            sites.push({ where: `${file}/${jobId}`, line: line.trim() });
          }
        }
      }
    }
  }
  for (const name of readdirSync(join(REPO_ROOT, "scripts"))) {
    if (!name.endsWith(".sh")) continue;
    for (const line of readFileSync(
      join(REPO_ROOT, "scripts", name),
      "utf8",
    ).split("\n")) {
      if (isStatement(line)) {
        sites.push({ where: `scripts/${name}`, line: line.trim() });
      }
    }
  }

  it("finds the five that decide a workflow's scope today", () => {
    expect(sites.map(({ where }) => where).sort()).toEqual([
      "browser-regressions.yml/changes",
      "formal-regressions.yml/changes",
      "protocol-compat.yml/guarded-files-tripwire",
      "scripts/ci-push-scope.sh",
      "test.yml/macos-packaging-changes",
    ]);
  });

  for (const { where, line } of sites) {
    it(`${where} reads it NUL-delimited, with renames off`, () => {
      expect(line).toContain("git diff -z ");
      expect(line).toContain("--no-renames");
    });
  }
});

// What keeps a scoped workflow a gate: its own relevance list in
// `ci-push-scope.sh`, and a gated job that runs when the decision could not be
// made. Without `!cancelled()` GitHub skips a job whose dependency failed, and
// a skipped job satisfies a required check - so a failed `changes` job would
// pass the gate instead of running it. The answer is tested with `!= 'false'`
// rather than `== 'true'`, so an output that is missing or malformed runs the
// job too; only an explicit `false` skips it.
describe("a workflow whose push run decides inside itself", () => {
  it("covers the three workflows the design names", () => {
    expect(SCOPED.map(({ file }) => file).sort()).toEqual([
      "gradle-wrapper.yml",
      "protocol-compat.yml",
      "real-supervisor.yml",
    ]);
  });

  for (const { file, changes, gated } of SCOPED) {
    describe(file, () => {
      const { workflow } = workflows.find((entry) => entry.file === file);

      it(`${changes} asks ci-push-scope.sh about this workflow, and publishes the answer`, () => {
        const job = workflow.jobs[changes];
        const filter = job.steps.find((step) => step.id === "filter");
        expect(String(filter.run)).not.toContain("${{");
        expect(String(filter.run)).toContain(
          `${PUSH_SCOPE} ${file} "$EVENT" "$PR_BASE" "$PUSH_BASE"`,
        );
        expect(filter.env.EVENT).toBe("${{ github.event_name }}");
        expect(filter.env.PR_BASE).toBe(
          "${{ github.event.pull_request.base.sha }}",
        );
        expect(filter.env.PUSH_BASE).toBe("${{ steps.base.outputs.sha }}");
        expect(job.outputs.run).toBe(`\${{ steps.${filter.id}.outputs.run }}`);
      });

      for (const jobId of gated) {
        it(`${jobId} runs when the change reaches it, and when the decision failed`, () => {
          const condition = normalize(workflow.jobs[jobId].if);
          expect(workflow.jobs[jobId].needs).toBe(changes);
          expect(condition).toContain("!cancelled()");
          expect(condition).toContain(
            `(needs.${changes}.result != 'success' || needs.${changes}.outputs.run != 'false')`,
          );
        });
      }
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

  it("watches every workflow that runs on a push to main, whether or not it also runs on pull_request", () => {
    const expected = pushWorkflows
      .filter(({ file }) => file !== "trunk-red.yml")
      .map(({ workflow: w }) => w.name)
      .sort();
    expect(expected).toContain("Scorecard supply-chain security");
    expect([...workflow.on.workflow_run.workflows].sort()).toEqual(expected);
    expect(workflow.on.workflow_run.branches).toEqual(["main"]);
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
  });

  // The owner ruled that no test may need a retry: a test passes on its first
  // attempt (3 Nov 2026), so a failure is red on attempt 1 and is fixed
  // forward. Re-running a run needs `actions: write`; the one job holds no
  // scope, so it cannot re-run anything.
  it("holds no permission at the top or on its one job, so it re-runs nothing", () => {
    expect(workflow.permissions).toEqual({});
    const jobs = Object.values(workflow.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].permissions).toEqual({});
    expect(jobs[0].steps).toHaveLength(1);
    expect(String(jobs[0].steps[0].run)).not.toMatch(/\bgh\b|rerun/);
  });

  it("acts only on a first-attempt push run", () => {
    const condition = normalize(Object.values(workflow.jobs)[0].if);
    expect(condition).toContain("github.event.workflow_run.event == 'push'");
    // A later attempt is a person's re-run of a run whose attempt 1 was
    // already reported.
    expect(condition).toContain("github.event.workflow_run.run_attempt == 1");
  });

  // The job answers every conclusion except the three that are not a break:
  // success, skipped and a person's cancellation. The release gates refuse
  // every other conclusion (neutral, action_required, stale too), so the alert
  // covers the same set. Read from the parsed `if`: it names exactly those
  // three with `!=`, and holds no `conclusion ==` comparison at all, so
  // nobody can bring a list of bad conclusions back.
  it("answers every conclusion except success, skipped and cancelled, with no conclusion == list", () => {
    const condition = normalize(Object.values(workflow.jobs)[0].if);
    const excluded = [
      ...condition.matchAll(
        /github\.event\.workflow_run\.conclusion != '([a-z_]+)'/g,
      ),
    ]
      .map((match) => match[1])
      .sort();
    expect(excluded).toEqual(["cancelled", "skipped", "success"]);
    expect(condition).not.toMatch(/workflow_run\.conclusion\s*==/);
    expect(condition).not.toContain("failure");
    expect(condition).not.toContain("timed_out");
  });

  it("interpolates no expression into a run body", () => {
    for (const step of Object.values(workflow.jobs)[0].steps) {
      expect(String(step.run ?? "")).not.toContain("${{");
    }
  });

  // The owner decided a red `main` is reported by FAILING, not by a message:
  // the failed `trunk-red` run is the one signal an alert has to watch. So
  // nothing here may carry a webhook or a secret, and every run of the job
  // ends non-zero. Asserted on the parsed step, so a reformat of the YAML
  // cannot hide a path that went quiet.
  describe("reports a red main by failing the job and sends nothing anywhere", () => {
    const step = Object.values(workflow.jobs)[0].steps[0];
    const env = step?.env ?? {};
    const run = String(step?.run ?? "");

    it("holds no Slack or webhook env key and reads no secret, in the step or anywhere in the workflow", () => {
      expect(Object.keys(env).length).toBeGreaterThan(0);
      expect(
        Object.keys(env).filter((key) => /SLACK|WEBHOOK/i.test(key)),
      ).toEqual([]);
      expect(
        Object.values(env).filter((value) =>
          String(value).includes("secrets."),
        ),
      ).toEqual([]);
      expect(JSON.stringify(workflow)).not.toContain("secrets.");
    });

    it("posts nothing: no curl, no Slack and no webhook in the run text", () => {
      expect(run.length).toBeGreaterThan(0);
      expect(run).not.toMatch(/\bcurl\b/i);
      expect(run).not.toMatch(/slack|webhook/i);
    });

    it("writes its line to the job summary and an error annotation, then exits 1 on every path", () => {
      const lines = run
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(run).toContain('>> "$GITHUB_STEP_SUMMARY"');
      expect(run).toContain("::error::");
      expect(lines.at(-1)).toBe("exit 1");
      expect(run).not.toMatch(/exit 0/);
    });
  });
});

// The DCO check on a maintainer commit rests on this. A maintainer pull request
// into `main` runs no DCO job in CI (the gate above), so the `commit-msg` hook
// is the only check that a commit is signed off. CONTRIBUTING.md documents a
// bare `pre-commit install`, which installs only the hook types named by
// `default_install_hook_types`; without `commit-msg` in that list the DCO hook
// never runs.
describe(".pre-commit-config.yaml", () => {
  const config = parse(
    readFileSync(join(REPO_ROOT, ".pre-commit-config.yaml"), "utf8"),
  );

  it("installs both pre-commit and commit-msg on a bare `pre-commit install`", () => {
    expect(Array.isArray(config.default_install_hook_types)).toBe(true);
    expect(config.default_install_hook_types).toContain("pre-commit");
    expect(config.default_install_hook_types).toContain("commit-msg");
  });
});
