import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The gate against a schema added the eager way.
 *
 * Wave 2 converted protocol schemas to `lazySchema(() => z.object(...))`
 * stand-ins so importing a module builds nothing. Until this file, nothing
 * failed when someone added a schema eagerly instead, or reached into a lazy
 * stand-in with a combinator call at module scope (`.extend`, `.merge`, ...),
 * which forces it to build at import exactly as if it had never been wrapped.
 *
 * It began as a census, and the census decided its shape: 48 eager schemas,
 * every one of them under `protocol/src/framework/` and none in any contract
 * area. So the gate pins the set OUTSIDE `framework/` by exact equality, and
 * that set starts empty; `framework/` is excluded as a directory, with the
 * reason stated where the exclusion is made, rather than by 48 names.
 */

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const PROTOCOL_SRC = path.join(PROTOCOL_ROOT, "src");
// Findings are keyed relative to the monorepo root (`protocol/src/...`), not
// to PROTOCOL_ROOT (`src/...`), so a key like
// `protocol/src/framework/ws-protocol.ts#manifestMethodEntrySchema` matches
// what a reader would actually see in the repo tree.
const TRAYCER_ROOT = path.join(PROTOCOL_ROOT, "..");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "__tests__",
  "__fixtures__",
]);

function isTestFileName(fileName: string): boolean {
  return fileName.endsWith(".test.ts") || fileName.endsWith(".d.ts");
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
  return isTestFileName(base);
}

/**
 * Every `.ts` file `git` tracks (or has staged as a new file) under
 * `protocol/src`, minus tests, fixtures and declaration files. Scoped to
 * `protocol/src` alone: the census is about protocol schemas, not the whole
 * monorepo.
 */
function collectProtocolSrcFiles(): string[] {
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
    ],
    { cwd: PROTOCOL_SRC, encoding: "utf8" },
  );
  const files: string[] = [];
  for (const relative of listing.split("\0")) {
    if (relative.length === 0) continue;
    if (shouldSkipListedPath(relative)) continue;
    const full = path.join(PROTOCOL_SRC, relative);
    if (!existsSync(full)) continue;
    files.push(full);
  }
  return files;
}

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

type EagerSchemaKind = "z-rooted" | "combinator-on-identifier";

type EagerSchemaFinding = {
  readonly sourceFile: string;
  readonly variableName: string;
  readonly kind: EagerSchemaKind;
};

function eagerSchemaFindingKey(finding: EagerSchemaFinding): string {
  return `${finding.sourceFile}#${finding.variableName}`;
}

// The wave-2 hazard's other half: a combinator called directly on another
// SCHEMA IDENTIFIER (never on `z` itself - `z.array(...)` etc. is caught by
// the z-rooted rule below) forces that identifier's value to build, lazy
// stand-in or not, the moment the module loads.
const COMBINATOR_METHOD_NAMES = new Set([
  "extend",
  "merge",
  "pick",
  "omit",
  "partial",
  "and",
  "or",
  "array",
  "optional",
  "nullable",
]);

// Peels the wrapper expressions the task calls out explicitly - parens,
// `as`, `satisfies` - and nothing else. It deliberately does NOT walk into
// a call's arguments (which is how `lazySchema(() => z.object(...))` stays
// unmatched: the declarator's initializer, once unwrapped, is the
// `lazySchema(...)` call itself, never the `z.object(...)` buried inside its
// thunk argument).
function unwrapWrapperExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

// Walks a call/property-access chain down to whatever sits at its root -
// the receiver a fluent chain like `z.enum([...]).optional()` ultimately
// bottoms out on.
function calleeChainRoot(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isZRootedCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const root = calleeChainRoot(expression);
  return ts.isIdentifier(root) && root.text === "z";
}

function isCombinatorOnIdentifierCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression)) return false;
  if (callee.expression.text === "z") return false;
  return COMBINATOR_METHOD_NAMES.has(callee.name.text);
}

/**
 * Every module-scope (top-level `const`/`let`, including `export const`)
 * variable whose initializer - after unwrapping parens/`as`/`satisfies`
 * only, never a call's arguments - is either:
 *
 *  - a call rooted at the identifier `z` (`z.object(...)`,
 *    `z.enum([...]).optional()`, `z.array(itemSchema)`, ...): built the
 *    moment the module loads, the thing `lazySchema` exists to prevent; or
 *  - a combinator call directly on another identifier
 *    (`otherSchema.extend({...})`): forces THAT identifier's value to build
 *    at import too, lazy stand-in or not.
 *
 * A hazard nested inside a function body, or inside a `lazySchema(() =>
 * ...)` thunk, is invisible here by construction: this only ever looks at
 * a top-level statement's own initializer, never recurses into one.
 */
