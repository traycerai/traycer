import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Predicate (a) of scan-standin-ops.cjs: a hit is an operand X that is a
 * binding resolved to a stand-in (an imported protocol export declared
 * `= lazySchema(`, an exported alias of one of those, a local
 * `= lazySchema(` const, or a local alias of either)
 * appearing DIRECTLY as:
 *   - the argument of Object.keys / values / entries / getOwnPropertyNames /
 *     getOwnPropertySymbols / getOwnPropertyDescriptors / getPrototypeOf /
 *     setPrototypeOf / freeze / seal / isFrozen / hasOwn, Reflect.ownKeys /
 *     getPrototypeOf, JSON.stringify, structuredClone, any `.postMessage(`
 *   - any source argument of Object.assign (position >= 1)
 *   - a spread in an object literal `{ ...X }`
 *   - the object of `for (k in X)`
 *   - `X.hasOwnProperty(` / `Object.prototype.hasOwnProperty.call(X`
 * `X.shape`, `X.options`, `X.parse(...)` are not hits: reading a property
 * materialises the stand-in first. This test does not apply predicate (b)
 * (the /schema$/i name heuristic).
 */

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TRAYCER_ROOT = path.join(PROTOCOL_ROOT, "..");

const SCAN_PREFIXES = [
  "protocol/src/",
  "clients/gui-app/src/",
  "clients/shared/",
  "clients/traycer-cli/src/",
  "clients/desktop/src/",
] as const;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "__tests__",
  "__fixtures__",
]);

const OBJECT_FNS = new Set([
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "setPrototypeOf",
  "freeze",
  "seal",
  "isFrozen",
  "hasOwn",
]);
const REFLECT_FNS = new Set(["ownKeys", "getPrototypeOf"]);

type StandinOpHit = {
  readonly sourceFile: string;
  readonly line: number;
  readonly what: string;
};

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isLazySchemaCall(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  return (
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "lazySchema"
  );
}

type ExportedAlias = {
  readonly alias: string;
  readonly target: string;
};

function collectLazyExportNames(
  protocolSrcFiles: readonly string[],
): Set<string> {
  const names = new Set<string>();
  const aliases: ExportedAlias[] = [];
  for (const filePath of protocolSrcFiles) {
    const text = readFileSync(filePath, "utf8");
    const source = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const stmt of source.statements) {
      if (!ts.isVariableStatement(stmt)) {
        continue;
      }
      const isExport = stmt.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExport) {
        continue;
      }
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
          continue;
        }
        if (isLazySchemaCall(decl.initializer)) {
          names.add(decl.name.text);
          continue;
        }
        const inner = unwrap(decl.initializer);
        if (ts.isIdentifier(inner)) {
          aliases.push({ alias: decl.name.text, target: inner.text });
        }
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const pair of aliases) {
      if (names.has(pair.target) && !names.has(pair.alias)) {
        names.add(pair.alias);
        grew = true;
      }
    }
  }
  return names;
}

function collectStandIns(
  source: ts.SourceFile,
  lazyExportNames: ReadonlySet<string>,
): Set<string> {
  const standIns = new Set<string>();
  for (const stmt of source.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause !== undefined &&
      !stmt.importClause.isTypeOnly
    ) {
      const bindings = stmt.importClause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) {
            continue;
          }
          const orig = (el.propertyName ?? el.name).text;
          if (lazyExportNames.has(orig)) {
            standIns.add(el.name.text);
          }
        }
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const stmt of source.statements) {
      if (!ts.isVariableStatement(stmt)) {
        continue;
      }
      for (const decl of stmt.declarationList.declarations) {
        if (
          !ts.isIdentifier(decl.name) ||
          decl.initializer === undefined ||
          standIns.has(decl.name.text)
        ) {
          continue;
        }
        const inner = unwrap(decl.initializer);
        if (isLazySchemaCall(inner)) {
          standIns.add(decl.name.text);
          grew = true;
          continue;
        }
        if (ts.isIdentifier(inner) && standIns.has(inner.text)) {
          standIns.add(decl.name.text);
          grew = true;
        }
      }
    }
  }
  return standIns;
}

function isStandInExpr(
  expression: ts.Expression,
  standIns: ReadonlySet<string>,
): boolean {
  const inner = unwrap(expression);
  return ts.isIdentifier(inner) && standIns.has(inner.text);
}

