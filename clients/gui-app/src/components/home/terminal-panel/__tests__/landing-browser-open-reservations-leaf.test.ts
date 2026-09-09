import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const STORE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "landing-browser-open-reservations.ts",
);

interface StoreImports {
  /** Every module specifier TypeScript's own scanner can name. */
  readonly specifiers: ReadonlyArray<string>;
  /**
   * `import()` / `require()` calls whose specifier is not a plain string.
   *
   * The scanner cannot name these, so they are counted rather than read: one is
   * enough to make the leaf claim unverifiable, which is the same as false.
   */
  readonly computed: number;
}

function isComputedModuleCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const isModuleCall =
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require");
  if (!isModuleCall) return false;
  const specifier = node.arguments.at(0);
  return specifier !== undefined && !ts.isStringLiteral(specifier);
}

function scanImports(source: string): StoreImports {
  const tree = ts.createSourceFile(
    "landing-browser-open-reservations.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let computed = 0;
  const visit = (node: ts.Node): void => {
    if (isComputedModuleCall(node)) computed += 1;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return {
    specifiers: ts
      .preProcessFile(source, true, true)
      .importedFiles.map((file) => file.fileName),
    computed,
  };
}

/**
 * The reservation store must import nothing but `react`.
 *
 * `__tests__/test-browser-apis.ts` resets that store after every test, so this
 * one module's import list is part of the setup of every jsdom suite in the
 * package - and a setup file cannot reach a module graph safely by EITHER
 * route. Statically, each module in it is evaluated before the test file and
 * keeps the real binding for anything that file later `vi.mock`s. Lazily, from
 * inside the hook, it is evaluated at teardown, where a suite's partial
 * `vi.mock` of any module in the graph throws for a missing export. Both
 * happened, one after the other, and neither failure named this store or the
 * suite that reset it - they surfaced as `use-landing-browser-reconciliation`
 * and `use-file-edit-session-recovery-race` failing on things neither file has
 * heard of. That is the cost of this guard silently ceasing to guard, and it is
 * why the cases below matter as much as the assertion.
 *
 * Read by TypeScript's own scanner rather than by a pattern of ours. The
 * hand-rolled regex this replaces saw ordinary imports, re-exports and
 * type-only imports, and was blind to a dynamic import written with a template
 * literal, either form written with a comment before the specifier, and
 * `require`. Each of those appended to the real source still measured as
 * `["react"]` - a guard that reads exactly like a clean file.
 */
describe("the landing browser reservation store is a leaf", () => {
  const source = readFileSync(STORE_PATH, "utf8");

  it("imports react and nothing else", () => {
    const scanned = scanImports(source);

    expect(scanned.specifiers).toEqual(["react"]);
    expect(scanned.computed).toBe(0);
  });

  /**
   * Every form measured against the REAL source, so each case is the redden
   * this guard would produce rather than a statement that it would.
   */
  it.each([
    ["ordinary static", 'import { y } from "some-module";'],
    ["side-effect only", 'import "some-module";'],
    ["type-only", 'import type { T } from "some-module";'],
    ["re-export", 'export { z } from "some-module";'],
    ["static, comment before the specifier", 'import { x } from /* c */ "m";'],
    ["dynamic, string specifier", 'void import("some-module");'],
    ["dynamic, template literal", "void import(`some-module`);"],
    ["dynamic, comment before the specifier", 'void import(/* w */ "m");'],
    ["require", 'const q = require("some-module");'],
  ])("catches a second import written as %s", (_label, snippet) => {
    expect(scanImports(`${source}\n${snippet}\n`).specifiers).not.toEqual([
      "react",
    ]);
  });

  /**
   * The residual gap, closed by counting rather than by reading.
   *
   * TypeScript's scanner names a specifier it can read; a computed one it
   * cannot, and reports nothing at all - so on these two forms the specifier
   * list alone still measures as `["react"]`. Asserted here in BOTH directions
   * so the counter is what catches them.
   */
  it.each([
    ["an identifier", 'const n = "some-module";\nvoid import(n);'],
    ["a substituted template", 'const n = "x";\nvoid import(`./mod-${n}`);'],
  ])("catches a dynamic import whose specifier is %s", (_label, snippet) => {
    const scanned = scanImports(`${source}\n${snippet}\n`);

    expect(scanned.specifiers).toEqual(["react"]);
    expect(scanned.computed).toBe(1);
  });
});
