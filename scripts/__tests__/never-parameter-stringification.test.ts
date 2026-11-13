import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type NeverParameterSite = {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly parameterName: string;
  readonly source:
    | "template interpolation"
    | "string concatenation"
    | "String()"
    | "JSON.stringify";
  readonly expressionText: string;
};

type UnsafeStringUse = {
  readonly source: NeverParameterSite["source"];
  readonly node: ts.Node;
};

type RepositoryScan = {
  readonly fileCount: number;
  readonly candidateFiles: readonly string[];
  readonly parsedFileCount: number;
  readonly sites: readonly NeverParameterSite[];
  readonly elapsedMs: number;
};

// The scan reads every source file as text and parses only files containing
// the literal `: never`. It recognizes direct parameter references inside
// template substitutions, string `+` expressions with a statically visible
// string operand, `String(...)`, and `JSON.stringify(...)`. It does not track
// aliases or custom conversion helpers; it is a shape check, not dataflow.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SOURCE_EXCLUDES = [
  "**/node_modules/**",
  "**/__tests__/**",
  "**/dist/**",
  "**/dist-sea/**",
  "**/coverage/**",
  "**/out/**",
  "**/.git/**",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.test.ts",
  "**/*.test.tsx",
];

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

function isParameterReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }
  return true;
}

function functionShadowsParameter(
  node: ts.Node,
  parameterName: string,
): boolean {
  const declaration = functionWithBody(node);
  return (
    declaration !== null &&
    declaration.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === parameterName,
    )
  );
}

