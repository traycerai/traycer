import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The scanner behind `lazy-schema-thunk-rules-scan.test.ts` (protocol and OSS
 * clients) and its host twin (host and common). One module, so a fix reaches
 * both scans. Every root and prefix is a parameter of `scanThunkRules` and
 * `gitListedFiles`; nothing here names a repo.
 *
 * It parses every `lazySchema(` thunk and reports:
 *
 * R1 outermost `.describe(`/`.meta(`/`.register(` of a returned expression
 * R2 outermost `z.instanceof(`
 * R3 outermost `z.json(`
 * R4 returned identifier bound to a thunk-local const that a nested function
 *    (getter / z.lazy arrow) references
 * R5 side effects while the thunk runs, interprocedural through imports:
 *      S1 assign / S2 ++-- / S3 delete / S4 mutator or Object/Reflect mutator
 *      on a non-local root / Z registry write observable apart from the
 *      thunk's own fresh schema (metadata carrying an `id`, or `.register` on
 *      a schema that is not fresh) / U unanalysed
 * R6 returned expression is an identifier (or a property chain of one) that
 *    the thunk does not declare: an alias of an existing value
 *
 * R5 fails closed. A call the walk cannot follow is a finding of kind
 * `U unanalysed` whose detail is a stable label, never a silent pass. What it
 * follows: local and module functions, methods of an object literal or class
 * the receiver names, getters, constructors with their field initialisers and
 * base classes, parameter initialisers, tagged templates, and a function
 * passed by name as a callback. Over-reporting is intended; under-reporting is
 * the defect.
 */

export const UNANALYSED_KIND = "U unanalysed";

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
const CALL_FORMS = new Set(["call", "apply", "bind"]);
/** Running these on a schema runs its refine and transform callbacks. */
const PARSE_FAMILY = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "spa",
  "encode",
  "decode",
  "encodeAsync",
  "decodeAsync",
  "safeEncode",
  "safeDecode",
  "safeEncodeAsync",
  "safeDecodeAsync",
]);

/**
 * `Namespace.member` calls that are pure. Explicit on purpose: a whole
 * namespace such as `Reflect` or `Array` also holds `Reflect.apply` and
 * `Array.prototype.push.call`, which run arbitrary code.
 */
