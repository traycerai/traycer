import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * AST scan of every `lazySchema(` thunk in protocol/src and clients/.
 *
 * R1 outermost `.describe(`/`.meta(`/`.register(` of a returned expression
 * R2 outermost `z.instanceof(`
 * R3 outermost `z.json(`
 * R4 returned identifier bound to a thunk-local const that a nested function
 *    (getter / z.lazy arrow) references
 * R5 side effects while the thunk runs (S1 assign / S2 ++-- / S3 delete /
 *    S4 mutator or Object/Reflect mutator on a non-local root / Z registry
 *    write), interprocedural through imports
 */

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TRAYCER_ROOT = path.join(PROTOCOL_ROOT, "..");
const REPO_ROOT = path.join(TRAYCER_ROOT, "..");
const PROTOCOL_SRC = path.join(PROTOCOL_ROOT, "src");
const COMMON_SRC = path.join(REPO_ROOT, "packages/common/src");

const SCAN_PREFIXES = ["protocol/src/", "clients/"] as const;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "__tests__",
  "__fixtures__",
  "__mocks__",
]);

const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);
const OBJ_MUTATORS = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
  "freeze",
  "seal",
  "preventExtensions",
  "set",
  "deleteProperty",
]);
const ZOD_REG = new Set(["register", "meta", "describe"]);
const PURE_GLOBALS = new Set([
  "Object",
  "Array",
  "JSON",
  "Math",
  "Number",
  "String",
  "Symbol",
  "Reflect",
  "Boolean",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Error",
  "TypeError",
  "RangeError",
  "Promise",
  "BigInt",
  "URL",
  "Buffer",
  "Proxy",
  "globalThis",
  "Uint8Array",
  "Intl",
  "console",
  "encodeURIComponent",
  "decodeURIComponent",
  "parseInt",
  "parseFloat",
  "isFinite",
  "isNaN",
  "structuredClone",
]);
const FRESH_RETURNING = new Set([
  "keys",
  "values",
  "entries",
  "fromEntries",
  "from",
  "of",
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "toSorted",
  "toReversed",
  "toSpliced",
  "split",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
]);

const FRESH = { kind: "fresh" } as const;

type RuleId = "R1" | "R2" | "R3" | "R4" | "R5";

type ThunkRuleHit = {
  readonly rule: RuleId;
  readonly file: string;
  readonly line: number;
  readonly bindingName: string | undefined;
  readonly kind: string;
  readonly detail: string;
};

type ThunkScanResult = {
  readonly thunkCount: number;
  readonly hits: readonly ThunkRuleHit[];
};

type ScanInput = {
  readonly files: readonly string[];
  readonly overlay: ReadonlyMap<string, string>;
  readonly protoSrc: string;
  readonly commonSrc: string;
  readonly contentRoot: string;
};

type LoadedFile = {
  readonly sf: ts.SourceFile;
  readonly text: string;
};

type ImportBinding = {
  readonly spec: string;
  readonly orig: string;
};

type Reexport = {
  readonly name: string;
  readonly orig: string;
  readonly spec: string;
};

type TopDecls = {
  readonly decls: Map<string, ts.Node>;
  readonly imports: Map<string, ImportBinding>;
  readonly reexports: Reexport[];
  readonly star: string[];
};

type ResolvedName =
  | { readonly kind: "local"; readonly abs: string; readonly node: ts.Node }
  | { readonly kind: "zod" }
  | { readonly kind: "external"; readonly spec: string }
  | { readonly kind: "unresolved"; readonly spec: string }
  | { readonly kind: "namespace"; readonly abs: string };

type SpecResolution =
  | { readonly abs: string }
  | { readonly external: string }
  | { readonly unresolved: string };

type SideEffectFinding = {
  readonly kind: string;
  readonly at: string;
  readonly detail: string;
  readonly via: string | undefined;
};

const PLANTED_HELPER_SOURCE = `export const helperLog: string[] = [];
export function pushingHelper(name: string) { helperLog.push(name); return name; }
export function pureHelper(name: string) { const local: string[] = []; local.push(name); return local; }
export class Registering { constructor(name: string) { helperLog.push(name); } }
`;

