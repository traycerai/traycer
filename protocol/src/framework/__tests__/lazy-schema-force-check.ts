import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ForceCheck = {
  readonly refused: boolean;
  readonly refusalMessage: string;
  readonly missingOnStandIn: readonly string[];
  readonly extraOnStandIn: readonly string[];
  readonly traitsEqual: boolean;
  readonly registryEqual: boolean;
};

export type ZeroCountFile = {
  readonly file: string;
  readonly reason: string;
};

function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
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

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function hasFunctionLikeAncestor(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isFunctionLike(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isLazySchemaCallee(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  if (ts.isIdentifier(inner)) {
    return inner.text === "lazySchema";
  }
  return (
    ts.isPropertyAccessExpression(inner) && inner.name.text === "lazySchema"
  );
}

export function firstFrameOutsideLazySchema(
  stack: string | undefined,
  extraSkip: readonly string[],
): string {
  if (stack === undefined) {
    return "unknown";
  }
  for (const line of stack.split("\n")) {
    if (line.includes("lazy-schema.ts")) {
      continue;
    }
    if (extraSkip.some((skip) => line.includes(skip))) {
      continue;
    }
    if (line.includes("node:")) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("Error") || trimmed.length === 0) {
      continue;
    }
    return trimmed;
  }
  return "unknown";
}

function shouldSkipListedPath(relative: string): boolean {
  const posix = relative.split(path.sep).join("/");
  for (const segment of posix.split("/")) {
    if (
      segment === "__tests__" ||
      segment === "__fixtures__" ||
      segment === "__mocks__" ||
      segment === "node_modules"
    ) {
      return true;
    }
  }
  return posix.endsWith(".d.ts") || posix.endsWith(".test.ts");
}

export function listLazySchemaModules(
  gitRoot: string,
  prefixes: readonly string[],
  pathspecs: readonly string[],
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
      ...pathspecs,
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
    if (!readFileSync(full, "utf8").includes("lazySchema(")) {
      continue;
    }
    files.push(full);
  }
  return files;
}

export function countModuleScopeLazySchemaCalls(fileAbs: string): number {
  const text = readFileSync(fileAbs, "utf8");
  const source = ts.createSourceFile(
    fileAbs,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileAbs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isLazySchemaCallee(node.expression) &&
      !hasFunctionLikeAncestor(node)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

export function recordedCountForFile(
  recorded: readonly { readonly site: string }[],
  fileAbs: string,
  posix: string,
): number {
  let count = 0;
  for (const entry of recorded) {
    if (entry.site.includes(fileAbs) || entry.site.includes(posix)) {
      count += 1;
    }
  }
  return count;
}

export function sameEntry(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (!isObject(a) || !isObject(b)) {
    return false;
  }
  const keys = Reflect.ownKeys(a);
  return (
    keys.length === Reflect.ownKeys(b).length &&
    keys.every(
      (key) =>
        Reflect.getOwnPropertyDescriptor(b, key) !== undefined &&
        Object.is(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

export function registryPair(schema: object): {
  has: boolean;
  entry: unknown;
} {
  const registry: unknown = Reflect.get(globalThis, "__zod_globalRegistry");
  if (!isObject(registry)) {
    return { has: false, entry: undefined };
  }
  const hasFn: unknown = Reflect.get(registry, "has");
  const getFn: unknown = Reflect.get(registry, "get");
  if (typeof hasFn !== "function" || typeof getFn !== "function") {
    return { has: false, entry: undefined };
  }
  return {
    has: Reflect.apply(hasFn, registry, [schema]) === true,
    entry: Reflect.apply(getFn, registry, [schema]),
  };
}

function missingKeys(from: object, onto: object): string[] {
  const missing: string[] = [];
  for (const key of Reflect.ownKeys(from)) {
    if (!Reflect.has(onto, key)) {
      missing.push(String(key));
    }
  }
  return missing;
}

export function checkForcedStandIn(
  standIn: object,
  build: () => object,
): ForceCheck {
  try {
    void Reflect.get(standIn, "_zod");
  } catch (error) {
    return {
      refused: true,
      refusalMessage: error instanceof Error ? error.message : String(error),
      missingOnStandIn: [],
      extraOnStandIn: [],
      traitsEqual: false,
      registryEqual: false,
    };
  }
  const twin = build();
  const standZod: unknown = Reflect.get(standIn, "_zod");
  const twinZod: unknown = Reflect.get(twin, "_zod");
  if (!isObject(standZod) || !isObject(twinZod)) {
    throw new Error("forced stand-in or twin has no _zod");
  }
  const missingOnStandIn = missingKeys(twinZod, standZod).map(
    (key) => `_zod.${key}`,
  );
  const extraOnStandIn = missingKeys(standZod, twinZod).map(
    (key) => `_zod.${key}`,
  );
  const twinBag: unknown = Reflect.get(twinZod, "bag");
  const standBag: unknown = Reflect.get(standZod, "bag");
  if (isObject(twinBag) && isObject(standBag)) {
    missingOnStandIn.push(
      ...missingKeys(twinBag, standBag).map((key) => `_zod.bag.${key}`),
    );
    extraOnStandIn.push(
      ...missingKeys(standBag, twinBag).map((key) => `_zod.bag.${key}`),
    );
  }
  const standTraits: unknown = Reflect.get(standZod, "traits");
  const twinTraits: unknown = Reflect.get(twinZod, "traits");
  const traitsEqual =
    standTraits instanceof Set &&
    twinTraits instanceof Set &&
    standTraits.size === twinTraits.size &&
    [...standTraits].every((trait) => twinTraits.has(trait));
  const standReg = registryPair(standIn);
  const twinReg = registryPair(twin);
  return {
    refused: false,
    refusalMessage: "",
    missingOnStandIn,
    extraOnStandIn,
    traitsEqual,
    registryEqual:
      standReg.has === twinReg.has && sameEntry(standReg.entry, twinReg.entry),
  };
}
