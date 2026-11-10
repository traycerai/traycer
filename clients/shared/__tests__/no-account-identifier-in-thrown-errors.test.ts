import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Source-scan gate: a thrown Error message in `clients/shared` or
// `protocol/src` must not interpolate an account-identity field.
//
// The detector finds each `new *Error` message argument (and `super(...)`
// in a class that extends `*Error`) and checks that argument as an
// expression. String literals and the literal chunks of a template are
// never examined, so prose can name a field or contain `.email` without
// being flagged. A template is checked on its substitution expressions
// only, and a `+` / `+=` concatenation on its operands.
//
// Inside an expression span it flags either a dotted identity access
// (`.userId`, `.accountId`, `.orgId`, `.organizationId`, `.email`,
// `.teamId`, or `identity.`) or a bare identity name (`userId`,
// `accountId`, `orgId`, `organizationId`, `email`, `teamId`). A bare
// name there is a value being interpolated.
//
// One hop: when the message argument itself is a bare identifier that
// is not an identity name, the same check is applied to that
// identifier's initializer in the same function body. Nothing deeper.
//
// Violators below are in-memory strings. They are not written under
// `clients/shared` or `protocol/src`. An in-tree violator makes the
// package dirty for any concurrent lint or test run, and a CI job reads
// that deliberate violation as a genuine breach. Same constraint as
// `host-lifecycle-eslint-boundary.test.ts`.
//
// Limits, on purpose. There is no scope analysis. The hop is one
// initializer, and only when the argument itself is the identifier.
// Unseen: forwarding (`${cause.message}`, `error.message`, `${cause}` —
// the field is already in the originating throw, and that origin is the
// fix site), a message built in another function, a spread
// (`{ ...details }`), the Error options argument, a local whose
// initializer is itself only a name, a bare local named inside a
// substitution or operand (the hop does not apply there), an
// outer-function or module-level local, and computed access
// (`identity["userId"]`).

const DOTTED_ACCESS =
  /\.(?:organizationId|accountId|userId|orgId|email|teamId)\b|identity\./;

const BARE_IDENTITY_NAME =
  /\b(?:organizationId|accountId|userId|orgId|email|teamId)\b/;

