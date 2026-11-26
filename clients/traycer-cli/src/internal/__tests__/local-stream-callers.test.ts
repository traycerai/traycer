import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Who may name the two token surfaces a local stream hangs on.
 *
 * `localStreamCredential` hands out the held host-only token's bearer together
 * with the one recovery for a refused open; only `runLocalStream` may ask for
 * it, so a command cannot dial the local host on that token and leave the
 * recovery out. `streamBearerForOwnRecovery` is a bearer with no such recovery,
 * for the two callers that run their own.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));

interface Guard {
  readonly name: string;
  /** Paths under `src`, with `/`, that may. */
  readonly allowed: readonly string[];
}

const GUARDS: readonly Guard[] = [
  {
    name: "localStreamCredential",
    allowed: ["internal/local-stream.ts", "internal/cli-host-tokens.ts"],
  },
  {
    name: "streamBearerForOwnRecovery",
    allowed: [
      "commands/monitor.ts",
      "host/credential-provisioning.ts",
      "internal/cli-host-tokens.ts",
    ],
  },
];

interface Source {
  /** Relative to `src`, with `/`. */
  readonly path: string;
  readonly text: string;
}

interface Violation {
  readonly path: string;
  readonly name: string;
}

/**
 * Every identifier and string literal in a source: how code can name a member,
 * whether it calls it, aliases it, destructures it under another name or reads
 * it by a quoted key. A comment is neither.
 */
function namesIn(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
      names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, false));
  return names;
}

/** The guards each source breaks. */
function violationsIn(sources: readonly Source[]): readonly Violation[] {
  return sources.flatMap((source) => {
    const names = namesIn(source.text);
    return GUARDS.filter(
      (guard) => !guard.allowed.includes(source.path) && names.has(guard.name),
    ).map((guard) => ({ path: source.path, name: guard.name }));
  });
}

function isProductionSource(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts");
}

/** A fixture is real TypeScript: it parses, so only what it names can fail it. */
function expectParses(text: string): void {
  const result = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  expect(result.diagnostics ?? []).toEqual([]);
}

function fixture(body: string): Source {
  const text = [
    'import { runLocalStream } from "../internal/local-stream";',
    "",
    "export async function dialTheHost(tokens: unknown, hostId: string) {",
    ...body.split("\n").map((line) => `  ${line}`),
    "  return { tokens, hostId, runLocalStream };",
    "}",
    "",
  ].join("\n");
  expectParses(text);
  return { path: "commands/fixture.ts", text };
}

describe("who names the local stream's token surfaces", () => {
  it("is nobody outside the allowed files, in the real tree", () => {
    const sources: Source[] = ts.sys
      .readDirectory(SRC, [".ts"], undefined, undefined)
      .filter(
        (path) => !path.includes("/__tests__/") && isProductionSource(path),
      )
      .map((path) => ({
        path: relative(SRC, path).split(sep).join("/"),
        text: readFileSync(path, "utf8"),
      }));
    // The scan reads the tree it means to: the allowed files are in it.
    const paths = sources.map((source) => source.path);
    for (const guard of GUARDS)
      for (const allowed of guard.allowed) expect(paths).toContain(allowed);
    expect(paths.some((path) => path.includes("__tests__"))).toBe(false);
    expect(paths.some((path) => path.endsWith(".test.ts"))).toBe(false);
    expect(violationsIn(sources)).toEqual([]);
  });

  it("passes a file that calls neither", () => {
    expect(
      violationsIn([fixture("const held = String(hostId);\nvoid held;")]),
    ).toEqual([]);
  });

  it("fails a file that calls localStreamCredential", () => {
    const source = fixture(
      "const credential = (tokens as { localStreamCredential(id: string): unknown }).localStreamCredential(hostId);\nvoid credential;",
    );
    expect(violationsIn([source])).toEqual([
      { path: "commands/fixture.ts", name: "localStreamCredential" },
    ]);
  });

  it("fails a file that calls streamBearerForOwnRecovery", () => {
    const source = fixture(
      "const bearer = (tokens as { streamBearerForOwnRecovery(id: string): unknown }).streamBearerForOwnRecovery(hostId);\nvoid bearer;",
    );
    expect(violationsIn([source])).toEqual([
      { path: "commands/fixture.ts", name: "streamBearerForOwnRecovery" },
    ]);
  });

  it("fails a file that supplies streamBearerForOwnRecovery as a property", () => {
    const source = fixture(
      "const fake = { streamBearerForOwnRecovery: () => null };\nvoid fake;",
    );
    expect(violationsIn([source])).toEqual([
      { path: "commands/fixture.ts", name: "streamBearerForOwnRecovery" },
    ]);
  });

  it.each(
    GUARDS.flatMap(({ name }) => [
      {
        use: "destructures under another name",
        name,
        body: `const { ${name}: held } = tokens as Record<string, unknown>;\nvoid held;`,
      },
      {
        use: "aliases without calling",
        name,
        body: `const held = (tokens as Record<string, unknown>).${name};\nvoid held;`,
      },
      {
        use: "reads by a quoted key",
        name,
        body: `const held = (tokens as Record<string, unknown>)["${name}"];\nvoid held;`,
      },
    ]),
  )("fails a file that $use $name", ({ name, body }) => {
    expect(violationsIn([fixture(body)])).toEqual([
      { path: "commands/fixture.ts", name },
    ]);
  });

  it("lets an allowed file name its own guard, and no other", () => {
    const text = fixture("void hostId;").text;
    const own = `${text}\nconst a = tokens.localStreamCredential(hostId);\n`;
    expect(
      violationsIn([{ path: "internal/local-stream.ts", text: own }]),
    ).toEqual([]);
    const other = `${text}\nconst b = tokens.streamBearerForOwnRecovery(hostId);\n`;
    expect(
      violationsIn([{ path: "internal/local-stream.ts", text: other }]),
    ).toEqual([
      { path: "internal/local-stream.ts", name: "streamBearerForOwnRecovery" },
    ]);
  });
});
