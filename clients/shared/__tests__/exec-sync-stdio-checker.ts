import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import * as ts from "typescript";

// Shared by `exec-sync-stdio.test.ts`. `execFileSync`/`execSync` copy a
// failing child's stderr into THIS process's stderr unless the caller passes
// an `stdio` option - see the sites this gate protects. This module is the
// AST-based predicate (TypeScript compiler API, never a string/comment
// scanner) plus the filesystem walk that applies it across the batch's
// production scope. Kept out of `exec-sync-stdio.test.ts` itself so the
// synthetic-source test in that file can import the exact function the
// real-repo scan uses - one predicate, never two independently-drifting
// copies.

export type ExecSyncStdioViolationKind = "missing-stdio" | "renamed-import";

export interface ExecSyncStdioViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: ExecSyncStdioViolationKind;
  readonly detail: string;
}

export interface ExecSyncStdioCheckResult {
  readonly violations: readonly ExecSyncStdioViolation[];
  readonly totalCallSites: number;
  readonly callSitesWithStdio: number;
}

/** `relative/path.ts:line` - the format every failure message in this gate uses. */
export function formatExecSyncStdioViolation(
  violation: ExecSyncStdioViolation,
): string {
  return `${violation.file}:${String(violation.line)}`;
}

const CHILD_PROCESS_MODULE_SPECIFIERS = new Set([
  "child_process",
  "node:child_process",
]);

const GUARDED_NAMES = new Set(["execFileSync", "execSync", "spawnSync"]);

function oneIndexedLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/** The static text of an object member's name, or `null` when it cannot be
 * determined without type information (a computed name, a spread). A `null`
 * result is never treated as a match - see `objectLiteralHasStdioProperty`. */
function staticPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function expressionCapturesStderr(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text === "pipe" || node.text === "ignore";
  }
  if (!ts.isArrayLiteralExpression(node)) return false;
  const stderr = node.elements[2];
  if (stderr === undefined) return false;
  if (
    ts.isStringLiteral(stderr) ||
    ts.isNoSubstitutionTemplateLiteral(stderr)
  ) {
    return stderr.text === "pipe" || stderr.text === "ignore";
  }
  return false;
}

function objectLiteralHasCapturedStdio(
  literal: ts.ObjectLiteralExpression,
): boolean {
  return literal.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    if (staticPropertyNameText(property.name) !== "stdio") return false;
    return expressionCapturesStderr(property.initializer);
  });
}

/** Does `call` carry an object-literal argument whose `stdio` value captures
 * or discards stderr (`"pipe"` / `"ignore"`, or an array whose index 2 is
 * one of those)? `"inherit"`, `undefined`, and `["ignore","pipe","inherit"]`
 * all still copy the child's stderr into ours. */
function callHasStdioOptionsObject(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      objectLiteralHasCapturedStdio(argument),
  );
}

function collectGuardedAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) &&
      GUARDED_NAMES.has(node.initializer.text)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

/** Is `expr` a call to `execFileSync`/`execSync`/`spawnSync`, including
 * `cp.execFileSync(...)`, `execFileSync.call(...)`, `cp["execFileSync"](...)`,
 * and a same-file alias (`const run = execFileSync; run(...)`)? */
function guardedCalleeName(
  expr: ts.Expression,
  aliases: ReadonlySet<string>,
): string | null {
  if (ts.isParenthesizedExpression(expr)) {
    return guardedCalleeName(expr.expression, aliases);
  }
  if (ts.isIdentifier(expr)) {
    if (GUARDED_NAMES.has(expr.text) || aliases.has(expr.text))
      return expr.text;
    return null;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (expr.name.text === "call" || expr.name.text === "apply") {
      return guardedCalleeName(expr.expression, aliases);
    }
    return GUARDED_NAMES.has(expr.name.text) ? expr.name.text : null;
  }
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    if (
      arg !== undefined &&
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
      GUARDED_NAMES.has(arg.text)
    ) {
      return arg.text;
    }
  }
  return null;
}

/**
 * Parses `sourceText` (as `fileName`, so `.tsx` parses with JSX enabled) and
 * returns every `execFileSync`/`execSync` call site plus every import that
 * renames one of those two - a renamed named import
 * (`import { execFileSync as x } from "node:child_process"`) produces calls
 * shaped like `x(...)`, indistinguishable from any other identifier call
 * without resolving the import, so it is flagged directly as a violation
 * rather than chased through alias tracking. A namespace/default import
 * (`import * as cp from "child_process"`) needs no separate handling: its
 * calls are `cp.execFileSync(...)`, a property access already covered by
 * `guardedCalleeName` above.
 */
