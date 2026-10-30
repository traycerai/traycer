/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * No desktop string a person reads carries the words the product does not use
 * for the person's settings - "environment", "binding" and "placeholder". The
 * glossary pass removed them from about 30 strings; this keeps them out.
 *
 * WHAT COUNTS AS A STRING A PERSON READS is decided by its AST POSITION, never
 * by its text, so an RPC id, a query key, a search keyword or a code
 * identifier that happens to contain the word is simply not in scope, and a
 * future user-visible string with the same word cannot hide behind one:
 *
 *   - JSX text, and a `{ }` child's literals (through conditionals and
 *     `&&` / `||` / `??`, so `{ok ? "a" : "b"}` is read like text);
 *   - the value of a JSX attribute a person sees (`title`, `aria-label`,
 *     `placeholder`, ...) - the attribute NAME is not scanned, so
 *     `placeholder="Search"` is fine;
 *   - the value of an object property a UI reads out (`label`, `title`,
 *     `description`, `message`, `text`, ...);
 *   - the first argument of a `toast`, `toast.<kind>` call.
 *
 * `keywords` (search vocabulary, never displayed), `id` and every call to
 * `.request(...)` are not display positions, so they are not scanned.
 *
 * The allowlist below is by file AND exact string, and each entry names the
 * ledger row that closed it by verification. An entry nothing matches fails the
 * suite, so the list cannot outlive the string it excuses.
 */
const GUI_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_SRC = path.join(GUI_SRC, "..", "..", "desktop", "src");

const EXCLUDED_WORDS = /\b(?:environments?|bindings?|placeholders?)\b/i;

const DISPLAY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "title",
  "aria-label",
  "aria-description",
  "alt",
  "placeholder",
  "label",
  "description",
  "tooltip",
  "helperText",
  "emptyText",
  "emptyLabel",
  "content",
]);

const DISPLAY_PROPERTIES: ReadonlySet<string> = new Set([
  "label",
  "title",
  "description",
  "message",
  "text",
  "summary",
  "hint",
  "caption",
  "tooltip",
  "heading",
  "body",
  "helperText",
  "emptyText",
  "emptyLabel",
  "ariaLabel",
  "placeholder",
]);

interface Allowed {
  readonly file: string;
  readonly text: string;
  /** The ledger row that closed it by verification. */
  readonly closedBy: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    file: "gui-app/src/lib/settings-sections.ts",
    text: "Environment",
    closedBy:
      "the environments redesign names the Settings sidebar group Environment",
  },
  // The build without environments (`unreleased-features.ts`) restores the
  // words the glossary pass replaced, because that build is the release
  // before the pass. Each string below is the pre-glossary one, reachable
  // only through that build's arm of its gate; the shipped arm beside it
  // carries the glossary's own word.
  {
    file: "gui-app/src/components/settings/panels/permissions/rules-tab.tsx",
    text: "Environment",
    closedBy: "the build without environments names the Rules section as 1.5.1",
  },
  {
    file: "gui-app/src/components/settings/panels/providers-settings.definitions.ts",
    text: "Environment variables",
    closedBy:
      "the build without environments searches the Providers group as 1.5.1",
  },
  {
    file: "gui-app/src/components/settings/panels/providers-settings.definitions.ts",
    text: "Per-provider environment overrides.",
    closedBy:
      "the build without environments searches the Providers group as 1.5.1",
  },
  {
    file: "gui-app/src/components/settings/panels/provider-env-overrides-section.tsx",
    text: "Environment variables",
    closedBy: "the build without environments titles the section as 1.5.1",
  },
  {
    file: "gui-app/src/components/settings/panels/provider-api-key-section.tsx",
    text: "Using   from your shell environment. Save a key here to override it.",
    closedBy: "the build without environments says shell environment as 1.5.1",
  },
  {
    file: "gui-app/src/components/settings/panels/shell-settings-panel.tsx",
    text: "Host environment",
    closedBy: "the build without environments labels the save status as 1.5.1",
  },
  {
    file: "gui-app/src/components/settings/panels/shell-settings.definitions.ts",
    text: "Host environment · After restart",
    closedBy: "the build without environments labels the group as 1.5.1",
  },
];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(name)) continue;
    if (/\.(?:test|spec|gen|d)\.tsx?$/.test(name)) continue;
    if (/(?:test-support|-fixture|\.stories)\.tsx?$/.test(name)) continue;
    out.push(full);
  }
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((s) => s.literal.text),
    ].join(" ");
  }
  return null;
}

