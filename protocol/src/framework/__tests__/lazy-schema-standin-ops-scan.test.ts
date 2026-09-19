import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Predicate (a) of scan-standin-ops.cjs: a hit is an operand X that is a
 * stand-in expression appearing DIRECTLY as:
 *   - the argument of Object.keys / values / entries / getOwnPropertyNames /
 *     getOwnPropertySymbols / getOwnPropertyDescriptor(s) / getPrototypeOf /
 *     setPrototypeOf / freeze / seal / isFrozen / hasOwn, Reflect.ownKeys /
 *     getPrototypeOf / getOwnPropertyDescriptor, structuredClone, any
 *     `.postMessage(`, v8.serialize / `serialize` imported from node:v8
 *   - any source argument of Object.assign (position >= 1)
 *   - the target of Object.defineProperty
 *   - `workerData` on `new Worker(..., { workerData })`
 *   - a spread in an object literal `{ ...X }`
 *   - the object of `for (k in X)`
 *   - `X.hasOwnProperty(` / `Object.prototype.hasOwnProperty.call(X`
 * A stand-in expression is a binding resolved to a stand-in (an imported
 * protocol export declared `= lazySchema(`, an exported alias of one of
 * those, a local `= lazySchema(` const, or a local alias of either), a
 * namespace-import member (`ns.fooSchema`), a property read whose name is a
 * stand-in export or a contract slot (`contract.requestSchema`,
 * `x.responseSchema`), or an element of a known stand-in array.
 * `X.shape`, `X.options`, `X.parse(...)` are not hits: reading a property
 * materialises the stand-in first. `JSON.stringify` is not a hit either: it
 * reads `toJSON` through the prototype and builds first. This test does not
 * apply predicate (b) (the /schema$/i name heuristic).
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
  "clients/mobile",
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
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "setPrototypeOf",
  "freeze",
  "seal",
  "isFrozen",
  "hasOwn",
]);
const REFLECT_FNS = new Set([
  "ownKeys",
  "getPrototypeOf",
  "getOwnPropertyDescriptor",
]);
const CONTRACT_SLOTS = new Set(["requestSchema", "responseSchema"]);

const STANDIN_IMPORT =
  'import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";\n';
const PLANTED_LAZY_NAMES = new Set(["permissionModeSchema"]);

type StandinOpHit = {
  readonly sourceFile: string;
  readonly line: number;
  readonly what: string;
};

type StandInScanContext = {
  readonly standIns: Set<string>;
  readonly namespaceImports: Set<string>;
  readonly standInArrays: Set<string>;
  readonly v8Namespaces: Set<string>;
  readonly v8SerializeBindings: Set<string>;
  readonly lazyExportNames: ReadonlySet<string>;
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

function importSpecifierText(stmt: ts.ImportDeclaration): string | null {
  if (ts.isStringLiteral(stmt.moduleSpecifier)) {
    return stmt.moduleSpecifier.text;
  }
  return null;
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

function isStandInExpr(
  expression: ts.Expression,
  ctx: StandInScanContext,
): boolean {
  const inner = unwrap(expression);
  if (ts.isIdentifier(inner) && ctx.standIns.has(inner.text)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(inner)) {
    const name = inner.name.text;
    const obj = unwrap(inner.expression);
    if (
      ts.isIdentifier(obj) &&
      ctx.namespaceImports.has(obj.text) &&
      ctx.lazyExportNames.has(name)
    ) {
      return true;
    }
    if (ctx.lazyExportNames.has(name) || CONTRACT_SLOTS.has(name)) {
      return true;
    }
  }
  if (ts.isElementAccessExpression(inner)) {
    const arr = unwrap(inner.expression);
    if (ts.isIdentifier(arr) && ctx.standInArrays.has(arr.text)) {
      return true;
    }
  }
  return false;
}

function isStandInArrayLiteral(
  expression: ts.Expression,
  ctx: StandInScanContext,
): boolean {
  const inner = unwrap(expression);
  if (!ts.isArrayLiteralExpression(inner) || inner.elements.length === 0) {
    return false;
  }
  for (const element of inner.elements) {
    if (ts.isSpreadElement(element) || !isStandInExpr(element, ctx)) {
      return false;
    }
  }
  return true;
}

function collectStandInContext(
  source: ts.SourceFile,
  lazyExportNames: ReadonlySet<string>,
): StandInScanContext {
  const ctx: StandInScanContext = {
    standIns: new Set(),
    namespaceImports: new Set(),
    standInArrays: new Set(),
    v8Namespaces: new Set(),
    v8SerializeBindings: new Set(),
    lazyExportNames,
  };
  for (const stmt of source.statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      stmt.importClause === undefined ||
      stmt.importClause.isTypeOnly
    ) {
      continue;
    }
    const specifier = importSpecifierText(stmt);
    const isNodeV8 = specifier === "node:v8";
    if (stmt.importClause.name !== undefined && isNodeV8) {
      ctx.v8Namespaces.add(stmt.importClause.name.text);
    }
    const bindings = stmt.importClause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      ctx.namespaceImports.add(bindings.name.text);
      if (isNodeV8) {
        ctx.v8Namespaces.add(bindings.name.text);
      }
      continue;
    }
    if (!ts.isNamedImports(bindings)) {
      continue;
    }
    for (const el of bindings.elements) {
      if (el.isTypeOnly) {
        continue;
      }
      const orig = (el.propertyName ?? el.name).text;
      if (lazyExportNames.has(orig)) {
        ctx.standIns.add(el.name.text);
      }
      if (isNodeV8 && orig === "serialize") {
        ctx.v8SerializeBindings.add(el.name.text);
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
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
          continue;
        }
        const inner = unwrap(decl.initializer);
        if (!ctx.standIns.has(decl.name.text)) {
          if (isLazySchemaCall(inner) || isStandInExpr(inner, ctx)) {
            ctx.standIns.add(decl.name.text);
            grew = true;
          }
        }
        if (
          !ctx.standInArrays.has(decl.name.text) &&
          isStandInArrayLiteral(inner, ctx)
        ) {
          ctx.standInArrays.add(decl.name.text);
          grew = true;
        }
      }
    }
  }
  return ctx;
}

