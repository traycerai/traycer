import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const repoRoot = process.cwd();
const guardPath = path.resolve(repoRoot, "scripts/test-worker-environment.ts");
const probeFixture = path.resolve(
  import.meta.dirname,
  "fixtures/test-worker-environment",
);
const fixtureConfig = path.join(probeFixture, "vitest.config.ts");
const rootOrderConfig = path.resolve(repoRoot, "protocol/vitest.config.ts");
const inheritedConfig = path.resolve(
  repoRoot,
  "clients/gui-app/vitest.measurements.config.ts",
);
const inheritedTestSpread = "    ...baseConfig.test,\n";
const requiredGlobalSetups: string[] = [];

function listVitestConfigs(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      entry.name !== "node_modules" &&
      entry.name !== ".git" &&
      entry.name !== ".next" &&
      entry.name !== "traycer" &&
      entry.name !== "dist"
    ) {
      found.push(...listVitestConfigs(path.join(directory, entry.name)));
    } else if (
      entry.isFile() &&
      /vitest.*config\.[cm]?[jt]sx?$/u.test(entry.name)
    ) {
      found.push(path.join(directory, entry.name));
    }
  }
  return found.sort();
}

function parse(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function nameOf(
  node: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function objectProperty(
  object: ts.ObjectLiteralExpression | undefined,
  propertyName: string,
): ts.Expression | undefined {
  if (object === undefined) return undefined;
  const property = object.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) && nameOf(item.name) === propertyName,
  );
  return property === undefined ? undefined : property.initializer;
}

function variableInitializers(
  source: ts.SourceFile,
): Map<string, ts.Expression> {
  const values = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = nameOf(declaration.name);
      if (name !== undefined && declaration.initializer !== undefined) {
        values.set(name, declaration.initializer);
      }
    }
  }
  return values;
}

function resolveExpression(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): ts.Expression | undefined {
  return resolveExpressionWithSeen(expression, source, declarations, new Set());
}

function resolveExpressionWithSeen(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
  seen: Set<string>,
): ts.Expression | undefined {
  if (expression === undefined) return undefined;
  const current = unwrap(expression);
  if (!ts.isIdentifier(current)) return current;
  if (seen.has(current.text)) return undefined;
  const next = declarations.get(current.text);
  if (next === undefined) return undefined;
  seen.add(current.text);
  return resolveExpressionWithSeen(next, source, declarations, seen);
}

function firstArrayElement(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): ts.Expression | undefined {
  const resolved = resolveExpression(expression, source, declarations);
  if (resolved === undefined) return undefined;
  if (ts.isArrayLiteralExpression(resolved)) {
    const first = resolved.elements[0];
    if (first === undefined) return undefined;
    if (ts.isSpreadElement(first)) {
      return firstArrayElement(first.expression, source, declarations);
    }
    return resolveExpression(first, source, declarations);
  }
  return resolved;
}

function setupPath(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): string | undefined {
  const evaluatePath = (
    candidate: ts.Expression | undefined,
    seen: Set<string>,
  ): string | undefined => {
    if (candidate === undefined) return undefined;
    const current = unwrap(candidate);
    if (ts.isIdentifier(current)) {
      if (current.text === "__dirname") return path.dirname(source.fileName);
      if (seen.has(current.text)) return undefined;
      const initializer = declarations.get(current.text);
      if (initializer === undefined) return undefined;
      seen.add(current.text);
      return evaluatePath(initializer, seen);
    }
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      return path.resolve(path.dirname(source.fileName), current.text);
    }
    if (!ts.isCallExpression(current)) return undefined;
    const callee = current.expression;
    const method = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    const resolves = method === "resolve" || method.startsWith("resolve");
    const joins = method === "join" || method.startsWith("join");
    if (!resolves && !joins) return undefined;
    const [firstArgument, ...remainingArguments] = current.arguments;
    const firstIsImportDir =
      firstArgument !== undefined &&
      ts.isPropertyAccessExpression(unwrap(firstArgument)) &&
      ts.isMetaProperty(unwrap(firstArgument).expression) &&
      unwrap(firstArgument).name.text === "dirname";
    const base = firstIsImportDir
      ? path.dirname(source.fileName)
      : evaluatePath(firstArgument, new Set(seen));
    if (base === undefined) return undefined;
    const segments: string[] = [];
    for (const argument of remainingArguments) {
      const resolvedArgument = resolveExpression(
        argument,
        source,
        declarations,
      );
      if (
        resolvedArgument === undefined ||
        (!ts.isStringLiteral(resolvedArgument) &&
          !ts.isNoSubstitutionTemplateLiteral(resolvedArgument))
      ) {
        return undefined;
      }
      segments.push(resolvedArgument.text);
    }
    return resolves
      ? path.resolve(base, ...segments)
      : path.join(base, ...segments);
  };
  return evaluatePath(expression, new Set());
}

