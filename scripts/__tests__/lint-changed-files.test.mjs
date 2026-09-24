// Tests for the pure `planLint` helper in scripts/lint-changed-files.mjs.
// These do not touch the filesystem or spawn anything - `projectOf` is a
// plain map lookup supplied by each test, exactly as the real CLI wrapper
// (main()) supplies one backed by package.json scans.

import { describe, expect, it } from "vitest";
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
