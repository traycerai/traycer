/// <reference types="node" />

/**
 * R6F2 enumeration/source-scan: every construction site of a "last copy"
 * notice (`unrecoverableSendNotice` / `displacedRestorationNotice`) must be
 * accompanied by a write into `lastCopyPrompts` - directly, through
 * `recordLastCopyPrompt`/`withLastCopyPrompts`, or (for a call buried inside
 * a pure helper like `rejectionNotice`) at that helper's OWN call site.
 *
 * The notice is rendered text; `lastCopyPrompts` is the document behind it
 * that `handOffUnrecordedPromptToStash` actually reads at teardown. A notice
 * with no matching record is exactly R6F2: the user sees "your prompt was
 * lost", and an hour later there is nothing left to hand off.
 *
 * Follows `src/__tests__/muted-fill-on-raised-surface-lint.test.ts`'s shape:
 * a static source scan, not a runtime test, so a FUTURE producer that forgets
 * the record is caught before it ships.
 *
 * R8N2: the scope-finding used to be raw brace matching over the source
 * text. Two defects with that: a template literal containing a `{` throws
 * the brace count off, and a NESTED, UNCALLED arrow function's body is plain
 * text inside the enclosing block, so a producer sitting inside one vouches
 * for a notice that never actually runs it. Both are fixed by using the real
 * TypeScript AST (`typescript`, already a repo dependency) instead of
 * counting characters: the "enclosing block" is the nearest ancestor
 * `Block`/`ObjectLiteralExpression` NODE, and the walk that looks for a
 * producer inside it does not descend into a nested function's own body -
 * that body runs on its own schedule, not as part of this block's effect.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  path.join(SRC_DIR, "chat-session-store.ts"),
  path.join(SRC_DIR, "chat-queue-reconciler.ts"),
];

const NOTICE_FNS = ["unrecoverableSendNotice", "displacedRestorationNotice"];

/** Callee names that mean "a lastCopyPrompts document was recorded here". */
const PRODUCER_CALL_NAMES = [
  "recordLastCopyPrompt",
  "withLastCopyPrompts",
  "unrecoverableSendPrompt",
];

/** Property names that mean the same thing, written as a state-patch key. */
const PRODUCER_PROPERTY_NAMES = ["lastCopyPrompts", "appendedLastCopyPrompts"];

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every real invocation of `name(...)` in `sourceFile`, wherever it sits. */
function findCallExpressions(
  sourceFile: ts.SourceFile,
  name: string,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/**
 * `Node.parent` is declared non-optional in the TypeScript API even though a
 * source file's own root nodes have none at runtime - so walking it needs an
 * explicit widen, not a type the checker already believes is never
 * `undefined`.
 */
function parentOf(node: ts.Node): ts.Node | undefined {
  return node.parent;
}

/**
 * The SCOPE a producer must share with the notice: the nearest enclosing
 * `Block` or object-literal node, found by walking real AST parents rather
 * than matching brace characters in text.
 */
function enclosingScope(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = parentOf(node);
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isObjectLiteralExpression(current)) {
      return current;
    }
    current = parentOf(current);
  }
  return null;
}

function isProducerCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    PRODUCER_CALL_NAMES.includes(node.expression.text)
  );
}

function isProducerProperty(node: ts.Node): boolean {
  if (
    !ts.isPropertyAssignment(node) &&
    !ts.isShorthandPropertyAssignment(node)
  ) {
    return false;
  }
  return (
    ts.isIdentifier(node.name) &&
    PRODUCER_PROPERTY_NAMES.includes(node.name.text)
  );
}

/**
 * Whether `scope` names a producer, without crediting one that lives inside
 * a NESTED function-like body - that body runs on its own schedule (later,
 * elsewhere, or never), so its contents are not this block's effect.
 *
 * R9N1: the enumerated check (function expression / arrow / declaration)
 * missed every OTHER function-like shape TypeScript's own AST recognizes -
 * a class or object-literal METHOD, a get/set accessor, a constructor. A
 * producer sitting inside an uncalled one of those still vouched for a
 * notice built beside it, in exactly the shape the enumerated list was
 * meant to rule out. `ts.isFunctionLike` is the real, exhaustive predicate
 * for "this node's body runs on its own schedule" - use it instead of
 * naming shapes one at a time.
 */
function scopeNamesProducer(scope: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isProducerCall(node) || isProducerProperty(node)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

function callHasProducerInScope(call: ts.CallExpression): boolean {
  const scope = enclosingScope(call);
  return scope !== null && scopeNamesProducer(scope);
}

/** Nearest enclosing NAMED function declaration, however deep. */
function enclosingNamedFunction(node: ts.Node): ts.FunctionDeclaration | null {
  let current: ts.Node | undefined = parentOf(node);
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return current;
    }
    current = parentOf(current);
  }
  return null;
}

