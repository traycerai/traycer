import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// THE SOURCE GATE. Every verb that changes the host's Scheduled Task - the
// schtasks verbs, the PowerShell `*-ScheduledTask` cmdlets, and the
// Schedule.Service COM calls - is spelled in `windows-task-gate.ts` and
// nowhere else in the CLI, and every `gateWindowsTaskVerb` result is only ever
// executed through its `.exec(` call. A new call site that spells a verb of
// its own, or hands the executor on, skips the ownership check this suite
// exists to keep in front of every one of them.

const GATE_FILE = "service/platforms/windows-task-gate.ts";

const SRC_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

// schtasks verbs as argv elements (`/end` and `/End` are the same to schtasks).
const SCHTASKS_MUTATING_VERB = /^\/(?:end|create|run|delete|change)$/i;
// Any literal that carries a mutating cmdlet or COM call by name.
const MUTATING_SCRIPT_TEXT =
  /\b(?:Register|Unregister|Start|Stop|Set|Enable|Disable)-ScheduledTask\b|\bDeleteFolder\b|\bRegisterTaskDefinition\b|\bDeleteTask\b/i;

function nonTestSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      if (name.endsWith(".d.ts")) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/** The text of every string-ish literal in `source`, comments excluded. */
function literalTexts(source: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      texts.push(node.text);
    } else if (ts.isTemplateHead(node)) {
      texts.push(node.text);
    } else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

/** The mutating-verb spellings found in `text`, as a scanner would report them. */
function mutatingSpellingsIn(path: string, text: string): string[] {
  const source = parse(path, text);
  const found: string[] = [];
  for (const literal of literalTexts(source)) {
    if (SCHTASKS_MUTATING_VERB.test(literal)) found.push(literal);
    const script = MUTATING_SCRIPT_TEXT.exec(literal);
    if (script !== null) found.push(script[0]);
  }
  return found;
}

function relativePath(file: string): string {
  return relative(SRC_ROOT, file).split(sep).join("/");
}

/**
 * Every `gateWindowsTaskVerb(...)` call whose result is bound to a name, with
 * how that name is used afterwards. `null` for a call that is not bound to a
 * plain `const x = ...` (which the gate's contract does not allow).
 */
interface GateResultUse {
  readonly file: string;
  readonly line: number;
  readonly bound: string | null;
  readonly properties: string[];
  readonly execUsedAsCallee: boolean;
  readonly identifierEscapes: boolean;
}