/**
 * The texts a display position's value can show: a literal, or the literals
 * reachable through `{ }`, parentheses, a conditional's branches and the
 * operands of `&&`, `||` and `??`. A call, a property access or an identifier
 * contributes nothing - what it yields is not written here.
 */
function textsOf(node: ts.Node | undefined): readonly string[] {
  if (node === undefined) return [];
  if (ts.isJsxExpression(node)) return textsOf(node.expression);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return textsOf(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [...textsOf(node.whenTrue), ...textsOf(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [...textsOf(node.left), ...textsOf(node.right)];
    }
    return [];
  }
  const literal = literalText(node);
  return literal === null ? [] : [literal];
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function isToastCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "toast";
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "toast"
  );
}

export function displayStringsOf(
  fileName: string,
  source: string,
): readonly { readonly line: number; readonly text: string }[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, texts: readonly string[]): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    for (const text of texts) found.push({ line, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text !== "") add(node, [text]);
    } else if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name)
        ? node.name.text
        : node.name.name.text;
      if (DISPLAY_ATTRIBUTES.has(name)) add(node, textsOf(node.initializer));
    } else if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      // A child expression: `{cond ? "a" : "b"}` is read exactly like text.
      add(node, textsOf(node.expression));
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== null && DISPLAY_PROPERTIES.has(name)) {
        add(node, textsOf(node.initializer));
      }
    } else if (ts.isCallExpression(node) && isToastCallee(node.expression)) {
      add(node, textsOf(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function scanTree(root: string, label: string): readonly Hit[] {
  const files: string[] = [];
  walk(root, files);
  const hits: Hit[] = [];
  for (const full of files) {
    const rel = `${label}/${path.relative(root, full).split(path.sep).join("/")}`;
    for (const found of displayStringsOf(full, readFileSync(full, "utf8"))) {
      if (EXCLUDED_WORDS.test(found.text)) {
        hits.push({ file: rel, line: found.line, text: found.text });
      }
    }
  }
  return hits;
}

function unexcused(hits: readonly Hit[]): readonly Hit[] {
  return hits.filter(
    (hit) =>
      !ALLOWED.some(
        (entry) => entry.file === hit.file && entry.text === hit.text,
      ),
  );
}

describe("the desktop's display strings and the excluded words", () => {
  const hits = [
    ...scanTree(GUI_SRC, "gui-app/src"),
    ...scanTree(DESKTOP_SRC, "desktop/src"),
  ];

  it("carry none of environment, binding or placeholder", () => {
    expect(
      unexcused(hits).map((hit) => `${hit.file}:${hit.line} ${hit.text}`),
    ).toEqual([]);
  });

  it("has no allowlist entry that nothing matches any more", () => {
    const stale = ALLOWED.filter(
      (entry) =>
        !hits.some((hit) => hit.file === entry.file && hit.text === entry.text),
    );
    expect(stale).toEqual([]);
  });

  it("scans the display positions it claims to (the scanner is not vacuous)", () => {
    const found = displayStringsOf(
      "probe.tsx",
      [
        "const a = <p>Your environment</p>;",
        'const b = <input placeholder="a binding" aria-label="env binding" />;',
        'const c = { label: "binding", keywords: ["environment"], id: "environment" };',
        'toast.info("the environment moved");',
        'client.request("environment.status", {});',
        'const d = <input placeholder="Search" />;',
        'const e = <p>{shown ? `a shell environment` : "ok"}</p>;',
        'const f = <p>{list.map((x) => "environment")}</p>;',
      ].join("\n"),
    ).map((f) => f.text);
    expect(found).toEqual(
      expect.arrayContaining([
        "Your environment",
        "a binding",
        "env binding",
        "binding",
        "the environment moved",
        "Search",
        "a shell environment",
      ]),
    );
    expect(found).not.toContain("environment");
    expect(found).not.toContain("environment.status");
    // a call's arguments are not written at the position: not read
    expect(found.filter((t) => t === "environment")).toEqual([]);
  });

  it("matches the words as words, not as parts of other words", () => {
    expect(EXCLUDED_WORDS.test("Your environment")).toBe(true);
    expect(EXCLUDED_WORDS.test("key bindings")).toBe(true);
    expect(EXCLUDED_WORDS.test("Keybinding")).toBe(false);
    expect(EXCLUDED_WORDS.test("Placeholders")).toBe(true);
  });
});
