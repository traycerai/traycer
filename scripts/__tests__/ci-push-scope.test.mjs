// Tests for scripts/ci-push-scope.sh: whether a change reaches what one
// workflow tests. The REAL script runs against REAL commits in a throwaway git
// repository, so the range it builds and the diff it reads are the ones a
// runner gets, not a stub's idea of them.
//
// Every case states a rule rather than a path list: rules 1 to 3 of the
// script's header (a workflow file runs its own workflow, the root files run
// everything, a failed detection runs everything), and for each workflow one
// change it must run on and one it must skip. Rule 4 is not here and cannot be:
// "a skipped suite inherits the last green result" is a property of the base the
// `changes` job hands this script, which is `ci-last-green-sha.sh`'s answer, and
// `ci-last-green-sha.test.mjs` is where that is pinned.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ci-push-scope.sh");

const WORKFLOWS = [
  "protocol-compat.yml",
  "real-supervisor.yml",
  "gradle-wrapper.yml",
];

// The tree every case starts from. Each path a case moves or deletes has to
// exist here first.
const BASE_TREE = [
  "README.md",
  "package.json",
  "bun.lock",
  "nx.json",
  "protocol/src/index.ts",
  "protocol/README.md",
  "clients/shared/src/index.ts",
  "clients/traycer-cli/src/index.ts",
  "clients/gui-app/src/main.tsx",
  "clients/mobile/android/gradlew",
  "clients/mobile/android/build.gradle",
  "clients/mobile/android/gradle/wrapper/gradle-wrapper.jar",
  ".github/workflows/protocol-compat.yml",
  ".github/workflows/real-supervisor.yml",
  ".github/workflows/gradle-wrapper.yml",
];

let sandbox;
let repo;
let base;

const git = (...args) => {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (path, contents) => {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
};

const script = (...args) =>
  spawnSync("bash", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });

