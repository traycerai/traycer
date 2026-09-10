/// <reference types="node" />

import { ESLint, type Linter } from "eslint";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type RecordValue = Record<string, unknown>;

interface Restriction {
  readonly selector: string;
}

interface TypeSafetyModule {
  readonly traycerTypeSafetyRestrictions: unknown;
}

interface OxlintModule {
  readonly default: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function readRestrictions(value: unknown): readonly Restriction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): readonly Restriction[] => {
    if (!isRecord(entry) || typeof entry.selector !== "string") return [];
    return [{ selector: entry.selector }];
  });
}

function readRuleRestrictions(value: unknown): readonly Restriction[] {
  if (
    Array.isArray(value) &&
    (value[0] === "error" ||
      value[0] === "warn" ||
      value[0] === "off" ||
      typeof value[0] === "number")
  ) {
    return readRestrictions(value.slice(1));
  }
  return readRestrictions(value);
}

function isErrorRule(value: unknown): boolean {
  if (Array.isArray(value)) return value[0] === "error" || value[0] === 2;
  return value === "error" || value === 2;
}

function readRule(value: unknown, name: string): unknown {
  if (!isRecord(value) || !isRecord(value.rules)) return undefined;
  return value.rules[name];
}

function readOverrides(value: unknown): readonly RecordValue[] {
  if (!isRecord(value) || !Array.isArray(value.overrides)) return [];
  return value.overrides.filter(isRecord);
}

const guiAppRoot = path.resolve(process.cwd());
const submoduleRoot = `${guiAppRoot}/../..`;
const probePaths = [
  "src/lib/routes.ts",
  "src/__tests__/lint-rule-guards.test.ts",
] as const;

interface EslintAnchor {
  readonly eslint: ESLint;
  readonly rule: unknown;
}

function assertAnchorExists(relativePath: string): void {
  if (!existsSync(path.resolve(guiAppRoot, relativePath))) {
    throw new Error(`Expected stable lint anchor to exist: ${relativePath}`);
  }
}

const typeSafetyModule = (await import(
  pathToFileURL(`${submoduleRoot}/eslint/traycer-type-safety-rules.mjs`).href
)) as TypeSafetyModule;
const sharedTypeSafetyRestrictions: readonly (Restriction | undefined)[] =
  readRestrictions(typeSafetyModule.traycerTypeSafetyRestrictions);

const expectedSelectors = [
  { name: "as any", selector: sharedTypeSafetyRestrictions[0]?.selector },
  { name: "as unknown", selector: sharedTypeSafetyRestrictions[1]?.selector },
  {
    name: "chained type assertions",
    selector: sharedTypeSafetyRestrictions[2]?.selector,
  },
  {
    name: "optional parameters",
    selector: sharedTypeSafetyRestrictions[3]?.selector,
  },
  {
    name: "default parameters",
    selector: sharedTypeSafetyRestrictions[4]?.selector,
  },
  {
    name: "optional rest tuple/union shims",
    selector: sharedTypeSafetyRestrictions[5]?.selector,
  },
  {
    name: "ReturnType references",
    selector: sharedTypeSafetyRestrictions[6]?.selector,
  },
] as const;

function requireSelector(entry: (typeof expectedSelectors)[number]): string {
  if (entry.selector === undefined) {
    throw new Error(`Shared type-safety selector missing for ${entry.name}`);
  }
  return entry.selector;
}

function eslintRuleFor(relativePath: string): unknown {
  return getEslintAnchor(relativePath).rule;
}

function getEslintAnchor(relativePath: string): EslintAnchor {
  if (relativePath === probePaths[0]) return eslintAnchors.production;
  if (relativePath === probePaths[1]) return eslintAnchors.test;
  throw new Error(`Unknown lint anchor: ${relativePath}`);
}

async function lintProbe(
  code: string,
  relativePath: string,
): Promise<readonly Linter.LintMessage[]> {
  const results = await getEslintAnchor(relativePath).eslint.lintText(code, {
    filePath: `${guiAppRoot}/${relativePath}`,
  });
  const result = results.at(0);
  if (result === undefined) throw new Error("Expected an ESLint probe result");
  return result.messages;
}

const oxlintModule = (await import(
  pathToFileURL(`${guiAppRoot}/oxlint.config.ts`).href
)) as OxlintModule;
const oxlintOverrides = readOverrides(oxlintModule.default);

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const oxlintPlugins = readStringArray(
  isRecord(oxlintModule.default) ? oxlintModule.default.jsPlugins : undefined,
);

function expandBraces(pattern: string): readonly string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (match === null) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  return match[1]
    .split(",")
    .flatMap((choice) => expandBraces(`${prefix}${choice}${suffix}`));
}

function globMatches(relativePath: string, pattern: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$+.()|[\]{}]/.test(character)
        ? `\\${character}`
        : character;
    }
  }
  return new RegExp(`${source}$`).test(relativePath);
}

function matchesGlobList(value: unknown, relativePath: string): boolean {
  let patterns: readonly unknown[];
  if (typeof value === "string") {
    patterns = [value];
  } else if (Array.isArray(value)) {
    patterns = value;
  } else {
    patterns = [];
  }
  return patterns.some(
    (pattern): pattern is string =>
      typeof pattern === "string" &&
      expandBraces(pattern).some((expanded) =>
        globMatches(relativePath, expanded),
      ),
  );
}

