// Tests for the pure `planLint` helper in scripts/lint-changed-files.mjs.
// These do not touch the filesystem or spawn anything - `projectOf` is a
// plain map lookup supplied by each test, exactly as the real CLI wrapper
// (main()) supplies one backed by package.json scans.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILES_PER_PROJECT, planLint } from "../lint-changed-files.mjs";

/** Every path is still on disk unless a test says otherwise. */
const present = () => true;
/** Every project declares `lint:files` unless a test says otherwise. */
const always = () => true;

/** Builds a `projectOf` that maps repo-relative paths to a project root by
 * longest-prefix match against the given project roots, or null. */
function projectOfFactory(projectRoots) {
  return (path) => {
    const matches = projectRoots
      .filter((root) => path === root || path.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length);
    return matches[0] ?? null;
  };
}

describe("planLint", () => {
  describe("repo-level config changes force mode: repo", () => {
    const projectOf = projectOfFactory(["clients/gui-app"]);

    it.each([
      "eslint/base.mjs",
      "package.json",
      "bun.lock",
      "tsconfig.base.json",
    ])("%s changing switches to repo mode", (repoConfigPath) => {
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: [repoConfigPath, "clients/gui-app/src/App.tsx"],
        projectOf,
      });
      expect(plan.mode).toBe("repo");
      expect(plan.reason).toContain(repoConfigPath);
    });

    it("also matches nx.json, .oxlintrc*, oxlint.config.*, eslint.config.*", () => {
      for (const path of [
        "nx.json",
        ".oxlintrc.json",
        ".oxlintrc.base.json",
        "oxlint.config.ts",
        "eslint.config.mjs",
      ]) {
        const plan = planLint({
          exists: present,
          lintsFiles: always,
          changedPaths: [path],
          projectOf,
        });
        expect(plan.mode, path).toBe("repo");
      }
    });

    it("does not treat a nested file that merely matches a leaf name as repo-level", () => {
      // `package.json` deep inside a project must NOT match `^package\.json$`
      // (repo-level) - only a project-relative package.json inside a
      // project's own root counts, and that is exercised separately below.
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: ["clients/gui-app/nested/package.json"],
        projectOf,
      });
      expect(plan.mode).toBe("projects");
    });
  });

  describe("grouping changed files per project", () => {
    it("groups lintable source files under their project, project-relative and sorted", () => {
      const projectOf = projectOfFactory(["clients/gui-app"]);
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: [
          "clients/gui-app/src/b.tsx",
          "clients/gui-app/src/a.ts",
          "clients/gui-app/src/nested/c.jsx",
        ],
        projectOf,
      });
      expect(plan.mode).toBe("projects");
      expect(plan.runs).toEqual([
        {
          project: "clients/gui-app",
          files: ["src/a.ts", "src/b.tsx", "src/nested/c.jsx"],
          reason: "3 changed file(s)",
        },
      ]);
    });

    it("sorts runs by project name", () => {
      const projectOf = projectOfFactory([
        "clients/gui-app",
        "clients/desktop",
      ]);
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: ["clients/gui-app/src/a.ts", "clients/desktop/src/b.ts"],
        projectOf,
      });
      expect(plan.mode).toBe("projects");
      expect(plan.runs.map((r) => r.project)).toEqual([
        "clients/desktop",
        "clients/gui-app",
      ]);
    });
  });

  describe("non-lintable files", () => {
    const projectOf = projectOfFactory(["clients/gui-app"]);

    it("ignores non-source extensions such as .css and .md", () => {
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: [
          "clients/gui-app/src/styles.css",
          "clients/gui-app/README.md",
        ],
        projectOf,
      });
      expect(plan.mode).toBe("projects");
      expect(plan.runs).toEqual([]);
    });

    it("produces no run for a project whose only changes are non-lintable", () => {
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: [
          "clients/gui-app/src/styles.css",
          "clients/gui-app/assets/logo.svg",
        ],
        projectOf,
      });
      expect(
        plan.runs.find((r) => r.project === "clients/gui-app"),
      ).toBeUndefined();
    });
  });

  describe("project-level config changes force files: null for that project only", () => {
    it("package.json inside the project root switches only that project to whole-project lint", () => {
      const projectOf = projectOfFactory([
        "clients/gui-app",
        "clients/desktop",
      ]);
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: [
          "clients/gui-app/package.json",
          "clients/gui-app/src/a.ts",
          "clients/desktop/src/b.ts",
        ],
        projectOf,
      });
      expect(plan.mode).toBe("projects");
      const guiRun = plan.runs.find((r) => r.project === "clients/gui-app");
      const desktopRun = plan.runs.find((r) => r.project === "clients/desktop");
      expect(guiRun).toEqual({
        project: "clients/gui-app",
        files: null,
        reason: "package.json changed",
      });
      expect(desktopRun).toEqual({
        project: "clients/desktop",
        files: ["src/b.ts"],
        reason: "1 changed file(s)",
      });
    });

    it.each([
      "tsconfig.app.json",
      "eslint.config.mjs",
      "oxlint.config.ts",
      ".oxlintrc.json",
      ".eslintrc.json",
    ])(
      "%s inside the project root also forces files: null",
      (relativeConfig) => {
        const projectOf = projectOfFactory(["clients/gui-app"]);
        const plan = planLint({
          exists: present,
          lintsFiles: always,
          changedPaths: [`clients/gui-app/${relativeConfig}`],
          projectOf,
        });
        const run = plan.runs.find((r) => r.project === "clients/gui-app");
        expect(run.files).toBeNull();
        expect(run.reason).toContain(relativeConfig);
      },
    );
  });

  describe("file count cap", () => {
    it("falls back to files: null when a project exceeds MAX_FILES_PER_PROJECT", () => {
      const projectOf = projectOfFactory(["clients/gui-app"]);
      const changedPaths = Array.from(
        { length: MAX_FILES_PER_PROJECT + 1 },
        (_, index) => `clients/gui-app/src/file-${index}.ts`,
      );
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths,
        projectOf,
      });
      const run = plan.runs.find((r) => r.project === "clients/gui-app");
      expect(run.files).toBeNull();
      expect(run.reason).toBe(`${MAX_FILES_PER_PROJECT + 1} files changed`);
    });

    it("stays a file list at exactly MAX_FILES_PER_PROJECT", () => {
      const projectOf = projectOfFactory(["clients/gui-app"]);
      const changedPaths = Array.from(
        { length: MAX_FILES_PER_PROJECT },
        (_, index) => `clients/gui-app/src/file-${index}.ts`,
      );
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths,
        projectOf,
      });
      const run = plan.runs.find((r) => r.project === "clients/gui-app");
      expect(run.files).not.toBeNull();
      expect(run.files).toHaveLength(MAX_FILES_PER_PROJECT);
    });
  });

  describe("paths outside any project", () => {
    it("skips a path whose projectOf returns null", () => {
      const projectOf = projectOfFactory(["clients/gui-app"]);
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: ["README.md", "clients/gui-app/src/a.ts"],
        projectOf,
      });
      expect(plan.mode).toBe("projects");
      expect(plan.runs).toEqual([
        {
          project: "clients/gui-app",
          files: ["src/a.ts"],
          reason: "1 changed file(s)",
        },
      ]);
    });

    it("returns an empty projects plan when every path is outside any project", () => {
      const projectOf = projectOfFactory(["clients/gui-app"]);
      const plan = planLint({
        exists: present,
        lintsFiles: always,
        changedPaths: ["README.md", "docs/notes.md"],
        projectOf,
      });
      expect(plan).toEqual({ mode: "projects", runs: [] });
    });
  });
  describe("deletions", () => {
    const projectOf = projectOfFactory(["clients/shared", "clients/gui-app"]);

    it("a deleted project lint config still selects whole-project lint", () => {
      const deleted = new Set(["clients/shared/oxlint.config.ts"]);
      const plan = planLint({
        changedPaths: ["clients/shared/oxlint.config.ts"],
        projectOf,
        lintsFiles: always,
        exists: (path) => !deleted.has(path),
      });
      expect(plan).toEqual({
        mode: "projects",
        runs: [
          {
            project: "clients/shared",
            files: null,
            reason: "oxlint.config.ts changed",
          },
        ],
      });
    });

    it("a deleted repo-level lint config still selects repo mode", () => {
      const plan = planLint({
        changedPaths: ["eslint/traycer-type-safety-rules.mjs"],
        projectOf,
        lintsFiles: always,
        exists: () => false,
      });
      expect(plan.mode).toBe("repo");
    });

    it("a deleted source file is not linted", () => {
      const deleted = new Set(["clients/gui-app/src/gone.ts"]);
      const plan = planLint({
        changedPaths: [
          "clients/gui-app/src/gone.ts",
          "clients/gui-app/src/kept.ts",
        ],
        projectOf,
        lintsFiles: always,
        exists: (path) => !deleted.has(path),
      });
      expect(plan).toEqual({
        mode: "projects",
        runs: [
          {
            project: "clients/gui-app",
            files: ["src/kept.ts"],
            reason: "1 changed file(s)",
          },
        ],
      });
    });
  });
  describe("projects without lint:files", () => {
    const projectOf = projectOfFactory(["clients/shared", "clients/gui-app"]);
    const onlyGuiApp = (project) => project === "clients/gui-app";

    it("lints a changed project that has no lint:files script whole", () => {
      const plan = planLint({
        changedPaths: ["clients/shared/src/a.ts", "clients/gui-app/src/b.ts"],
        projectOf,
        lintsFiles: onlyGuiApp,
        exists: present,
      });
      expect(plan).toEqual({
        mode: "projects",
        runs: [
          {
            project: "clients/gui-app",
            files: ["src/b.ts"],
            reason: "1 changed file(s)",
          },
          {
            project: "clients/shared",
            files: null,
            reason: "no lint:files script",
          },
        ],
      });
    });

    it("still lints it whole when only its package.json changed", () => {
      const plan = planLint({
        changedPaths: ["clients/shared/package.json"],
        projectOf,
        lintsFiles: onlyGuiApp,
        exists: present,
      });
      expect(plan.runs).toEqual([
        {
          project: "clients/shared",
          files: null,
          reason: "package.json changed",
        },
      ]);
    });
  });
});