function isWorkerConstructor(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  if (ts.isIdentifier(inner) && inner.text === "Worker") {
    return true;
  }
  return ts.isPropertyAccessExpression(inner) && inner.name.text === "Worker";
}

function workerDataIsStandIn(
  options: ts.Expression,
  ctx: StandInScanContext,
): boolean {
  const inner = unwrap(options);
  if (!ts.isObjectLiteralExpression(inner)) {
    return false;
  }
  for (const prop of inner.properties) {
    if (
      ts.isShorthandPropertyAssignment(prop) &&
      prop.name.text === "workerData" &&
      isStandInExpr(prop.name, ctx)
    ) {
      return true;
    }
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "workerData" &&
      isStandInExpr(prop.initializer, ctx)
    ) {
      return true;
    }
  }
  return false;
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
  const ctx = collectStandInContext(source, lazyExportNames);
  const hits: StandinOpHit[] = [];
  const hit = (node: ts.Node, what: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    hits.push({ sourceFile, line: line + 1, what });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isWorkerConstructor(node.expression)) {
      const options =
        node.arguments === undefined ? undefined : node.arguments[1];
      if (options !== undefined && workerDataIsStandIn(options, ctx)) {
        hit(node, "Worker workerData");
      }
    }
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
          isStandInExpr(first, ctx)
        ) {
          hit(node, `Object.${fn}`);
        }
        if (
          obj === "Object" &&
          fn === "assign" &&
          node.arguments.slice(1).some((arg) => isStandInExpr(arg, ctx))
        ) {
          hit(node, "Object.assign source");
        }
        if (
          obj === "Object" &&
          fn === "defineProperty" &&
          first !== undefined &&
          isStandInExpr(first, ctx)
        ) {
          hit(node, "Object.defineProperty target");
        }
        if (
          obj === "Reflect" &&
          REFLECT_FNS.has(fn) &&
          first !== undefined &&
          isStandInExpr(first, ctx)
        ) {
          hit(node, `Reflect.${fn}`);
        }
        if (
          ctx.v8Namespaces.has(obj) &&
          fn === "serialize" &&
          first !== undefined &&
          isStandInExpr(first, ctx)
        ) {
          hit(node, "v8.serialize");
        }
      }
      if (
        ts.isIdentifier(callee) &&
        ctx.v8SerializeBindings.has(callee.text) &&
        node.arguments[0] !== undefined &&
        isStandInExpr(node.arguments[0], ctx)
      ) {
        hit(node, "serialize");
      }
      if (
        ts.isIdentifier(callee) &&
        callee.text === "structuredClone" &&
        node.arguments[0] !== undefined &&
        isStandInExpr(node.arguments[0], ctx)
      ) {
        hit(node, "structuredClone");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "postMessage" &&
        node.arguments.some((arg) => isStandInExpr(arg, ctx))
      ) {
        hit(node, "postMessage");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "hasOwnProperty" &&
        isStandInExpr(callee.expression, ctx)
      ) {
        hit(node, "hasOwnProperty");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "call" &&
        /hasOwnProperty$/.test(callee.expression.getText(source)) &&
        node.arguments[0] !== undefined &&
        isStandInExpr(node.arguments[0], ctx)
      ) {
        hit(node, "hasOwnProperty.call");
      }
    }
    if (ts.isSpreadAssignment(node) && isStandInExpr(node.expression, ctx)) {
      hit(node, "object spread");
    }
    if (ts.isForInStatement(node) && isStandInExpr(node.expression, ctx)) {
      hit(node, "for-in");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function plantedWhats(source: string): readonly string[] {
  return findStandinOpHitsInSource(
    "planted.ts",
    source,
    PLANTED_LAZY_NAMES,
  ).map((hit) => hit.what);
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
    const planted = `${STANDIN_IMPORT}void Object.keys(permissionModeSchema);\n`;
    expect(plantedWhats(planted)).toEqual(["Object.keys"]);
    const commentOnly = `${STANDIN_IMPORT}// Object.keys(permissionModeSchema)\n`;
    expect(plantedWhats(commentOnly)).toEqual([]);
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

  it("finds one planted control per predicate branch", () => {
    expect(
      plantedWhats(`${STANDIN_IMPORT}void ({ ...permissionModeSchema });\n`),
    ).toEqual(["object spread"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}for (const k in permissionModeSchema) {\n  void k;\n}\n`,
      ),
    ).toEqual(["for-in"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void permissionModeSchema.hasOwnProperty("x");\n`,
      ),
    ).toEqual(["hasOwnProperty"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Object.prototype.hasOwnProperty.call(permissionModeSchema, "x");\n`,
      ),
    ).toEqual(["hasOwnProperty.call"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Object.assign({}, permissionModeSchema);\n`,
      ),
    ).toEqual(["Object.assign source"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void structuredClone(permissionModeSchema);\n`,
      ),
    ).toEqual(["structuredClone"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void port.postMessage(permissionModeSchema);\n`,
      ),
    ).toEqual(["postMessage"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Reflect.ownKeys(permissionModeSchema);\n`,
      ),
    ).toEqual(["Reflect.ownKeys"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Reflect.getPrototypeOf(permissionModeSchema);\n`,
      ),
    ).toEqual(["Reflect.getPrototypeOf"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Reflect.getOwnPropertyDescriptor(permissionModeSchema, "x");\n`,
      ),
    ).toEqual(["Reflect.getOwnPropertyDescriptor"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Object.getOwnPropertyDescriptor(permissionModeSchema, "x");\n`,
      ),
    ).toEqual(["Object.getOwnPropertyDescriptor"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}import v8 from "node:v8";\nvoid v8.serialize(permissionModeSchema);\n`,
      ),
    ).toEqual(["v8.serialize"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}import { serialize } from "node:v8";\nvoid serialize(permissionModeSchema);\n`,
      ),
    ).toEqual(["serialize"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}const workerData = permissionModeSchema;\nnew Worker("w.js", { workerData });\n`,
      ),
    ).toEqual(["Worker workerData"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void Object.defineProperty(permissionModeSchema, "k", { value: 1 });\n`,
      ),
    ).toEqual(["Object.defineProperty target"]);
    expect(
      plantedWhats(
        'import * as ns from "@traycer/protocol/persistence/epic/foundation";\nvoid Object.keys(ns.permissionModeSchema);\n',
      ),
    ).toEqual(["Object.keys"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}const bag = { permissionModeSchema };\nvoid Object.keys(bag.permissionModeSchema);\n`,
      ),
    ).toEqual(["Object.keys"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}const contract = { requestSchema: permissionModeSchema };\nvoid Object.keys(contract.requestSchema);\n`,
      ),
    ).toEqual(["Object.keys"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}const x = { responseSchema: permissionModeSchema };\nvoid Object.keys(x.responseSchema);\n`,
      ),
    ).toEqual(["Object.keys"]);
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}const schemas = [permissionModeSchema];\nvoid Object.keys(schemas[0]);\n`,
      ),
    ).toEqual(["Object.keys"]);
  });

  it("does not treat JSON.stringify as a stand-in own-key op", () => {
    expect(
      plantedWhats(
        `${STANDIN_IMPORT}void JSON.stringify(permissionModeSchema);\n`,
      ),
    ).toEqual([]);
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
  }, 30_000);
});