function containsParameterReference(
  root: ts.Node,
  parameterName: string,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== root && functionShadowsParameter(node, parameterName)) return;
    if (
      ts.isIdentifier(node) &&
      node.text === parameterName &&
      isParameterReference(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
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

function isJsonStringifyCall(node: ts.CallExpression): boolean {
  const callee = unwrap(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON" &&
    callee.name.text === "stringify"
  );
}

function isStringCall(node: ts.CallExpression): boolean {
  const callee = unwrap(node.expression);
  return ts.isIdentifier(callee) && callee.text === "String";
}

function firstConversionCall(
  root: ts.Node,
  parameterName: string,
): UnsafeStringUse | null {
  let found: UnsafeStringUse | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (node !== root && functionShadowsParameter(node, parameterName)) return;
    if (
      ts.isCallExpression(node) &&
      node.arguments.some((argument) =>
        containsParameterReference(argument, parameterName),
      )
    ) {
      if (isJsonStringifyCall(node)) {
        found = { source: "JSON.stringify", node };
        return;
      }
      if (isStringCall(node)) {
        found = { source: "String()", node };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isStringOperand(
  expression: ts.Expression,
  owner: ts.FunctionLikeDeclaration,
): boolean {
  const unwrapped = unwrap(expression);
  if (
    ts.isStringLiteral(unwrapped) ||
    ts.isNoSubstitutionTemplateLiteral(unwrapped) ||
    ts.isTemplateExpression(unwrapped)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(unwrapped) &&
    (isStringCall(unwrapped) || isJsonStringifyCall(unwrapped))
  ) {
    return true;
  }
  if (ts.isBinaryExpression(unwrapped)) {
    return (
      unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (isStringOperand(unwrapped.left, owner) ||
        isStringOperand(unwrapped.right, owner))
    );
  }
  if (ts.isIdentifier(unwrapped)) {
    return owner.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === unwrapped.text &&
        parameter.type?.kind === ts.SyntaxKind.StringKeyword,
    );
  }
  return false;
}

function isStringConcatenation(
  expression: ts.Expression,
  owner: ts.FunctionLikeDeclaration,
): expression is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringOperand(expression.left, owner) ||
      isStringOperand(expression.right, owner))
  );
}

function findUnsafeStringUse(
  owner: ts.FunctionLikeDeclaration,
  parameterName: string,
): UnsafeStringUse | null {
  const body = owner.body;
  if (body === undefined) return null;
  let found: UnsafeStringUse | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (node !== body && functionShadowsParameter(node, parameterName)) return;

    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        if (!containsParameterReference(span.expression, parameterName)) {
          continue;
        }
        found = firstConversionCall(span.expression, parameterName) ?? {
          source: "template interpolation",
          node: span.expression,
        };
        return;
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      isStringConcatenation(node, owner) &&
      containsParameterReference(node, parameterName)
    ) {
      found = firstConversionCall(node, parameterName) ?? {
        source: "string concatenation",
        node,
      };
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.some((argument) =>
        containsParameterReference(argument, parameterName),
      )
    ) {
      if (isJsonStringifyCall(node)) {
        found = { source: "JSON.stringify", node };
        return;
      }
      if (isStringCall(node)) {
        found = { source: "String()", node };
        return;
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function inspectFunction(
  owner: ts.FunctionLikeDeclaration,
  filePath: string,
  sourceFile: ts.SourceFile,
  sites: NeverParameterSite[],
): void {
  for (const parameter of owner.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.type?.kind !== ts.SyntaxKind.NeverKeyword
    ) {
      continue;
    }
    const unsafeUse = findUnsafeStringUse(owner, parameter.name.text);
    if (unsafeUse === null) continue;
    const position = sourceFile.getLineAndCharacterOfPosition(
      unsafeUse.node.getStart(sourceFile),
    );
    sites.push({
      filePath,
      line: position.line + 1,
      column: position.character + 1,
      parameterName: parameter.name.text,
      source: unsafeUse.source,
      expressionText: unsafeUse.node.getText(sourceFile),
    });
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function scanRepository(): RepositoryScan {
  const startedAt = performance.now();
  const allFiles = ts.sys
    .readDirectory(REPO_ROOT, SOURCE_EXTENSIONS, SOURCE_EXCLUDES)
    .map(normalizePath);
  const candidates: { readonly filePath: string; readonly text: string }[] = [];
  for (const filePath of allFiles) {
    const text = readFileSync(filePath, "utf8");
    if (text.includes(": never")) candidates.push({ filePath, text });
  }

  const sites: NeverParameterSite[] = [];
  for (const candidate of candidates) {
    const sourceFile = ts.createSourceFile(
      candidate.filePath,
      candidate.text,
      ts.ScriptTarget.Latest,
      true,
      candidate.filePath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      const owner = functionWithBody(node);
      if (owner !== null) {
        inspectFunction(owner, candidate.filePath, sourceFile, sites);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    fileCount: allFiles.length,
    candidateFiles: candidates.map(({ filePath }) => filePath),
    parsedFileCount: candidates.length,
    sites,
    elapsedMs: performance.now() - startedAt,
  };
}

const repositoryScan = scanRepository();

function hasCandidate(suffix: string): boolean {
  return repositoryScan.candidateFiles.some((filePath) =>
    normalizePath(filePath).endsWith(suffix),
  );
}

function sitesForFile(suffix: string): readonly NeverParameterSite[] {
  return repositoryScan.sites.filter((site) =>
    normalizePath(site.filePath).endsWith(suffix),
  );
}

describe(`never parameter string rule (${repositoryScan.candidateFiles.length} candidates, ${repositoryScan.fileCount} files, ${repositoryScan.elapsedMs.toFixed(1)} ms)`, () => {
  it(`finds no unsafe never parameter string use (${repositoryScan.sites.length} sites)`, () => {
    expect(repositoryScan.candidateFiles.length).toBeGreaterThan(0);
    expect(repositoryScan.parsedFileCount).toBe(
      repositoryScan.candidateFiles.length,
    );
    expect(repositoryScan.sites).toEqual([]);
  });

  it("keeps a bare never parameter reference clean", () => {
    const suffix = "clients/gui-app/src/stores/chats/chat-queue-reconciler.ts";
    expect(hasCandidate(suffix)).toBe(true);
    expect(sitesForFile(suffix)).toEqual([]);
  });

  it("keeps a bare never drag-source reference clean", () => {
    const suffix =
      "clients/gui-app/src/components/chat/composer/composer-drag-attachment.ts";
    expect(hasCandidate(suffix)).toBe(true);
    expect(sitesForFile(suffix)).toEqual([]);
  });

  it("ignores never in sandbox defaults UI copy", () => {
    const suffix =
      "clients/gui-app/src/components/settings/panels/sandbox-defaults-section.tsx";
    expect(hasCandidate(suffix)).toBe(true);
    expect(sitesForFile(suffix)).toEqual([]);
  });

  it("ignores never in sandbox confirmation UI copy", () => {
    const suffix =
      "clients/gui-app/src/components/hosts/sandbox-confirm-dialogs.tsx";
    expect(hasCandidate(suffix)).toBe(true);
    expect(sitesForFile(suffix)).toEqual([]);
  });
});