// End-to-end coverage against a real fixture git repo, driving the script's
// main() (not just the pure planLint()) so the git plumbing, project
// discovery via package.json, and the actual `bun` invocations are exercised
// together. A fake `bun` on PATH stands in for the real linters so these
// tests stay fast and never depend on lint actually being configured.

const SCRIPT_PATH = fileURLToPath(
  new URL("../lint-changed-files.mjs", import.meta.url),
);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** A fake `bun` that appends `$PWD|$*` as one line to the file named by
 * FAKE_BUN_LOG, and exits 1 instead of 0 when FAKE_BUN_FAIL is set - so a
 * test can assert exactly what the real script invoked it with, without any
 * real linter running. */
function writeFakeBun(binDir) {
  const bunPath = join(binDir, "bun");
  writeFileSync(
    bunPath,
    [
      "#!/bin/bash",
      'printf "%s|%s\\n" "$PWD" "$*" >> "$FAKE_BUN_LOG"',
      'if [ -n "${FAKE_BUN_FAIL:-}" ]; then exit 1; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bunPath, 0o755);
}

function initFixtureRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-root", private: true }, null, 2) + "\n",
  );

  mkdirSync(join(dir, "packages/a/src"), { recursive: true });
  writeFileSync(
    join(dir, "packages/a/package.json"),
    JSON.stringify(
      {
        name: "fixture-a",
        scripts: { lint: "lint-a .", "lint:files": "lint-a" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "packages/a/src/x.ts"), "export const x = 1;\n");

  mkdirSync(join(dir, "packages/b/src"), { recursive: true });
  writeFileSync(
    join(dir, "packages/b/package.json"),
    JSON.stringify(
      { name: "fixture-b", scripts: { lint: "lint-b ." } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "packages/b/src/y.ts"), "export const y = 1;\n");

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

describe("lint-changed-files.mjs end-to-end against a fixture git repo", () => {
  let repoDir;
  let binDir;
  let baseSha;

  beforeEach(() => {
    repoDir = realpathSync(
      mkdtempSync(join(tmpdir(), "lint-changed-files-repo-")),
    );
    binDir = realpathSync(
      mkdtempSync(join(tmpdir(), "lint-changed-files-bin-")),
    );
    writeFakeBun(binDir);
    baseSha = initFixtureRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function runScript(baseRef, { fail = false } = {}) {
    const logFile = join(repoDir, ".fake-bun.log");
    const result = spawnSync("node", [SCRIPT_PATH, baseRef], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_BUN_LOG: logFile,
        ...(fail ? { FAKE_BUN_FAIL: "1" } : {}),
      },
    });
    const calls = existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
    return { ...result, calls };
  }

  it("lints changed and untracked-but-staged files in a project with lint:files, path-prefixed and sorted", () => {
    writeFileSync(
      join(repoDir, "packages/a/src/x.ts"),
      "export const x = 2;\n",
    );
    // A leading-dash filename must reach the linter as `./`-prefixed so it
    // is never mistaken for a flag.
    writeFileSync(
      join(repoDir, "packages/a/src/-flag.ts"),
      "export const y = 1;\n",
    );
    git(repoDir, ["add", "-A"]);

    const { status, stdout, calls } = runScript(baseSha);

    expect(status, stdout).toBe(0);
    expect(calls).toHaveLength(1);
    const [cwdUsed, argsUsed] = calls[0].split("|");
    expect(cwdUsed).toBe(join(repoDir, "packages/a"));
    expect(argsUsed).toBe("run lint:files ./src/-flag.ts ./src/x.ts");
  });

  it("lints a project without lint:files whole", () => {
    writeFileSync(
      join(repoDir, "packages/b/src/y.ts"),
      "export const y = 2;\n",
    );

    const { status, stdout, calls } = runScript(baseSha);

    expect(status, stdout).toBe(0);
    expect(calls).toHaveLength(1);
    const [cwdUsed, argsUsed] = calls[0].split("|");
    expect(cwdUsed).toBe(join(repoDir, "packages/b"));
    expect(argsUsed).toBe("run lint");
  });

  it("reports nothing to lint when the only change is a deleted source file", () => {
    git(repoDir, ["rm", "-q", "packages/a/src/x.ts"]);

    const { status, stdout, calls } = runScript(baseSha);

    expect(status, stdout).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdout).toContain("no lintable files changed");
  });

  it("switches to whole-project nx affected from the repo root when a repo-level config changes", () => {
    writeFileSync(join(repoDir, "nx.json"), JSON.stringify({}, null, 2) + "\n");
    git(repoDir, ["add", "-A"]);

    const { status, stdout, calls } = runScript(baseSha);

    expect(status, stdout).toBe(0);
    expect(calls).toHaveLength(1);
    const [cwdUsed, argsUsed] = calls[0].split("|");
    expect(cwdUsed).toBe(repoDir);
    expect(argsUsed).toBe(
      `x nx affected --target=lint --base=${baseSha} --parallel=3 --tui=false`,
    );
  });

  it("propagates a failing bun invocation as a non-zero exit", () => {
    writeFileSync(
      join(repoDir, "packages/a/src/x.ts"),
      "export const x = 3;\n",
    );

    const { status } = runScript(baseSha, { fail: true });

    expect(status).toBe(1);
  });
});
