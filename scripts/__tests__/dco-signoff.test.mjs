// Runs the REAL sign-off check of .github/workflows/dco.yml against tiny
// temporary Git repositories. The workflow is PARSED (never pattern-matched),
// the step named `Check sign-off on all PR commits` is located, and its
// complete `run` body is executed with bash from inside a fixture repository,
// with BASE_SHA/HEAD_SHA bound the way the workflow binds them from the pull
// request. DCO_WORKFLOW_PATH (test-only) points the reader at another copy of
// the workflow so the same test can exercise a different revision of it.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const WORKFLOW_PATH =
  process.env.DCO_WORKFLOW_PATH ??
  join(REPO_ROOT, ".github", "workflows", "dco.yml");
const STEP_NAME = "Check sign-off on all PR commits";

const DEPENDABOT_AUTHOR = {
  name: "dependabot[bot]",
  email: "49699333+dependabot[bot]@users.noreply.github.com",
};
const DEPENDABOT_NOREPLY =
  "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>";
const DEPENDABOT_SUPPORT = "dependabot[bot] <support@github.com>";
const HUMAN_AUTHOR = {
  name: "Fixture Human",
  email: "fixture.human@example.test",
};
const HUMAN_IDENTITY = "Fixture Human <fixture.human@example.test>";
const COMMITTER = {
  name: "Fixture Committer",
  email: "fixture.committer@example.test",
};

const loadRunBody = () => {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));
  const steps = workflow.jobs.dco.steps.filter(
    (step) => step.name === STEP_NAME,
  );
  expect(steps).toHaveLength(1);
  expect(typeof steps[0].run).toBe("string");
  return steps[0].run;
};

let root;
let repo;
let gitEnv;

// No user/system config, no templates, no hooks and no signing, so nothing
// outside the fixture can make git fail before the check runs.
const git = (args, { input, env } = {}) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: repo,
      env: { ...gitEnv, ...env },
      input,
      encoding: "utf8",
    },
  ).trim();

const authorEnv = (author) => ({
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
});

const commit = (author, subject, signoff) => {
  const message =
    signoff === null
      ? `${subject}\n`
      : `${subject}\n\nSigned-off-by: ${signoff}\n`;
  git(["commit", "--allow-empty", "-F", "-"], {
    input: message,
    env: authorEnv(author),
  });
  return git(["rev-parse", "HEAD"]);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dco-signoff-"));
  repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  gitEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
  };
  git(["init", "--quiet", "--template=", "--initial-branch=main"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseCommit = () => commit(HUMAN_AUTHOR, "base", HUMAN_IDENTITY);

// Executes the workflow's real run body the way a Linux runner step does
// (`bash -e -o pipefail`), from the fixture repository.
const runCheck = (base, head) => {
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", loadRunBody()],
    {
      cwd: repo,
      env: { ...gitEnv, BASE_SHA: base, HEAD_SHA: head },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  return result;
};

// The range under check must be exactly the commits the case built.
const expectRange = (base, head, expected) => {
  const range = git(["rev-list", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  expect([...range].sort()).toEqual([...expected].sort());
};

const expectRejected = (result, offenders, author) => {
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    `Commits missing a matching 'Signed-off-by: ${author}' trailer:`,
  );
  expect(result.stdout).toContain(
    "Each commit must be signed off by its author per the DCO.",
  );
  const listed = result.stdout
    .split("\n")
    .filter((line) => /^ {2}[0-9a-f]{40} /.test(line));
  expect(listed.map((line) => line.trim().split(" ")[0]).sort()).toEqual(
    [...offenders].sort(),
  );
};

describe("DCO sign-off check", () => {
  it("accepts the exact Dependabot author signed off with the support identity", () => {
    const base = baseCommit();
    const head = commit(DEPENDABOT_AUTHOR, "bump dep", DEPENDABOT_SUPPORT);
    expectRange(base, head, [head]);

    const result = runCheck(base, head);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All PR commits are signed off.");
  });

  it("still accepts the Dependabot author signed off with its own noreply identity", () => {
    const base = baseCommit();
    const head = commit(DEPENDABOT_AUTHOR, "bump dep", DEPENDABOT_NOREPLY);
    expectRange(base, head, [head]);

    expect(runCheck(base, head).status).toBe(0);
  });

  it("rejects the exact Dependabot author signed off by a different identity", () => {
    const base = baseCommit();
    const head = commit(
      DEPENDABOT_AUTHOR,
      "bump dep",
      "Someone Else <someone.else@example.test>",
    );
    expectRange(base, head, [head]);

    expectRejected(runCheck(base, head), [head], DEPENDABOT_NOREPLY);
  });

  it("rejects an ordinary author carrying only the Dependabot support sign-off", () => {
    const base = baseCommit();
    const head = commit(HUMAN_AUTHOR, "human change", DEPENDABOT_SUPPORT);
    expectRange(base, head, [head]);

    expectRejected(runCheck(base, head), [head], HUMAN_IDENTITY);
  });

  it("accepts an ordinary author signed off with their own identity", () => {
    const base = baseCommit();
    const head = commit(HUMAN_AUTHOR, "human change", HUMAN_IDENTITY);
    expectRange(base, head, [head]);

    expect(runCheck(base, head).status).toBe(0);
  });

  it("rejects an unsigned Dependabot commit", () => {
    const base = baseCommit();
    const head = commit(DEPENDABOT_AUTHOR, "bump dep", null);
    expectRange(base, head, [head]);

    expectRejected(runCheck(base, head), [head], DEPENDABOT_NOREPLY);
  });

  it("exempts an unsigned merge while checking the commits it brings in", () => {
    const base = baseCommit();
    git(["checkout", "--quiet", "-b", "side"]);
    const side = commit(HUMAN_AUTHOR, "side change", HUMAN_IDENTITY);
    git(["checkout", "--quiet", "main"]);
    const mainParent = commit(
      DEPENDABOT_AUTHOR,
      "main change",
      DEPENDABOT_NOREPLY,
    );
    git(["merge", "--quiet", "--no-ff", "-m", "merge side", "side"], {
      env: authorEnv(HUMAN_AUTHOR),
    });
    const merge = git(["rev-parse", "HEAD"]);
    expect(
      git(["rev-list", "--parents", "-n1", merge]).split(" "),
    ).toHaveLength(3);
    expect(
      git(["show", "-s", "--format=%(trailers:key=Signed-off-by)", merge]),
    ).toBe("");
    expectRange(base, merge, [side, mainParent, merge]);

    const result = runCheck(base, merge);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All PR commits are signed off.");
  });

  describe("rejects near-miss Dependabot sign-offs", () => {
    const cases = [
      {
        label: "a lookalike author with another noreply account id",
        author: {
          name: "dependabot[bot]",
          email: "12345+dependabot[bot]@users.noreply.github.com",
        },
        identity:
          "dependabot[bot] <12345+dependabot[bot]@users.noreply.github.com>",
        signoff: DEPENDABOT_SUPPORT,
      },
      {
        label: "a trailer that only contains the support identity",
        author: DEPENDABOT_AUTHOR,
        identity: DEPENDABOT_NOREPLY,
        signoff: `Not ${DEPENDABOT_SUPPORT}`,
      },
    ];

    for (const { label, author, identity, signoff } of cases) {
      it(label, () => {
        const base = baseCommit();
        const head = commit(author, "bump dep", signoff);
        expectRange(base, head, [head]);

        expectRejected(runCheck(base, head), [head], identity);
      });
    }
  });
});