function isGuardSetup(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): boolean {
  const first = firstArrayElement(expression, source, declarations);
  return setupPath(first, source, declarations) === guardPath;
}

function configObject(
  source: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
  const exported = source.statements.find(ts.isExportAssignment);
  if (exported === undefined) return undefined;
  const expression = unwrap(exported.expression);
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    const calleeName = ts.isIdentifier(callee) ? callee.text : "";
    if (calleeName === "defineConfig" || calleeName === "mergeConfig") {
      const argument =
        calleeName === "mergeConfig"
          ? expression.arguments[1]
          : expression.arguments[0];
      const value = argument === undefined ? undefined : unwrap(argument);
      return value !== undefined && ts.isObjectLiteralExpression(value)
        ? value
        : undefined;
    }
  }
  return ts.isObjectLiteralExpression(expression) ? expression : undefined;
}

function projectObjects(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): ts.ObjectLiteralExpression[] | undefined {
  if (expression === undefined) return [];
  const current = unwrap(expression);
  if (ts.isObjectLiteralExpression(current)) return [current];
  if (ts.isIdentifier(current)) {
    if (current.text === "undefined") return [];
    const resolved = resolveExpression(current, source, declarations);
    if (resolved === undefined) return undefined;
    return projectObjects(resolved, source, declarations);
  }
  if (ts.isConditionalExpression(current)) {
    const left = projectObjects(current.whenTrue, source, declarations);
    const right = projectObjects(current.whenFalse, source, declarations);
    return left === undefined || right === undefined
      ? undefined
      : [...left, ...right];
  }
  if (!ts.isArrayLiteralExpression(current)) return undefined;
  const result: ts.ObjectLiteralExpression[] = [];
  for (const element of current.elements) {
    const resolved = ts.isSpreadElement(element)
      ? projectObjects(element.expression, source, declarations)
      : projectObjects(element, source, declarations);
    if (resolved === undefined) return undefined;
    result.push(...resolved);
  }
  return result;
}

function importedVitestBaseNames(source: ts.SourceFile): Set<string> {
  const importedPaths = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.includes("vitest.config") &&
      statement.importClause !== undefined &&
      statement.importClause.name !== undefined
    ) {
      const importedPath = path.resolve(
        path.dirname(source.fileName),
        statement.moduleSpecifier.text,
      );
      const resolvedPath = [
        importedPath,
        `${importedPath}.ts`,
        `${importedPath}.mts`,
        `${importedPath}.js`,
        `${importedPath}.mjs`,
      ].find(existsSync);
      if (resolvedPath !== undefined) {
        importedPaths.set(statement.importClause.name.text, resolvedPath);
      }
    }
  }
  return new Set(importedPaths.keys());
}

