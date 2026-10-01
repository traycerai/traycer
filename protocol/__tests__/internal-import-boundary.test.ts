import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Hard-enforces the `_internal/` privacy boundary for `@traycer/protocol`.
 *
 * Files under `protocol/<domain>/_internal/` host the raw Zod values for
 * registered records (e.g. `epicSchema`, `permissionRoleSchema`,
 * `userSchema`, `roomMetadataSchema`). Importing them directly bypasses
 * the registry's version stamp, which is exactly the drift this
 * framework was built to prevent.
 *
 * The rule is intentionally strict: **no file is allowed to import from
 * a `_internal/` path** except:
 *
 * - The owning registry - `protocol/<domain>/registry.ts` - which is
 *   the canonical entry that wraps records into versioned contracts.
 * - Other modules that already live under `_internal/` themselves.
 *
 * Everything else (including other modules inside `protocol/`) reaches
 * record schemas through `getRecordSchema(<registry>, "<record-name>")`.
 *
 * This test scans every `.ts`/`.tsx` file in the monorepo and fails on
 * any import path matching `@traycer/protocol/.../_internal/...` from a
 * file that is not an authorized importer.
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

// Matches any import (runtime or type-only) referencing a path under
// `@traycer/protocol/.../_internal/...`. The privacy boundary is
// total: even type-only imports leak structural detail across the
// boundary. Recursive types that require a `z.ZodType<...>`
// annotation must be co-located with the owning registry, not
// imported from `_internal/`.
const FORBIDDEN_IMPORT_PATTERN =
  /["']@traycer\/protocol\/[^"']*\/_internal\/[^"']*["']/g;

/**
 * A file is an authorized `_internal/` importer only because it wraps
 * record schemas into a versioned contract - not because someone once
 * added its name to a list. A literal allow-list goes stale the moment a
 * new legitimate registry is added (`persistence/chat-sync-registry.ts`
 * did exactly that); deriving the set from what a file actually IS keeps
 * it self-updating and makes a fifth registry a conscious, well-messaged
 * edit instead of a silent gap.
 *
 * Eligible means all three:
 *  (a) the file sits directly under `protocol/src/<area>/` - one
 *      directory level, never nested, never under `_internal`, never a
 *      test file (a `__tests__` "area" is excluded outright, and a test
 *      basename never matches the naming rule below anyway);
 *  (b) its basename is `registry.ts` or ends in `-registry.ts`;
 *  (c) its source actually calls `defineVersionedRecordRegistry(` - the
 *      one factory a RECORD registry wraps `_internal/` schemas with.
 *      `protocol/src/host/registry.ts` is an RPC registry
 *      (`defineFloorAwareVersionedRpcRegistry`) and must not qualify.
 */
const RECORD_REGISTRY_PATH_PATTERN = /^protocol\/src\/([^/]+)\/([^/]+)$/u;
const RECORD_REGISTRY_FACTORY_CALL = /\bdefineVersionedRecordRegistry\s*\(/u;

function isAuthorizedRecordRegistryFile(
  repoRelativePosixPath: string,
  sourceText: string,
): boolean {
  const match = RECORD_REGISTRY_PATH_PATTERN.exec(repoRelativePosixPath);
  if (match === null) return false;
  const [, area, basename] = match;
  if (area === "_internal" || area === "__tests__") return false;
  if (basename !== "registry.ts" && !basename.endsWith("-registry.ts")) {
    return false;
  }
  return RECORD_REGISTRY_FACTORY_CALL.test(sourceText);
}

function collectAuthorizedRegistryFiles(repoRoot: string): Set<string> {
  const srcDir = path.join(repoRoot, "protocol", "src");
  const authorized = new Set<string>();

  for (const area of readdirSync(srcDir)) {
    const areaPath = path.join(srcDir, area);
    let areaStat;
    try {
      areaStat = statSync(areaPath);
    } catch {
      continue;
    }
    if (!areaStat.isDirectory()) continue;

    for (const entry of readdirSync(areaPath)) {
      const filePath = path.join(areaPath, entry);
      let entryStat;
      try {
        entryStat = statSync(filePath);
      } catch {
        continue;
      }
      if (!entryStat.isFile()) continue;

      const repoRelativePosixPath = ["protocol", "src", area, entry].join("/");
      const sourceText = readFileSync(filePath, "utf8");
      if (isAuthorizedRecordRegistryFile(repoRelativePosixPath, sourceText)) {
        authorized.add(filePath);
      }
    }
  }

  return authorized;
}

const AUTHORIZED_IMPORTERS = collectAuthorizedRegistryFiles(REPO_ROOT);

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

function findForbiddenImportsInText(
  contents: string,
): { lineNumber: number; line: string }[] {
  const matches: { lineNumber: number; line: string }[] = [];

  contents.split("\n").forEach((line, index) => {
    FORBIDDEN_IMPORT_PATTERN.lastIndex = 0;
    if (FORBIDDEN_IMPORT_PATTERN.test(line)) {
      matches.push({ lineNumber: index + 1, line: line.trim() });
    }
  });

  return matches;
}

function findForbiddenImports(
  filePath: string,
): { lineNumber: number; line: string }[] {
  return findForbiddenImportsInText(readFileSync(filePath, "utf8"));
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

  it("the forbidden-import matcher is red-capable: a planted _internal import line is detected", () => {
    // Built by parts, not as a literal string: this test file is itself
    // scanned by the suite above, and a literal match here would trip its
    // own violation check.
    const forbiddenPath = [
      "@traycer",
      "protocol",
      "persistence",
      "_internal",
      "foo-schemas",
    ].join("/");
    const planted =
      `import { fooSchema } from "${forbiddenPath}";\n` +
      'import { bar } from "@traycer/protocol/common/schemas";\n';
    const matches = findForbiddenImportsInText(planted);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.lineNumber).toBe(1);
    expect(matches[0]?.line).toContain("_internal/foo-schemas");
  });
});

