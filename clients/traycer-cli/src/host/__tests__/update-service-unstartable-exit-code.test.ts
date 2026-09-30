import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";

// Exit status 79 is the host update reconciler's latch on "an automatic update
// deferred over a service registration this account cannot start". The reconciler acts
// on it, so NOTHING else in the CLI may exit with 79: a different failure that
// happened to return it would park the reconciler on the wrong cause. The
// scan covers every exit spelling the CLI has - `exitCode:` properties,
// `process.exit(...)`, and `*_EXIT_CODE` constants - over every non-test file.

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ONLY_RETURNER = "host/update-service-unstartable.ts";
const RESERVED = 79;

function sources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

const relativePath = (file: string): string =>
  relative(SRC_ROOT, file).split(sep).join("/");

interface ExitUse {
  readonly file: string;
  readonly line: number;
  /** The numeric literal, or the constant's name. */
  readonly value: number | string;
}

function exitUses(file: string, text: string): ExitUse[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const uses: ExitUse[] = [];
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const numeric = (node: ts.Expression): number | null => {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    return null;
  };
  const visit = (node: ts.Node): void => {
    // `exitCode: 75` / `exitCode: SOME_CONSTANT`
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "exitCode"
    ) {
      const literal = numeric(node.initializer);
      if (literal !== null) uses.push({ file, line: at(node), value: literal });
      else if (ts.isIdentifier(node.initializer)) {
        uses.push({ file, line: at(node), value: node.initializer.text });
      }
    }
    // `process.exit(75)`
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "exit"
    ) {
      const arg = node.arguments[0];
      const literal = arg === undefined ? null : numeric(arg);
      if (literal !== null) uses.push({ file, line: at(node), value: literal });
    }
    // `const FOO_EXIT_CODE = 75`
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /EXIT_CODE$/.test(node.name.text) &&
      node.initializer !== undefined
    ) {
      const literal = numeric(node.initializer);
      if (literal !== null) uses.push({ file, line: at(node), value: literal });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

describe("exit status 79 belongs to the unstartable-service update deferral alone", () => {
  const all: ExitUse[] = [];
  for (const file of sources(SRC_ROOT)) {
    all.push(...exitUses(relativePath(file), readFileSync(file, "utf8")));
  }

  it("the reserved code is 79 (the reconciler's latch and this scan agree)", () => {
    expect(HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE).toBe(RESERVED);
  });

  it("the scan sees the CLI's real exits (it is not vacuous)", () => {
    const literals = new Set(
      all.flatMap((use) => (typeof use.value === "number" ? [use.value] : [])),
    );
    for (const known of [0, 1, 2, 75, 76, 77]) {
      expect(literals).toContain(known);
    }
  });

  it("no numeric exit literal or *_EXIT_CODE constant in the CLI is 79", () => {
    expect(
      all
        .filter((use) => use.value === RESERVED)
        .map((use) => `${use.file}:${use.line}`),
    ).toEqual([]);
  });

  it("the reserved constant is returned only by host/update-service-unstartable.ts", () => {
    const users = all
      .filter(
        (use) => use.value === "HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE",
      )
      .map((use) => use.file);
    // Disabled and not-owned branches may both park; no other module may.
    expect([...new Set(users)]).toEqual([ONLY_RETURNER]);
  });

  it("no other module names the reserved constant, except the runner's own once-per-state deferred-vs-failed classification", () => {
    // R3 §F: `runner/runner.ts` reads the constant to log a deferral
    // ("CLI command deferred", INFO, no stack) instead of an ordinary
    // failure - it never RETURNS 79 itself, only recognises the code the
    // refusal already returned.
    const ALSO_NAMES = "runner/runner.ts";
    const named: string[] = [];
    for (const file of sources(SRC_ROOT)) {
      const path = relativePath(file);
      if (path === ONLY_RETURNER || path === ALSO_NAMES) continue;
      if (
        readFileSync(file, "utf8").includes(
          "HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE",
        )
      ) {
        named.push(path);
      }
    }
    expect(named).toEqual([]);
  });

  it("the scan flags a stray 79 (sanity)", () => {
    expect(
      exitUses(
        "stray.ts",
        "throw cliError({ code: 'x', message: 'y', exitCode: 79 });",
      ),
    ).toEqual([{ file: "stray.ts", line: 1, value: 79 }]);
    expect(exitUses("stray.ts", "process.exit(79);")).toHaveLength(1);
    expect(exitUses("stray.ts", "const MY_EXIT_CODE = 79;")).toHaveLength(1);
  });
});