function findEagerSchemasInSource(
  fileName: string,
  text: string,
): EagerSchemaFinding[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: EagerSchemaFinding[] = [];

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declarator of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declarator.name)) continue;
      if (declarator.initializer === undefined) continue;
      const initializer = unwrapWrapperExpression(declarator.initializer);

      if (isZRootedCall(initializer)) {
        findings.push({
          sourceFile: fileName,
          variableName: declarator.name.text,
          kind: "z-rooted",
        });
        continue;
      }
      if (isCombinatorOnIdentifierCall(initializer)) {
        findings.push({
          sourceFile: fileName,
          variableName: declarator.name.text,
          kind: "combinator-on-identifier",
        });
      }
    }
  }

  return findings;
}

describe("findEagerSchemasInSource: planted sources (pure)", () => {
  it("a module-scope z.object(...) is found as z-rooted", () => {
    expect(
      findEagerSchemasInSource("inline.ts", "export const A = z.object({});\n"),
    ).toEqual([
      { sourceFile: "inline.ts", variableName: "A", kind: "z-rooted" },
    ]);
  });

  it("the same schema wrapped in lazySchema(() => ...) is not found", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "export const A = lazySchema(() => z.object({}));\n",
      ),
    ).toEqual([]);
  });

  it("a module-scope combinator call on another identifier is found", () => {
    expect(
      findEagerSchemasInSource("inline.ts", "const B = A.extend({});\n"),
    ).toEqual([
      {
        sourceFile: "inline.ts",
        variableName: "B",
        kind: "combinator-on-identifier",
      },
    ]);
  });

  it("the same .extend inside a function body is not found", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "function make() {\n  const B = A.extend({});\n  return B;\n}\n",
      ),
    ).toEqual([]);
  });

  it("the same .extend inside a lazySchema thunk is not found", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "export const B = lazySchema(() => A.extend({}));\n",
      ),
    ).toEqual([]);
  });

  it("z.object inside a function body is not found", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "function make() {\n  const A = z.object({});\n  return A;\n}\n",
      ),
    ).toEqual([]);
  });

  it("a type-only file finds nothing", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "export type Foo = { a: string };\nexport interface Bar { b: number }\n",
      ),
    ).toEqual([]);
  });

  it("z.array(...) is z-rooted, not combinator-on-identifier, even though 'array' is a combinator name", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "export const A = z.array(itemSchema);\n",
      ),
    ).toEqual([
      { sourceFile: "inline.ts", variableName: "A", kind: "z-rooted" },
    ]);
  });

  it("parens/as/satisfies wrapping the whole initializer are unwrapped before the check", () => {
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "export const A = (z.object({}) as never);\n",
      ),
    ).toEqual([
      { sourceFile: "inline.ts", variableName: "A", kind: "z-rooted" },
    ]);
    expect(
      findEagerSchemasInSource(
        "inline.ts",
        "export const A = z.object({}) satisfies unknown;\n",
      ),
    ).toEqual([
      { sourceFile: "inline.ts", variableName: "A", kind: "z-rooted" },
    ]);
  });
});

// `protocol/src/framework/` is excluded from the gate below, not because it
// was missed, but because it was MEASURED and accepted: the lazy-schema work
// found the framework barrel builds 165 instances of its own, imports no
// contract module, and forces nothing downstream - these are the
// wire-negotiation primitives every connection uses regardless of which
// contract methods run. A 48-name allowlist over that directory would just
// be re-pinning a directory already measured and accepted, not closing a
// real gap. The exclusion is a directory rule, not a name list: see
// `isFrameworkPath` and its own describe block below.
function isFrameworkPath(repoRelativePosixPath: string): boolean {
  const segments = repoRelativePosixPath.split("/");
  return (
    segments[0] === "protocol" &&
    segments[1] === "src" &&
    segments[2] === "framework"
  );
}

function eagerFindingKeyWithKind(finding: EagerSchemaFinding): string {
  return `${eagerSchemaFindingKey(finding)} (${finding.kind})`;
}

type EagerAllowlistEntry = {
  readonly key: string;
  readonly reason: string;
};

// A placeholder ("ok", "needed") is not a reason; this is long enough to
// force an actual sentence without being an arbitrary essay requirement.
const MIN_ALLOWLIST_REASON_LENGTH = 20;

function isValidAllowlistReason(reason: string): boolean {
  return reason.trim().length >= MIN_ALLOWLIST_REASON_LENGTH;
}

