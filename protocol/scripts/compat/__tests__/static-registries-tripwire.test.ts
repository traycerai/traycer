import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
    { cwd: gitRoot, encoding: "utf8" },
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

function scanFactoryCalls(
  gitRoot: string,
  relativeTo: string,
): { readonly files: readonly string[]; readonly sites: FactoryCallSite[] } {
  const files = collectTypeScriptFiles(gitRoot);
  const sites: FactoryCallSite[] = [];
  for (const filePath of files) {
    const relative = posixRelative(relativeTo, filePath);
    sites.push(
      ...findFactoryCallsInSource(relative, readFileSync(filePath, "utf8")),
    );
  }
  return { files, sites };
}

function scanFactoryNameViolations(
  gitRoot: string,
  relativeTo: string,
): FactoryNameViolation[] {
  const files = collectTypeScriptFiles(gitRoot);
  const violations: FactoryNameViolation[] = [];
  for (const filePath of files) {
    const relative = posixRelative(relativeTo, filePath);
    violations.push(
      ...findFactoryNameViolationsInSource(
        relative,
        readFileSync(filePath, "utf8"),
      ),
    );
  }
  return violations;
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

  it("production has no aliased factory imports and no factory value uses outside framework", () => {
    const violations = scanFactoryNameViolations(TRAYCER_ROOT, PROTOCOL_ROOT);
    expect(violations).toEqual([]);
  });

  it("the production call-site multiset equals STATIC_REGISTRIES", () => {
    const scanned = scanFactoryCalls(TRAYCER_ROOT, PROTOCOL_ROOT);
    expect(scanned.files.length).toBeGreaterThan(0);
    expect(scanned.files).toContain(
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
    expect(sortedSiteKeys(scanned.sites)).toEqual(sortedSiteKeys(expected));
    expect(sortedSiteKeys([...scanned.sites, planted])).not.toEqual(
      sortedSiteKeys(expected),
    );
  });
});