function inheritsImportedVitestConfig(source: ts.SourceFile): boolean {
  const importedNames = importedVitestBaseNames(source);
  if (importedNames.size === 0) return false;
  const exported = source.statements.find(ts.isExportAssignment);
  if (exported === undefined) return false;
  const expression = unwrap(exported.expression);
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    const callName = ts.isIdentifier(callee) ? callee.text : "";
    if (callName === "mergeConfig") {
      const base = expression.arguments[0];
      return (
        base !== undefined &&
        ts.isIdentifier(unwrap(base)) &&
        importedNames.has(unwrap(base).text)
      );
    }
    if (callName !== "defineConfig") return false;
  }
  const configValue = ts.isCallExpression(expression)
    ? expression.arguments[0]
    : expression;
  if (configValue === undefined) return false;
  const config = unwrap(configValue);
  if (!ts.isObjectLiteralExpression(config)) return false;
  const spreadsImportedBase = (object: ts.ObjectLiteralExpression): boolean =>
    object.properties.some((property) => {
      if (!ts.isSpreadAssignment(property)) return false;
      const spread = unwrap(property.expression);
      if (ts.isIdentifier(spread)) return importedNames.has(spread.text);
      if (ts.isPropertyAccessExpression(spread)) {
        return (
          importedNames.has(spread.expression.getText(source)) &&
          spread.name.text === "test"
        );
      }
      return false;
    });
  const testValue = objectProperty(config, "test");
  if (testValue === undefined) return spreadsImportedBase(config);
  const testObject = unwrap(testValue);
  return (
    ts.isObjectLiteralExpression(testObject) && spreadsImportedBase(testObject)
  );
}

function assertUnambiguousPolicyObject(
  object: ts.ObjectLiteralExpression | undefined,
  keys: ReadonlySet<string>,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
  configLabel: string,
  label: string,
): void {
  if (object === undefined) return;
  const seen = new Set<string>();
  const spreads: Array<{ index: number; expression: ts.Expression }> = [];
  const propertyIndexes = new Map<string, number>();
  const importedNames = importedVitestBaseNames(source);
  object.properties.forEach((property, index) => {
    if (ts.isSpreadAssignment(property)) {
      spreads.push({ index, expression: property.expression });
      return;
    }
    if (!ts.isPropertyAssignment(property)) return;
    const propertyName = nameOf(property.name);
    if (propertyName === undefined || !keys.has(propertyName)) return;
    if (seen.has(propertyName)) {
      throw new Error(`${configLabel}: duplicate ${label}.${propertyName}`);
    }
    seen.add(propertyName);
    propertyIndexes.set(propertyName, index);
  });
  let inheritedBaseSpreadSeen = false;
  for (const spread of spreads) {
    const unresolvedKeys = [...propertyIndexes.entries()]
      .filter(([key, index]) => index < spread.index)
      .map(([key]) => key);
    const spreadExpression = unwrap(spread.expression);
    const isBaseSpread =
      ts.isIdentifier(spreadExpression) &&
      importedNames.has(spreadExpression.text);
    const isBaseTestSpread =
      ts.isPropertyAccessExpression(spreadExpression) &&
      spreadExpression.name.text === "test" &&
      ts.isIdentifier(spreadExpression.expression) &&
      importedNames.has(spreadExpression.expression.text);
    if (isBaseSpread || isBaseTestSpread) {
      if (inheritedBaseSpreadSeen || unresolvedKeys.length > 0) {
        throw new Error(
          `${configLabel}: inherited config spread follows a policy entry in ${label}`,
        );
      }
      inheritedBaseSpreadSeen = true;
      continue;
    }
    const spreadKeys = staticSpreadKeys(
      spread.expression,
      source,
      declarations,
      new Set(),
    );
    if (spreadKeys === undefined) {
      throw new Error(`${configLabel}: unsupported spread in ${label}`);
    }
    const laterDirectKeys = [...propertyIndexes.entries()]
      .filter(([key, index]) => index > spread.index)
      .map(([key]) => key);
    const canSetUnvalidatedPolicy = [...spreadKeys].some(
      (key) => keys.has(key) && !laterDirectKeys.includes(key),
    );
    if (
      unresolvedKeys.some((key) => spreadKeys.has(key)) ||
      canSetUnvalidatedPolicy
    ) {
      throw new Error(`${configLabel}: spread can override ${label} policy`);
    }
  }
}

