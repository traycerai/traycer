#!/usr/bin/env node
// Local pre-commit lint: lint only the files this branch changed.
//
//   node scripts/lint-changed-files.mjs <base-ref>
//
// CI lints whole projects (`nx affected --target=lint`); this runner is the
// LOCAL half only. Whole-project lint of gui-app starts tsgolint, which
// builds the full type program with no cache (~5 GB, ~30 s every commit). On
// the changed files alone the same linters cost ~1.7 GB and ~3 s. Accepted
// gap: a change that makes an UNCHANGED file newly violate a type-aware rule
// (an untouched caller of a function that became async now trips
// no-floating-promises) is reported by CI, not by the commit. The compile
// step still type-checks every file locally.
//
// A project is the nearest package.json with a `lint` script. One that also
// declares `lint:files` (lint the paths appended to it; its `lint` is then
// `lint:files .`) is linted per file; one without it is linted whole, so a
// new project, or one that drops `lint:files`, is never skipped. When a change
// can alter lint results for files that did not change, the runner falls back
// to whole-project lint: a project's own lint config, tsconfig or
// package.json switches that project to `lint`; a repo-level one switches
// the run to `nx affected --target=lint`. The config list mirrors the
// `lint` target inputs in nx.json, plus tsconfig (type-aware rules read it)
// and package.json (plugin versions).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const LINTABLE_SOURCE = /\.[cm]?[jt]sx?$/;
const REPO_LINT_CONFIG = [
  /^eslint\//,
  /^package\.json$/,
  /^bun\.lock$/,
  /^nx\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.oxlintrc[^/]*$/,
  /^oxlint\.config\.[^/]+$/,
  /^eslint\.config\.[^/]+$/,
];
const PROJECT_LINT_CONFIG =
  /^(?:package\.json|tsconfig[^/]*\.json|\.oxlintrc[^/]*|oxlint\.config\.[^/]+|eslint\.config\.[^/]+|\.eslintrc[^/]*)$/;
// Past this many files a project is cheaper to lint whole than to hand the
// linters an argument list approaching ARG_MAX.
export const MAX_FILES_PER_PROJECT = 200;

/**
 * @param {{ changedPaths: string[], projectOf: (path: string) => string | null, lintsFiles: (project: string) => boolean, exists: (path: string) => boolean }} input
 *   changedPaths: repo-relative, `/`-separated, deletions included.
 *   projectOf: the repo-relative root of the nearest project with a `lint`
 *   script, or null. lintsFiles: whether that project has `lint:files`.
 *   exists: whether the path is still part of the commit (git status, not
 *   the disk: `git rm --cached` leaves the file behind); a deleted config
 *   still selects whole-project lint, a deleted source file is not linted.
 * @returns {{ mode: "repo", reason: string }
 *   | { mode: "projects", runs: { project: string, files: string[] | null, reason: string }[] }}
 *   `files: null` means lint the whole project.
 */
export function planLint({ changedPaths, projectOf, lintsFiles, exists }) {
  const repoConfig = changedPaths.find((path) =>
    REPO_LINT_CONFIG.some((pattern) => pattern.test(path)),
  );
  if (repoConfig !== undefined) {
    return { mode: "repo", reason: `${repoConfig} changed` };
  }

  /** @type {Map<string, { files: string[], configChange: string | null }>} */
  const byProject = new Map();
  for (const path of changedPaths) {
    const project = projectOf(path);
    if (project === null) continue;
    const relativePath = posix.relative(project, path);
    const entry = byProject.get(project) ?? { files: [], configChange: null };
    byProject.set(project, entry);
    if (PROJECT_LINT_CONFIG.test(relativePath)) {
      entry.configChange ??= relativePath;
    } else if (LINTABLE_SOURCE.test(relativePath) && exists(path)) {
      entry.files.push(relativePath);
    }
  }

  const runs = [];
  for (const [project, { files, configChange }] of byProject) {
    if (configChange !== null) {
      runs.push({ project, files: null, reason: `${configChange} changed` });
    } else if (files.length > 0 && !lintsFiles(project)) {
      runs.push({ project, files: null, reason: "no lint:files script" });
    } else if (files.length > MAX_FILES_PER_PROJECT) {
      runs.push({
        project,
        files: null,
        reason: `${files.length} files changed`,
      });
    } else if (files.length > 0) {
      runs.push({
        project,
        files: files.sort(),
        reason: `${files.length} changed file(s)`,
      });
    }
  }
  runs.sort((left, right) => left.project.localeCompare(right.project));
  return { mode: "projects", runs };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function run(command, args, cwd) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`lint: cannot run ${command}: ${result.error.message}`);
  }
  return result.status === 0;
}

function main(baseRef) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const mergeBase = git(root, ["merge-base", baseRef, "HEAD"]).trim();
  // Against the working tree: during a commit pre-commit has stashed the
  // unstaged edits, so this is exactly the branch plus the staged change.
  // Deletions stay in: a deleted lint config changes results for files that
  // did not change, so it must still select whole-project lint. Renames are
  // split into delete + add for the same reason. planLint drops a deleted
  // SOURCE file itself, after config detection, since config files are
  // sources too (oxlint.config.ts). Deletion is read from git's status, not
  // the disk: `git rm --cached` removes a file from the commit and leaves it
  // in the working tree.
  const fields = git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    "--diff-filter=ACMDT",
    "-z",
    mergeBase,
  ])
    .split("\0")
    .filter((field) => field !== "");
  const changedPaths = [];
  const deleted = new Set();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [status, path] = [fields[index], fields[index + 1]];
    changedPaths.push(path);
    if (status === "D") deleted.add(path);
  }
  const exists = (path) => !deleted.has(path);

  /** @type {Map<string, Record<string, unknown> | null>} project scripts by directory */
  const projectScripts = new Map();
  const projectOf = (path) => {
    for (
      let directory = posix.dirname(path);
      ;
      directory = posix.dirname(directory)
    ) {
      if (!projectScripts.has(directory)) {
        const manifest = join(root, directory, "package.json");
        let scripts = null;
        if (directory !== "." && existsSync(manifest)) {
          const declared =
            JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
          if (typeof declared.lint === "string") scripts = declared;
        }
        projectScripts.set(directory, scripts);
      }
      if (projectScripts.get(directory) !== null) return directory;
      if (directory === ".") return null;
    }
  };

  const lintsFiles = (project) =>
    typeof projectScripts.get(project)?.["lint:files"] === "string";

  const plan = planLint({ changedPaths, projectOf, lintsFiles, exists });
  if (plan.mode === "repo") {
    console.log(`lint: ${plan.reason}; linting every affected project.`);
    return run(
      "bun",
      [
        "x",
        "nx",
        "affected",
        "--target=lint",
        `--base=${baseRef}`,
        "--parallel=3",
        "--tui=false",
      ],
      root,
    );
  }

  if (plan.runs.length === 0) {
    console.log("lint: no lintable files changed.");
    return true;
  }
  let passed = true;
  for (const { project, files, reason } of plan.runs) {
    console.log(`lint: ${project} (${reason})`);
    // `./` so a file named like a flag (`-x.ts`) reaches the linters as a
    // path.
    const args =
      files === null
        ? ["run", "lint"]
        : ["run", "lint:files", ...files.map((file) => `./${file}`)];
    passed = run("bun", args, join(root, project)) && passed;
  }
  return passed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseRef = process.argv[2];
  if (baseRef === undefined) {
    console.error("usage: lint-changed-files.mjs <base-ref>");
    process.exit(2);
  }
  process.exit(main(baseRef) ? 0 : 1);
}
