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

type RegistryKind = "unary-rpc" | "stream-rpc" | "record";

type FactoryCallSite = {
  readonly sourceFile: string;
  readonly kind: RegistryKind;
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

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function isTestFileName(fileName: string): boolean {
  return fileName.endsWith(".test.ts") || fileName.endsWith(".test.tsx");
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
      "*.ts",
      "*.tsx",
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
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
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
        if (kind !== null && enclosingFunctionName(node) !== name) {
          sites.push({ sourceFile, kind });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
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

  it("the production call-site multiset equals STATIC_REGISTRIES", () => {
    const scanned = scanFactoryCalls(TRAYCER_ROOT, PROTOCOL_ROOT);
    expect(scanned.files.length).toBeGreaterThan(0);
    expect(scanned.sites.length).toBeGreaterThanOrEqual(5);

    const expected = STATIC_REGISTRIES.map((entry) => ({
      sourceFile: entry.sourceFile,
      kind: entry.kind,
    }));
    expect(sortedSiteKeys(scanned.sites)).toEqual(sortedSiteKeys(expected));

    const extra: FactoryCallSite = {
      sourceFile: "src/not-in-manifest.ts",
      kind: "unary-rpc",
    };
    expect(sortedSiteKeys([...scanned.sites, extra])).not.toEqual(
      sortedSiteKeys(expected),
    );
    expect(siteKey(extra)).toBe("src/not-in-manifest.ts\nunary-rpc");
  });
});