/**
 * The escape hatch for a schema outside `framework/` that genuinely must
 * stay eager. `lazy-schema.ts` documents the real cases: a schema carrying
 * something zod attaches AFTER `new` - `.describe()`/`.meta()`/`.register()`
 * as the outermost call, the check `z.instanceof` installs, or a cycle
 * closed through a const declared inside the thunk - must be declared
 * eagerly, because `lazySchema`'s `build` has to return the schema exactly
 * as zod's constructor left it.
 *
 * Empty today: nothing outside `framework/` needs this yet.
 */
const ALLOWED_EAGER_SCHEMAS_OUTSIDE_FRAMEWORK: readonly EagerAllowlistEntry[] =
  [];

function diffEagerFindingsAgainstAllowlist(
  findings: readonly EagerSchemaFinding[],
  allowlist: readonly EagerAllowlistEntry[],
): {
  readonly unexpected: readonly string[];
  readonly stale: readonly string[];
} {
  const keys = [...new Set(findings.map(eagerFindingKeyWithKind))].sort();
  const allowedKeys = [...allowlist.map((entry) => entry.key)].sort();
  const unexpected = keys.filter((key) => !allowedKeys.includes(key));
  const stale = allowedKeys.filter((key) => !keys.includes(key));
  return { unexpected, stale };
}