export function unaccountedNoticeSitesIn(
  source: string,
  label: string,
): Offence[] {
  const sourceFile = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const offences: Offence[] = [];

  for (const fn of NOTICE_FNS) {
    for (const call of findCallExpressions(sourceFile, fn)) {
      if (callHasProducerInScope(call)) continue;
      // The pure-helper escape hatch: the notice-building call sits inside a
      // helper (e.g. `rejectionNotice`) that only RETURNS a notice, so the
      // record belongs at the helper's own call site. EVERY such call site
      // must record - one qualifying caller used to be enough, which let a
      // second, forgetful caller of the same helper through.
      const enclosingFn = enclosingNamedFunction(call);
      if (enclosingFn?.name !== undefined) {
        const helperCalls = findCallExpressions(
          sourceFile,
          enclosingFn.name.text,
        );
        if (
          helperCalls.length > 0 &&
          helperCalls.every((site) => callHasProducerInScope(site))
        ) {
          continue;
        }
      }
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        call.getStart(sourceFile),
      );
      const lineText = source.split("\n")[line] ?? "";
      offences.push({ file: label, line: line + 1, text: lineText.trim() });
    }
  }
  return offences;
}

function findUnaccountedNoticeSites(file: string): Offence[] {
  return unaccountedNoticeSitesIn(
    readFileSync(file, "utf8"),
    path.relative(SRC_DIR, file),
  );
}

function countNoticeCallSites(source: string): number {
  const sourceFile = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return NOTICE_FNS.reduce(
    (count, fn) => count + findCallExpressions(sourceFile, fn).length,
    0,
  );
}