export function checkExecSyncStdio(
  fileName: string,
  sourceText: string,
): ExecSyncStdioCheckResult {
  const scriptKind = scriptKindFor(fileName);
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const violations: ExecSyncStdioViolation[] = [];
  let totalCallSites = 0;
  let callSitesWithStdio = 0;
  const aliases = collectGuardedAliases(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const guardedName = guardedCalleeName(node.expression, aliases);
      if (guardedName !== null) {
        totalCallSites += 1;
        const hasStdio = callHasStdioOptionsObject(node);
        if (hasStdio) {
          callSitesWithStdio += 1;
        } else {
          violations.push({
            file: fileName,
            line: oneIndexedLine(sourceFile, node),
            kind: "missing-stdio",
            detail: `${guardedName} call missing an \`stdio\` option - a failing child's stderr is copied into this process's stderr unless \`stdio\` is given`,
          });
        }
      }
    } else if (
      ts.isBindingElement(node) &&
      node.propertyName !== undefined &&
      ts.isIdentifier(node.propertyName) &&
      GUARDED_NAMES.has(node.propertyName.text) &&
      ts.isIdentifier(node.name) &&
      node.name.text !== node.propertyName.text
    ) {
      // `const { execFileSync: run } = require("node:child_process")` (or
      // `await import(...)`) renames it just as an import would.
      violations.push({
        file: fileName,
        line: oneIndexedLine(sourceFile, node),
        kind: "renamed-import",
        detail: `\`${node.propertyName.text}\` destructured as \`${node.name.text}\` - a renamed binding evades this gate's structural call-site match, so it must be flagged where it is bound`,
      });
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      CHILD_PROCESS_MODULE_SPECIFIERS.has(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        const localName = element.name.text;
        if (GUARDED_NAMES.has(importedName) && importedName !== localName) {
          violations.push({
            file: fileName,
            line: oneIndexedLine(sourceFile, element),
            kind: "renamed-import",
            detail: `\`${importedName}\` imported as \`${localName}\` - a renamed import evades this gate's structural call-site match, so it must be flagged at the import itself`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { violations, totalCallSites, callSitesWithStdio };
}

// ---- Repository scan -------------------------------------------------------

const EXCLUDED_DIR_NAMES = new Set([
  "__tests__",
  "node_modules",
  "dist",
  "out",
  // Defensive: no client package currently nests a `scripts/` dir inside its
  // `src/` tree (build/dev tooling lives at `clients/<pkg>/scripts/`,
  // `protocol/scripts/`, outside the scanned trees already), but the batch
  // spec calls this out explicitly as an exclusion, so it is enforced
  // structurally rather than relying on today's layout staying that way.
  "scripts",
]);

// A runtime `.cjs`/`.mjs`/`.js` module in scope runs the same calls, so the
// whole JS family is scanned, not only TypeScript.
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function scriptKindFor(fileName: string): ts.ScriptKind {
  const ext = extname(fileName);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isScannableSourceFile(fileName: string): boolean {
  if (/\.d\.[cm]?ts$/.test(fileName)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName)) return false;
  return SCANNED_EXTENSIONS.has(extname(fileName));
}

function collectSourceFiles(dir: string, files: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isScannableSourceFile(entry.name)) continue;
    files.push(join(dir, entry.name));
  }
}

/**
 * Every production TypeScript or JavaScript file in this batch's scope:
 * `clients/*\/src/**` for every client package that has a `src/` dir,
 * `clients/shared/**` (no `src/` dir there), and `protocol/src/**` -
 * excluding `__tests__/` dirs, test and spec files, declaration files,
 * `node_modules`, `dist`, `out`, and any `scripts/` dir. `repoRoot` is resolved by the caller from the test file's own
 * location, never from `process.cwd()`.
 */
export function collectExecSyncStdioScanFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const clientsDir = join(repoRoot, "clients");
  for (const entry of readdirSync(clientsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "shared") continue; // no `src/`; walked separately below
    collectSourceFiles(join(clientsDir, entry.name, "src"), files);
  }
  collectSourceFiles(join(clientsDir, "shared"), files);
  collectSourceFiles(join(repoRoot, "protocol", "src"), files);
  return files;
}

export interface ExecSyncStdioRepoScanResult extends ExecSyncStdioCheckResult {
  readonly filesScanned: number;
}

/** Runs {@link checkExecSyncStdio} over every file
 * {@link collectExecSyncStdioScanFiles} finds under `repoRoot`, aggregating
 * violations and call-site counts across the whole scope. Each violation's
 * `file` is repo-root-relative, matching the `relative/path.ts:line` format
 * this gate's failure message uses. */
export function scanRepoForExecSyncStdio(
  repoRoot: string,
): ExecSyncStdioRepoScanResult {
  const files = collectExecSyncStdioScanFiles(repoRoot);
  const violations: ExecSyncStdioViolation[] = [];
  let totalCallSites = 0;
  let callSitesWithStdio = 0;

  for (const filePath of files) {
    const relativePath = relative(repoRoot, filePath);
    const sourceText = readFileSync(filePath, "utf8");
    const result = checkExecSyncStdio(relativePath, sourceText);
    violations.push(...result.violations);
    totalCallSites += result.totalCallSites;
    callSitesWithStdio += result.callSitesWithStdio;
  }

  return {
    violations,
    totalCallSites,
    callSitesWithStdio,
    filesScanned: files.length,
  };
}