function formatGateFailure(diff: {
  readonly unexpected: readonly string[];
  readonly stale: readonly string[];
}): string {
  const sections: string[] = [
    "Eager schema allowlist outside protocol/src/framework/ is out of sync.",
  ];
  if (diff.unexpected.length > 0) {
    sections.push(
      [
        "Newly found eager schema(s) not on the allowlist:",
        ...diff.unexpected.map((key) => `  ${key}`),
        "",
        "For each: wrap the schema in `lazySchema(() => ...)`; or, if it",
        "genuinely must be eager (lazy-schema.ts: a schema carrying what zod",
        "attaches AFTER construction - `.describe()`/`.meta()`/`.register()` as",
        "the outermost call, a `z.instanceof` check, or a cycle closed through a",
        "const declared inside the thunk - must stay eager), add its key to",
        "ALLOWED_EAGER_SCHEMAS_OUTSIDE_FRAMEWORK with a `reason` explaining why.",
      ].join("\n"),
    );
  }
  if (diff.stale.length > 0) {
    sections.push(
      [
        "Stale allowlist entr(y/ies) no longer found - the schema was fixed or",
        "removed, so delete the entry:",
        ...diff.stale.map((key) => `  ${key}`),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

type ProtocolSrcScan = {
  readonly files: readonly string[];
  readonly findings: readonly EagerSchemaFinding[];
};

function scanProtocolSrc(): ProtocolSrcScan {
  const files = collectProtocolSrcFiles();
  const findings: EagerSchemaFinding[] = [];
  for (const filePath of files) {
    const relative = posixRelative(TRAYCER_ROOT, filePath);
    const text = readFileSync(filePath, "utf8");
    findings.push(...findEagerSchemasInSource(relative, text));
  }
  return { files, findings };
}

describe("isFrameworkPath: the framework/ exclusion is a directory rule, not a substring match", () => {
  it("protocol/src/framework/x.ts is excluded", () => {
    expect(isFrameworkPath("protocol/src/framework/x.ts")).toBe(true);
  });

  it("a file whose NAME merely starts with 'framework' is not excluded", () => {
    expect(isFrameworkPath("protocol/src/host/framework-ish.ts")).toBe(false);
  });

  it("a nested directory that happens to be named framework/, anywhere but directly under protocol/src/, stays in scope", () => {
    // Only the top-level protocol/src/framework/ is the wave-2-measured
    // exclusion; a same-named directory elsewhere is an ordinary directory.
    expect(isFrameworkPath("protocol/src/host/framework/x.ts")).toBe(false);
  });
});

describe("isValidAllowlistReason: an allowlist entry must carry a real reason", () => {
  it("an empty or whitespace-only reason is invalid", () => {
    expect(isValidAllowlistReason("")).toBe(false);
    expect(isValidAllowlistReason("   ")).toBe(false);
  });

  it("a short placeholder is invalid", () => {
    expect(isValidAllowlistReason("ok")).toBe(false);
    expect(isValidAllowlistReason("needed")).toBe(false);
  });

  it("a real sentence explaining why is valid", () => {
    expect(
      isValidAllowlistReason(
        "carries a z.instanceof check zod attaches after construction; must stay eager per lazy-schema.ts",
      ),
    ).toBe(true);
  });
});

describe("diffEagerFindingsAgainstAllowlist: red-first proof (planted source, no production files touched)", () => {
  it("a new eager schema outside framework/ diffs as unexpected against an empty allowlist", () => {
    const findings = findEagerSchemasInSource(
      "protocol/src/host/planted.ts",
      "export const A = z.object({});\n",
    );
    const diff = diffEagerFindingsAgainstAllowlist(findings, []);
    expect(diff.unexpected).toEqual([
      "protocol/src/host/planted.ts#A (z-rooted)",
    ]);
    expect(diff.stale).toEqual([]);
  });

  it("the identical source under protocol/src/framework/ produces no diff, because the gate filters framework/ out before diffing", () => {
    const findings = findEagerSchemasInSource(
      "protocol/src/framework/planted.ts",
      "export const A = z.object({});\n",
    );
    const outsideFramework = findings.filter(
      (finding) => !isFrameworkPath(finding.sourceFile),
    );
    const diff = diffEagerFindingsAgainstAllowlist(outsideFramework, []);
    expect(diff.unexpected).toEqual([]);
    expect(diff.stale).toEqual([]);
  });
});

describe("eager-schema gate: protocol/src outside framework/", () => {
  // Measured on this machine (3 runs, load average ~11 during the earlier
  // census pass): 197-218ms (~0.22s) for the full protocol/src scan. Using
  // the tripwire suite's own local->CI slowdown factor (2.2x) plus a 5x
  // margin: 0.22s * 2.2 * 5 = 2.42s = 2420ms. That is BELOW vitest's 5000ms
  // default hook timeout (by roughly 2.07x), so no explicit timeout is
  // passed here - the default already covers this pass with margin to
  // spare.
  let scan: ProtocolSrcScan;

  beforeAll(() => {
    scan = scanProtocolSrc();
  });

  it("CONTROL: production scan covers real breadth outside framework/ too (352 files total; 19 under framework/, so 333 outside - well over 100)", () => {
    const outsideFiles = scan.files.filter(
      (filePath) => !isFrameworkPath(posixRelative(TRAYCER_ROOT, filePath)),
    );
    expect(outsideFiles.length).toBeGreaterThan(100);
  });

  it("CONTROL: production scan finds EXACTLY 48 eager schemas inside protocol/src/framework/ (46 z-rooted, 2 combinator) - a census fact, not a ceiling", () => {
    const frameworkFindings = scan.findings.filter((finding) =>
      isFrameworkPath(finding.sourceFile),
    );
    const byKind = new Map<EagerSchemaKind, number>();
    for (const finding of frameworkFindings) {
      byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
    }

    if (frameworkFindings.length !== 48) {
      throw new Error(
        [
          `Expected exactly 48 eager schemas inside protocol/src/framework/, found ${frameworkFindings.length}.`,
          "This number is a CENSUS FACT pinned when this gate was built (wave 2's own",
          "measurement: the framework barrel builds 165 instances of its own, imports",
          "no contract module, forces nothing downstream) - not a ceiling. framework/",
          "is free to change.",
          "If this changed because framework/ genuinely grew or shrank its eager",
          "schema count: first confirm the scanner still sees real production code",
          "(the manifestMethodEntrySchema membership check below), then update this",
          "number to match.",
        ].join("\n"),
      );
    }

    expect(byKind.get("z-rooted")).toBe(46);
    expect(byKind.get("combinator-on-identifier")).toBe(2);
    expect(
      frameworkFindings.some(
        (finding) =>
          finding.sourceFile === "protocol/src/framework/ws-protocol.ts" &&
          finding.variableName === "manifestMethodEntrySchema" &&
          finding.kind === "combinator-on-identifier",
      ),
    ).toBe(true);
  });

  it("every allowlist entry (if any) carries a real reason, not a placeholder", () => {
    const invalid = ALLOWED_EAGER_SCHEMAS_OUTSIDE_FRAMEWORK.filter(
      (entry) => !isValidAllowlistReason(entry.reason),
    );
    expect(invalid).toEqual([]);
  });

  it("GATE: every eager schema outside protocol/src/framework/ is on the allowlist, exactly", () => {
    const outsideFindings = scan.findings.filter(
      (finding) => !isFrameworkPath(finding.sourceFile),
    );
    const diff = diffEagerFindingsAgainstAllowlist(
      outsideFindings,
      ALLOWED_EAGER_SCHEMAS_OUTSIDE_FRAMEWORK,
    );

    if (diff.unexpected.length > 0 || diff.stale.length > 0) {
      throw new Error(formatGateFailure(diff));
    }

    expect(diff.unexpected).toEqual([]);
    expect(diff.stale).toEqual([]);
  });
});