describe("last-copy notice producer scan", () => {
  it("every unrecoverableSendNotice/displacedRestorationNotice construction is accompanied by a lastCopyPrompts record", () => {
    const offences = FILES.flatMap(findUnaccountedNoticeSites);
    expect(offences).toEqual([]);
  });

  it("sanity: the scan actually finds the known call sites (a passing scan is not a scan that found nothing)", () => {
    const totalCallSites = FILES.reduce(
      (count, file) => count + countNoticeCallSites(readFileSync(file, "utf8")),
      0,
    );
    expect(totalCallSites).toBeGreaterThan(0);
  });

  it("ORPHAN CONTROL: a notice whose only nearby lastCopyPrompts mention is in a DIFFERENT block is reported", () => {
    // The exact shape raw brace/line-window matching accepted: a sibling
    // updater that happens to mention the map vouches for a notice it has
    // nothing to do with. A scan that cannot fail here cannot protect a
    // future producer.
    const orphan = `
function somethingElse(state: S) {
  return {
    lastCopyPrompts: { ...state.lastCopyPrompts },
  };
}

function noticeOnly(state: S) {
  return {
    errorNotices: appendErrorNotice(
      state.errorNotices,
      unrecoverableSendNotice(send),
    ),
  };
}
`;
    const offences = unaccountedNoticeSitesIn(orphan, "orphan.ts");
    expect(offences).toHaveLength(1);
    expect(offences[0].text).toContain("unrecoverableSendNotice");
  });

  it("ORPHAN CONTROL: the same notice WITH a record in its own block passes", () => {
    const accounted = `
function noticeAndRecord(state: S) {
  return {
    errorNotices: appendErrorNotice(
      state.errorNotices,
      unrecoverableSendNotice(send),
    ),
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  };
}
`;
    expect(unaccountedNoticeSitesIn(accounted, "accounted.ts")).toEqual([]);
  });

  it("TEMPLATE-LITERAL CONTROL: a brace inside a template literal does not throw off the scope walk", () => {
    // The defect raw brace-matching had: a `{` inside a template literal is
    // not a real block boundary, but a character scanner cannot tell the
    // difference. A real parser does not see one there at all.
    const withTemplateBrace = `
function noticeAndRecord(state: S) {
  const label = \`account \${state.id}\`;
  return {
    label,
    errorNotices: appendErrorNotice(
      state.errorNotices,
      unrecoverableSendNotice(send),
    ),
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  };
}
`;
    expect(unaccountedNoticeSitesIn(withTemplateBrace, "template.ts")).toEqual(
      [],
    );
  });

  it("UNCALLED-NESTED-ARROW CONTROL: a producer inside a nested function that is never invoked here does not vouch for the notice", () => {
    // The other defect: a nested arrow DEFINED inside the block but never
    // called as part of this block's own effect must not count - its body
    // runs later, elsewhere, or never.
    const uncalledNestedArrow = `
function noticeOnly(state: S) {
  const laterMaybe = () => ({
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  });
  return {
    errorNotices: appendErrorNotice(
      state.errorNotices,
      unrecoverableSendNotice(send),
    ),
    deferred: laterMaybe,
  };
}
`;
    const offences = unaccountedNoticeSitesIn(
      uncalledNestedArrow,
      "uncalled.ts",
    );
    expect(offences).toHaveLength(1);
    expect(offences[0].text).toContain("unrecoverableSendNotice");
  });

  it("UNCALLED-METHOD CONTROL: a producer inside an uncalled object-literal METHOD, in the SAME return object as the notice, does not vouch for it (R9N1, DRIVE RED under the pre-fix enumerated guard AND under raw-brace)", () => {
    // The enumerated guard (function expression / arrow / declaration) never
    // named a METHOD shape. The existing UNCALLED-NESTED-ARROW CONTROL above
    // does not actually exercise that guard at all: its arrow is defined in
    // a statement BEFORE the return, and `enclosingScope` narrows to the
    // nearest object-literal ancestor of the notice call - the return's OWN
    // object literal, which is a sibling of that statement, not an ancestor
    // of it. The guard only matters when the function-like construct is
    // DEFINED inline, as a property of that SAME object literal - the shape
    // below. `ts.isFunctionLike` is what closes this: it recognizes a method
    // (and an accessor, and a constructor) as its own schedule, the same as
    // an arrow or a plain function.
    const uncalledMethod = `
function noticeAndMethod(state: S) {
  return {
    errorNotices: appendErrorNotice(
      state.errorNotices,
      unrecoverableSendNotice(send),
    ),
    helpers: {
      run() {
        return {
          lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
        };
      },
    },
  };
}
`;
    const offences = unaccountedNoticeSitesIn(
      uncalledMethod,
      "uncalled-method.ts",
    );
    expect(offences).toHaveLength(1);
    expect(offences[0].text).toContain("unrecoverableSendNotice");
  });

  it("TEMPLATE-LITERAL ORPHAN: an unmatched brace inside a template literal must not cut a notice's scope short of its OWN accounting record (R9N1, DRIVE RED under raw-brace)", () => {
    // A real parser sees no brace inside the template literal at all - it is
    // string content, closed by the backtick, not a block boundary. A
    // character counter cannot tell the difference: a lone UNMATCHED `}`
    // inside the literal (unlike the balanced `${...}` interpolation the
    // existing TEMPLATE-LITERAL CONTROL above uses) reads as closing the
    // enclosing object literal right there - before the walk ever reaches
    // `lastCopyPrompts`, which sits later in the SAME object, right beside
    // the notice. A naive counter reports this notice as unaccounted for;
    // a real parser correctly sees one property list with both members in
    // it and reports nothing.
    const unbalancedTemplateBrace = `
function noticeThenRecord(state: S) {
  return {
    errorNotices: appendErrorNotice(
      state.errorNotices,
      unrecoverableSendNotice(send),
    ),
    label: \`oops }\`,
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  };
}
`;
    expect(
      unaccountedNoticeSitesIn(
        unbalancedTemplateBrace,
        "unbalanced-template.ts",
      ),
    ).toEqual([]);
  });

  it("EVERY-CALLER CONTROL: a pure-helper notice builder with two callers, only one of which records, is reported (DRIVE RED on every->some)", () => {
    // Reproduces the reviewer's finding: `helperCalls.some(...)` would let a
    // SECOND, forgetful caller of the same notice-building helper through as
    // long as some OTHER caller records. `every` is the only version that
    // actually enforces "every call site must record".
    const twoCallersOnlyOneRecords = `
function rejectionNotice(send: Send) {
  return unrecoverableSendNotice(send);
}

function accountedCaller(state: S) {
  return {
    errorNotices: appendErrorNotice(state.errorNotices, rejectionNotice(send)),
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  };
}

function unaccountedCaller(state: S) {
  return {
    errorNotices: appendErrorNotice(state.errorNotices, rejectionNotice(send)),
  };
}
`;
    const offences = unaccountedNoticeSitesIn(
      twoCallersOnlyOneRecords,
      "two-callers.ts",
    );
    expect(offences).toHaveLength(1);
    expect(offences[0].text).toContain("unrecoverableSendNotice");
  });

  it("EVERY-CALLER CONTROL: the same shape with BOTH callers recording passes", () => {
    const bothCallersRecord = `
function rejectionNotice(send: Send) {
  return unrecoverableSendNotice(send);
}

function accountedCallerOne(state: S) {
  return {
    errorNotices: appendErrorNotice(state.errorNotices, rejectionNotice(send)),
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  };
}

function accountedCallerTwo(state: S) {
  return {
    errorNotices: appendErrorNotice(state.errorNotices, rejectionNotice(send)),
    lastCopyPrompts: recordLastCopyPrompt(state.lastCopyPrompts, send),
  };
}
`;
    expect(
      unaccountedNoticeSitesIn(bothCallersRecord, "two-callers-ok.ts"),
    ).toEqual([]);
  });
});