// Commits `paths` on a fresh branch at the base commit and asks the script
// whether that push reaches `workflow`. `edit` runs in the repository instead
// of writing files, for a move or a delete.
const pushTouching = (workflow, paths, edit = undefined) => {
  git("checkout", "-q", "-B", "case", base);
  if (edit) edit();
  for (const path of paths) write(path, `changed ${Math.random()}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "case");
  const result = script(workflow, "push", "", base);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ci-push-scope-"));
  repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  for (const path of BASE_TREE) write(path, "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("a change to a workflow file runs that workflow, and only that one", () => {
  for (const workflow of WORKFLOWS) {
    it(`${workflow} runs on a change to its own file`, () => {
      expect(pushTouching(workflow, [`.github/workflows/${workflow}`])).toBe(
        "true",
      );
    });

    for (const other of WORKFLOWS.filter((name) => name !== workflow)) {
      it(`${workflow} skips a change to ${other}`, () => {
        expect(pushTouching(workflow, [`.github/workflows/${other}`])).toBe(
          "false",
        );
      });
    }
  }
});

describe("a change to a root file every project's checks read runs everything", () => {
  for (const root of ["package.json", "bun.lock", "nx.json", "tsconfig.json"]) {
    for (const workflow of WORKFLOWS) {
      it(`${workflow} runs on a change to ${root}`, () => {
        expect(pushTouching(workflow, [root])).toBe("true");
      });
    }
  }
});

describe("a failure of change detection runs everything", () => {
  it("runs when the base is the all-zero SHA ci-last-green-sha.sh prints", () => {
    const zeros = "0000000000000000000000000000000000000000";
    for (const workflow of WORKFLOWS) {
      const result = script(workflow, "push", "", zeros);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("true");
      expect(result.stderr).toContain("No earlier commit to diff against");
    }
  });

  it("runs when there is no base at all", () => {
    for (const workflow of WORKFLOWS) {
      expect(script(workflow, "push", "", "").stdout.trim()).toBe("true");
    }
  });

  it("runs on an event that is neither a push nor a pull request", () => {
    for (const workflow of WORKFLOWS) {
      const result = script(workflow, "workflow_dispatch", "", "");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("true");
      expect(result.stderr).toContain("always runs");
    }
  });
});

describe("protocol-compat.yml reaches the protocol surface and the client transports", () => {
  it("runs on a protocol change", () => {
    expect(pushTouching("protocol-compat.yml", ["protocol/src/index.ts"])).toBe(
      "true",
    );
  });

  it("runs on a change to @traycer-clients/shared, whose transports the last step drives", () => {
    expect(
      pushTouching("protocol-compat.yml", ["clients/shared/src/index.ts"]),
    ).toBe("true");
  });

  it("skips a change confined to another client", () => {
    expect(
      pushTouching("protocol-compat.yml", [
        "clients/gui-app/src/main.tsx",
        "clients/traycer-cli/src/index.ts",
      ]),
    ).toBe("false");
  });

  it("skips a Markdown change inside the protocol package", () => {
    expect(pushTouching("protocol-compat.yml", ["protocol/README.md"])).toBe(
      "false",
    );
  });
});

describe("real-supervisor.yml reaches the CLI's launchd rows", () => {
  it("runs on a CLI change", () => {
    expect(
      pushTouching("real-supervisor.yml", ["clients/traycer-cli/src/index.ts"]),
    ).toBe("true");
  });

  it("runs on a change to a package the rows import", () => {
    expect(
      pushTouching("real-supervisor.yml", ["clients/shared/src/index.ts"]),
    ).toBe("true");
    expect(pushTouching("real-supervisor.yml", ["protocol/src/index.ts"])).toBe(
      "true",
    );
  });

  it("skips a change confined to the GUI", () => {
    expect(
      pushTouching("real-supervisor.yml", ["clients/gui-app/src/main.tsx"]),
    ).toBe("false");
  });
});

describe("gradle-wrapper.yml reaches the wrapper files the action validates", () => {
  it("runs on a change to a committed wrapper jar", () => {
    expect(
      pushTouching("gradle-wrapper.yml", [
        "clients/mobile/android/gradle/wrapper/gradle-wrapper.jar",
      ]),
    ).toBe("true");
  });

  it("runs on a change to the wrapper script", () => {
    expect(
      pushTouching("gradle-wrapper.yml", ["clients/mobile/android/gradlew"]),
    ).toBe("true");
  });

  // The action finds the jars itself, anywhere in the tree, so a wrapper added
  // by a project that does not exist yet has to be validated too. A list keyed
  // on today's mobile path would miss it.
  it("runs on a wrapper added under a path no project holds today", () => {
    expect(
      pushTouching("gradle-wrapper.yml", [
        "tools/android-sample/gradlew.bat",
        "tools/android-sample/gradle/wrapper/gradle-wrapper.jar",
      ]),
    ).toBe("true");
  });

  // The pinned action selects a jar by
  // `unhomoglyph(name).endsWith("gradle-wrapper.jar")`, and its own fixtures
  // include a jar whose `e` is Cyrillic. A test keyed on the literal name would
  // skip the validation of a jar the action finds and checksums.
  it("runs on a jar whose name hides a lookalike character", () => {
    expect(
      pushTouching("gradle-wrapper.yml", ["tools/gradlе-wrapper.jar"]),
    ).toBe("true");
  });

  it("runs on any path that is not plain ASCII, because a lookalike can hide every token", () => {
    expect(pushTouching("gradle-wrapper.yml", ["tools/café/w.bin"])).toBe(
      "true",
    );
  });

  it("skips a change confined to the GUI", () => {
    expect(
      pushTouching("gradle-wrapper.yml", ["clients/gui-app/src/main.tsx"]),
    ).toBe("false");
  });

  // A build script matches on its name, not because the action reads it: the
  // name test is what keeps a renamed or lookalike wrapper in scope, and the
  // job is 19 s.
  it("runs on a build script, which its name test cannot tell from a wrapper", () => {
    expect(
      pushTouching("gradle-wrapper.yml", [
        "clients/mobile/android/build.gradle",
      ]),
    ).toBe("true");
  });
});

// `git diff --name-only` applies `core.quotePath` to a path that is not plain
// ASCII: the record becomes `"protocol/src/caf\303\251.ts"`, quotes included,
// and every anchored test fails on it — a suite skipped on a change to a file
// it reads. The diff is read NUL-delimited instead, which also carries a path
// holding a quote or a newline intact.
describe("a path git would quote in its display output", () => {
  it("still reaches the package it is in", () => {
    expect(pushTouching("protocol-compat.yml", ["protocol/src/café.ts"])).toBe(
      "true",
    );
    expect(
      pushTouching("real-supervisor.yml", ["clients/shared/src/café.ts"]),
    ).toBe("true");
  });

  it("still reaches it when the name holds a quote or a newline", () => {
    expect(
      pushTouching("protocol-compat.yml", ['protocol/src/say "hi".ts']),
    ).toBe("true");
    expect(
      pushTouching("protocol-compat.yml", ["protocol/src/two\nlines.ts"]),
    ).toBe("true");
  });

  it("still skips when it is in no package the workflow reads", () => {
    expect(
      pushTouching("protocol-compat.yml", ["clients/gui-app/src/café.tsx"]),
    ).toBe("false");
  });
});

// `--no-renames`, so a file moved OUT of a listed path is still reported at its
// old path and still counts. Rename detection would print the new path alone,
// and a move out of `protocol/` would skip the gate that guards it.
it("counts a file moved out of a listed package, at its old path", () => {
  expect(
    pushTouching("protocol-compat.yml", [], () => {
      mkdirSync(join(repo, "docs"), { recursive: true });
      git("mv", "protocol/src/index.ts", "docs/index.ts");
    }),
  ).toBe("true");
});

// A pull request is its own diff against the merge base, not against the base
// branch's tip: a commit the base branch gained after the branch forked belongs
// to that branch's own run, and counting it here would run every suite on every
// pull request opened behind a protocol change.
it("compares a pull request against the merge base, not the base branch's tip", () => {
  git("checkout", "-q", "-B", "pr", base);
  write("clients/gui-app/src/main.tsx", "pr change\n");
  git("add", "-A");
  git("commit", "-q", "-m", "pr");
  const prHead = git("rev-parse", "HEAD");

  git("checkout", "-q", "-B", "main-moved", base);
  write("protocol/src/index.ts", "landed after the fork\n");
  git("add", "-A");
  git("commit", "-q", "-m", "landed");
  const movedBase = git("rev-parse", "HEAD");

  git("checkout", "-q", prHead);
  expect(
    script("protocol-compat.yml", "pull_request", movedBase, "").stdout.trim(),
  ).toBe("false");
});

// ONE `[[ ]]` test of `$1` against a pattern, and nothing else on the line.
//
// The whole form is whitelisted, not a list of banned openers, because the
// banned list kept being one shape short: first `$(cmd)`; then
// `[[ a ]] || cmd || [[ b ]]`, which ends in `]]` like a single test; then
// `[[ -e <(cmd) ]]`, where process substitution runs a command with no `$(` in
// sight; then `[[ $1 -eq 0 ]]`, where an arithmetic comparison evaluates its
// operand recursively, so the path `a[$(cmd)]` runs `cmd` with nothing
// suspicious in the source line at all. Each of those was a real execution
// under bash 3.2.
//
// So the operator must be `=~` or `==` - a pattern match, which evaluates
// nothing - the left side must be `$1` or `! $1`, and the pattern itself may
// hold no space, which is what stops a second test and a command being written
// after the first. `$(` is rejected on top of that, because `$` and `(` both
// belong to a pattern.
const BRACKET_TEST = (line) => {
  if (!/^\[\[ .* \]\]$/.test(line)) return false;
  const inside = line.slice("[[ ".length, -" ]]".length);
  return (
    /^(! )?\$1 (=~|==) [A-Za-z0-9^|()/.,_+*[\]$-]+$/.test(inside) &&
    !inside.includes("$(")
  );
};

// Every per-workflow `reaches` is called as the condition of an `if`, and bash
// suspends `errexit` for the whole body of a function called there. A command
// that failed inside one would not abort the script: it would leave its
// variable empty, the tests after it would read that empty value, and the
// answer could be `false` on a path the workflow reads - which is rule 3
// inverted. So a `reaches` may only match patterns.
it("decides every path by pattern alone, with nothing in it that can fail", () => {
  const lines = readFileSync(SCRIPT, "utf8").split("\n");
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*reaches\(\) \{$/.test(lines[index])) continue;
    const indent = /^\s*/.exec(lines[index])[0];
    const end = lines.findIndex(
      (line, at) => at > index && line === `${indent}}`,
    );
    expect(end).toBeGreaterThan(index);
    bodies.push(lines.slice(index + 1, end).join("\n"));
  }

  // The forms a pattern test is made of, and nothing else. A command
  // substitution is not the only hazard: a bare external command used as the
  // condition returns 127 when it is missing, which reads as `false` too.
  const ALLOWED = [
    /^case "\$1" in$/,
    /^esac$/,
    /^return [01]$/,
    /^;;$/,
    BRACKET_TEST,
    // A `case` pattern - globs, bracket expressions and alternation only -
    // alone, or with its whole body on the same line.
    /^[A-Za-z0-9*.[\]/| -]+\)$/,
    /^[A-Za-z0-9*.[\]/| -]+\) return [01] ;;$/,
  ];

  expect(bodies).toHaveLength(WORKFLOWS.length);
  for (const body of bodies) {
    for (const line of body.split("\n").map((text) => text.trim())) {
      if (line.length === 0) continue;
      expect(
        ALLOWED.some((form) =>
          typeof form === "function" ? form(line) : form.test(line),
        ),
        `${line} is not a pattern test`,
      ).toBe(true);
    }
  }
});

// The guard above is only worth having if it rejects the shapes that would run
// something. Each of these was found to execute under bash 3.2 while passing an
// earlier version of it.
it("rejects every bracket-test line that would run a command", () => {
  for (const line of [
    "[[ $(printf '%s' \"$1\") =~ ^protocol/ ]]",
    "[[ `false` ]]",
    "[[ $1 == *.md ]] || /usr/bin/false || [[ $1 =~ ^protocol/ ]]",
    "[[ -e <(printf executed >&2) ]]",
    "[[ -e >(false) ]]",
    "[[ $1 =~ ^protocol/ ]] && /usr/bin/true",
    "[[ -n ${x:=$(false)} ]]",
    // An arithmetic comparison evaluates its operand recursively, so the path
    // `a[$(cmd)]` runs `cmd` - with nothing suspicious in this line at all.
    "[[ $1 -eq 0 ]]",
    "[[ $1 =~ $(printf '^a') ]]",
  ]) {
    expect(BRACKET_TEST(line), `${line} would run something`).toBe(false);
  }
});

it("accepts a plain pattern test of the path", () => {
  for (const line of [
    "[[ $1 =~ ^(protocol|clients/shared)/ ]]",
    "[[ ! $1 =~ ^[A-Za-z0-9._/+-]+$ ]]",
  ]) {
    expect(BRACKET_TEST(line), `${line} is a plain pattern test`).toBe(true);
  }
});

describe("usage", () => {
  it("exits 2 for a workflow with no relevance list", () => {
    const result = script("codeql.yml", "push", "", "");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no relevance list for codeql.yml");
    expect(result.stdout).toBe("");
  });

  it("exits 2 on the wrong number of arguments", () => {
    for (const args of [
      [],
      ["protocol-compat.yml"],
      ["a", "b", "c", "d", "e"],
    ]) {
      const result = script(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: ci-push-scope.sh");
      expect(result.stdout).toBe("");
    }
  });

  it("is executable, so a workflow step can run it by path", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(spawnSync("test", ["-x", SCRIPT]).status).toBe(0);
  });
});