function effectiveOxlintRuleFor(relativePath: string): unknown {
  let effective: unknown;
  for (const override of oxlintOverrides) {
    const files = override.files;
    const excludedFiles = override.excludedFiles;
    const matchesFiles =
      files === undefined || matchesGlobList(files, relativePath);
    const matchesExcludedFiles = matchesGlobList(excludedFiles, relativePath);
    if (!matchesFiles || matchesExcludedFiles) continue;
    const rule = readRule(override, "traycer/no-restricted-syntax");
    if (rule !== undefined) effective = rule;
  }
  return effective;
}

function expectNoFatal(messages: readonly Linter.LintMessage[]): void {
  expect(messages.some((message) => message.fatal === true)).toBe(false);
}

async function createEslintAnchor(relativePath: string): Promise<EslintAnchor> {
  assertAnchorExists(relativePath);
  const eslint = new ESLint({ cwd: guiAppRoot });
  const config = (await eslint.calculateConfigForFile(
    `${guiAppRoot}/${relativePath}`,
  )) as RecordValue;
  return { eslint, rule: readRule(config, "no-restricted-syntax") };
}

const eslintAnchors = {
  production: await createEslintAnchor(probePaths[0]),
  test: await createEslintAnchor(probePaths[1]),
} as const;

// These strings are deliberate lint probe data, assembled from fragments so
// source censuses do not mistake test inputs for production type bypasses.
const prohibitedFormsProbe = [
  "declare const value: string;",
  ["const anyValue = value", " as", " any;"].join(""),
  ["const unknownValue = value", " as", " unknown;"].join(""),
  ["const chainedValue = value", " as string", " as number;"].join(""),
  [
    "function optionalParameter(input",
    '?: string): string { return input ?? ""; }',
  ].join(""),
  [
    "function defaultParameter(input: string",
    ' = "fallback"): string { return input; }',
  ].join(""),
  "function restTuple(...inputs: [string?]): void { void inputs; }",
  "function restUnion(...inputs: [string?] | []): void { void inputs; }",
  "void anyValue;",
  "void unknownValue;",
  "void chainedValue;",
  "void optionalParameter;",
  "void defaultParameter;",
  "void restTuple;",
  "void restUnion;",
].join("\n");

const utilityProbe = [
  "declare function readValue(): string;",
  ["type UtilityResult = ", "Return", "Type", "<typeof readValue>;"].join(""),
  "void (null as UtilityResult | null);",
].join("\n");

const bareGenericProbe = [
  "interface Commands<ReturnType> { command: () => ReturnType; }",
  "type BareLibraryParameter = Commands<string>;",
].join("\n");

describe("GUI type-safety selector composition", () => {
  it.each(expectedSelectors)(
    "retains the $name selector for production and test files",
    (entry) => {
      const selector = requireSelector(entry);
      expect(existsSync(path.join(guiAppRoot, probePaths[0]))).toBe(true);
      expect(existsSync(path.join(guiAppRoot, probePaths[1]))).toBe(true);
      const production = eslintRuleFor(probePaths[0]);
      const test = eslintRuleFor(probePaths[1]);
      expect(isErrorRule(production)).toBe(true);
      expect(isErrorRule(test)).toBe(true);
      expect(
        readRuleRestrictions(production).some(
          (item) => item.selector === selector,
        ),
      ).toBe(true);
      expect(
        readRuleRestrictions(test).some((item) => item.selector === selector),
      ).toBe(true);
    },
  );

  it.each(expectedSelectors)(
    "adapts the $name selector into the oxlint restricted-syntax plugin",
    (entry) => {
      for (const relativePath of probePaths) {
        const rule = effectiveOxlintRuleFor(relativePath);
        expect(isErrorRule(rule)).toBe(true);
        expect(
          oxlintPlugins.some((plugin) =>
            plugin.includes("oxlint-restricted-syntax-plugin"),
          ),
        ).toBe(true);
        expect(
          readRuleRestrictions(rule).some(
            (item) => item.selector === requireSelector(entry),
          ),
        ).toBe(true);
      }
    },
  );

  it.each(probePaths)(
    "fires the seven-form probes under the %s config",
    async (relativePath) => {
      const messages = await lintProbe(prohibitedFormsProbe, relativePath);
      expectNoFatal(messages);
      const restricted = messages.filter(
        (message) => message.ruleId === "no-restricted-syntax",
      );
      expect(
        restricted.filter((message) => message.message.includes("as any")),
      ).toHaveLength(1);
      expect(
        restricted.filter((message) => message.message.includes("as unknown")),
      ).toHaveLength(1);
      expect(
        restricted.filter((message) =>
          message.message.includes("chain type assertions"),
        ),
      ).toHaveLength(1);
      expect(
        restricted.filter((message) =>
          message.message.includes("Optional parameters"),
        ),
      ).toHaveLength(1);
      expect(
        restricted.filter((message) =>
          message.message.includes("Default parameter"),
        ),
      ).toHaveLength(1);
      expect(
        restricted.filter((message) =>
          message.message.includes("rest-parameter tuple"),
        ),
      ).toHaveLength(2);
      const utilityMessages = await lintProbe(utilityProbe, relativePath);
      expectNoFatal(utilityMessages);
      expect(
        utilityMessages.filter(
          (message) => message.ruleId === "no-restricted-syntax",
        ),
      ).toHaveLength(1);
      const bareMessages = await lintProbe(bareGenericProbe, relativePath);
      expectNoFatal(bareMessages);
      expect(
        bareMessages.filter(
          (message) => message.ruleId === "no-restricted-syntax",
        ),
      ).toHaveLength(0);
    },
  );
});