const PURE_GLOBAL_CALLS = new Set([
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Object.fromEntries",
  "Object.getOwnPropertyNames",
  "Object.getOwnPropertySymbols",
  "Object.getOwnPropertyDescriptor",
  "Object.getOwnPropertyDescriptors",
  "Object.getPrototypeOf",
  "Object.create",
  "Object.is",
  "Object.hasOwn",
  "Object.isFrozen",
  "Object.isSealed",
  "Object.isExtensible",
  "Object.groupBy",
  "Array.isArray",
  "Array.from",
  "Array.of",
  "Number.isInteger",
  "Number.isFinite",
  "Number.isNaN",
  "Number.isSafeInteger",
  "Number.parseInt",
  "Number.parseFloat",
  "String.fromCharCode",
  "String.fromCodePoint",
  "String.raw",
  "Symbol.for",
  "Symbol.keyFor",
  "Date.now",
  "Date.parse",
  "Date.UTC",
  "Reflect.get",
  "Reflect.has",
  "Reflect.ownKeys",
  "Reflect.getPrototypeOf",
  "Reflect.getOwnPropertyDescriptor",
  "Reflect.isExtensible",
  "BigInt.asIntN",
  "BigInt.asUintN",
  "Buffer.from",
  "Buffer.alloc",
  "Buffer.byteLength",
  "Buffer.concat",
  "Buffer.isBuffer",
  "URL.canParse",
]);
/** Namespaces every member of which is pure. */
const PURE_NAMESPACES = new Set(["Math", "JSON"]);
/** Global functions that are pure, called by their bare name. */
const PURE_GLOBAL_FUNCTIONS = new Set([
  "Boolean",
  "Number",
  "String",
  "Symbol",
  "BigInt",
  "Object",
  "Array",
  "Error",
  "TypeError",
  "RangeError",
  "Date",
  "RegExp",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "parseInt",
  "parseFloat",
  "isFinite",
  "isNaN",
  "structuredClone",
  "atob",
  "btoa",
]);
/** Built-ins whose `new` runs no caller-visible code of its own. */
const PURE_CONSTRUCTORS = new Set([
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "ReferenceError",
  "URIError",
  "AggregateError",
  "Promise",
  "URL",
  "URLSearchParams",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "ArrayBuffer",
  "DataView",
  "TextEncoder",
  "TextDecoder",
  "Proxy",
  "Boolean",
  "Number",
  "String",
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

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export type ThunkRuleHit = {
  readonly rule: RuleId;
  readonly file: string;
  readonly line: number;
  readonly bindingName: string | undefined;
  readonly kind: string;
  readonly detail: string;
  /**
   * Where the finding itself sits (file:line:column), for an R5 finding. Two
   * hits with the same label and the same `at` are one occurrence.
   */
  readonly at: string | undefined;
};

export type ThunkScanResult = {
  readonly thunkCount: number;
  readonly hits: readonly ThunkRuleHit[];
};

export type ScanInput = {
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

type ClassLike = ts.ClassDeclaration | ts.ClassExpression;

type ParamProvenance = {
  readonly kind: "param";
  readonly owner: ts.SignatureDeclaration;
  readonly index: number;
  readonly name: string;
};

/** Where the object a written-through expression denotes comes from. */
type Provenance =
  | { readonly kind: "fresh" }
  | { readonly kind: "nonlocal" }
  | { readonly kind: "unknown" }
  | ParamProvenance;

/**
 * An effect a function has on the OBJECT one of its parameters holds: a write
 * through it, or a method on it the walk cannot follow. It is applied at each
 * analysed call site to the argument passed at `index`.
 */
type ParamEffect = {
  readonly owner: ts.SignatureDeclaration;
  readonly index: number;
  readonly paramName: string;
  readonly kind: string;
  readonly detail: string;
  readonly method: string | undefined;
};

type WalkResult = {
  readonly findings: SideEffectFinding[];
  readonly effects: ParamEffect[];
};

const FRESH_PROVENANCE: Provenance = { kind: "fresh" };
const NONLOCAL_PROVENANCE: Provenance = { kind: "nonlocal" };
const UNKNOWN_PROVENANCE: Provenance = { kind: "unknown" };

type MemberSource =
  | {
      readonly kind: "object";
      readonly abs: string;
      readonly literal: ts.ObjectLiteralExpression;
    }
  | {
      readonly kind: "class";
      readonly abs: string;
      readonly cls: ClassLike;
      readonly instance: boolean;
    };

type MemberFn = {
  readonly abs: string;
  readonly fn: ts.SignatureDeclaration;
};

type BaseClass =
  | { readonly kind: "none" }
  | { readonly kind: "pure" }
  | { readonly kind: "class"; readonly abs: string; readonly cls: ClassLike }
  | { readonly kind: "unknown"; readonly node: ts.Node; readonly text: string };

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

export function gitListedFiles(
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

/** True when a call sits somewhere on the property chain of `expression`. */
function receiverHasCall(expression: ts.Expression): boolean {
  let current = strip(expression);
  for (;;) {
    if (ts.isCallExpression(current)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = strip(current.expression);
      continue;
    }
    return false;
  }
}

/**
 * The operands of a conditional or logical receiver, each of which is the
 * receiver on some path: `(a ? b : c).m()` calls `m` on `b` or on `c`.
 */
function receiverBranches(
  expression: ts.Expression,
): readonly ts.Expression[] | undefined {
  if (ts.isConditionalExpression(expression)) {
    return [expression.whenTrue, expression.whenFalse];
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return [expression.left, expression.right];
  }
  return undefined;
}

/** The first property name read off the root identifier of a chain. */
function firstMemberName(expression: ts.Expression): string | undefined {
  let current = strip(expression);
  let last: string | undefined = undefined;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      last = current.name.text;
      current = strip(current.expression);
      continue;
    }
    return last;
  }
}

/** A literal whose evaluation makes a value nobody else holds. */
function isFreshLiteral(node: ts.Expression): boolean {
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isStringLiteral(node) ||
    ts.isTemplateExpression(node) ||
    isLiteralRoot(node)
  );
}

/** A global whose calls and reads yield a fresh value. */
function isPureGlobalRoot(name: string): boolean {
  if (
    PURE_NAMESPACES.has(name) ||
    PURE_GLOBAL_FUNCTIONS.has(name) ||
    name === "undefined" ||
    name === "NaN" ||
    name === "Infinity"
  ) {
    return true;
  }
  for (const call of PURE_GLOBAL_CALLS) {
    if (call.startsWith(`${name}.`)) {
      return true;
    }
  }
  return false;
}

function combineProvenance(list: readonly Provenance[]): Provenance {
  const nonlocal = list.find((entry) => entry.kind === "nonlocal");
  if (nonlocal !== undefined) {
    return nonlocal;
  }
  const param = list.find((entry) => entry.kind === "param");
  if (param !== undefined) {
    return param;
  }
  const unknown = list.find((entry) => entry.kind === "unknown");
  if (unknown !== undefined) {
    return unknown;
  }
  return FRESH_PROVENANCE;
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

/**
 * The node that declares `name` inside `fn`: a parameter, a variable, a
 * function or class declaration. Nested function bodies are not searched.
 */
function localDeclarationOf(
  fn: ts.SignatureDeclaration,
  name: string,
): ts.Node | undefined {
  for (const parameter of fn.parameters) {
    const names = new Set<string>();
    bindingNames(parameter.name, names);
    if (names.has(name)) {
      return parameter;
    }
  }
  let found: ts.Node | undefined = undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) {
      return;
    }
    if (node !== fn && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        found = node;
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const names = new Set<string>();
      bindingNames(node.name, names);
      if (names.has(name)) {
        found = node;
        return;
      }
    }
    if (ts.isClassDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  const body = "body" in fn ? fn.body : undefined;
  if (body !== undefined) {
    visit(body);
  }
  return found;
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

function classOfNode(node: ts.Node): ClassLike | undefined {
  if (ts.isClassDeclaration(node)) {
    return node;
  }
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    const initializer = strip(node.initializer);
    if (ts.isClassExpression(initializer)) {
      return initializer;
    }
  }
  return undefined;
}

function isStaticMember(member: ts.Declaration): boolean {
  return (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
}

function memberNameOf(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return undefined;
}

function functionLiteralOf(
  expression: ts.Expression,
): ts.SignatureDeclaration | undefined {
  const inner = strip(expression);
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
    return inner;
  }
  return undefined;
}

/** A literal whose evaluation makes a fresh value nobody else holds. */
function isLiteralRoot(node: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * Whether zod metadata written by this argument could carry an `id`. A
 * literal without an `id` (and without a spread or a computed key) provably
 * cannot; anything else is assumed to.
 */
function mayCarryId(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) {
    return false;
  }
  const inner = strip(argument);
  if (!ts.isObjectLiteralExpression(inner)) {
    return true;
  }
  for (const property of inner.properties) {
    if (ts.isSpreadAssignment(property)) {
      return true;
    }
    const name = property.name;
    if (name === undefined || ts.isComputedPropertyName(name)) {
      return true;
    }
    if (memberNameOf(name) === "id") {
      return true;
    }
  }
  return false;
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

/**
 * The root identifier of a returned expression that is an identifier or a
 * property chain of one, with no call anywhere: the shape of an alias.
 */
function aliasRootName(expression: ts.Expression): string | undefined {
  let current = strip(expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      current = strip(current.expression);
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const key = strip(current.argumentExpression);
      if (
        ts.isStringLiteral(key) ||
        ts.isNumericLiteral(key) ||
        ts.isNoSubstitutionTemplateLiteral(key)
      ) {
        current = strip(current.expression);
        continue;
      }
      return undefined;
    }
    if (ts.isIdentifier(current)) {
      return current.text;
    }
    return undefined;
  }
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

export function scanThunkRules(input: ScanInput): ThunkScanResult {
  const loadCache = new Map<string, LoadedFile>();
  const declCache = new Map<string, TopDecls>();
  const localsCache = new Map<ts.SignatureDeclaration, Set<string>>();
  const fnMemo = new Map<ts.Node, WalkResult>();
  const inProgress = new Set<ts.Node>();

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

  const columnOf = (abs: string, node: ts.Node): number => {
    const loaded = load(abs);
    if (loaded === undefined) {
      return 0;
    }
    return (
      loaded.sf.getLineAndCharacterOfPosition(node.getStart(loaded.sf))
        .character + 1
    );
  };

  const rel = (abs: string): string => {
    const relative = path.relative(input.contentRoot, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return abs.split(path.sep).join("/");
    }
    return relative.split(path.sep).join("/");
  };

  const localsFor = (fn: ts.SignatureDeclaration): Set<string> => {
    const cached = localsCache.get(fn);
    if (cached !== undefined) {
      return cached;
    }
    const computed = localsOf(fn);
    localsCache.set(fn, computed);
    return computed;
  };

  const makeFinding = (
    abs: string,
    kind: string,
    node: ts.Node,
    detail: string,
  ): SideEffectFinding => ({
    kind,
    at: `${rel(abs)}:${String(lineOf(abs, node))}:${String(columnOf(abs, node))}`,
    detail,
    via: undefined,
  });

  const withVia = (
    finding: SideEffectFinding,
    prefix: string,
  ): SideEffectFinding => ({
    kind: finding.kind,
    at: finding.at,
    detail: finding.detail,
    via: finding.via !== undefined ? `${prefix} <- ${finding.via}` : prefix,
  });

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
          } else {
            const names = new Set<string>();
            bindingNames(decl.name, names);
            for (const name of names) {
              out.decls.set(name, decl);
            }
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

  /** The value a declaration holds, when it is an object literal or a class. */
  const memberSourceOf = (
    abs: string,
    node: ts.Node,
  ): MemberSource | undefined => {
    if (ts.isClassDeclaration(node)) {
      return { kind: "class", abs, cls: node, instance: false };
    }
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.initializer === undefined
    ) {
      return undefined;
    }
    const initializer = strip(node.initializer);
    if (ts.isObjectLiteralExpression(initializer)) {
      return { kind: "object", abs, literal: initializer };
    }
    if (ts.isClassExpression(initializer)) {
      return { kind: "class", abs, cls: initializer, instance: false };
    }
    if (ts.isNewExpression(initializer)) {
      const ctor = strip(initializer.expression);
      if (ts.isIdentifier(ctor)) {
        const resolved = resolveName(abs, ctor.text, new Set());
        if (resolved !== undefined && resolved.kind === "local") {
          const cls = classOfNode(resolved.node);
          if (cls !== undefined) {
            return {
              kind: "class",
              abs: resolved.abs,
              cls,
              instance: true,
            };
          }
        }
      }
    }
    return undefined;
  };

  const baseClassOf = (classAbs: string, cls: ClassLike): BaseClass => {
    const heritage = cls.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const baseType = heritage?.types[0];
    if (heritage === undefined || baseType === undefined) {
      return { kind: "none" };
    }
    const expression = strip(baseType.expression);
    if (ts.isIdentifier(expression)) {
      const resolved = resolveName(classAbs, expression.text, new Set());
      if (resolved === undefined && PURE_CONSTRUCTORS.has(expression.text)) {
        return { kind: "pure" };
      }
      if (resolved !== undefined && resolved.kind === "zod") {
        return { kind: "pure" };
      }
      if (resolved !== undefined && resolved.kind === "local") {
        const baseCls = classOfNode(resolved.node);
        if (baseCls !== undefined) {
          return { kind: "class", abs: resolved.abs, cls: baseCls };
        }
      }
    }
    return {
      kind: "unknown",
      node: baseType,
      text: snippet(expression, 60),
    };
  };

  const findMemberFns = (
    source: MemberSource,
    name: string,
    access: "method" | "get",
    visited: Set<ClassLike>,
  ): MemberFn[] => {
    const out: MemberFn[] = [];
    if (source.kind === "object") {
      for (const property of source.literal.properties) {
        if (memberNameOf(property.name) !== name) {
          continue;
        }
        if (access === "get") {
          if (ts.isGetAccessorDeclaration(property)) {
            out.push({ abs: source.abs, fn: property });
          }
        } else if (ts.isMethodDeclaration(property)) {
          out.push({ abs: source.abs, fn: property });
        } else if (ts.isPropertyAssignment(property)) {
          const literal = functionLiteralOf(property.initializer);
          if (literal !== undefined) {
            out.push({ abs: source.abs, fn: literal });
          }
        }
      }
      return out;
    }
    if (visited.has(source.cls)) {
      return out;
    }
    visited.add(source.cls);
    for (const member of source.cls.members) {
      if (memberNameOf(member.name) !== name) {
        continue;
      }
      if (isStaticMember(member) === source.instance) {
        continue;
      }
      if (access === "get") {
        if (ts.isGetAccessorDeclaration(member)) {
          out.push({ abs: source.abs, fn: member });
        }
      } else if (ts.isMethodDeclaration(member)) {
        out.push({ abs: source.abs, fn: member });
      } else if (
        ts.isPropertyDeclaration(member) &&
        member.initializer !== undefined
      ) {
        const literal = functionLiteralOf(member.initializer);
        if (literal !== undefined) {
          out.push({ abs: source.abs, fn: literal });
        }
      }
    }
    if (out.length > 0) {
      return out;
    }
    const base = baseClassOf(source.abs, source.cls);
    if (base.kind === "class") {
      return findMemberFns(
        {
          kind: "class",
          abs: base.abs,
          cls: base.cls,
          instance: source.instance,
        },
        name,
        access,
        visited,
      );
    }
    return out;
  };

  const walkFn = (
    abs: string,
    fn: ts.SignatureDeclaration,
    outer: readonly ts.SignatureDeclaration[],
  ): WalkResult => {
    const roots: ts.Node[] = [...fn.parameters];
    const body = functionBody(fn);
    if (body !== undefined) {
      roots.push(body);
    }
    return walkOwner(abs, fn, fn, outer, roots);
  };

  /**
   * What running a `new` of `cls` does: the constructor, the instance field
   * initialisers, and the same again for each base class. An unresolvable
   * base is a finding, never a silent skip.
   */
  const walkClass = (
    classAbs: string,
    cls: ClassLike,
    visited: Set<ClassLike>,
  ): SideEffectFinding[] => {
    if (visited.has(cls)) {
      return [];
    }
    visited.add(cls);
    const out: SideEffectFinding[] = [];
    for (const member of cls.members) {
      if (ts.isConstructorDeclaration(member)) {
        out.push(...walkFn(classAbs, member, []).findings);
      } else if (
        ts.isPropertyDeclaration(member) &&
        member.initializer !== undefined &&
        !isStaticMember(member)
      ) {
        out.push(
          ...walkOwner(classAbs, member, undefined, [], [member.initializer])
            .findings,
        );
      }
    }
    const base = baseClassOf(classAbs, cls);
    if (base.kind === "class") {
      out.push(...walkClass(base.abs, base.cls, visited));
    } else if (base.kind === "unknown") {
      out.push(
        makeFinding(
          classAbs,
          UNANALYSED_KIND,
          base.node,
          `class-base ${base.text} (${rel(classAbs)})`,
        ),
      );
    }
    return out;
  };

  const walkOwner = (
    abs: string,
    owner: ts.Node,
    fnLike: ts.SignatureDeclaration | undefined,
    outer: readonly ts.SignatureDeclaration[],
    roots: readonly ts.Node[],
  ): WalkResult => {
    const memoised = fnMemo.get(owner);
    if (memoised !== undefined) {
      return memoised;
    }
    if (inProgress.has(owner)) {
      return { findings: [], effects: [] };
    }
    inProgress.add(owner);
    const scopes: ts.SignatureDeclaration[] =
      fnLike !== undefined ? [fnLike, ...outer] : [...outer];
    const locals = new Set<string>();
    for (const scope of scopes) {
      for (const name of localsFor(scope)) {
        locals.add(name);
      }
    }
    const findings: SideEffectFinding[] = [];
    const effects: ParamEffect[] = [];

    const add = (kind: string, node: ts.Node, detail: string): void => {
      findings.push(makeFinding(abs, kind, node, detail));
    };
    const unanalysed = (node: ts.Node, label: string): void => {
      add(UNANALYSED_KIND, node, label);
    };
    const site = (node: ts.Node): string =>
      `${rel(abs)}:${String(lineOf(abs, node))}:${String(columnOf(abs, node))}`;
    const localDeclaration = (name: string): ts.Node | undefined => {
      for (const scope of scopes) {
        const found = localDeclarationOf(scope, name);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };

    /**
     * Where the value an expression denotes comes from. `fresh`: made here or
     * by zod, nobody else holds it. `param`: the object a parameter of a scope
     * function holds. `nonlocal`: a module value or a global. `unknown`: a
     * local initialised by a call the walk cannot classify. A local is as
     * fresh as its initialiser, so `const x = moduleList` is `nonlocal`.
     */
    const provenanceOf = (
      expression: ts.Expression,
      viaLocal: boolean,
      seen: Set<string>,
    ): Provenance => {
      const inner = strip(expression);
      const branches = receiverBranches(inner);
      if (branches !== undefined) {
        return combineProvenance(
          branches.map((branch) => provenanceOf(branch, viaLocal, seen)),
        );
      }
      if (isFreshLiteral(inner) || ts.isFunctionLike(inner)) {
        return FRESH_PROVENANCE;
      }
      const root = rootOf(inner);
      if (isFreshRoot(root)) {
        return FRESH_PROVENANCE;
      }
      if (!ts.isIdentifier(root)) {
        return isFreshLiteral(root) ? FRESH_PROVENANCE : NONLOCAL_PROVENANCE;
      }
      const name = root.text;
      const hasCall = receiverHasCall(inner);
      if (locals.has(name)) {
        if (seen.has(name)) {
          return FRESH_PROVENANCE;
        }
        seen.add(name);
        const declaration = localDeclaration(name);
        if (declaration === undefined) {
          return FRESH_PROVENANCE;
        }
        if (ts.isParameter(declaration)) {
          const parameterOwner = declaration.parent;
          if (ts.isFunctionLike(parameterOwner)) {
            return {
              kind: "param",
              owner: parameterOwner,
              index: parameterOwner.parameters.indexOf(declaration),
              name,
            };
          }
          return FRESH_PROVENANCE;
        }
        if (ts.isVariableDeclaration(declaration)) {
          let source: ts.Expression | undefined = declaration.initializer;
          if (source === undefined) {
            const list = declaration.parent;
            if (
              ts.isVariableDeclarationList(list) &&
              ts.isForOfStatement(list.parent)
            ) {
              source = list.parent.expression;
            }
          }
          if (source === undefined) {
            return FRESH_PROVENANCE;
          }
          return provenanceOf(source, true, seen);
        }
        return FRESH_PROVENANCE;
      }
      const resolved = resolveName(abs, name, new Set());
      if (resolved !== undefined && resolved.kind === "zod") {
        return FRESH_PROVENANCE;
      }
      if (resolved === undefined && isPureGlobalRoot(name)) {
        return FRESH_PROVENANCE;
      }
      if (viaLocal && hasCall) {
        if (
          resolved !== undefined &&
          resolved.kind === "local" &&
          isSchemaLike(resolved.node)
        ) {
          return FRESH_PROVENANCE;
        }
        return UNKNOWN_PROVENANCE;
      }
      return NONLOCAL_PROVENANCE;
    };
    const provenanceOfTarget = (expression: ts.Expression): Provenance =>
      provenanceOf(expression, false, new Set());
    const rootNameOf = (expression: ts.Expression): string => {
      const root = rootOf(expression);
      return !isFreshRoot(root) && ts.isIdentifier(root)
        ? root.text
        : snippet(expression, 30);
    };
    /**
     * A write to the object `target` denotes. A fresh object is fine; a
     * module value is a finding; a parameter's object is an effect of the
     * function, reported at each analysed call site that hands it a module
     * value; an unknown provenance is unanalysed.
     */
    const mutation = (
      node: ts.Node,
      target: ts.Expression,
      kind: string,
      detail: string,
    ): void => {
      const provenance = provenanceOfTarget(target);
      if (provenance.kind === "fresh") {
        return;
      }
      if (provenance.kind === "nonlocal") {
        add(kind, node, detail);
        return;
      }
      if (provenance.kind === "param") {
        effects.push({
          owner: provenance.owner,
          index: provenance.index,
          paramName: provenance.name,
          kind,
          detail,
          method: undefined,
        });
        return;
      }
      unanalysed(
        node,
        `mutation-on-unknown-provenance ${rootNameOf(target)} (${rel(abs)})`,
      );
    };
    const isSchemaArgument = (argument: ts.Expression): boolean => {
      const root = rootOf(argument);
      if (isFreshRoot(root) || !ts.isIdentifier(root)) {
        return false;
      }
      const resolved = resolveName(abs, root.text, new Set());
      return (
        resolved !== undefined &&
        (resolved.kind === "zod" ||
          (resolved.kind === "local" && isSchemaLike(resolved.node)))
      );
    };
    /**
     * A recorded effect on parameter `effect.index` of a function this walk
     * has just entered, applied to the argument the call site passes there.
     */
    const applyEffect = (
      effect: ParamEffect,
      args: readonly ts.Expression[],
      prefix: string,
      node: ts.Node,
    ): void => {
      const raw = args[effect.index];
      if (raw === undefined) {
        return;
      }
      const argument = ts.isSpreadElement(raw) ? raw.expression : raw;
      const provenance = provenanceOfTarget(argument);
      if (provenance.kind === "fresh") {
        return;
      }
      if (provenance.kind === "param") {
        effects.push({
          owner: provenance.owner,
          index: provenance.index,
          paramName: provenance.name,
          kind: effect.kind,
          detail: effect.detail,
          method: effect.method,
        });
        return;
      }
      if (
        provenance.kind === "nonlocal" &&
        effect.kind === UNANALYSED_KIND &&
        effect.method !== undefined &&
        !PARSE_FAMILY.has(effect.method) &&
        isSchemaArgument(argument)
      ) {
        return;
      }
      if (provenance.kind === "unknown") {
        findings.push({
          kind: UNANALYSED_KIND,
          at: site(node),
          detail: `argument-of-unknown-provenance ${effect.paramName} (${rel(abs)})`,
          via: prefix,
        });
        return;
      }
      findings.push({
        kind: effect.kind,
        at: site(node),
        detail:
          effect.kind === UNANALYSED_KIND
            ? effect.detail
            : `${effect.detail} [parameter ${effect.paramName}]`,
        via: prefix,
      });
    };
    const enterWith = (
      label: string,
      node: ts.Node,
      targetAbs: string,
      target: ts.SignatureDeclaration,
      outerScopes: readonly ts.SignatureDeclaration[],
      args: readonly ts.Expression[] | undefined,
    ): void => {
      const prefix = `${label} <- ${site(node)}`;
      const result = walkFn(targetAbs, target, outerScopes);
      for (const finding of result.findings) {
        findings.push(withVia(finding, prefix));
      }
      for (const effect of result.effects) {
        if (effect.owner === target) {
          if (args !== undefined) {
            applyEffect(effect, args, prefix, node);
          }
        } else if (scopes.includes(effect.owner)) {
          effects.push(effect);
        }
      }
    };
    const enter = (
      label: string,
      node: ts.Node,
      targetAbs: string,
      target: ts.SignatureDeclaration,
      outerScopes: readonly ts.SignatureDeclaration[],
    ): void => {
      enterWith(label, node, targetAbs, target, outerScopes, undefined);
    };
    const sourceOfIdentifier = (name: string): MemberSource | undefined => {
      if (locals.has(name)) {
        const declaration = localDeclaration(name);
        return declaration === undefined
          ? undefined
          : memberSourceOf(abs, declaration);
      }
      const resolved = resolveName(abs, name, new Set());
      if (resolved !== undefined && resolved.kind === "local") {
        return memberSourceOf(resolved.abs, resolved.node);
      }
      return undefined;
    };
    /** Walks the method the receiver's object literal or class defines. */
    const walkMember = (
      node: ts.Node,
      name: string,
      method: string,
      args: readonly ts.Expression[],
    ): boolean => {
      const source = sourceOfIdentifier(name);
      if (source === undefined) {
        return false;
      }
      const members = findMemberFns(source, method, "method", new Set());
      for (const member of members) {
        enterWith(`${name}.${method}`, node, member.abs, member.fn, [], args);
      }
      return members.length > 0;
    };
    /** The call-free chain a local was initialised from, if it is one. */
    const aliasInitializer = (name: string): ts.Expression | undefined => {
      const declaration = localDeclaration(name);
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        const initializer = strip(declaration.initializer);
        if (aliasRootName(initializer) !== undefined) {
          return initializer;
        }
      }
      return undefined;
    };
    /** Records an unanalysed effect on the parameter `provenance` names. */
    const parameterEffect = (
      provenance: ParamProvenance,
      detail: string,
      method: string | undefined,
    ): void => {
      effects.push({
        owner: provenance.owner,
        index: provenance.index,
        paramName: provenance.name,
        kind: UNANALYSED_KIND,
        detail,
        method,
      });
    };
    /**
     * Running the parse family on a schema runs its refine and transform
     * callbacks, which the walk only follows when they are literals in this
     * thunk. `schema` is the schema value being parsed with.
     */
    const parseOf = (
      node: ts.Node,
      schema: ts.Expression,
      label: string,
      method: string,
    ): void => {
      const provenance = provenanceOfTarget(schema);
      if (provenance.kind === "fresh") {
        return;
      }
      if (provenance.kind === "param") {
        parameterEffect(provenance, label, method);
        return;
      }
      unanalysed(node, label);
    };

    /**
     * A registry write that is observable apart from the thunk's own fresh
     * schema. `.describe(text)` never is; metadata is when it can carry an
     * `id` (the registry lists ids, so an id registers late); `.register` is
     * when its receiver is not a schema this thunk built.
     */
    const zodRegistryWrite = (
      node: ts.Node,
      receiver: ts.Expression,
      method: string,
      args: readonly ts.Expression[],
    ): void => {
      if (method === "meta") {
        if (mayCarryId(args[0])) {
          add("Z registry", node, snippet(node, 80));
        }
        return;
      }
      if (method === "register") {
        if (mayCarryId(args[1])) {
          add("Z registry", node, snippet(node, 80));
        } else {
          mutation(node, receiver, "Z registry", snippet(node, 80));
        }
      }
    };

    const analyseIdentifierCallee = (
      name: string,
      node: ts.Node,
      args: readonly ts.Expression[],
    ): void => {
      if (locals.has(name)) {
        const declaration = localDeclaration(name);
        if (declaration === undefined) {
          return;
        }
        const target = targetFn(declaration);
        if (target !== undefined) {
          enterWith(name, node, abs, target, scopes, args);
        } else if (
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined
        ) {
          unanalysed(node, `callee-not-function ${name} (${rel(abs)})`);
        }
        return;
      }
      const resolved = resolveName(abs, name, new Set());
      if (resolved === undefined) {
        if (!PURE_GLOBAL_FUNCTIONS.has(name)) {
          unanalysed(node, `unresolved-ident ${name} (${rel(abs)})`);
        }
        return;
      }
      if (resolved.kind === "zod") {
        const imported = topDecls(abs).imports.get(name);
        if (imported !== undefined && imported.orig === "meta") {
          if (mayCarryId(args[0])) {
            add("Z registry", node, snippet(node, 80));
          }
        }
        const firstArgument = args[0];
        if (
          imported !== undefined &&
          PARSE_FAMILY.has(imported.orig) &&
          firstArgument !== undefined
        ) {
          parseOf(
            node,
            firstArgument,
            `parse-runs-callbacks ${name} (${rel(abs)})`,
            imported.orig,
          );
        }
        return;
      }
      if (resolved.kind === "external") {
        unanalysed(node, `external ${resolved.spec}:${name} (${rel(abs)})`);
        return;
      }
      if (resolved.kind === "unresolved") {
        unanalysed(
          node,
          `unresolved-module ${resolved.spec}:${name} (${rel(abs)})`,
        );
        return;
      }
      if (resolved.kind === "namespace") {
        unanalysed(node, `namespace-call ${name} (${rel(abs)})`);
        return;
      }
      const target = targetFn(resolved.node);
      if (target === undefined) {
        unanalysed(node, `callee-not-function ${name} (${rel(resolved.abs)})`);
        return;
      }
      enterWith(name, node, resolved.abs, target, [], args);
    };

    const classifyReceiver = (
      node: ts.Node,
      ce: ts.PropertyAccessExpression,
      method: string,
      receiver: ts.Expression,
      args: readonly ts.Expression[],
      depth: number,
    ): void => {
      const recvExpr = strip(receiver);
      const branches = receiverBranches(recvExpr);
      if (branches !== undefined) {
        for (const branch of branches) {
          classifyReceiver(node, ce, method, branch, args, depth);
        }
        return;
      }
      const recvRoot = rootOf(receiver);
      if (isFreshRoot(recvRoot)) {
        return;
      }
      if (!ts.isIdentifier(recvRoot)) {
        if (isFreshLiteral(recvRoot)) {
          return;
        }
        unanalysed(
          node,
          `method-on-expression ${snippet(ce, 60)} (${rel(abs)})`,
        );
        return;
      }
      const name = recvRoot.text;
      const direct = ts.isIdentifier(recvExpr);
      if (locals.has(name)) {
        if (direct && walkMember(node, name, method, args)) {
          return;
        }
        const provenance = provenanceOfTarget(receiver);
        if (provenance.kind === "fresh") {
          return;
        }
        if (provenance.kind === "param") {
          parameterEffect(
            provenance,
            PARSE_FAMILY.has(method)
              ? `parse-runs-callbacks ${provenance.name}.${method} (${rel(abs)})`
              : `param-method ${provenance.name}.${method} (${rel(abs)})`,
            method,
          );
          return;
        }
        if (provenance.kind === "unknown") {
          unanalysed(
            node,
            `method-on-unknown-provenance ${name}.${method} (${rel(abs)})`,
          );
          return;
        }
        const alias = aliasInitializer(name);
        if (alias !== undefined && depth < 4) {
          classifyReceiver(node, ce, method, alias, args, depth + 1);
          return;
        }
        unanalysed(
          node,
          `method-on-non-schema ${name}.${method} (${rel(abs)})`,
        );
        return;
      }
      const resolved = resolveName(abs, name, new Set());
      if (resolved === undefined) {
        if (direct && PURE_GLOBAL_CALLS.has(`${name}.${method}`)) {
          return;
        }
        if (PURE_NAMESPACES.has(name)) {
          return;
        }
        if (
          !direct &&
          receiverHasCall(receiver) &&
          PURE_GLOBAL_FUNCTIONS.has(name)
        ) {
          return;
        }
        unanalysed(
          node,
          `method-on-unresolved ${name}.${method} (${rel(abs)})`,
        );
        return;
      }
      if (resolved.kind === "zod") {
        const firstArgument = args[0];
        if (direct && PARSE_FAMILY.has(method) && firstArgument !== undefined) {
          parseOf(
            node,
            firstArgument,
            `parse-runs-callbacks ${name}.${method} (${rel(abs)})`,
            method,
          );
        }
        return;
      }
      if (resolved.kind === "external") {
        unanalysed(
          node,
          `method-on-external ${resolved.spec}:${name}.${method} (${rel(abs)})`,
        );
        return;
      }
      if (resolved.kind === "unresolved") {
        unanalysed(
          node,
          `method-on-unresolved-module ${resolved.spec}:${name}.${method} (${rel(abs)})`,
        );
        return;
      }
      if (resolved.kind === "namespace") {
        if (direct) {
          const inner = resolveExport(resolved.abs, method, new Set());
          if (inner !== undefined && inner.kind === "zod") {
            return;
          }
          if (inner !== undefined && inner.kind === "local") {
            const target = targetFn(inner.node);
            if (target !== undefined) {
              enterWith(`${name}.${method}`, node, inner.abs, target, [], args);
              return;
            }
          }
          unanalysed(node, `namespace-member ${name}.${method} (${rel(abs)})`);
          return;
        }
        const first = firstMemberName(receiver);
        const member =
          first === undefined
            ? undefined
            : resolveExport(resolved.abs, first, new Set());
        if (
          member !== undefined &&
          (member.kind === "zod" ||
            (member.kind === "local" && isSchemaLike(member.node)))
        ) {
          if (member.kind === "local" && PARSE_FAMILY.has(method)) {
            unanalysed(
              node,
              `parse-runs-callbacks ${first ?? name}.${method} (${rel(abs)})`,
            );
          }
          return;
        }
        unanalysed(
          node,
          `method-on-non-schema ${name}.${first ?? "?"}.${method} (${rel(abs)})`,
        );
        return;
      }
      if (isSchemaLike(resolved.node)) {
        if (PARSE_FAMILY.has(method)) {
          unanalysed(
            node,
            `parse-runs-callbacks ${name}.${method} (${rel(abs)})`,
          );
        }
        return;
      }
      if (direct) {
        const source = memberSourceOf(resolved.abs, resolved.node);
        if (source !== undefined) {
          const members = findMemberFns(source, method, "method", new Set());
          if (members.length > 0) {
            for (const member of members) {
              enterWith(
                `${name}.${method}`,
                node,
                member.abs,
                member.fn,
                [],
                args,
              );
            }
            return;
          }
        }
      }
      unanalysed(
        node,
        `method-on-non-schema ${name}.${method} (${rel(resolved.abs)})`,
      );
    };

    const analysePropertyCall = (
      node: ts.Node,
      ce: ts.PropertyAccessExpression,
      args: readonly ts.Expression[],
    ): void => {
      const method = ce.name.text;
      const recvExpr = strip(ce.expression);
      const recvRoot = rootOf(ce.expression);
      const recvName =
        !isFreshRoot(recvRoot) && ts.isIdentifier(recvRoot)
          ? recvRoot.text
          : undefined;
      if (ZOD_REG.has(method)) {
        zodRegistryWrite(node, ce.expression, method, args);
        return;
      }
      if (
        (recvName === "Object" || recvName === "Reflect") &&
        !locals.has(recvName) &&
        ts.isIdentifier(recvExpr) &&
        OBJ_MUTATORS.has(method)
      ) {
        const first = args[0];
        if (first !== undefined) {
          mutation(node, first, "S4 object-mutator", snippet(node, 80));
        }
        return;
      }
      if (MUTATORS.has(method)) {
        mutation(node, ce.expression, "S4 mutator", snippet(node, 80));
        return;
      }
      if (CALL_FORMS.has(method)) {
        unanalysed(node, `call-apply-bind ${snippet(ce, 60)} (${rel(abs)})`);
        return;
      }
      classifyReceiver(node, ce, method, ce.expression, args, 0);
    };

    const analyseElementCall = (
      node: ts.Node,
      ce: ts.ElementAccessExpression,
    ): void => {
      const provenance = provenanceOfTarget(ce.expression);
      if (provenance.kind === "fresh") {
        return;
      }
      const label = `element-access-call ${snippet(ce, 60)} (${rel(abs)})`;
      if (provenance.kind === "param") {
        parameterEffect(provenance, label, undefined);
        return;
      }
      unanalysed(node, label);
    };

    const analyseCallee = (
      node: ts.Node,
      callee: ts.Expression,
      args: readonly ts.Expression[],
    ): void => {
      const ce = strip(callee);
      if (ts.isPropertyAccessExpression(ce)) {
        analysePropertyCall(node, ce, args);
      } else if (ts.isElementAccessExpression(ce)) {
        analyseElementCall(node, ce);
      } else if (ts.isIdentifier(ce)) {
        analyseIdentifierCallee(ce.text, node, args);
      } else if (ts.isFunctionLike(ce)) {
        // An IIFE: the function-like branch of `visit` walks it.
      } else if (ce.kind === ts.SyntaxKind.SuperKeyword) {
        // `super(...)`: the base class is walked with the `new`.
      } else if (ce.kind === ts.SyntaxKind.ImportKeyword) {
        unanalysed(node, `dynamic-import (${rel(abs)})`);
      } else {
        unanalysed(node, `dynamic-callee ${snippet(ce, 60)} (${rel(abs)})`);
      }
    };

    const analyseNew = (node: ts.NewExpression): void => {
      const ce = strip(node.expression);
      const label = snippet(ce, 60);
      const args = node.arguments ?? [];
      const walkClassOf = (
        classAbs: string,
        cls: ClassLike,
        name: string,
      ): void => {
        const prefix = `new ${name} <- ${site(node)}`;
        for (const finding of walkClass(classAbs, cls, new Set())) {
          findings.push(withVia(finding, prefix));
        }
        for (const member of cls.members) {
          if (ts.isConstructorDeclaration(member)) {
            for (const effect of walkFn(classAbs, member, []).effects) {
              if (effect.owner === member) {
                applyEffect(effect, args, prefix, node);
              }
            }
          }
        }
      };
      if (ts.isClassExpression(ce)) {
        walkClassOf(abs, ce, "class");
        return;
      }
      if (ts.isIdentifier(ce)) {
        const name = ce.text;
        if (locals.has(name)) {
          const declaration = localDeclaration(name);
          const cls =
            declaration === undefined ? undefined : classOfNode(declaration);
          if (cls !== undefined) {
            walkClassOf(abs, cls, name);
            return;
          }
          const target =
            declaration === undefined ? undefined : targetFn(declaration);
          if (target !== undefined) {
            enterWith(`new ${name}`, node, abs, target, scopes, args);
          }
          return;
        }
        const resolved = resolveName(abs, name, new Set());
        if (resolved === undefined) {
          if (!PURE_CONSTRUCTORS.has(name)) {
            unanalysed(node, `new ${name} (unresolved) (${rel(abs)})`);
          }
          return;
        }
        if (resolved.kind === "zod") {
          return;
        }
        if (resolved.kind !== "local") {
          unanalysed(node, `new ${name} (${resolved.kind}) (${rel(abs)})`);
          return;
        }
        const cls = classOfNode(resolved.node);
        if (cls !== undefined) {
          walkClassOf(resolved.abs, cls, name);
          return;
        }
        const target = targetFn(resolved.node);
        if (target !== undefined) {
          enterWith(`new ${name}`, node, resolved.abs, target, [], args);
          return;
        }
        unanalysed(node, `new ${name} (not-a-class) (${rel(abs)})`);
        return;
      }
      if (ts.isPropertyAccessExpression(ce)) {
        const recv = strip(ce.expression);
        if (ts.isIdentifier(recv) && !locals.has(recv.text)) {
          const resolved = resolveName(abs, recv.text, new Set());
          if (resolved === undefined && recv.text === "Intl") {
            return;
          }
          if (resolved !== undefined && resolved.kind === "zod") {
            return;
          }
          if (resolved !== undefined && resolved.kind === "namespace") {
            const inner = resolveExport(resolved.abs, ce.name.text, new Set());
            if (inner !== undefined && inner.kind === "local") {
              const cls = classOfNode(inner.node);
              if (cls !== undefined) {
                walkClassOf(inner.abs, cls, label);
                return;
              }
            }
          }
        }
      }
      unanalysed(node, `new ${label} (${rel(abs)})`);
    };

    const analyseGetter = (node: ts.PropertyAccessExpression): void => {
      const recv = strip(node.expression);
      if (!ts.isIdentifier(recv)) {
        return;
      }
      const source = sourceOfIdentifier(recv.text);
      if (source === undefined) {
        return;
      }
      const getters = findMemberFns(source, node.name.text, "get", new Set());
      for (const getter of getters) {
        enter(
          `get ${recv.text}.${node.name.text}`,
          node,
          getter.abs,
          getter.fn,
          [],
        );
      }
    };

    /** A function passed by name as an argument runs during the call. */
    const walkCallbackIdentifiers = (
      node: ts.Node,
      args: readonly ts.Expression[],
    ): void => {
      for (const arg of args) {
        const inner = strip(arg);
        if (!ts.isIdentifier(inner)) {
          continue;
        }
        if (locals.has(inner.text)) {
          const declaration = localDeclaration(inner.text);
          const target =
            declaration === undefined ? undefined : targetFn(declaration);
          if (target !== undefined) {
            enter(`callback ${inner.text}`, node, abs, target, scopes);
          }
          continue;
        }
        const resolved = resolveName(abs, inner.text, new Set());
        if (resolved !== undefined && resolved.kind === "local") {
          const target = targetFn(resolved.node);
          if (target !== undefined) {
            enter(`callback ${inner.text}`, node, resolved.abs, target, []);
          }
        }
      }
    };

    /** A write through a name that this function does not declare. */
    const assignTo = (
      node: ts.Node,
      target: ts.Expression,
      kind: string,
      detail: string,
    ): void => {
      const stripped = strip(target);
      if (ts.isIdentifier(stripped)) {
        if (!locals.has(stripped.text)) {
          add(kind, node, detail);
        }
        return;
      }
      mutation(node, stripped, kind, detail);
    };

    const visit = (node: ts.Node): void => {
      if (node !== fnLike && ts.isFunctionLike(node)) {
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
          const result = walkFn(abs, node, scopes);
          for (const finding of result.findings) {
            findings.push(finding);
          }
          for (const effect of result.effects) {
            if (scopes.includes(effect.owner)) {
              effects.push(effect);
            }
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
        } else {
          assignTo(node, left, "S1 assign", snippet(node, 80));
        }
      }
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
      ) {
        const head = strip(node.initializer);
        if (
          ts.isArrayLiteralExpression(head) ||
          ts.isObjectLiteralExpression(head)
        ) {
          add("S1 destructuring-assign", node, snippet(node.initializer, 80));
        } else {
          assignTo(node, head, "S1 assign", snippet(node.initializer, 80));
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        assignTo(node, node.operand, "S2 update", snippet(node, 80));
      }
      if (ts.isDeleteExpression(node)) {
        mutation(node, node.expression, "S3 delete", snippet(node, 80));
      }
      if (ts.isCallExpression(node)) {
        analyseCallee(node, node.expression, node.arguments);
        walkCallbackIdentifiers(node, node.arguments);
      } else if (ts.isNewExpression(node)) {
        analyseNew(node);
        walkCallbackIdentifiers(node, node.arguments ?? []);
      } else if (ts.isTaggedTemplateExpression(node)) {
        analyseCallee(node, node.tag, []);
      }
      if (ts.isPropertyAccessExpression(node)) {
        analyseGetter(node);
      }
      ts.forEachChild(node, visit);
    };

    for (const root of roots) {
      visit(root);
    }
    inProgress.delete(owner);
    const result: WalkResult = { findings, effects };
    fnMemo.set(owner, result);
    return result;
  };

  type ThunkFn = {
    readonly abs: string;
    readonly fnAbs: string;
    readonly call: ts.CallExpression;
    readonly fn: ts.SignatureDeclaration;
    readonly outer: readonly ts.SignatureDeclaration[];
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
            fnAbs: abs,
            call: node,
            fn: arg,
            outer: [],
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
            for (const returned of factoryReturnedFunctions(target)) {
              thunkFns.push({
                abs,
                fnAbs: resolved.abs,
                call: node,
                fn: returned,
                outer: [target],
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
    at: string | undefined,
  ): void => {
    hits.push({
      rule,
      file: rel(abs),
      line: lineOf(abs, call),
      bindingName,
      kind,
      detail,
      at,
    });
  };

  for (const thunk of thunkFns) {
    const declaredInside = new Set<string>(localsFor(thunk.fn));
    for (const scope of thunk.outer) {
      for (const name of localsFor(scope)) {
        declaredInside.add(name);
      }
    }
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
          undefined,
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
          undefined,
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
          undefined,
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
            undefined,
          );
        }
      }
      const aliasRoot = aliasRootName(returned);
      if (
        aliasRoot !== undefined &&
        aliasRoot !== "undefined" &&
        !declaredInside.has(aliasRoot)
      ) {
        pushHit(
          "R6",
          thunk.abs,
          thunk.call,
          thunk.bindingName,
          "alias",
          snippet(inner, 80),
          undefined,
        );
      }
    }
    for (const finding of walkFn(thunk.fnAbs, thunk.fn, thunk.outer).findings) {
      pushHit(
        "R5",
        thunk.abs,
        thunk.call,
        thunk.bindingName,
        finding.kind,
        finding.detail,
        finding.at,
      );
    }
  }

  return { thunkCount, hits };
}

export function hitsOf(
  result: ThunkScanResult,
  rule: RuleId,
  bindingName: string,
): readonly ThunkRuleHit[] {
  return result.hits.filter(
    (hit) => hit.rule === rule && hit.bindingName === bindingName,
  );
}

export function formatHit(hit: ThunkRuleHit): string {
  const name = hit.bindingName !== undefined ? ` ${hit.bindingName}` : "";
  return `${hit.rule} ${hit.file}:${String(hit.line)}${name} ${hit.kind} ${hit.detail}`;
}

export function isUnanalysedHit(hit: ThunkRuleHit): boolean {
  return hit.rule === "R5" && hit.kind === UNANALYSED_KIND;
}

/**
 * Occurrences per unanalysed label: the number of distinct source sites
 * (file:line:column of the call) that carry it. A call reached from several
 * thunks is one occurrence; a further call under the same label is another.
 */
export function unanalysedCountsOf(
  result: ThunkScanResult,
): ReadonlyMap<string, number> {
  const sites = new Map<string, Set<string>>();
  for (const hit of result.hits) {
    if (!isUnanalysedHit(hit)) {
      continue;
    }
    const at = hit.at ?? `${hit.file}:${String(hit.line)}`;
    const known = sites.get(hit.detail);
    if (known === undefined) {
      sites.set(hit.detail, new Set([at]));
    } else {
      known.add(at);
    }
  }
  const counts = new Map<string, number>();
  for (const [label, at] of sites) {
    counts.set(label, at.size);
  }
  return counts;
}

/**
 * One line per label whose production occurrence count differs from the
 * allow-list's, in either direction: a label nobody judged, a further call
 * under a judged label, or a stale entry. Empty means the two are equal.
 */
export function allowListMismatches(
  actual: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
): string[] {
  const out: string[] = [];
  for (const [label, found] of actual) {
    const expected = allowed.get(label);
    if (expected === undefined) {
      out.push(
        `${label}: ${String(found)} occurrence(s), not in the allow-list; judge each and add it with a reason only if it is pure`,
      );
    } else if (expected !== found) {
      out.push(
        `${label}: allow-list says ${String(expected)} occurrence(s), found ${String(found)}; judge the difference and update the count`,
      );
    }
  }
  for (const [label, expected] of allowed) {
    if (!actual.has(label)) {
      out.push(
        `${label}: stale allow-list entry (${String(expected)} occurrence(s)), found none; remove it`,
      );
    }
  }
  return out.sort();
}

/** The distinct labels of the unanalysed findings, sorted. */
export function unanalysedLabelsOf(result: ThunkScanResult): string[] {
  const labels = new Set<string>();
  for (const hit of result.hits) {
    if (isUnanalysedHit(hit)) {
      labels.add(hit.detail);
    }
  }
  return [...labels].sort();
}
