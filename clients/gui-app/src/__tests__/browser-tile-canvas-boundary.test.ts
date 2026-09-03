import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `src/components/browser-tile/` is the shared browser tab tile: it must
 * serve both the task canvas and the Start Page panel, so every canvas fact
 * (open/close, placement, focus) has to reach it as a prop rather than an
 * import. This gate bans direct imports of the canvas store and the
 * tile-open/link routing modules from anywhere in that directory.
 *
 * This is a DIRECT-import scan, not a transitive one. The tile legitimately
 * imports a dozen canvas-*directory* siblings that are canvas-*state*-free
 * (`browser-tile-toolbar`, `screencast-surface`, `use-electron-tile-chrome`,
 * …); walking transitively would need its own allowlist for those and become
 * a maintenance tax with no payoff. So this test decides the syntactic half
 * only — the same limitation `no-account-identifiers-in-logs.test.ts`
 * documents in the internal repo for its own source scan.
 */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = path.join(SRC_DIR, "components", "browser-tile");

const BANNED_MODULE_PREFIXES: readonly string[] = [
  "@/stores/epics/canvas",
  "@/lib/canvas/tile-open",
  "@/hooks/epic/use-epic-tile-navigation",
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  "@/components/epic-canvas/hooks/use-tile-body-visible",
];

interface BoundaryViolation {
  readonly file: string;
  readonly specifier: string;
}

function collectSourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts")
    ) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Resolves an import specifier written in `file` to the `@/...` alias form
 * used repo-wide (`"@/*": ["./src/*"]`), so a relative spelling of a banned
 * module (`../../stores/epics/canvas/store`) is caught the same as the
 * aliased one. A bare package specifier (no `@/` prefix, not relative) is
 * left untouched — it can never match a banned `@/...` prefix.
 */
function resolveToAlias(specifier: string, fromFile: string): string {
  if (specifier.startsWith("@/")) return specifier;
  if (!specifier.startsWith(".")) return specifier;
  const absolute = path.resolve(path.dirname(fromFile), specifier);
  const relativeToSrc = path
    .relative(SRC_DIR, absolute)
    .split(path.sep)
    .join("/");
  return `@/${relativeToSrc}`;
}

function matchesBannedPrefix(resolved: string): string | undefined {
  return BANNED_MODULE_PREFIXES.find(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
  );
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function findViolations(): readonly BoundaryViolation[] {
  const files = collectSourceFiles(SCAN_ROOT);
  if (files.length === 0) {
    throw new Error(
      `browser-tile-canvas-boundary: directory walk found zero files under ${SCAN_ROOT} — the scan is misconfigured, not the directory empty.`,
    );
  }
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const relativePath = path.relative(SRC_DIR, file).split(path.sep).join("/");
    for (const specifier of collectModuleSpecifiers(sourceFile)) {
      const resolved = resolveToAlias(specifier, file);
      const bannedPrefix = matchesBannedPrefix(resolved);
      if (bannedPrefix !== undefined) {
        violations.push({ file: relativePath, specifier });
      }
    }
  }
  return violations;
}

describe("browser-tile canvas boundary", () => {
  it("discovers at least 5 files under components/browser-tile/, so the scan is not vacuous", () => {
    const files = collectSourceFiles(SCAN_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("imports nothing from the canvas store or tile-open/link routing", () => {
    const violations = findViolations()
      .map((violation) => `${violation.file} -> ${violation.specifier}`)
      .sort();
    expect(violations).toEqual([]);
  });
});