const PLANTED_PLANTED_SOURCE = `import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";
import { pushingHelper, pureHelper, Registering } from "./helper";
import * as helpers from "./helper";
let counter = 0;
let lastBuilt: unknown = undefined;
const registry = new Map<string, unknown>();
const seen = new Set<string>();
const list: string[] = [];
const holder: Record<string, unknown> = {};
// POSITIVES, one per branch: the expected kind is in the name
export const P_S1_assign = lazySchema(() => { lastBuilt = 1; return z.string(); });
export const P_S1_prop = lazySchema(() => { holder.x = 1; return z.string(); });
export const P_S1_destructure = lazySchema(() => { [lastBuilt] = [1]; return z.string(); });
export const P_S2_update = lazySchema(() => { counter++; return z.string(); });
export const P_S3_delete = lazySchema(() => { delete holder.x; return z.string(); });
export const P_S4_mapset = lazySchema(() => { registry.set("a", 1); return z.string(); });
export const P_S4_setadd = lazySchema(() => { seen.add("a"); return z.string(); });
export const P_S4_push = lazySchema(() => { list.push("a"); return z.string(); });
export const P_S4_objassign = lazySchema(() => { Object.assign(holder, { a: 1 }); return z.string(); });
export const P_Z_describe_nested = lazySchema(() => z.object({ a: z.string().describe("x") }));
export const P_Z_meta = lazySchema(() => z.string().meta({ id: "x" }));
export const P_inter_helper = lazySchema(() => z.literal(pushingHelper("a")));
export const P_inter_namespace = lazySchema(() => z.literal(helpers.pushingHelper("a")));
export const P_callback = lazySchema(() => z.enum(["a", "b"].map((v) => { list.push(v); return v; }) as ["a", "b"]));
export const P_iife = lazySchema(() => z.literal((() => { counter += 1; return 1; })()));
export const P_new = lazySchema(() => { new Registering("a"); return z.string(); });
// NEGATIVES: no effect outside the built value
export const N_local = lazySchema(() => { const xs: string[] = []; xs.push("a"); return z.enum(xs as [string]); });
export const N_fresh_chain = lazySchema(() => z.enum(Object.keys(holder).sort() as [string]));
export const N_pure_helper = lazySchema(() => z.enum(pureHelper("a") as [string]));
export const N_returned_closure = lazySchema(() => z.string().transform(() => "x"));
export const N_zod_set = lazySchema(() => z.set(z.string()));
`;

const PLANTED_HISTORICAL_SOURCE = `const residualList: string[] = [];
function withResidualCapture(id: string, shape: object) {
  residualList.push(id);
  return shape;
}
const shape = { a: 1 };
export const historical = lazySchema(() => withResidualCapture("x", shape));
`;

const PLANTED_RULES_SOURCE = `import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";
class Foo {}
export const P_R1_describe = lazySchema(() => z.string().describe("x"));
export const P_R1_meta = lazySchema(() => z.string().meta({ id: "x" }));
export const P_R1_register = lazySchema(() => z.string().register(z.globalRegistry));
export const P_R1_block = lazySchema(() => {
  return z.string().describe("block");
});
export const P_R1_parens = lazySchema(() => (z.string().describe("parens")));
export const P_R1_nonnull = lazySchema(() => z.string().describe("bang")!);
export const N_R1_nested = lazySchema(() => z.object({ a: z.string().describe("x") }));
export const N_R1_optional = lazySchema(() => z.string().optional());
export const P_R2_instanceof = lazySchema(() => z.instanceof(Foo));
export const N_R2_nested = lazySchema(() => z.object({ a: z.instanceof(Foo) }));
export const P_R3_json = lazySchema(() => z.json());
export const N_R3_nested = lazySchema(() => z.object({ a: z.json() }));
export const P_R4_getter = lazySchema(() => {
  const node = z.object({
    get inner() {
      return node;
    },
  });
  return node;
});
export const P_R4_lazy = lazySchema(() => {
  const node = z.lazy(() => node);
  return node;
});
export const N_R4_plain_local = lazySchema(() => {
  const node = z.string();
  return node;
});
export const N_R4_module_ident = lazySchema(() => P_R3_json);
`;

const PLANTED_DIR = path.join(PROTOCOL_SRC, "sweepctl");
const PLANTED_PLANTED_ABS = path.join(PLANTED_DIR, "planted.ts");
const PLANTED_HELPER_ABS = path.join(PLANTED_DIR, "helper.ts");
const PLANTED_HISTORICAL_ABS = path.join(PLANTED_DIR, "historical.ts");
const PLANTED_RULES_ABS = path.join(PLANTED_DIR, "rules.ts");

const R5_POSITIVES: readonly {
  readonly name: string;
  readonly kind: string;
}[] = [
  { name: "P_S1_assign", kind: "S1 assign" },
  { name: "P_S1_prop", kind: "S1 assign" },
  { name: "P_S1_destructure", kind: "S1 destructuring-assign" },
  { name: "P_S2_update", kind: "S2 update" },
  { name: "P_S3_delete", kind: "S3 delete" },
  { name: "P_S4_mapset", kind: "S4 mutator" },
  { name: "P_S4_setadd", kind: "S4 mutator" },
  { name: "P_S4_push", kind: "S4 mutator" },
  { name: "P_S4_objassign", kind: "S4 object-mutator" },
  { name: "P_Z_describe_nested", kind: "Z registry" },
  { name: "P_Z_meta", kind: "Z registry" },
  { name: "P_inter_helper", kind: "S4 mutator" },
  { name: "P_inter_namespace", kind: "S4 mutator" },
  { name: "P_callback", kind: "S4 mutator" },
  { name: "P_iife", kind: "S1 assign" },
  { name: "P_new", kind: "S4 mutator" },
];