function gateResultUses(file: string, text: string): GateResultUse[] {
  const source = parse(file, text);
  const uses: GateResultUse[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "gateWindowsTaskVerb"
    ) {
      uses.push(describeGateUse(source, file, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** `x === null` / `x !== null`: reads the binding without handing it on. */
function isNullComparison(parent: ts.Node, identifier: ts.Node): boolean {
  if (!ts.isBinaryExpression(parent)) return false;
  const operator = parent.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false;
  }
  const other = parent.left === identifier ? parent.right : parent.left;
  return other.kind === ts.SyntaxKind.NullKeyword;
}

function describeGateUse(
  source: ts.SourceFile,
  file: string,
  call: ts.CallExpression,
): GateResultUse {
  const line = source.getLineAndCharacterOfPosition(call.getStart()).line + 1;
  // Walk out through `await` / parentheses / a conditional's branch to the
  // declaration that binds the result.
  let parent: ts.Node = call.parent;
  while (
    ts.isAwaitExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isConditionalExpression(parent)
  ) {
    parent = parent.parent;
  }
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) {
    return {
      file,
      line,
      bound: null,
      properties: [],
      execUsedAsCallee: false,
      identifierEscapes: true,
    };
  }
  const name = parent.name.text;
  // The scope the name lives in: the nearest enclosing block or file.
  let scope: ts.Node = parent;
  while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  const properties: string[] = [];
  let execUsedAsCallee = true;
  let identifierEscapes = false;
  const scan = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== parent.name) {
      const access = node.parent;
      if (ts.isPropertyAccessExpression(access) && access.expression === node) {
        properties.push(access.name.text);
        if (access.name.text === "exec") {
          const callee = access.parent;
          if (!(ts.isCallExpression(callee) && callee.expression === access)) {
            execUsedAsCallee = false;
          }
        }
      } else if (!isNullComparison(access, node)) {
        identifierEscapes = true;
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(scope);
  return {
    file,
    line,
    bound: name,
    properties,
    execUsedAsCallee,
    identifierEscapes,
  };
}

describe("the Scheduled Task source gate: a mutating verb is spelled only in windows-task-gate.ts", () => {
  const files = nonTestSourceFiles(SRC_ROOT);

  it("scans the real tree (the gate file is in it, and it does spell the verbs)", () => {
    const relativeFiles = files.map(relativePath);
    expect(relativeFiles).toContain(GATE_FILE);
    expect(relativeFiles).toContain("service/platforms/windows.ts");
    const gateSpellings = mutatingSpellingsIn(
      GATE_FILE,
      readFileSync(join(SRC_ROOT, GATE_FILE), "utf8"),
    );
    expect(gateSpellings).toEqual(
      expect.arrayContaining([
        "/End",
        "/Run",
        "/Create",
        "/Delete",
        "DeleteFolder",
      ]),
    );
  });

  it("no other non-test file spells a schtasks mutating verb, a *-ScheduledTask cmdlet or a COM delete", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const path = relativePath(file);
      if (path === GATE_FILE) continue;
      const found = mutatingSpellingsIn(path, readFileSync(file, "utf8"));
      for (const spelling of found) offenders.push(`${path}: ${spelling}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner catches a bypassing call (sanity: it is not vacuous)", () => {
    const bypass = `await runCommand("schtasks", ["/End", "/TN", taskName], options);`;
    expect(mutatingSpellingsIn("bypass.ts", bypass)).toEqual(["/End"]);
    expect(
      mutatingSpellingsIn(
        "bypass.ts",
        "run(`powershell -Command Disable-ScheduledTask ${x}`);",
      ),
    ).toEqual(["Disable-ScheduledTask"]);
    expect(
      mutatingSpellingsIn(
        "bypass.ts",
        `const s = "$f.DeleteTask('Host',0)"; const q = ["/Query", "/TN", n];`,
      ),
    ).toEqual(["DeleteTask"]);
  });

  it("every gateWindowsTaskVerb result is bound and only read as kind / error / task / exec, and exec is only ever called", () => {
    const uses: GateResultUse[] = [];
    for (const file of files) {
      const path = relativePath(file);
      if (path === GATE_FILE) continue;
      uses.push(...gateResultUses(path, readFileSync(file, "utf8")));
    }
    // The install, uninstall (`/Delete`, folder), stop (`/End`), start
    // (`/Run`) and definition-refresh (`/Create`) sites.
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const use of uses) {
      const where = `${use.file}:${use.line}`;
      expect({ where, bound: use.bound !== null }).toEqual({
        where,
        bound: true,
      });
      expect({ where, escapes: use.identifierEscapes }).toEqual({
        where,
        escapes: false,
      });
      expect({ where, execUsedAsCallee: use.execUsedAsCallee }).toEqual({
        where,
        execUsedAsCallee: true,
      });
      for (const property of use.properties) {
        expect({ where, property }).toEqual({
          where,
          property: expect.stringMatching(/^(?:kind|error|task|exec)$/),
        });
      }
    }
  });

  it("the result check flags an escaping executor (sanity)", () => {
    const escaping = gateResultUses(
      "escape.ts",
      "async function f(l, d) { const end = await gateWindowsTaskVerb(l, 'end', d); return end.exec; }",
    );
    expect(escaping).toHaveLength(1);
    expect(escaping[0]?.execUsedAsCallee).toBe(false);
    const passedOn = gateResultUses(
      "escape.ts",
      "async function f(l, d) { const end = await gateWindowsTaskVerb(l, 'end', d); other(end); }",
    );
    expect(passedOn[0]?.identifierEscapes).toBe(true);
  });
  // The switch a task's owner set is theirs: only the explicit repair
  // (`host service install`) may write it back on, so no other command can
  // open the repair scope. `host install`, `host apply`, `host update` and
  // `host ensure` reach the install with the scope closed.
  it("runAsExplicitRegistrationRepair is called from commands/service-install.ts and nowhere else", () => {
    const callers: string[] = [];
    for (const file of files) {
      const path = relativePath(file);
      if (path === "service/registration-repair.ts") continue;
      const source = parse(path, readFileSync(file, "utf8"));
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "runAsExplicitRegistrationRepair"
        ) {
          callers.push(path);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(callers).toEqual(["commands/service-install.ts"]);
  });
});
