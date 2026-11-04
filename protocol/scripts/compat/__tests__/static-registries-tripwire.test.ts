import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { GIT_OUTPUT_MAX_BUFFER_BYTES } from "../../../../scripts/git-output-limit.cjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { STATIC_REGISTRIES } from "../static-registries";

/**
 * Fails when a `define*` registry factory is called from a production module
 * that `STATIC_REGISTRIES` does not name. Construction no longer walks
 * schemas, so a registry left off that list is never fully validated.
 *
 * The matcher walks the TypeScript AST. A regex would also match the factory
 * name in comments and docblocks (`defineVersionedRpcRegistry()`).
 */

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TRAYCER_ROOT = path.join(PROTOCOL_ROOT, "..");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "__tests__",
  "__fixtures__",
]);

const FACTORY_NAMES = new Set([
  "defineVersionedRpcRegistry",
  "defineFloorAwareVersionedRpcRegistry",
  "defineVersionedStreamRpcRegistry",
  "defineVersionedRecordRegistry",
]);

const LIST_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  "*.js",
  "*.mjs",
  "*.cjs",
] as const;

type RegistryKind = "unary-rpc" | "stream-rpc" | "record";

type FactoryCallSite = {
  readonly sourceFile: string;
  readonly kind: RegistryKind;
};

type FactoryNameViolation = {
  readonly sourceFile: string;
  readonly line: number;
  readonly what: string;
};

function kindForFactory(name: string): RegistryKind | null {
  if (
    name === "defineVersionedRpcRegistry" ||
    name === "defineFloorAwareVersionedRpcRegistry"
  ) {
    return "unary-rpc";
  }
  if (name === "defineVersionedStreamRpcRegistry") {
    return "stream-rpc";
  }
  if (name === "defineVersionedRecordRegistry") {
    return "record";
  }
  return null;
}

function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.name)
  ) {
    return node.expression.name.text;
  }
  return null;
}

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function isTestFileName(fileName: string): boolean {
  return (
    fileName.endsWith(".test.ts") ||
    fileName.endsWith(".test.tsx") ||
    fileName.endsWith(".test.mts") ||
    fileName.endsWith(".test.cts") ||
    fileName.endsWith(".test.js") ||
    fileName.endsWith(".test.mjs") ||
    fileName.endsWith(".test.cjs")
  );
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
  return base.endsWith(".d.ts") || isTestFileName(base);
}