describe("@traycer/protocol _internal/ privacy boundary: authorized-importer derivation", () => {
  it("derives exactly the four current record registries, by repo-relative path", () => {
    const derived = [...AUTHORIZED_IMPORTERS]
      .map((filePath) =>
        path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
      )
      .sort();

    expect(derived).toEqual(
      [
        "protocol/src/auth/registry.ts",
        "protocol/src/common/registry.ts",
        "protocol/src/persistence/chat-sync-registry.ts",
        "protocol/src/persistence/registry.ts",
      ].sort(),
    );
  });

  it("a fifth registry only qualifies by satisfying all three eligibility rules, never by name alone", () => {
    // This test documents the failure message a future registry addition
    // gets if the derivation ever regresses to name-matching alone: the
    // count above must move only when a file genuinely earns it.
    expect(AUTHORIZED_IMPORTERS.size).toBe(4);
  });
});

describe("isAuthorizedRecordRegistryFile: eligibility predicate (pure)", () => {
  const RECORD_FACTORY_SOURCE =
    'import { defineVersionedRecordRegistry } from "@traycer/protocol/framework/index";\n' +
    "export const fooRegistry = defineVersionedRecordRegistry({});\n";
  const RPC_FACTORY_SOURCE =
    'import { defineFloorAwareVersionedRpcRegistry } from "@traycer/protocol/framework/index";\n' +
    "export const hostRegistry = defineFloorAwareVersionedRpcRegistry({});\n";

  it("right place + right name + calls the record factory -> true", () => {
    expect(
      isAuthorizedRecordRegistryFile(
        "protocol/src/persistence/chat-sync-registry.ts",
        RECORD_FACTORY_SOURCE,
      ),
    ).toBe(true);
  });

  it("host/registry.ts-like: right place + right name, but no record-factory call -> false", () => {
    expect(
      isAuthorizedRecordRegistryFile(
        "protocol/src/host/registry.ts",
        RPC_FACTORY_SOURCE,
      ),
    ).toBe(false);
  });

  it("a foo-registry.ts nested one level deeper than protocol/src/<area>/ -> false", () => {
    expect(
      isAuthorizedRecordRegistryFile(
        "protocol/src/persistence/nested/foo-registry.ts",
        RECORD_FACTORY_SOURCE,
      ),
    ).toBe(false);
  });

  it("a clients/...-registry.ts that calls the factory is still outside protocol/src -> false", () => {
    expect(
      isAuthorizedRecordRegistryFile(
        "clients/gui-app/src/widget-registry.ts",
        RECORD_FACTORY_SOURCE,
      ),
    ).toBe(false);
  });

  it("a non-registry basename that calls the factory -> false", () => {
    expect(
      isAuthorizedRecordRegistryFile(
        "protocol/src/persistence/schemas.ts",
        RECORD_FACTORY_SOURCE,
      ),
    ).toBe(false);
  });
});