const IDENTITY_FIELD_NAMES = new Set([
  "userId",
  "accountId",
  "orgId",
  "organizationId",
  "email",
  "teamId",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

// `ts.sys.readDirectory` exclude globs. A bare directory name is not a
// recursive exclude, so each skipped directory is a `**/name/**` pattern.
// Declaration files and test files match the `.ts` extension, so they are
// excluded by name as well.
const SOURCE_EXCLUDES = [
  "**/node_modules/**",
  "**/__tests__/**",
  "**/dist/**",
  "**/dist-sea/**",
  "**/coverage/**",
  "**/out/**",
  "**/.git/**",
  "**/*.d.ts",
  "**/*.test.ts",
  "**/*.test.tsx",
];

type ThrownIdentityInterpolation = {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly fieldText: string;
};

type ErrorMessageScan = {
  readonly violations: readonly ThrownIdentityInterpolation[];
  readonly constructionCount: number;
};

type ScanContext = {
  readonly sourceFile: ts.SourceFile;
  readonly violations: ThrownIdentityInterpolation[];
  constructionCount: number;
};

type ProductionPopulation = {
  readonly fileCount: number;
  readonly constructionCount: number;
  readonly violations: readonly ThrownIdentityInterpolation[];
  readonly files: readonly string[];
};

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_ROOT = join(THIS_DIR, "..");
const REPO_ROOT = join(SHARED_ROOT, "..", "..");
const PROTOCOL_SRC = join(REPO_ROOT, "protocol", "src");

function findThrownIdentityInterpolations(
  filePath: string,
  sourceText: string,
): ErrorMessageScan {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ctx: ScanContext = {
    sourceFile,
    violations: [],
    constructionCount: 0,
  };
  visit(sourceFile, ctx);
  return {
    violations: ctx.violations,
    constructionCount: ctx.constructionCount,
  };
}

function isIdentityFieldName(name: string): boolean {
  return IDENTITY_FIELD_NAMES.has(name);
}

function matchedFieldText(original: string, blanked: string): string | null {
  const dotted = DOTTED_ACCESS.exec(blanked);
  const bare = BARE_IDENTITY_NAME.exec(blanked);
  if (dotted !== null && (bare === null || dotted.index <= bare.index)) {
    return expandAccess(
      original,
      dotted.index,
      dotted.index + dotted[0].length,
    );
  }
  if (bare !== null) {
    return original.slice(bare.index, bare.index + bare[0].length);
  }
  return null;
}

function blankLiteralChunks(expr: ts.Node, sourceFile: ts.SourceFile): string {
  const start = expr.getStart(sourceFile);
  const text = expr.getText(sourceFile);
  const chars = text.split("");
  const blank = (node: ts.Node): void => {
    const from = node.getStart(sourceFile) - start;
    const to = node.getEnd() - start;
    for (
      let index = Math.max(0, from);
      index < Math.min(chars.length, to);
      index += 1
    ) {
      chars[index] = " ";
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      blank(node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      blank(node.head);
      for (const span of node.templateSpans) {
        visit(span.expression);
        blank(span.literal);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return chars.join("");
}

function fieldTextInExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): string | null {
  return matchedFieldText(
    expr.getText(sourceFile),
    blankLiteralChunks(expr, sourceFile),
  );
}

function expandAccess(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && text[from - 1] === ".") {
    const ident = /[\w$]+$/.exec(text.slice(0, from - 1));
    if (ident === null || ident.index === undefined) break;
    from = ident.index;
  }
  if (text[end - 1] === ".") {
    const tail = /^[\w$]+/.exec(text.slice(end));
    if (tail !== null) end += tail[0].length;
  }
  return text.slice(from, end);
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function messageExpressions(
  args: readonly ts.Expression[],
  calleeName: string,
): readonly ts.Expression[] {
  if (calleeName === "AggregateError") {
    const message = args[1];
    return message === undefined ? [] : [message];
  }
  const first = args[0];
  if (first === undefined) return [];
  const unwrapped = unwrap(first);
  if (!ts.isObjectLiteralExpression(unwrapped)) return [first];
  const messages: ts.Expression[] = [];
  for (const prop of unwrapped.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      propertyNameText(prop.name) === "message"
    ) {
      messages.push(prop.initializer);
    }
    if (
      ts.isShorthandPropertyAssignment(prop) &&
      prop.name.text === "message"
    ) {
      messages.push(prop.name);
    }
  }
  return messages;
}

function errorConstructorName(expr: ts.Expression): string | null {
  const unwrapped = unwrap(expr);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return null;
}

function isErrorConstructor(name: string): boolean {
  return name === "Error" || name.endsWith("Error");
}

function functionWithBody(node: ts.Node): ts.FunctionLikeDeclaration | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node;
  }
  return null;
}

function enclosingFunctionBody(node: ts.Node): ts.Node | null {
  let current = node.parent;
  while (current !== undefined) {
    const declaration = functionWithBody(current);
    if (declaration !== null && declaration.body !== undefined) {
      return declaration.body;
    }
    current = current.parent;
  }
  return null;
}

function initializerInFunction(
  name: ts.Identifier,
  sourceFile: ts.SourceFile,
): ts.Expression | null {
  const body = enclosingFunctionBody(name);
  if (body === null) return null;
  const useAt = name.getStart(sourceFile);
  let found: ts.Expression | null = null;
  let foundAt = -1;
  const visitDecl = (node: ts.Node): void => {
    if (node !== body && functionWithBody(node) !== null) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name.text &&
      node.initializer !== undefined
    ) {
      const at = node.name.getStart(sourceFile);
      if (at < useAt && at > foundAt) {
        found = node.initializer;
        foundAt = at;
      }
    }
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(body);
  return found;
}

function fieldTextOfMessage(
  message: ts.Expression,
  sourceFile: ts.SourceFile,
): string | null {
  const bare = unwrap(message);
  if (ts.isIdentifier(bare)) {
    if (isIdentityFieldName(bare.text)) return bare.text;
    const initializer = initializerInFunction(bare, sourceFile);
    if (initializer === null) return null;
    return fieldTextInExpression(initializer, sourceFile);
  }
  return fieldTextInExpression(message, sourceFile);
}

function inspectMessage(
  message: ts.Expression,
  at: ts.Node,
  ctx: ScanContext,
): void {
  const fieldText = fieldTextOfMessage(message, ctx.sourceFile);
  if (fieldText === null) return;
  const position = ctx.sourceFile.getLineAndCharacterOfPosition(
    at.getStart(ctx.sourceFile),
  );
  ctx.violations.push({
    filePath: ctx.sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    fieldText,
  });
}

function noteMessages(
  args: readonly ts.Expression[],
  calleeName: string,
  at: ts.Node,
  ctx: ScanContext,
): void {
  for (const message of messageExpressions(args, calleeName)) {
    inspectMessage(message, at, ctx);
  }
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | null {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function extendsError(classNode: ts.ClassLikeDeclaration): boolean {
  const clauses = classNode.heritageClauses;
  if (clauses === undefined) return false;
  for (const clause of clauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const typeNode of clause.types) {
      const name = errorConstructorName(typeNode.expression);
      if (name !== null && isErrorConstructor(name)) return true;
    }
  }
  return false;
}

function visit(node: ts.Node, ctx: ScanContext): void {
  if (ts.isNewExpression(node)) {
    const name = errorConstructorName(node.expression);
    if (name !== null && isErrorConstructor(name)) {
      ctx.constructionCount += 1;
      if (node.arguments !== undefined) {
        noteMessages(node.arguments, name, node, ctx);
      }
    }
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    const classNode = enclosingClass(node);
    if (classNode !== null && extendsError(classNode)) {
      noteMessages(node.arguments, "Error", node, ctx);
    }
  }
  ts.forEachChild(node, (child) => {
    visit(child, ctx);
  });
}

function scanProductionPopulation(): ProductionPopulation {
  const files = [
    ...ts.sys.readDirectory(SHARED_ROOT, SOURCE_EXTENSIONS, SOURCE_EXCLUDES),
    ...ts.sys.readDirectory(PROTOCOL_SRC, SOURCE_EXTENSIONS, SOURCE_EXCLUDES),
  ];
  const violations: ThrownIdentityInterpolation[] = [];
  let constructionCount = 0;
  for (const file of files) {
    let result: ErrorMessageScan;
    try {
      result = findThrownIdentityInterpolations(
        file,
        readFileSync(file, "utf8"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "scan failed";
      throw new Error(`identity scan failed for ${file}: ${message}`);
    }
    constructionCount += result.constructionCount;
    violations.push(...result.violations);
  }
  return {
    fileCount: files.length,
    constructionCount,
    violations,
    files,
  };
}

// Loaded once so the case name itself reports the population size. A glob
// that matches nothing would still be a green `toEqual([])` without that
// count; the assertions below reject an empty population.
const productionScan = scanProductionPopulation();

function scanLines(
  filePath: string,
  lines: readonly string[],
): ErrorMessageScan {
  return findThrownIdentityInterpolations(filePath, lines.join("\n"));
}

function expectFlagged(
  filePath: string,
  lines: readonly string[],
  fieldText: string,
): void {
  const result = scanLines(filePath, lines);
  expect(result.constructionCount).toBe(1);
  expect(result.violations).toEqual([
    expect.objectContaining({ filePath, fieldText }),
  ]);
}

function expectClean(filePath: string, lines: readonly string[]): void {
  const result = scanLines(filePath, lines);
  expect(result.constructionCount).toBe(1);
  expect(result.violations).toEqual([]);
}

describe("no account identifier in thrown Error messages", () => {
  it(`finds no identity-field interpolation across ${productionScan.fileCount} production files (${productionScan.constructionCount} new-Error constructions)`, () => {
    expect(productionScan.fileCount).toBe(723);
    expect(productionScan.constructionCount).toBe(473);
    expect(
      productionScan.files.some((file) =>
        file.endsWith(join("clients", "shared", "auth", "bearer-source.ts")),
      ),
    ).toBe(true);
    expect(
      productionScan.files.some((file) =>
        file.endsWith(join("protocol", "src", "auth", "request-context.ts")),
      ),
    ).toBe(true);
    expect(
      productionScan.files.some(
        (file) =>
          file.includes(`${sep}__tests__${sep}`) ||
          file.endsWith(".test.ts") ||
          file.endsWith(".test.tsx"),
      ),
    ).toBe(false);
    expect(productionScan.violations).toEqual([]);
  });

  it("flags the pre-fix bearer-source template", () => {
    expectFlagged(
      join("clients", "shared", "auth", "bearer-source.ts"),
      [
        "class MutableBearerLease {",
        "  readonly identity: { readonly userId: string };",
        "  getBearerToken(): string {",
        "    throw new CredentialLeaseReleasedError(",
        "      `No bearer available for user '${this.identity.userId}'`,",
        "    );",
        "  }",
        "}",
      ],
      "this.identity.userId",
    );
  });

  it("flags the pre-fix empty-bearer WebSocket template", () => {
    expectFlagged(
      join("clients", "shared", "host-transport", "ws-rpc-client.ts"),
      [
        "function extractBearerForOpenFrame(source: {",
        "  readonly identity: { readonly userId: string };",
        "}): void {",
        "  throw new MissingBearerTokenForOpenFrameError(",
        "    `Cannot open host WebSocket with an empty bearer token for user '${source.identity.userId}'`,",
        "  );",
        "}",
      ],
      "source.identity.userId",
    );
  });

  it("flags an identity field joined with +", () => {
    expectFlagged(
      join("in-memory", "concat.ts"),
      [
        "function extractBearerForOpenFrame(source: {",
        "  readonly identity: { readonly userId: string };",
        "}): void {",
        "  throw new Error(",
        '    "Cannot open host WebSocket with an empty bearer token for user " +',
        "      source.identity.userId,",
        "  );",
        "}",
      ],
      "source.identity.userId",
    );
  });

  it("flags an identity field copied into a local and passed to Error", () => {
    expectFlagged(
      join("in-memory", "local-value.ts"),
      [
        "function getBearerToken(source: {",
        "  readonly identity: { readonly userId: string };",
        "}): void {",
        "  const leaked = source.identity.userId;",
        "  throw new Error(leaked);",
        "}",
      ],
      "source.identity.userId",
    );
  });

  it("flags a bare identity parameter interpolated into the message", () => {
    expectFlagged(
      join("in-memory", "bare-parameter.ts"),
      [
        "function getBearerToken(userId: string): void {",
        "  throw new Error(`no bearer for ${userId}`);",
        "}",
      ],
      "userId",
    );
  });

  it("flags a message template stored in a local and passed to Error", () => {
    expectFlagged(
      join("in-memory", "local-message.ts"),
      [
        "function getBearerToken(source: {",
        "  readonly identity: { readonly userId: string };",
        "}): void {",
        "  const detail = `No bearer available for user '${source.identity.userId}'`;",
        "  throw new Error(detail);",
        "}",
      ],
      "source.identity.userId",
    );
  });

  it("does not flag the lease-mismatch prose that names userId", () => {
    expectClean(join("protocol", "src", "auth", "request-context.ts"), [
      "function rotateBearerToken(): void {",
      "  throw new IdentityMismatchError(",
      '    "Refusing to rotate credentials: the supplied userId does not match the lease identity",',
      "  );",
      "}",
    ]);
  });

  it("does not flag the rotate-parser prose that names userId", () => {
    expectClean(
      join(
        "clients",
        "desktop",
        "src",
        "electron-main",
        "ipc",
        "ipc-parsers.ts",
      ),
      [
        "function parseTokenRotateExpected(): void {",
        "  throw new Error(",
        '    "tokenStore.rotate requires a { userId, token } object",',
        "  );",
        "}",
      ],
    );
  });

  it("does not flag a template that names userId only in the literal part", () => {
    expectClean(join("in-memory", "prose-template.ts"), [
      "function rotateBearerToken(reason: string): void {",
      "  throw new IdentityMismatchError(",
      "    `Refusing to rotate credentials: the supplied userId does not match the lease identity (${reason})`,",
      "  );",
      "}",
    ]);
  });

  it("does not flag a local whose text only names userId", () => {
    expectClean(join("in-memory", "prose-local.ts"), [
      "function rotateBearerToken(): void {",
      "  const detail =",
      '    "Refusing to rotate credentials: the supplied userId does not match the lease identity";',
      "  throw new IdentityMismatchError(detail);",
      "}",
    ]);
  });

  it("does not flag a literal that contains a dotted identity field", () => {
    expectClean(join("in-memory", "literal-dotted-field.ts"), [
      "function saveProfile(): void {",
      '  throw new Error("set profile.email before saving");',
      "}",
    ]);
  });

  it("does not flag prose that uses the word email", () => {
    expectClean(join("in-memory", "prose-email.ts"), [
      "function requireProfile(email: string): void {",
      "  if (email.length === 0) {",
      '    throw new Error("email must be present on the profile");',
      "  }",
      "}",
    ]);
  });

  it("does not flag forwarding of another error's message", () => {
    expectClean(
      join("clients", "shared", "host-transport", "ws-rpc-client.ts"),
      [
        "function extractBearerForOpenFrame(source: {",
        "  getBearerToken(): string;",
        "}): void {",
        "  try {",
        "    source.getBearerToken();",
        "  } catch (cause) {",
        "    throw new MissingBearerTokenForOpenFrameError(",
        "      `Cannot open host WebSocket: ${cause.message}`,",
        "    );",
        "  }",
        "}",
      ],
    );
  });
});