function findStandinOpHitsInSource(
  sourceFile: string,
  text: string,
  lazyExportNames: ReadonlySet<string>,
): StandinOpHit[] {
  const source = ts.createSourceFile(
    sourceFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    sourceFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const standIns = collectStandIns(source, lazyExportNames);
  const hits: StandinOpHit[] = [];
  const hit = (node: ts.Node, what: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    hits.push({ sourceFile, line: line + 1, what });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ) {
        const obj = callee.expression.text;
        const fn = callee.name.text;
        const first = node.arguments[0];
        if (
          obj === "Object" &&
          OBJECT_FNS.has(fn) &&
          first !== undefined &&
          isStandInExpr(first, standIns)
        ) {
          hit(node, `Object.${fn}`);
        }
        if (
          obj === "Object" &&
          fn === "assign" &&
          node.arguments.slice(1).some((arg) => isStandInExpr(arg, standIns))
        ) {
          hit(node, "Object.assign source");
        }
        if (
          obj === "Reflect" &&
          REFLECT_FNS.has(fn) &&
          first !== undefined &&
          isStandInExpr(first, standIns)
        ) {
          hit(node, `Reflect.${fn}`);
        }
        if (
          obj === "JSON" &&
          fn === "stringify" &&
          first !== undefined &&
          isStandInExpr(first, standIns)
        ) {
          hit(node, "JSON.stringify");
        }
      }
      if (
        ts.isIdentifier(callee) &&
        callee.text === "structuredClone" &&
        node.arguments[0] !== undefined &&
        isStandInExpr(node.arguments[0], standIns)
      ) {
        hit(node, "structuredClone");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "postMessage" &&
        node.arguments.some((arg) => isStandInExpr(arg, standIns))
      ) {
        hit(node, "postMessage");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "hasOwnProperty" &&
        isStandInExpr(callee.expression, standIns)
      ) {
        hit(node, "hasOwnProperty");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "call" &&
        /hasOwnProperty$/.test(callee.expression.getText(source)) &&
        node.arguments[0] !== undefined &&
        isStandInExpr(node.arguments[0], standIns)
      ) {
        hit(node, "hasOwnProperty.call");
      }
    }
    if (
      ts.isSpreadAssignment(node) &&
      isStandInExpr(node.expression, standIns)
    ) {
      hit(node, "object spread");
    }
    if (ts.isForInStatement(node) && isStandInExpr(node.expression, standIns)) {
      hit(node, "for-in");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function shouldSkipListedPath(relative: string): boolean {
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  for (const segment of segments) {
    if (SKIP_DIR_NAMES.has(segment)) {
      return true;
    }
  }
  const base = segments[segments.length - 1];
  if (base === undefined) {
    return true;
  }
  return (
    base.endsWith(".d.ts") ||
    base.endsWith(".test.ts") ||
    base.endsWith(".test.tsx")
  );
}

function gitListedFiles(
  gitRoot: string,
  prefixes: readonly string[],
): string[] {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.ts",
      "*.tsx",
    ],
    { cwd: gitRoot, encoding: "utf8" },
  );
  const files: string[] = [];
  for (const relative of listing.split("\0")) {
    if (relative.length === 0 || shouldSkipListedPath(relative)) {
      continue;
    }
    const posix = relative.split(path.sep).join("/");
    if (!prefixes.some((prefix) => posix.startsWith(prefix))) {
      continue;
    }
    const full = path.join(gitRoot, relative);
    if (!existsSync(full)) {
      continue;
    }
    files.push(full);
  }
  return files;
}

describe("pending stand-in own-key operations", () => {
  it("finds Object.keys on a stand-in in an inline source string", () => {
    const lazyNames = new Set(["permissionModeSchema"]);
    const planted =
      'import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";\nvoid Object.keys(permissionModeSchema);\n';
    const hits = findStandinOpHitsInSource("planted.ts", planted, lazyNames);
    expect(hits.map((hit) => hit.what)).toEqual(["Object.keys"]);
    const commentOnly =
      'import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";\n// Object.keys(permissionModeSchema)\n';
    expect(
      findStandinOpHitsInSource("comment.ts", commentOnly, lazyNames),
    ).toEqual([]);
  });

  it("finds Object.keys on an exported alias using the collected name set", () => {
    const protocolFiles = gitListedFiles(TRAYCER_ROOT, ["protocol/src/"]);
    const lazyNames = collectLazyExportNames(protocolFiles);
    expect(lazyNames.has("userMessageSchema")).toBe(true);
    const planted =
      'import { userMessageSchema } from "@traycer/protocol/persistence/epic/messages";\nvoid Object.keys(userMessageSchema);\n';
    const hits = findStandinOpHitsInSource("planted.ts", planted, lazyNames);
    expect(hits.map((hit) => hit.what)).toEqual(["Object.keys"]);
  });

  it("production protocol and OSS client sources have zero stand-in own-key ops", () => {
    const protocolFiles = gitListedFiles(TRAYCER_ROOT, ["protocol/src/"]);
    expect(protocolFiles.length).toBeGreaterThan(0);
    const lazyNames = collectLazyExportNames(protocolFiles);
    expect(lazyNames.size).toBeGreaterThan(0);
    expect(lazyNames.has("permissionModeSchema")).toBe(true);

    const scanned = gitListedFiles(TRAYCER_ROOT, SCAN_PREFIXES);
    expect(scanned.length).toBeGreaterThan(0);
    const hits: StandinOpHit[] = [];
    for (const filePath of scanned) {
      const relative = path
        .relative(TRAYCER_ROOT, filePath)
        .split(path.sep)
        .join("/");
      hits.push(
        ...findStandinOpHitsInSource(
          relative,
          readFileSync(filePath, "utf8"),
          lazyNames,
        ),
      );
    }
    expect(hits).toEqual([]);
  });
});
