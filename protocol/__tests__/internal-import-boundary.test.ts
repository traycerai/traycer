import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `_internal/` imports are forbidden except the owning `registry.ts` and other `_internal/` modules.
 * Reach record schemas through `getRecordSchema`. Even type-only imports leak.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nx",
  ".turbo",
  "coverage",
  "out",
  ".git",
  ".tanstack",
  ".agents",
  ".claude",
  ".codex",
]);

// Matches any import (runtime or type-only) referencing a path under `@traycer/protocol/.../_internal/...`.
// The privacy boundary is total: even type-only imports leak structural detail across the boundary.
const FORBIDDEN_IMPORT_PATTERN =
  /["']@traycer\/protocol\/[^"']*\/_internal\/[^"']*["']/g;

/** Files allowed to import from `_internal/`. */
const AUTHORIZED_IMPORTERS = new Set<string>([
  path.join(REPO_ROOT, "protocol", "src", "auth", "registry.ts"),
  path.join(REPO_ROOT, "protocol", "src", "common", "registry.ts"),
  path.join(REPO_ROOT, "protocol", "src", "persistence", "registry.ts"),
]);

function isAuthorizedImporter(filePath: string): boolean {
  if (AUTHORIZED_IMPORTERS.has(filePath)) {
    return true;
  }
  // Files inside any `_internal/` directory are part of the private
  // surface and may freely cross-reference one another.
  return filePath.split(path.sep).includes("_internal");
}

function* walkSourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = path.join(directory, entry);
    let entryStat;
    try {
      entryStat = statSync(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      yield* walkSourceFiles(fullPath);
      continue;
    }

    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      yield fullPath;
    }
  }
}

function findForbiddenImports(
  filePath: string,
): { lineNumber: number; line: string }[] {
  const contents = readFileSync(filePath, "utf8");
  const matches: { lineNumber: number; line: string }[] = [];

  contents.split("\n").forEach((line, index) => {
    FORBIDDEN_IMPORT_PATTERN.lastIndex = 0;
    if (FORBIDDEN_IMPORT_PATTERN.test(line)) {
      matches.push({ lineNumber: index + 1, line: line.trim() });
    }
  });

  return matches;
}

describe("@traycer/protocol _internal/ privacy boundary", () => {
  it("only registries and _internal/ files import from a protocol _internal/ path", () => {
    const violations: string[] = [];

    for (const filePath of walkSourceFiles(REPO_ROOT)) {
      if (isAuthorizedImporter(filePath)) continue;

      const matches = findForbiddenImports(filePath);
      for (const match of matches) {
        const relPath = path.relative(REPO_ROOT, filePath);
        violations.push(`${relPath}:${match.lineNumber}: ${match.line}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "Files are importing from `@traycer/protocol/.../_internal/...`",
          "outside the registry / _internal/ allow-list.",
          "",
          'Use `getRecordSchema(<registry>, "<record-name>")` instead.',
          "",
          ...violations,
        ].join("\n"),
      );
    }

    expect(violations).toEqual([]);
  });
});