const R5_NEGATIVES: readonly string[] = [
  "N_local",
  "N_fresh_chain",
  "N_pure_helper",
  "N_returned_closure",
  "N_zod_set",
];

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
    base.endsWith(".test.tsx") ||
    base.endsWith(".spec.ts") ||
    base.endsWith(".spec.tsx")
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

function strip(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function moduleSpecText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      bindingNames(element.name, out);
    }
  }
}

function isZodSpec(spec: string): boolean {
  return spec === "zod" || spec.startsWith("zod/");
}

function isFreshRoot(root: ts.Expression | typeof FRESH): root is typeof FRESH {
  return root === FRESH;
}

function rootOf(expression: ts.Expression): ts.Expression | typeof FRESH {
  let current = strip(expression);
  for (;;) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = strip(current.expression);
      continue;
    }
    if (ts.isCallExpression(current)) {
      const callee = strip(current.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        FRESH_RETURNING.has(callee.name.text)
      ) {
        return FRESH;
      }
      current = callee;
      continue;
    }
    return current;
  }
}

function localsOf(fn: ts.SignatureDeclaration): Set<string> {
  const out = new Set<string>();
  for (const parameter of fn.parameters) {
    bindingNames(parameter.name, out);
  }
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) {
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name !== undefined
      ) {
        out.add(node.name.text);
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      bindingNames(node.name, out);
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      out.add(node.name.text);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      bindingNames(node.variableDeclaration.name, out);
    }
    ts.forEachChild(node, visit);
  };
  const body = "body" in fn ? fn.body : undefined;
  if (body !== undefined) {
    visit(body);
  }
  return out;
}

function functionBody(fn: ts.SignatureDeclaration): ts.ConciseBody | undefined {
  if (!("body" in fn)) {
    return undefined;
  }
  const body = fn.body;
  if (body === undefined) {
    return undefined;
  }
  return body;
}

function targetFn(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return node;
  }
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    const initializer = strip(node.initializer);
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
    ) {
      return initializer;
    }
  }
  return undefined;
}

function isSchemaLike(node: ts.Node): boolean {
  if (!ts.isVariableDeclaration(node) || node.initializer === undefined) {
    return false;
  }
  const root = rootOf(node.initializer);
  return (
    !isFreshRoot(root) &&
    ts.isIdentifier(root) &&
    (root.text === "z" ||
      root.text === "lazySchema" ||
      /Schema$/.test(root.text))
  );
}

function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = functionBody(fn);
  if (body === undefined) {
    return [];
  }
  if (!ts.isBlock(body)) {
    return [body];
  }
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      out.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

function thunkConstNames(fn: ts.SignatureDeclaration): Set<string> {
  const names = new Set<string>();
  const body = functionBody(fn);
  if (body === undefined) {
    return names;
  }
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) !== 0
      ) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === id) {
    return false;
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    return true;
  }
  if (ts.isMethodDeclaration(parent) && parent.name === id) {
    return false;
  }
  if (ts.isGetAccessorDeclaration(parent) && parent.name === id) {
    return false;
  }
  if (ts.isSetAccessorDeclaration(parent) && parent.name === id) {
    return false;
  }
  if (ts.isParameter(parent) && parent.name === id) {
    return false;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === id) {
    return false;
  }
  if (ts.isFunctionDeclaration(parent) && parent.name === id) {
    return false;
  }
  return true;
}

function nestedFunctionReferencesName(
  fn: ts.SignatureDeclaration,
  name: string,
): boolean {
  let found = false;
  const visit = (node: ts.Node, insideNested: boolean): void => {
    if (found) {
      return;
    }
    if (node !== fn && ts.isFunctionLike(node)) {
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (
      insideNested &&
      ts.isIdentifier(node) &&
      node.text === name &&
      isValueReference(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child, insideNested));
  };
  const body = functionBody(fn);
  if (body !== undefined) {
    visit(body, false);
  }
  return found;
}

function outermostRegistryMethod(
  expression: ts.Expression,
): string | undefined {
  const inner = strip(expression);
  if (!ts.isCallExpression(inner)) {
    return undefined;
  }
  const callee = inner.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  const name = callee.name.text;
  if (name === "describe" || name === "meta" || name === "register") {
    return name;
  }
  return undefined;
}

function outermostZodFactory(expression: ts.Expression): string | undefined {
  const inner = strip(expression);
  if (!ts.isCallExpression(inner)) {
    return undefined;
  }
  const callee = inner.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  const name = callee.name.text;
  if (name !== "instanceof" && name !== "json") {
    return undefined;
  }
  const recv = strip(callee.expression);
  if (!ts.isIdentifier(recv) || (recv.text !== "z" && recv.text !== "zod")) {
    return undefined;
  }
  return name;
}

function bindingNameOfLazySchemaCall(
  call: ts.CallExpression,
): string | undefined {
  const parent = call.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.initializer !== undefined &&
    strip(parent.initializer) === call
  ) {
    return parent.name.text;
  }
  return undefined;
}