function collectTypeScriptFiles(gitRoot: string): string[] {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...LIST_GLOBS,
    ],
    { maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES, cwd: gitRoot, encoding: "utf8" },
  );
  const files: string[] = [];
  for (const relative of listing.split("\0")) {
    if (relative.length === 0) {
      continue;
    }
    if (shouldSkipListedPath(relative)) {
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

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isProtocolFrameworkPath(sourceFile: string): boolean {
  const posix = sourceFile.split(path.sep).join("/");
  return (
    posix.includes("protocol/src/framework/") ||
    posix.startsWith("src/framework/")
  );
}

function isImportOrExportSpecifierNode(node: ts.Node): boolean {
  return (
    ts.isImportSpecifier(node) ||
    ts.isExportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isNamespaceExport(node) ||
    ts.isImportClause(node)
  );
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return false;
  }
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isBindingElement(parent) ||
      ts.isEnumMember(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

function isCallCalleeName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) {
    return false;
  }
  if (ts.isCallExpression(parent) && parent.expression === node) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return true;
  }
  return false;
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      ts.isTypeNode(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeParameterDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function findFactoryCallsInSource(
  sourceFile: string,
  text: string,
): FactoryCallSite[] {
  const source = ts.createSourceFile(
    sourceFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(sourceFile),
  );
  const sites: FactoryCallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null) {
        const kind = kindForFactory(name);
        if (kind !== null) {
          sites.push({ sourceFile, kind });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function findFactoryNameViolationsInSource(
  sourceFile: string,
  text: string,
): FactoryNameViolation[] {
  const source = ts.createSourceFile(
    sourceFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(sourceFile),
  );
  const violations: FactoryNameViolation[] = [];
  const hit = (node: ts.Node, what: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    violations.push({ sourceFile, line: line + 1, what });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && !node.isTypeOnly) {
      const imported = (node.propertyName ?? node.name).text;
      if (FACTORY_NAMES.has(imported) && node.name.text !== imported) {
        hit(node, "aliased-import");
      }
    }
    if (ts.isIdentifier(node) && FACTORY_NAMES.has(node.text)) {
      const parent = node.parent;
      if (
        parent !== undefined &&
        !isImportOrExportSpecifierNode(parent) &&
        !isDeclarationName(node) &&
        !isCallCalleeName(node) &&
        !isInTypePosition(node) &&
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !isProtocolFrameworkPath(sourceFile)
      ) {
        hit(node, "value-use");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

// Only 13 of the repo's 4,578 tracked TS/JS files contain any of the four
// factory names at all, so parsing every file to look for them is nearly
// all wasted work. A plain substring check is enough EXCEPT for a factory
// name written with a unicode identifier escape (`defineVersionedRpcRegistry`
// spelled with a `R` in place of an `R`, say): `node.text` is the
// UNESCAPED name, so the AST finders see it fine, but a substring check on
// the raw source would not - which would make the prefilter unsound rather
// than merely approximate. Catching any `\u` escape anywhere in the file
// keeps it sound at the cost of 94 extra files getting parsed - still ~50x
// fewer parses than the full file set.
const FACTORY_NAME_LIST = [...FACTORY_NAMES];

function needsParse(text: string): boolean {
  for (const name of FACTORY_NAME_LIST) {
    if (text.includes(name)) return true;
  }
  return text.includes("\\u");
}

type ProductionScanResult = {
  readonly files: readonly string[];
  readonly sites: FactoryCallSite[];
  readonly violations: FactoryNameViolation[];
  readonly parsedCount: number;
};

// One listing, one read, one parse per file - shared by both production
// tests below, which used to each run the full walk (list + read + parse)
// independently over the same 4,578 files.
function scanProduction(
  gitRoot: string,
  relativeTo: string,
): ProductionScanResult {
  const files = collectTypeScriptFiles(gitRoot);
  const sites: FactoryCallSite[] = [];
  const violations: FactoryNameViolation[] = [];
  let parsedCount = 0;
  for (const filePath of files) {
    const text = readFileSync(filePath, "utf8");
    if (!needsParse(text)) continue;
    parsedCount += 1;
    const relative = posixRelative(relativeTo, filePath);
    sites.push(...findFactoryCallsInSource(relative, text));
    violations.push(...findFactoryNameViolationsInSource(relative, text));
  }
  return { files, sites, violations, parsedCount };
}

function siteKey(site: FactoryCallSite): string {
  return `${site.sourceFile}\n${site.kind}`;
}

function sortedSiteKeys(
  sites: readonly { readonly sourceFile: string; readonly kind: string }[],
): string[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const key = `${site.sourceFile}\n${site.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => `${count}× ${key.replace("\n", " ")}`)
    .sort();
}

const HOST_REGISTRY_NAMES = new Set([
  "hostRpcRegistry",
  "hostStreamRpcRegistry",
]);
const HOST_REGISTRY_VALIDATORS = new Set([
  "validateVersionedRpcRegistry",
  "validateVersionedStreamRpcRegistry",
]);
const STATIC_REGISTRY_WALKERS = new Set([
  "findStaticRegistryFailures",
  "validateStaticRegistry",
]);
/** The one test file allowed to walk the host registries. */
const WHOLE_REGISTRY_HOME =
  "scripts/compat/__tests__/static-registries.test.ts";

function unwrapped(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
    ? unwrapped(node.expression)
    : node;
}

/** One file bound on its own, so TypeScript answers which declaration a name means. */
function bindSingleFile(source: ts.SourceFile): ts.TypeChecker {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    writeFile: () => undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    fileExists: (name) => name === source.fileName,
    readFile: () => undefined,
  };
  return ts
    .createProgram([source.fileName], { noLib: true, noResolve: true }, host)
    .getTypeChecker();
}

/**
 * The lines of a test file that hand a validator a whole host registry, a copy
 * of one, the static registry list, or any entry of that list, since every entry
 * can be a host registry. It resolves what a file can do to those in its own
 * text: rename an import, bind a value to a name in any scope and order,
 * destructure it, wrap it in a cast, spread it, `Object.assign` it, read it off a
 * namespace, index the list, loop over it, or hand its entries to a callback or
 * a validator passed by reference. A value that reaches a validator through a
 * function parameter or another module is out of its sight, and so is a loop
 * that hands a host registry's lines to a validator one at a time. A
 * destructured property is judged by its name, so a local object holding a
 * subset under a registry's name reads as whole: a false alarm, and a rename
 * clears it.
 */
function wholeHostRegistryValidationLines(
  fileName: string,
  text: string,
): number[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const checker = bindSingleFile(source);
  const validators = new Set([
    ...HOST_REGISTRY_VALIDATORS,
    ...STATIC_REGISTRY_WALKERS,
  ]);
  const isRegistryName = (name: string): boolean =>
    HOST_REGISTRY_NAMES.has(name) || name === "STATIC_REGISTRIES";

  // The exported name an expression comes from, following local bindings. A
  // name with no declaration in the file answers as itself; a parameter, or
  // anything else computed, answers null.
  const originName = (
    expression: ts.Expression,
    seen: ReadonlySet<ts.Symbol>,
  ): string | null => {
    const node = unwrapped(expression);
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (!ts.isIdentifier(node)) return null;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.[0];
    if (symbol === undefined || declaration === undefined) return node.text;
    if (seen.has(symbol)) return null;
    if (ts.isImportSpecifier(declaration)) {
      return (declaration.propertyName ?? declaration.name).text;
    }
    if (ts.isBindingElement(declaration)) {
      if (declaration.dotDotDotToken !== undefined) {
        const owner = declaration.parent.parent;
        return ts.isVariableDeclaration(owner) &&
          owner.initializer !== undefined
          ? originName(owner.initializer, new Set([...seen, symbol]))
          : null;
      }
      const bound = declaration.propertyName ?? declaration.name;
      return ts.isIdentifier(bound) ? bound.text : null;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      return originName(declaration.initializer, new Set([...seen, symbol]));
    }
    return null;
  };

  const isWhole = (
    expression: ts.Expression,
    seen: ReadonlySet<ts.Symbol>,
  ): boolean => {
    const origin = originName(expression, seen);
    if (origin !== null && isRegistryName(origin)) return true;
    const node = unwrapped(expression);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.declarations?.[0];
      return (
        symbol !== undefined &&
        declaration !== undefined &&
        !seen.has(symbol) &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        isWhole(declaration.initializer, new Set([...seen, symbol]))
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) && isWhole(property.expression, seen),
      );
    }
    if (ts.isCallExpression(node)) {
      return (
        node.expression.getText(source) === "Object.assign" &&
        node.arguments.some((argument) => isWhole(argument, seen))
      );
    }
    return false;
  };

  // The static registry list, or a copy of it.
  const isList = (
    expression: ts.Expression,
    seen: ReadonlySet<ts.Symbol>,
  ): boolean => {
    if (originName(expression, seen) === "STATIC_REGISTRIES") return true;
    const node = unwrapped(expression);
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some(
        (element) =>
          ts.isSpreadElement(element) && isList(element.expression, seen),
      );
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.declarations?.[0];
      return (
        symbol !== undefined &&
        declaration !== undefined &&
        !seen.has(symbol) &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        isList(declaration.initializer, new Set([...seen, symbol]))
      );
    }
    return false;
  };

  // A call of a method on the list, such as `.map`, `.forEach` or `.find`,
  // which hands each entry to its callback.
  const isListMethodCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    isList(node.expression.expression, new Set());

  // One entry of the list, or its registry: every entry can be a host
  // registry, so validating any one of them is a whole walk. An entry is read
  // by index, by `find` or `at`, by array destructuring, by `for…of`, or as a
  // callback's first parameter on a method of the list; its registry is read
  // as `.registry` or by destructuring `registry` from any of those.
  const isListEntry = (
    expression: ts.Expression,
    seen: ReadonlySet<ts.Symbol>,
  ): boolean => {
    const node = unwrapped(expression);
    if (ts.isElementAccessExpression(node))
      return isList(node.expression, seen);
    if (ts.isPropertyAccessExpression(node)) {
      return (
        node.name.text === "registry" && isListEntry(node.expression, seen)
      );
    }
    if (ts.isCallExpression(node)) {
      return (
        ts.isPropertyAccessExpression(node.expression) &&
        ["at", "find", "findLast"].includes(node.expression.name.text) &&
        isList(node.expression.expression, seen)
      );
    }
    if (!ts.isIdentifier(node)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.[0];
    if (symbol === undefined || declaration === undefined || seen.has(symbol)) {
      return false;
    }
    const next = new Set([...seen, symbol]);
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const owner = pattern.parent;
      if (ts.isArrayBindingPattern(pattern)) {
        // `const [first] = STATIC_REGISTRIES`
        return (
          declaration.dotDotDotToken === undefined &&
          ts.isVariableDeclaration(owner) &&
          owner.initializer !== undefined &&
          isList(owner.initializer, next)
        );
      }
      // `const { registry } = entry`, `for (const { registry } of list)`,
      // `({ registry }) => …`, or `const { ...copy } = entry`.
      const bound = declaration.propertyName ?? declaration.name;
      const takesEntryOrRegistry =
        declaration.dotDotDotToken !== undefined ||
        (ts.isIdentifier(bound) && bound.text === "registry");
      return (
        takesEntryOrRegistry &&
        (ts.isParameter(owner) || ts.isVariableDeclaration(owner)) &&
        bindsEntry(owner, next)
      );
    }
    return (
      (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) &&
      bindsEntry(declaration, next)
    );
  };

  // Whether a parameter or variable receives one entry of the list: the first
  // parameter of a callback on a method of the list, a `for…of` variable over
  // the list, or a variable initialised with an entry.
  const bindsEntry = (
    declaration: ts.ParameterDeclaration | ts.VariableDeclaration,
    seen: ReadonlySet<ts.Symbol>,
  ): boolean => {
    if (ts.isParameter(declaration)) {
      const callback = declaration.parent;
      return (
        callback.parameters[0] === declaration &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        isListMethodCall(callback.parent)
      );
    }
    const statement = declaration.parent.parent;
    if (ts.isForOfStatement(statement)) {
      return isList(statement.expression, seen);
    }
    return (
      declaration.initializer !== undefined &&
      isListEntry(declaration.initializer, seen)
    );
  };

  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const validator = originName(node.expression, new Set());
      const argument = node.arguments[0];
      const handsOverWhole =
        validator !== null &&
        validators.has(validator) &&
        argument !== undefined &&
        (isWhole(argument, new Set()) || isListEntry(argument, new Set()));
      // `STATIC_REGISTRIES.forEach(validateStaticRegistry)`: a validator
      // passed by reference to a method of the list.
      const passesValidator =
        isListMethodCall(node) &&
        node.arguments.some((callback) => {
          const name = originName(callback, new Set());
          return name !== null && validators.has(name);
        });
      if (handsOverWhole || passesValidator) {
        lines.push(
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("the one whole-registry validation", () => {
  // A walk of a host registry costs about a second of CPU per call, under the
  // file budget, so the budget would not see a new one. `static-registries.test.ts`
  // holds the one walk, through `STATIC_REGISTRIES`; a test validates the lines
  // it claims, as `{ [method]: hostRpcRegistry[method] }`.
  it("no test file but its home validates a whole host registry", () => {
    const listing = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.test.ts",
      ],
      {
        maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
        cwd: PROTOCOL_ROOT,
        encoding: "utf8",
      },
    );
    const found: string[] = [];
    let homeWalks = 0;
    for (const relative of listing.split("\0")) {
      const full = path.join(PROTOCOL_ROOT, relative);
      if (relative.length === 0 || !existsSync(full)) continue;
      const text = readFileSync(full, "utf8");
      if (
        !text.includes("validateVersioned") &&
        !text.includes("StaticRegistr") &&
        !text.includes("STATIC_REGISTRIES")
      ) {
        continue;
      }
      const lines = wholeHostRegistryValidationLines(relative, text);
      if (relative === WHOLE_REGISTRY_HOME) {
        homeWalks = lines.length;
        continue;
      }
      found.push(...lines.map((line) => `${relative}:${String(line)}`));
    }
    expect(found).toEqual([]);
    expect(homeWalks).toBe(1);
  });

  it.each([
    ["the unary registry", "validateVersionedRpcRegistry(hostRpcRegistry);", 1],
    [
      "the stream registry inside an assertion",
      "expect(() => validateVersionedStreamRpcRegistry(hostStreamRpcRegistry)).not.toThrow();",
      1,
    ],
    [
      "a spread copy",
      'validateVersionedRpcRegistry({ ...hostRpcRegistry, "a.b": line });',
      1,
    ],
    [
      "a renamed import",
      'import { hostRpcRegistry as registry } from "x"; validateVersionedRpcRegistry(registry);',
      1,
    ],
    [
      "a copy bound to a name",
      "const registry = { ...hostRpcRegistry }; validateVersionedRpcRegistry(registry);",
      1,
    ],
    [
      "an alias of an alias",
      "const a = hostRpcRegistry; const b = a; validateVersionedRpcRegistry(b);",
      1,
    ],
    [
      "a parenthesised cast",
      "validateVersionedRpcRegistry((hostRpcRegistry as never));",
      1,
    ],
    [
      "Object.assign",
      "validateVersionedRpcRegistry(Object.assign({}, hostRpcRegistry));",
      1,
    ],
    [
      "a namespace read",
      "validateVersionedRpcRegistry(host.hostRpcRegistry);",
      1,
    ],
    [
      "a renamed validator",
      'import { validateVersionedRpcRegistry as check } from "x"; check(hostRpcRegistry);',
      1,
    ],
    [
      "a validator bound to a name",
      "const check = validateVersionedRpcRegistry; check(hostRpcRegistry);",
      1,
    ],
    [
      "a namespace validator",
      "framework.validateVersionedRpcRegistry(hostRpcRegistry);",
      1,
    ],
    [
      "the static registry list",
      "findStaticRegistryFailures(STATIC_REGISTRIES);",
      1,
    ],
    [
      "a destructured registry",
      "const { hostRpcRegistry: r } = mod; validateVersionedRpcRegistry(r);",
      1,
    ],
    [
      "a rest copy of the registry",
      "const { ...registry } = hostRpcRegistry; validateVersionedRpcRegistry(registry);",
      1,
    ],
    [
      "a loop over the static registry list",
      "for (const entry of STATIC_REGISTRIES) validateStaticRegistry(entry);",
      1,
    ],
    [
      "a callback on the list",
      "STATIC_REGISTRIES.map((entry) => validateStaticRegistry(entry));",
      1,
    ],
    [
      "a function callback on a renamed list",
      'import { STATIC_REGISTRIES as list } from "x"; list.forEach(function (entry) { validateStaticRegistry(entry); });',
      1,
    ],
    [
      "a validator passed by reference to the list",
      "STATIC_REGISTRIES.forEach(validateStaticRegistry);",
      1,
    ],
    [
      "an entry read by index",
      "validateStaticRegistry(STATIC_REGISTRIES[0]);",
      1,
    ],
    [
      "an entry found by name",
      'validateStaticRegistry(STATIC_REGISTRIES.find((entry) => entry.name === "hostRpcRegistry")!);',
      1,
    ],
    [
      "an entry destructured from the list",
      "const [first] = STATIC_REGISTRIES; validateStaticRegistry(first);",
      1,
    ],
    [
      "an entry's registry, looping over a copy of the list",
      "for (const entry of [...STATIC_REGISTRIES]) validateVersionedRpcRegistry(entry.registry);",
      1,
    ],
    [
      "an entry's registry destructured in a loop",
      'for (const entry of STATIC_REGISTRIES) { if (entry.kind === "unary-rpc") { const { registry } = entry; validateVersionedRpcRegistry(registry); } }',
      1,
    ],
    [
      "a registry destructured by the loop",
      'for (const { kind, registry } of STATIC_REGISTRIES) { if (kind === "unary-rpc") validateVersionedRpcRegistry(registry); }',
      1,
    ],
    [
      "a registry destructured by a callback",
      "STATIC_REGISTRIES.forEach(({ registry }) => validateVersionedRpcRegistry(registry));",
      1,
    ],
    [
      "a rest copy of an entry",
      "const { ...copy } = STATIC_REGISTRIES[0]; validateStaticRegistry(copy);",
      1,
    ],
    [
      "a registry destructured from a test's own entry",
      "const { registry } = planted; validateVersionedRpcRegistry(registry);",
      0,
    ],
    [
      "a callback on the list that validates nothing",
      "STATIC_REGISTRIES.map((entry) => entry.name);",
      0,
    ],
    [
      "a loop over the test's own entries",
      "for (const entry of planted) validateStaticRegistry(entry);",
      0,
    ],
    [
      "a binding declared after the call that reads it",
      "function check() { validateVersionedRpcRegistry(registry); } const registry = hostRpcRegistry; check();",
      1,
    ],
    [
      "the same local name meaning a subset in another scope",
      'it("a", () => { const registry = hostRpcRegistry; expect(registry).toBeDefined(); }); it("b", () => { const registry = { "a.b": hostRpcRegistry["a.b"] }; validateVersionedRpcRegistry(registry); });',
      0,
    ],
    [
      "a parameter that shadows the name",
      "function check(hostRpcRegistry: Lines) { validateVersionedRpcRegistry(hostRpcRegistry); }",
      0,
    ],
    [
      "bindings that refer to each other",
      "const a = b; const b = a; validateVersionedRpcRegistry(a);",
      0,
    ],
    [
      "the lines a test claims",
      'validateVersionedRpcRegistry({ "a.b": hostRpcRegistry["a.b"] });',
      0,
    ],
    [
      "a registry of the test's own",
      "validateVersionedRpcRegistry(registry);",
      0,
    ],
    [
      "a planted entry among the record registries",
      "findStaticRegistryFailures(plantedAmongRecords(entry));",
      0,
    ],
  ] as const)("counts %s", (_name, text, count) => {
    expect(wholeHostRegistryValidationLines("t.test.ts", text)).toHaveLength(
      count,
    );
  });
});

describe("static registry tripwire", () => {
  it("finds a factory CallExpression and ignores the name in a comment", () => {
    expect(
      findFactoryCallsInSource(
        "inline.ts",
        "export const registry = defineVersionedRpcRegistry({ ping: {} });\n",
      ),
    ).toEqual([{ sourceFile: "inline.ts", kind: "unary-rpc" }]);
    expect(
      findFactoryCallsInSource(
        "inline.ts",
        "// defineVersionedRpcRegistry() runs at module load\nconst x = 1;\n",
      ),
    ).toEqual([]);
  });

  it("an aliased factory import plus a call is one violation", () => {
    const planted =
      'import { defineVersionedRecordRegistry as mk } from "./x";\nexport const registry = mk({ ping: {} });\n';
    expect(
      findFactoryNameViolationsInSource("inline.ts", planted),
    ).toHaveLength(1);
  });

  it("a factory passed as a value is one violation", () => {
    expect(
      findFactoryNameViolationsInSource(
        "inline.ts",
        "const x = items.map(defineVersionedRecordRegistry);\n",
      ),
    ).toHaveLength(1);
  });

  it("the same value reference under protocol/src/framework/ is not a violation", () => {
    expect(
      findFactoryNameViolationsInSource(
        "protocol/src/framework/x.ts",
        "const x = items.map(defineVersionedRecordRegistry);\n",
      ),
    ).toEqual([]);
  });

  it("finds a factory call in a .mjs inline source", () => {
    expect(
      findFactoryCallsInSource(
        "inline.mjs",
        "export const registry = defineVersionedRpcRegistry({ ping: {} });\n",
      ),
    ).toEqual([{ sourceFile: "inline.mjs", kind: "unary-rpc" }]);
  });

  it("the lister's filter rejects a __fixtures__ path", () => {
    expect(shouldSkipListedPath("src/__fixtures__/registry.ts")).toBe(true);
    expect(shouldSkipListedPath("protocol/src/auth/registry.ts")).toBe(false);
  });

  describe("production scan (shared pass)", () => {
    // Measured directly on this development machine (logged once while
    // developing this shared pass, then the log removed): the single
    // list+read+parse-filtered pass over the repo's 4,578 tracked files
    // completed in 500-950 ms across three runs, replacing two independent
    // ~2.9-3.9 s passes (each parsing every file). The suite's OLD per-test
    // cost (no shared pass, no prefilter) measured ~4 s on this machine and
    // 8.3-9.2 s on the CI runner - a ~2.2x slowdown factor. Applying that
    // factor to the high end of the NEW shared-pass measurement gives an
    // expected CI cost of ~950 ms * 2.2 ~= 2,090 ms for the one pass both
    // tests now share. The hook timeout below is 5x that expectation,
    // rounded, for headroom.
    const MEASURED_LOCAL_SHARED_SCAN_MS = 950;
    const CI_SLOWDOWN_FACTOR = 2.2;
    const EXPECTED_CI_SHARED_SCAN_MS = Math.round(
      MEASURED_LOCAL_SHARED_SCAN_MS * CI_SLOWDOWN_FACTOR,
    );
    const SHARED_SCAN_HOOK_TIMEOUT_MS = EXPECTED_CI_SHARED_SCAN_MS * 5;

    let scan: ProductionScanResult;

    beforeAll(() => {
      scan = scanProduction(TRAYCER_ROOT, PROTOCOL_ROOT);
    }, SHARED_SCAN_HOOK_TIMEOUT_MS);

    it("production has no aliased factory imports and no factory value uses outside framework", () => {
      expect(scan.violations).toEqual([]);
    });

    it("the production call-site multiset equals STATIC_REGISTRIES", () => {
      expect(scan.files.length).toBeGreaterThan(0);
      expect(scan.files).toContain(
        path.join(TRAYCER_ROOT, "protocol/src/auth/registry.ts"),
      );

      const plantedSites = findFactoryCallsInSource(
        "src/planted-unlisted.ts",
        "export const registry = defineVersionedRpcRegistry({ ping: {} });\n",
      );
      expect(plantedSites).toHaveLength(1);
      const planted = plantedSites[0];
      if (planted === undefined) {
        throw new Error("expected one planted factory call");
      }
      expect(siteKey(planted)).toBe("src/planted-unlisted.ts\nunary-rpc");

      const expected = STATIC_REGISTRIES.map((entry) => ({
        sourceFile: entry.sourceFile,
        kind: entry.kind,
      }));
      expect(sortedSiteKeys(scan.sites)).toEqual(sortedSiteKeys(expected));
      expect(sortedSiteKeys([...scan.sites, planted])).not.toEqual(
        sortedSiteKeys(expected),
      );
    });

    it("the prefilter is safe to trust: it parses a small minority of files, and yields the same sites/violations the two tests above already pinned", () => {
      expect(scan.parsedCount).toBeGreaterThan(0);
      expect(scan.parsedCount).toBeLessThan(scan.files.length * 0.05);
      expect(scan.violations).toEqual([]);
      const expected = STATIC_REGISTRIES.map((entry) => ({
        sourceFile: entry.sourceFile,
        kind: entry.kind,
      }));
      expect(sortedSiteKeys(scan.sites)).toEqual(sortedSiteKeys(expected));
    });
  });
});

describe("needsParse: prefilter (pure)", () => {
  it("a text containing each factory name needs a parse", () => {
    for (const name of FACTORY_NAME_LIST) {
      expect(needsParse(`export const x = ${name}({});\n`)).toBe(true);
    }
  });

  it("defineVersionedRpcRegistry({}) needs a parse, AND findFactoryCallsInSource finds the site - the control showing why the clause exists", () => {
    const text = "export const registry = defineVersionedRpcRegistry({});\n";
    expect(needsParse(text)).toBe(true);
    expect(findFactoryCallsInSource("inline.ts", text)).toEqual([
      { sourceFile: "inline.ts", kind: "unary-rpc" },
    ]);
  });

  it("a unicode-escaped identifier needs a parse even when no factory name appears as a literal substring", () => {
    // A `\u` escape can hide any identifier, including a factory name TS
    // would still resolve at parse time via the unescaped `node.text`. No
    // factory name is a literal substring here, so this is exactly the
    // case the `\u` clause exists to keep the prefilter sound for.
    const text = "export const registry = \\u0064oSomething({});\n";
    expect(needsParse(text)).toBe(true);
  });

  it("an ordinary file with neither a factory name nor a unicode escape does not need a parse", () => {
    expect(
      needsParse(
        "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      ),
    ).toBe(false);
  });
});