function staticSpreadKeys(
  expression: ts.Expression,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
  seen: Set<string>,
): Set<string> | undefined {
  const current = unwrap(expression);
  if (ts.isConditionalExpression(current)) {
    const whenTrue = staticSpreadKeys(
      current.whenTrue,
      source,
      declarations,
      new Set(seen),
    );
    const whenFalse = staticSpreadKeys(
      current.whenFalse,
      source,
      declarations,
      new Set(seen),
    );
    return whenTrue === undefined || whenFalse === undefined
      ? undefined
      : new Set([...whenTrue, ...whenFalse]);
  }
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return undefined;
    const initializer = declarations.get(current.text);
    if (initializer === undefined) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(current.text);
    return staticSpreadKeys(initializer, source, declarations, nextSeen);
  }
  if (!ts.isObjectLiteralExpression(current)) return undefined;
  const keys = new Set<string>();
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = staticSpreadKeys(
        property.expression,
        source,
        declarations,
        new Set(seen),
      );
      if (nested === undefined) return undefined;
      for (const key of nested) keys.add(key);
      continue;
    }
    if (!ts.isPropertyAssignment(property)) return undefined;
    const propertyName = nameOf(property.name);
    if (propertyName === undefined) return undefined;
    keys.add(propertyName);
  }
  return keys;
}

function booleanValue(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): boolean {
  const current =
    expression === undefined
      ? undefined
      : resolveExpression(expression, source, declarations);
  return current?.kind === ts.SyntaxKind.TrueKeyword;
}

function sequenceUsesList(
  testObject: ts.ObjectLiteralExpression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): boolean {
  return sequenceExpressionUsesList(
    objectProperty(testObject, "sequence"),
    source,
    declarations,
  );
}

function sequenceExpressionUsesList(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): boolean {
  const sequence = resolveExpression(expression, source, declarations);
  if (sequence === undefined || !ts.isObjectLiteralExpression(sequence))
    return false;
  const setupFiles = resolveExpression(
    objectProperty(sequence, "setupFiles"),
    source,
    declarations,
  );
  return (
    setupFiles !== undefined &&
    ts.isStringLiteral(setupFiles) &&
    setupFiles.text === "list"
  );
}

function allStringPaths(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
  declarations: Map<string, ts.Expression>,
): string[] | undefined {
  if (expression === undefined) return [];
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) {
    const resolved = resolveExpression(current, source, declarations);
    return resolved === undefined
      ? undefined
      : allStringPaths(resolved, source, declarations);
  }
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return [path.resolve(path.dirname(source.fileName), current.text)];
  }
  if (ts.isCallExpression(current)) {
    const resolvedPath = setupPath(current, source, declarations);
    return resolvedPath === undefined ? undefined : [resolvedPath];
  }
  if (!ts.isArrayLiteralExpression(current)) return undefined;
  const paths: string[] = [];
  for (const element of current.elements) {
    const result = allStringPaths(
      ts.isSpreadElement(element) ? element.expression : element,
      source,
      declarations,
    );
    if (result === undefined) return undefined;
    paths.push(...result);
  }
  return paths;
}