function snippet(node: ts.Node, max: number): string {
  const text = node.getText().replace(/\s+/g, " ");
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max);
}

function factoryReturnedFunctions(
  target: ts.SignatureDeclaration,
): ts.SignatureDeclaration[] {
  const returned: ts.SignatureDeclaration[] = [];
  const body = functionBody(target);
  if (body === undefined) {
    return returned;
  }
  if (
    ts.isArrowFunction(target) &&
    !ts.isBlock(target.body) &&
    ts.isFunctionLike(target.body)
  ) {
    returned.push(target.body);
    return returned;
  }
  const visit = (node: ts.Node): void => {
    if (node !== target && ts.isFunctionLike(node)) {
      const parent = node.parent;
      if (
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) &&
          parent.body === node &&
          parent === target)
      ) {
        returned.push(node);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returned;
}

function scanThunkRules(input: ScanInput): ThunkScanResult {
  const loadCache = new Map<string, LoadedFile>();
  const declCache = new Map<string, TopDecls>();
  const fnMemo = new Map<ts.SignatureDeclaration, SideEffectFinding[]>();
  const inProgress = new Set<ts.SignatureDeclaration>();

  const load = (abs: string): LoadedFile | undefined => {
    const cached = loadCache.get(abs);
    if (cached !== undefined) {
      return cached;
    }
    const overlayText = input.overlay.get(abs);
    let text: string;
    if (overlayText !== undefined) {
      text = overlayText;
    } else if (existsSync(abs)) {
      text = readFileSync(abs, "utf8");
    } else {
      return undefined;
    }
    const sf = ts.createSourceFile(
      abs,
      text,
      ts.ScriptTarget.Latest,
      true,
      abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const loaded = { sf, text };
    loadCache.set(abs, loaded);
    return loaded;
  };

  const lineOf = (abs: string, node: ts.Node): number => {
    const loaded = load(abs);
    if (loaded === undefined) {
      return 0;
    }
    return (
      loaded.sf.getLineAndCharacterOfPosition(node.getStart(loaded.sf)).line + 1
    );
  };

  const rel = (abs: string): string => {
    const relative = path.relative(input.contentRoot, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return abs.split(path.sep).join("/");
    }
    return relative.split(path.sep).join("/");
  };

  const resolveSpec = (fromAbs: string, spec: string): SpecResolution => {
    let base: string;
    if (spec.startsWith(".")) {
      base = path.resolve(path.dirname(fromAbs), spec);
    } else if (spec.startsWith("@traycer/protocol/")) {
      base = path.join(input.protoSrc, spec.slice("@traycer/protocol/".length));
    } else if (spec === "@traycer/protocol") {
      base = path.join(input.protoSrc, "index");
    } else if (spec.startsWith("@traycerai/common/")) {
      base = path.join(
        input.commonSrc,
        spec.slice("@traycerai/common/".length),
      );
    } else {
      return { external: spec };
    }
    base = base.replace(/\.(js|ts)$/, "");
    const candidates = [
      base + ".ts",
      base + ".tsx",
      path.join(base, "index.ts"),
    ];
    for (const candidate of candidates) {
      if (input.overlay.has(candidate) || existsSync(candidate)) {
        return { abs: candidate };
      }
    }
    return { unresolved: spec };
  };

  const topDecls = (abs: string): TopDecls => {
    const cached = declCache.get(abs);
    if (cached !== undefined) {
      return cached;
    }
    const out: TopDecls = {
      decls: new Map(),
      imports: new Map(),
      reexports: [],
      star: [],
    };
    declCache.set(abs, out);
    const loaded = load(abs);
    if (loaded === undefined) {
      return out;
    }
    for (const st of loaded.sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name !== undefined) {
        out.decls.set(st.name.text, st);
      } else if (ts.isClassDeclaration(st) && st.name !== undefined) {
        out.decls.set(st.name.text, st);
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            out.decls.set(decl.name.text, decl);
          }
        }
      } else if (
        ts.isImportDeclaration(st) &&
        st.importClause !== undefined &&
        !st.importClause.isTypeOnly
      ) {
        const spec = moduleSpecText(st.moduleSpecifier);
        if (spec === undefined) {
          continue;
        }
        const ic = st.importClause;
        if (ic.name !== undefined) {
          out.imports.set(ic.name.text, { spec, orig: "default" });
        }
        const nb = ic.namedBindings;
        if (nb !== undefined && ts.isNamespaceImport(nb)) {
          out.imports.set(nb.name.text, { spec, orig: "*" });
        }
        if (nb !== undefined && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) {
              continue;
            }
            out.imports.set(el.name.text, {
              spec,
              orig: (el.propertyName ?? el.name).text,
            });
          }
        }
      } else if (
        ts.isExportDeclaration(st) &&
        st.moduleSpecifier !== undefined &&
        !st.isTypeOnly
      ) {
        const spec = moduleSpecText(st.moduleSpecifier);
        if (spec === undefined) {
          continue;
        }
        if (st.exportClause === undefined) {
          out.star.push(spec);
        } else if (ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            out.reexports.push({
              name: el.name.text,
              orig: (el.propertyName ?? el.name).text,
              spec,
            });
          }
        }
      }
    }
    return out;
  };

  const resolveImport = (
    fromAbs: string,
    spec: string,
    orig: string,
    seen: Set<string>,
  ): ResolvedName | undefined => {
    if (isZodSpec(spec)) {
      return { kind: "zod" };
    }
    const resolved = resolveSpec(fromAbs, spec);
    if ("external" in resolved) {
      return { kind: "external", spec: resolved.external };
    }
    if ("unresolved" in resolved) {
      return { kind: "unresolved", spec: resolved.unresolved };
    }
    if (orig === "*") {
      return { kind: "namespace", abs: resolved.abs };
    }
    return resolveExport(resolved.abs, orig, seen);
  };

  const resolveExport = (
    abs: string,
    name: string,
    seen: Set<string>,
  ): ResolvedName | undefined => {
    const t = topDecls(abs);
    const decl = t.decls.get(name);
    if (decl !== undefined) {
      return { kind: "local", abs, node: decl };
    }
    for (const re of t.reexports) {
      if (re.name === name) {
        return resolveImport(abs, re.spec, re.orig, seen);
      }
    }
    if (t.imports.has(name)) {
      return resolveName(abs, name, seen);
    }
    for (const spec of t.star) {
      const resolved = resolveSpec(abs, spec);
      if (!("abs" in resolved)) {
        continue;
      }
      const got = resolveExport(resolved.abs, name, seen);
      if (got !== undefined) {
        return got;
      }
    }
    return undefined;
  };

  const resolveName = (
    abs: string,
    name: string,
    seen: Set<string>,
  ): ResolvedName | undefined => {
    const key = abs + "#" + name;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    const t = topDecls(abs);
    const decl = t.decls.get(name);
    if (decl !== undefined) {
      return { kind: "local", abs, node: decl };
    }
    const imp = t.imports.get(name);
    if (imp !== undefined) {
      return resolveImport(abs, imp.spec, imp.orig, seen);
    }
    return undefined;
  };

  const walkFn = (
    abs: string,
    fn: ts.SignatureDeclaration,
    extraLocals: readonly string[],
  ): SideEffectFinding[] => {
    const memoised = fnMemo.get(fn);
    if (memoised !== undefined) {
      return memoised;
    }
    if (inProgress.has(fn)) {
      return [];
    }
    inProgress.add(fn);
    const locals = localsOf(fn);
    for (const extra of extraLocals) {
      locals.add(extra);
    }
    const findings: SideEffectFinding[] = [];
    const isLocalRoot = (expression: ts.Expression): boolean => {
      const root = rootOf(expression);
      if (isFreshRoot(root)) {
        return true;
      }
      if (ts.isIdentifier(root)) {
        return locals.has(root.text);
      }
      return (
        ts.isArrayLiteralExpression(root) ||
        ts.isObjectLiteralExpression(root) ||
        ts.isNewExpression(root) ||
        ts.isStringLiteral(root) ||
        ts.isTemplateExpression(root)
      );
    };
    const add = (kind: string, node: ts.Node, detail: string): void => {
      findings.push({
        kind,
        at: `${rel(abs)}:${String(lineOf(abs, node))}`,
        detail,
        via: undefined,
      });
    };
    const callee = (abs2: string, name: string, node: ts.Node): void => {
      const resolved = resolveName(abs2, name, new Set());
      if (resolved === undefined) {
        return;
      }
      if (resolved.kind === "zod") {
        return;
      }
      if (
        resolved.kind === "external" ||
        resolved.kind === "unresolved" ||
        resolved.kind === "namespace"
      ) {
        return;
      }
      const target = targetFn(resolved.node);
      if (target === undefined) {
        return;
      }
      for (const finding of walkFn(resolved.abs, target, [])) {
        const viaPrefix = `${name} <- ${rel(abs)}:${String(lineOf(abs, node))}`;
        findings.push({
          kind: finding.kind,
          at: finding.at,
          detail: finding.detail,
          via:
            finding.via !== undefined
              ? `${viaPrefix} <- ${finding.via}`
              : viaPrefix,
        });
      }
    };
    const visit = (node: ts.Node): void => {
      if (node !== fn && ts.isFunctionLike(node)) {
        const parent = node.parent;
        const parenIife =
          ts.isParenthesizedExpression(parent) &&
          !ts.isCallExpression(strip(parent)) &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent;
        const directIife =
          ts.isCallExpression(parent) && parent.expression === node;
        let asArg = false;
        if (
          (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.arguments !== undefined
        ) {
          for (const arg of parent.arguments) {
            if (arg === node) {
              asArg = true;
            }
          }
        }
        if (parenIife || directIife || asArg) {
          for (const finding of walkFn(abs, node, [...locals])) {
            findings.push(finding);
          }
        }
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = strip(node.left);
        if (
          ts.isArrayLiteralExpression(left) ||
          ts.isObjectLiteralExpression(left)
        ) {
          add("S1 destructuring-assign", node, snippet(node, 80));
        } else if (!isLocalRoot(left)) {
          add("S1 assign", node, snippet(node, 80));
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        !isLocalRoot(node.operand)
      ) {
        add("S2 update", node, snippet(node, 80));
      }
      if (ts.isDeleteExpression(node) && !isLocalRoot(node.expression)) {
        add("S3 delete", node, snippet(node, 80));
      }
      if (ts.isCallExpression(node)) {
        const ce = strip(node.expression);
        if (ts.isPropertyAccessExpression(ce)) {
          const method = ce.name.text;
          const recvRoot = rootOf(ce.expression);
          const recvName =
            !isFreshRoot(recvRoot) && ts.isIdentifier(recvRoot)
              ? recvRoot.text
              : undefined;
          if (ZOD_REG.has(method)) {
            add("Z registry", node, snippet(node, 80));
          }
          if (
            (recvName === "Object" || recvName === "Reflect") &&
            ts.isIdentifier(strip(ce.expression)) &&
            OBJ_MUTATORS.has(method)
          ) {
            const first = node.arguments[0];
            if (first !== undefined && !isLocalRoot(first)) {
              add("S4 object-mutator", node, snippet(node, 80));
            }
          } else if (MUTATORS.has(method)) {
            let recvIsZod = false;
            if (recvName !== undefined) {
              const resolved = resolveName(abs, recvName, new Set());
              recvIsZod = resolved !== undefined && resolved.kind === "zod";
            }
            if (!recvIsZod && !isLocalRoot(ce.expression)) {
              add("S4 mutator", node, snippet(node, 80));
            }
          } else if (
            recvName !== undefined &&
            !locals.has(recvName) &&
            !PURE_GLOBALS.has(recvName)
          ) {
            const resolved = resolveName(abs, recvName, new Set());
            if (resolved !== undefined && resolved.kind === "namespace") {
              const inner = resolveExport(resolved.abs, method, new Set());
              const target =
                inner !== undefined && inner.kind === "local"
                  ? targetFn(inner.node)
                  : undefined;
              if (
                inner !== undefined &&
                inner.kind === "local" &&
                target !== undefined
              ) {
                for (const finding of walkFn(inner.abs, target, [])) {
                  const viaPrefix = `${recvName}.${method} <- ${rel(abs)}:${String(lineOf(abs, node))}`;
                  findings.push({
                    kind: finding.kind,
                    at: finding.at,
                    detail: finding.detail,
                    via:
                      finding.via !== undefined
                        ? `${viaPrefix} <- ${finding.via}`
                        : viaPrefix,
                  });
                }
              }
            }
          }
        } else if (ts.isIdentifier(ce) && !locals.has(ce.text)) {
          callee(abs, ce.text, node);
        }
      }
      if (ts.isNewExpression(node)) {
        const ce = strip(node.expression);
        if (
          ts.isIdentifier(ce) &&
          !locals.has(ce.text) &&
          !PURE_GLOBALS.has(ce.text)
        ) {
          const resolved = resolveName(abs, ce.text, new Set());
          if (
            resolved !== undefined &&
            resolved.kind === "local" &&
            ts.isClassDeclaration(resolved.node)
          ) {
            for (const mem of resolved.node.members) {
              if (ts.isConstructorDeclaration(mem)) {
                for (const finding of walkFn(resolved.abs, mem, [])) {
                  findings.push({
                    kind: finding.kind,
                    at: finding.at,
                    detail: finding.detail,
                    via: `new ${ce.text} <- ${rel(abs)}:${String(lineOf(abs, node))}`,
                  });
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    const body = functionBody(fn);
    if (body !== undefined) {
      visit(body);
    }
    inProgress.delete(fn);
    fnMemo.set(fn, findings);
    return findings;
  };

  type ThunkFn = {
    readonly abs: string;
    readonly call: ts.CallExpression;
    readonly fn: ts.SignatureDeclaration;
    readonly extraLocals: readonly string[];
    readonly bindingName: string | undefined;
  };

  const thunkFns: ThunkFn[] = [];
  let thunkCount = 0;
  for (const abs of input.files) {
    const loaded = load(abs);
    if (loaded === undefined || !loaded.text.includes("lazySchema(")) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "lazySchema" &&
        node.arguments.length > 0
      ) {
        const first = node.arguments[0];
        if (first === undefined) {
          ts.forEachChild(node, visit);
          return;
        }
        thunkCount += 1;
        const arg = strip(first);
        const bindingName = bindingNameOfLazySchemaCall(node);
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          thunkFns.push({
            abs,
            call: node,
            fn: arg,
            extraLocals: [],
            bindingName,
          });
        } else if (
          ts.isCallExpression(arg) &&
          ts.isIdentifier(arg.expression)
        ) {
          const resolved = resolveName(abs, arg.expression.text, new Set());
          const target =
            resolved !== undefined && resolved.kind === "local"
              ? targetFn(resolved.node)
              : undefined;
          if (
            resolved !== undefined &&
            resolved.kind === "local" &&
            target !== undefined
          ) {
            const factoryLocals = [...localsOf(target)];
            for (const returned of factoryReturnedFunctions(target)) {
              thunkFns.push({
                abs,
                call: node,
                fn: returned,
                extraLocals: factoryLocals,
                bindingName,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(loaded.sf);
  }

  const hits: ThunkRuleHit[] = [];
  const pushHit = (
    rule: RuleId,
    abs: string,
    call: ts.CallExpression,
    bindingName: string | undefined,
    kind: string,
    detail: string,
  ): void => {
    hits.push({
      rule,
      file: rel(abs),
      line: lineOf(abs, call),
      bindingName,
      kind,
      detail,
    });
  };

  for (const thunk of thunkFns) {
    for (const returned of returnedExpressions(thunk.fn)) {
      const registry = outermostRegistryMethod(returned);
      if (registry !== undefined) {
        pushHit(
          "R1",
          thunk.abs,
          thunk.call,
          thunk.bindingName,
          registry,
          snippet(strip(returned), 80),
        );
      }
      const factory = outermostZodFactory(returned);
      if (factory === "instanceof") {
        pushHit(
          "R2",
          thunk.abs,
          thunk.call,
          thunk.bindingName,
          factory,
          snippet(strip(returned), 80),
        );
      }
      if (factory === "json") {
        pushHit(
          "R3",
          thunk.abs,
          thunk.call,
          thunk.bindingName,
          factory,
          snippet(strip(returned), 80),
        );
      }
      const inner = strip(returned);
      if (ts.isIdentifier(inner)) {
        const consts = thunkConstNames(thunk.fn);
        if (
          consts.has(inner.text) &&
          nestedFunctionReferencesName(thunk.fn, inner.text)
        ) {
          pushHit(
            "R4",
            thunk.abs,
            thunk.call,
            thunk.bindingName,
            "self-ref",
            inner.text,
          );
        }
      }
    }
    for (const finding of walkFn(thunk.abs, thunk.fn, thunk.extraLocals)) {
      pushHit(
        "R5",
        thunk.abs,
        thunk.call,
        thunk.bindingName,
        finding.kind,
        finding.detail,
      );
    }
  }

  return { thunkCount, hits };
}

function hitsOf(
  result: ThunkScanResult,
  rule: RuleId,
  bindingName: string,
): readonly ThunkRuleHit[] {
  return result.hits.filter(
    (hit) => hit.rule === rule && hit.bindingName === bindingName,
  );
}

function formatHit(hit: ThunkRuleHit): string {
  const name = hit.bindingName !== undefined ? ` ${hit.bindingName}` : "";
  return `${hit.rule} ${hit.file}:${String(hit.line)}${name} ${hit.kind} ${hit.detail}`;
}

function scanOverlay(
  files: readonly string[],
  overlay: ReadonlyMap<string, string>,
): ThunkScanResult {
  return scanThunkRules({
    files,
    overlay,
    protoSrc: PROTOCOL_SRC,
    commonSrc: COMMON_SRC,
    contentRoot: TRAYCER_ROOT,
  });
}

function scanRulesPlanted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_RULES_ABS],
    new Map([[PLANTED_RULES_ABS, PLANTED_RULES_SOURCE]]),
  );
}

function scanR5Planted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_PLANTED_ABS],
    new Map([
      [PLANTED_PLANTED_ABS, PLANTED_PLANTED_SOURCE],
      [PLANTED_HELPER_ABS, PLANTED_HELPER_SOURCE],
    ]),
  );
}

function scanHistoricalPlanted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_HISTORICAL_ABS],
    new Map([[PLANTED_HISTORICAL_ABS, PLANTED_HISTORICAL_SOURCE]]),
  );
}

describe("lazySchema thunk rules scan", () => {
  it("R1 flags outermost describe/meta/register and ignores nested or other calls", () => {
    const result = scanRulesPlanted();
    expect(
      hitsOf(result, "R1", "P_R1_describe").map((hit) => hit.kind),
    ).toEqual(["describe"]);
    expect(hitsOf(result, "R1", "P_R1_meta").map((hit) => hit.kind)).toEqual([
      "meta",
    ]);
    expect(
      hitsOf(result, "R1", "P_R1_register").map((hit) => hit.kind),
    ).toEqual(["register"]);
    expect(hitsOf(result, "R1", "P_R1_block").map((hit) => hit.kind)).toEqual([
      "describe",
    ]);
    expect(hitsOf(result, "R1", "P_R1_parens").map((hit) => hit.kind)).toEqual([
      "describe",
    ]);
    expect(hitsOf(result, "R1", "P_R1_nonnull").map((hit) => hit.kind)).toEqual(
      ["describe"],
    );
    expect(hitsOf(result, "R1", "N_R1_nested")).toEqual([]);
    expect(hitsOf(result, "R1", "N_R1_optional")).toEqual([]);
    expect(hitsOf(result, "R1", "P_R2_instanceof")).toEqual([]);
    expect(hitsOf(result, "R1", "P_R3_json")).toEqual([]);

    const r5 = scanR5Planted();
    expect(hitsOf(r5, "R1", "P_Z_meta").map((hit) => hit.kind)).toEqual([
      "meta",
    ]);
    expect(hitsOf(r5, "R1", "P_Z_describe_nested")).toEqual([]);
  });

  it("R2 flags outermost z.instanceof and ignores nested instanceof", () => {
    const result = scanRulesPlanted();
    expect(
      hitsOf(result, "R2", "P_R2_instanceof").map((hit) => hit.kind),
    ).toEqual(["instanceof"]);
    expect(hitsOf(result, "R2", "N_R2_nested")).toEqual([]);
    expect(hitsOf(result, "R2", "P_R1_describe")).toEqual([]);
  });

  it("R3 flags outermost z.json and ignores nested json", () => {
    const result = scanRulesPlanted();
    expect(hitsOf(result, "R3", "P_R3_json").map((hit) => hit.kind)).toEqual([
      "json",
    ]);
    expect(hitsOf(result, "R3", "N_R3_nested")).toEqual([]);
    expect(hitsOf(result, "R3", "P_R1_describe")).toEqual([]);
  });

  it("R4 flags a returned thunk-local const that a nested getter or z.lazy references", () => {
    const result = scanRulesPlanted();
    expect(hitsOf(result, "R4", "P_R4_getter").map((hit) => hit.kind)).toEqual([
      "self-ref",
    ]);
    expect(hitsOf(result, "R4", "P_R4_lazy").map((hit) => hit.kind)).toEqual([
      "self-ref",
    ]);
    expect(hitsOf(result, "R4", "N_R4_plain_local")).toEqual([]);
    expect(hitsOf(result, "R4", "N_R4_module_ident")).toEqual([]);
    expect(hitsOf(result, "R4", "P_R1_describe")).toEqual([]);
  });

  it("R5 flags each planted side-effect branch and ignores the planted negatives", () => {
    const result = scanR5Planted();
    expect(result.thunkCount).toBe(R5_POSITIVES.length + R5_NEGATIVES.length);
    for (const positive of R5_POSITIVES) {
      expect(
        hitsOf(result, "R5", positive.name).map((hit) => hit.kind),
        positive.name,
      ).toContain(positive.kind);
    }
    for (const name of R5_NEGATIVES) {
      expect(hitsOf(result, "R5", name), name).toEqual([]);
    }
  });

  it("R5 flags the historical withResidualCapture-inside-thunk form", () => {
    const result = scanHistoricalPlanted();
    expect(result.thunkCount).toBe(1);
    expect(hitsOf(result, "R5", "historical").map((hit) => hit.kind)).toContain(
      "S4 mutator",
    );
  });

  it("production protocol and OSS client sources have zero R1-R5 hits and at least 3000 thunks", () => {
    const files = gitListedFiles(TRAYCER_ROOT, SCAN_PREFIXES);
    expect(files.length).toBeGreaterThan(0);
    const result = scanThunkRules({
      files,
      overlay: new Map(),
      protoSrc: PROTOCOL_SRC,
      commonSrc: COMMON_SRC,
      contentRoot: TRAYCER_ROOT,
    });
    expect(result.thunkCount).toBeGreaterThanOrEqual(3000);
    expect(result.hits.map(formatHit)).toEqual([]);
  }, 60_000);
});