function globalSetupExpressions(source: ts.SourceFile): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && nameOf(node.name) === "globalSetup") {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function assertGlobalSetupGuard(filePath: string, expectedGuard: string): void {
  if (!existsSync(filePath)) {
    throw new Error(
      `${path.relative(repoRoot, filePath)}: missing global setup file`,
    );
  }
  const text = readFileSync(filePath, "utf8");
  const source = parse(text, filePath);
  const firstImport = source.statements.find(ts.isImportDeclaration);
  if (
    firstImport === undefined ||
    firstImport.importClause !== undefined ||
    !ts.isStringLiteral(firstImport.moduleSpecifier)
  ) {
    throw new Error(
      `${path.relative(repoRoot, filePath)}: global setup guard import must be first`,
    );
  }
  let importedPath = path.resolve(
    path.dirname(filePath),
    firstImport.moduleSpecifier.text,
  );
  if (!path.extname(importedPath)) importedPath += ".ts";
  if (importedPath !== expectedGuard) {
    throw new Error(
      `${path.relative(repoRoot, filePath)}: missing first global setup guard import`,
    );
  }
}

function assertConfigSetups(
  root: string,
  overrideText: ReadonlyMap<string, string>,
): void {
  const configs = listVitestConfigs(root);
  if (configs.length === 0)
    throw new Error("repository: missing Vitest config inventory");
  const globalSetups = new Set<string>();

  for (const configPath of configs) {
    const text =
      overrideText.get(configPath) ?? readFileSync(configPath, "utf8");
    const source = parse(text, configPath);
    const declarations = variableInitializers(source);
    const rootObject = configObject(source);
    const testObject = resolveExpression(
      objectProperty(rootObject, "test"),
      source,
      declarations,
    );
    const testConfig =
      testObject !== undefined && ts.isObjectLiteralExpression(testObject)
        ? testObject
        : undefined;
    const rootSetup = objectProperty(testConfig, "setupFiles");
    const projectsExpression = objectProperty(testConfig, "projects");
    const projects = projectObjects(projectsExpression, source, declarations);
    const repoRelative = path.relative(root, configPath);
    if (rootObject === undefined) {
      throw new Error(
        `${repoRelative}: config structure is not statically recognizable`,
      );
    }

    if (projects === undefined) {
      throw new Error(
        `${repoRelative}: project structure is not statically recognizable`,
      );
    }
    const inheritedGuard = isGuardSetup(rootSetup, source, declarations);
    if (rootSetup !== undefined && !inheritedGuard) {
      throw new Error(
        `${repoRelative}: setupFiles must begin with the environment guard`,
      );
    }

    assertUnambiguousPolicyObject(
      rootObject,
      new Set(["test"]),
      source,
      declarations,
      repoRelative,
      "config",
    );
    assertUnambiguousPolicyObject(
      testConfig,
      new Set(["setupFiles", "sequence", "projects", "globalSetup"]),
      source,
      declarations,
      repoRelative,
      "test",
    );

    const baseGuard = inheritsImportedVitestConfig(source);
    if (!inheritedGuard && !baseGuard) {
      throw new Error(
        `${repoRelative}: effective root setupFiles missing environment guard`,
      );
    }

    const rootSequenceExpressionRaw = objectProperty(testConfig, "sequence");
    const rootSequenceOk = sequenceUsesList(testConfig, source, declarations);
    if (rootSequenceExpressionRaw !== undefined && !rootSequenceOk) {
      throw new Error(`${repoRelative}: sequence.setupFiles must be list`);
    }
    if (rootSequenceExpressionRaw === undefined && !baseGuard) {
      throw new Error(`${repoRelative}: sequence.setupFiles must be list`);
    }
    const rootSequenceExpression = resolveExpression(
      objectProperty(testConfig, "sequence"),
      source,
      declarations,
    );
    const rootSequence =
      rootSequenceExpression !== undefined &&
      ts.isObjectLiteralExpression(rootSequenceExpression)
        ? rootSequenceExpression
        : undefined;
    assertUnambiguousPolicyObject(
      rootSequence,
      new Set(["setupFiles"]),
      source,
      declarations,
      repoRelative,
      "sequence",
    );
    for (const project of projects) {
      const projectTestValue = resolveExpression(
        objectProperty(project, "test"),
        source,
        declarations,
      );
      const projectTest =
        projectTestValue !== undefined &&
        ts.isObjectLiteralExpression(projectTestValue)
          ? projectTestValue
          : undefined;
      const extendsRoot = booleanValue(
        objectProperty(project, "extends"),
        source,
        declarations,
      );
      assertUnambiguousPolicyObject(
        project,
        new Set(["extends", "test"]),
        source,
        declarations,
        repoRelative,
        "project",
      );
      assertUnambiguousPolicyObject(
        projectTest,
        new Set(["setupFiles", "sequence", "projects", "globalSetup"]),
        source,
        declarations,
        repoRelative,
        "project.test",
      );
      const projectSetup = objectProperty(projectTest, "setupFiles");
      if (!extendsRoot && !isGuardSetup(projectSetup, source, declarations)) {
        throw new Error(
          `${repoRelative}: non-inheriting project missing first environment guard`,
        );
      }
      const projectSequenceValue = resolveExpression(
        objectProperty(projectTest, "sequence"),
        source,
        declarations,
      );
      const projectSequence =
        projectSequenceValue !== undefined &&
        ts.isObjectLiteralExpression(projectSequenceValue)
          ? projectSequenceValue
          : undefined;
      assertUnambiguousPolicyObject(
        projectSequence,
        new Set(["setupFiles"]),
        source,
        declarations,
        repoRelative,
        "project.sequence",
      );
      const projectSequenceSetupFiles =
        projectSequence === undefined
          ? undefined
          : objectProperty(projectSequence, "setupFiles");
      if (
        projectSequence !== undefined &&
        (projectSequenceSetupFiles === undefined ||
          !sequenceExpressionUsesList(projectSequence, source, declarations))
      )
        throw new Error(
          `${repoRelative}: project sequence override must set setupFiles list`,
        );
      if (
        !extendsRoot &&
        (projectSequence === undefined ||
          projectSequenceSetupFiles === undefined)
      ) {
        throw new Error(
          `${repoRelative}: non-inheriting project missing sequence.setupFiles list`,
        );
      }
    }

    for (const expression of globalSetupExpressions(source)) {
      const paths = allStringPaths(expression, source, declarations);
      if (paths === undefined) {
        throw new Error(
          `${repoRelative}: globalSetup path is not statically recognizable`,
        );
      }
      for (const globalSetup of paths) globalSetups.add(globalSetup);
    }
  }

  for (const setupFile of requiredGlobalSetups) globalSetups.add(setupFile);
  for (const setupFile of globalSetups)
    assertGlobalSetupGuard(setupFile, guardPath);
}

function sourceWithFirstSetupRemoved(filePath: string): string {
  const text = readFileSync(filePath, "utf8");
  const source = parse(text, filePath);
  let setupProperty: ts.PropertyAssignment | undefined;
  const visit = (node: ts.Node): void => {
    if (
      setupProperty === undefined &&
      ts.isPropertyAssignment(node) &&
      nameOf(node.name) === "setupFiles" &&
      ts.isArrayLiteralExpression(unwrap(node.initializer))
    ) {
      setupProperty = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (setupProperty === undefined)
    throw new Error("control config has no setupFiles array");
  const arrayExpression = unwrap(setupProperty.initializer);
  if (!ts.isArrayLiteralExpression(arrayExpression)) {
    throw new Error("control config setupFiles is not an array");
  }
  const array = arrayExpression;
  const first = array.elements[0];
  if (first === undefined)
    throw new Error("control config has no first setup entry");
  const replacement =
    array.elements.length === 1
      ? "[]"
      : `[${array.elements
          .slice(1)
          .map((entry) => entry.getText(source))
          .join(", ")}]`;
  return `${text.slice(0, array.getStart(source))}${replacement}${text.slice(array.end)}`;
}

function sourceWithoutRootSetupOrder(filePath: string): string {
  const text = readFileSync(filePath, "utf8");
  const source = parse(text, filePath);
  const declarations = variableInitializers(source);
  const root = configObject(source);
  const testValue = resolveExpression(
    objectProperty(root, "test"),
    source,
    declarations,
  );
  if (testValue === undefined || !ts.isObjectLiteralExpression(testValue)) {
    throw new Error("control config test object is unsupported");
  }
  const sequenceValue = objectProperty(testValue, "sequence");
  const sequence =
    sequenceValue === undefined ? undefined : unwrap(sequenceValue);
  if (sequence === undefined || !ts.isObjectLiteralExpression(sequence)) {
    throw new Error("control config has no root sequence object");
  }
  const order = sequence.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      nameOf(property.name) === "setupFiles",
  );
  if (order === undefined)
    throw new Error("control config has no setup order field");
  return `${text.slice(0, sequence.getStart(source))}{}${text.slice(sequence.end)}`;
}

function sourceWithImportedConfigDisconnected(filePath: string): string {
  const text = readFileSync(filePath, "utf8");
  const disconnected = text.replace(inheritedTestSpread, "");
  if (disconnected === text) {
    throw new Error("control config inheritance expression was not found");
  }
  return disconnected;
}

function sourceWithParallelSequenceOverride(filePath: string): string {
  const text = readFileSync(filePath, "utf8");
  const changed = text.replace(
    inheritedTestSpread,
    `${inheritedTestSpread}    sequence: { setupFiles: "parallel" },\n`,
  );
  if (changed === text) {
    throw new Error("control config did not expose inherited test settings");
  }
  return changed;
}

function runVitest(
  args: string[],
  home: string,
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [path.resolve(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...args],
    {
      cwd: repoRoot,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        TMP: home,
        TEMP: home,
        NODE_ENV: "development",
        CI: "false",
        TRAYCER_ENV_GUARD_PROBE: "fake",
      },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

describe("test worker environment guard", () => {
  it("scrubs a synthetic probe before isolated and reused shared worker files", () => {
    const syntheticHome = mkdtempSync(
      path.join(tmpdir(), "traycer-worker-env-proof-"),
    );
    const unguardedConfig = path.join(
      probeFixture,
      `.vitest.unguarded.${process.pid}.config.ts`,
    );
    let createdUnguardedConfig = false;
    try {
      writeFileSync(
        unguardedConfig,
        `import { defineConfig } from "vitest/config";\n` +
          `export default defineConfig({ root: ${JSON.stringify(probeFixture)}, test: { setupFiles: [${JSON.stringify(path.join(probeFixture, "later-setup.ts"))}], include: ["probe-isolated.probe.ts"], isolate: true, sequence: { setupFiles: "list" } } });\n`,
        { flag: "wx" },
      );
      createdUnguardedConfig = true;
      const unguarded = runVitest(
        ["--config", unguardedConfig, "--maxWorkers=2"],
        syntheticHome,
      );
      expect(unguarded.status).not.toBe(0);
      expect(unguarded.output).toContain(
        "synthetic worker probe was present before later setup import",
      );
      const guarded = runVitest(
        ["--config", fixtureConfig, "--maxWorkers=2"],
        syntheticHome,
      );
      expect(guarded.status, guarded.output).toBe(0);
      const firstShared = guarded.output.indexOf("probe-shared-first.probe.ts");
      const secondShared = guarded.output.indexOf(
        "probe-shared-second.probe.ts",
      );
      expect(firstShared).toBeGreaterThanOrEqual(0);
      expect(secondShared).toBeGreaterThan(firstShared);
      expect(guarded.output).toContain("probe-isolated.probe.ts");
    } finally {
      if (createdUnguardedConfig) {
        rmSync(unguardedConfig, { force: true });
      }
      rmSync(syntheticHome, { recursive: true, force: true });
    }
  }, 250_000);

  it("checks every effective project and global setup structurally", () => {
    assertConfigSetups(repoRoot, new Map());
  });

  it("fails the source invariant when a config loses its actual guard entry", () => {
    const configPath = path.resolve(repoRoot, "scripts/vitest.config.ts");
    const changed = sourceWithFirstSetupRemoved(configPath);
    expect(() =>
      assertConfigSetups(repoRoot, new Map([[configPath, changed]])),
    ).toThrow(
      "scripts/vitest.config.ts: setupFiles must begin with the environment guard",
    );
  });

  it("fails when a project config loses inherited setup ordering", () => {
    const changed = sourceWithoutRootSetupOrder(rootOrderConfig);
    expect(() =>
      assertConfigSetups(repoRoot, new Map([[rootOrderConfig, changed]])),
    ).toThrow(
      `${path.relative(repoRoot, rootOrderConfig)}: sequence.setupFiles must be list`,
    );
  });

  it("does not accept an imported base config that the export does not inherit", () => {
    const changed = sourceWithImportedConfigDisconnected(inheritedConfig);
    const relative = path.relative(repoRoot, inheritedConfig);
    expect(() =>
      assertConfigSetups(repoRoot, new Map([[inheritedConfig, changed]])),
    ).toThrow(
      `${relative}: effective root setupFiles missing environment guard`,
    );
  });

  it("rejects a parallel setup override inside an inherited test config", () => {
    const changed = sourceWithParallelSequenceOverride(inheritedConfig);
    const relative = path.relative(repoRoot, inheritedConfig);
    expect(() =>
      assertConfigSetups(repoRoot, new Map([[inheritedConfig, changed]])),
    ).toThrow(`${relative}: sequence.setupFiles must be list`);
  });
});
