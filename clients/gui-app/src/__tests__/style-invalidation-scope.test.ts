/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Features,
  transform,
  type Selector,
  type SelectorComponent,
} from "lightningcss";
import { describe, expect, it } from "vitest";

/**
 * Selectors that make a style recalculation reach far past the element that
 * changed, kept out by reading the source (jsdom cannot measure style
 * invalidation):
 *
 * - an unqualified `:has()`, or one on html / body / :root / .wco / the app
 *   column, re-evaluates against nearly the whole document whenever any
 *   descendant changes. The state such a rule reads must be published on the
 *   element it styles instead (`data-app-title-band`, `data-inspector-dock`,
 *   `data-join-active`). A `:has()` on a local component root stays allowed.
 * - the same selector spelled as a Tailwind variant (`has-[...]`,
 *   `group-has-[...]`, `[&:has(...)]`) on the app-scope owners - the column
 *   frame, the shell and the root route components. `group-has-*` on a tab or
 *   row host is a local group and stays allowed everywhere else.
 *
 * The CSS check reads selectors through lightningcss, so nesting, `:is()` /
 * `:where()` / `:not()` wrappers and escaped identifiers are resolved for
 * us. Reported lines are those of the normalized (nesting-flattened) source,
 * not of the file. Not covered: `@custom-variant` preludes and selectors that
 * are only ever built inside a Tailwind class string outside the TSX owners.
 */

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Files whose classes style the whole window; a `has` variant here is app-scope. */
const APP_SCOPE_TSX = [
  "components/layout/app-column-frame.tsx",
  "components/layout/app-shell.tsx",
  "routes/root-route-components.tsx",
];
const HAS_VARIANT = /(?<![\w-])(?:group-|peer-)?has-|\[&:has\(/;

function sourceFiles(dir: string, extensions: ReadonlyArray<string>): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "node_modules"
        ? []
        : sourceFiles(full, extensions);
    }
    return extensions.some((extension) => name.endsWith(extension))
      ? [full]
      : [];
  });
}

interface Scope {
  readonly broad: boolean;
  readonly qualified: boolean;
}

/** The document or app-column scopes: html, body, :root, .wco, the column. */
function isBroad(component: SelectorComponent): boolean {
  switch (component.type) {
    case "type":
      return ["html", "body"].includes(component.name.toLowerCase());
    case "class":
      return component.name === "wco";
    case "attribute":
      return component.name === "data-layout-column";
    case "pseudo-class":
      return component.kind === "root";
    default:
      return false;
  }
}

/** A simple selector that narrows the subject to something local. */
function isQualifier(component: SelectorComponent): boolean {
  return (
    component.type === "class" ||
    component.type === "id" ||
    component.type === "attribute" ||
    component.type === "type" ||
    (component.type === "pseudo-class" && component.kind === "scope")
  );
}

function subjectOf(selector: Selector): SelectorComponent[] {
  return selector.slice(
    selector.findLastIndex((part) => part.type === "combinator") + 1,
  );
}

/** What one compound selects: broad if any alternative can be, qualified only if all are. */
function scopeOf(compound: SelectorComponent[]): Scope {
  let broad = false;
  let qualified = false;
  for (const part of compound) {
    if (isBroad(part)) {
      broad = true;
    } else if (
      part.type === "pseudo-class" &&
      (part.kind === "is" || part.kind === "where")
    ) {
      const alternatives = part.selectors.map((alt) => scopeOf(subjectOf(alt)));
      broad ||= alternatives.some((alt) => alt.broad);
      qualified ||= alternatives.every((alt) => alt.qualified);
    } else if (isQualifier(part)) {
      qualified = true;
    }
  }
  return { broad, qualified };
}

/**
 * Every `:has()` in `selector` whose compound is broad or unqualified. A
 * qualified compound to its left bounds it (`[a] > :not(:has(...))`), and
 * `:is` / `:where` / `:not` alternatives inherit the compound around them
 * (`body:not(:has(...))` is broad, `.card:not(:has(...))` is local). The
 * `:has()` argument is never read as a subject.
 */
function broadHasIn(selector: Selector, carried: Scope): string[] {
  const found: string[] = [];
  let ancestorQualified = carried.qualified;
  let compound: SelectorComponent[] = [];
  const flush = (): void => {
    const own = scopeOf(compound);
    const scope: Scope = {
      broad: carried.broad || own.broad,
      qualified: ancestorQualified || own.qualified,
    };
    for (const part of compound) {
      if (part.type !== "pseudo-class") continue;
      if (part.kind === "has") {
        if (scope.broad || !scope.qualified) {
          found.push(
            `${scope.broad ? "broad" : "unqualified"} :has() in ${JSON.stringify(selector)}`,
          );
        }
      } else if (
        part.kind === "is" ||
        part.kind === "where" ||
        part.kind === "not"
      ) {
        for (const alt of part.selectors) found.push(...broadHasIn(alt, scope));
      }
    }
    ancestorQualified = scope.qualified;
    compound = [];
  };
  for (const part of selector) {
    if (part.type === "combinator") flush();
    else compound.push(part);
  }
  flush();
  return found;
}

const AT_RULES = {
  utility: { prelude: "<custom-ident>", body: "style-block" },
  variant: { prelude: "<custom-ident>", body: "style-block" },
} as const;

/** `line: message` for every `:has()` that is unqualified or on a broad subject. */
function broadHasSelectors(css: string): string[] {
  // Flatten nesting first: the visitor then sees each rule's full selector.
  const flat = transform({
    filename: "scope.css",
    code: Buffer.from(css),
    include: Features.Nesting,
    customAtRules: AT_RULES,
  }).code;
  const found: string[] = [];
  transform({
    filename: "scope.css",
    code: flat,
    customAtRules: AT_RULES,
    visitor: {
      Rule: {
        style(rule) {
          for (const selector of rule.value.selectors) {
            for (const offence of broadHasIn(selector, {
              broad: false,
              qualified: false,
            })) {
              found.push(`${rule.value.loc.line + 1}: ${offence}`);
            }
          }
          return undefined;
        },
      },
    },
  });
  return found;
}

describe("broad :has() selectors", () => {
  it.each([
    ":has([data-a]) > [data-b]",
    ":root:has([data-a])",
    ".wco:has([data-a]) [data-layout-column]",
    "[data-layout-column]:has([data-a])",
    'body[data-label="wide column"]:has(.child)',
    // A `]` inside the quoted value, in each quote style and escaped.
    'body[data-label="wide] column"]:has(.child)',
    "body[data-label='wide] column']:has(.child)",
    'body[data-label="a\\"] b"]:has(.child)',
    // An escaped identifier is still body.
    "\\62 ody:has(.child)",
    "html :has(.child)",
    ".wco :has(.child)",
    // Wrapped subjects carry the compound around them.
    "body:not(:has(.child))",
    ":root:is(:has(.child))",
    ":is(html, body):has(.child)",
    ":where(.card, body):has(.child)",
    ".card:is(html):has(.child)",
    // Nested spellings.
    "body { &:has(.child) { x: y } }",
    "body { .card &:has(.child) { x: y } }",
    ".wco { & > [data-layout-column]:has(.child) { x: y } }",
  ])("flags %s", (selector) => {
    const css = selector.includes("{") ? selector : `${selector} { x: y }`;
    expect(broadHasSelectors(css)).toHaveLength(1);
  });

  it.each([
    ".group\\/tab:has(:focus-visible) .title",
    "#root:has(> [data-boot-ground])",
    "[data-a] > :not(:has([data-b]))",
    '.card[data-label="wide column"]:has(.child)',
    '.card[data-label="wide] column"]:has(.child)',
    ".card:not(:has(.child))",
    ".card:is(.a, .b):has(.child)",
    ":is(.a, .b):has(.child)",
    ".card:where(:has(.child))",
    "body .card:has(.child)",
    ".card { &:has(.child) { x: y } }",
    ".card { .row:has(.child) & { x: y } }",
    "/* :root:has([data-a]) */ .card { x: y }",
  ])("allows %s", (selector) => {
    const css = selector.includes("{") ? selector : `${selector} { x: y }`;
    expect(broadHasSelectors(css)).toEqual([]);
  });

  it("reads Tailwind utility bodies, where the subject is the element itself", () => {
    expect(broadHasSelectors("@utility a { &:has(.child) { x: y } }")).toEqual(
      [],
    );
    expect(
      broadHasSelectors("@utility a { body:has(.child) { x: y } }"),
    ).toHaveLength(1);
  });

  it("appears in no stylesheet under src", () => {
    const offences = sourceFiles(SRC_DIR, [".css"]).flatMap((file) =>
      broadHasSelectors(readFileSync(file, "utf8")).map(
        (offence) => `${path.relative(SRC_DIR, file)}:${offence}`,
      ),
    );
    expect(offences).toEqual([]);
  });
});

describe("has variants on the app-scope owners", () => {
  it("matches has-*, group-has-* and [&:has(...)] but not a local group class", () => {
    expect(HAS_VARIANT.test('className="group-has-[[data-a]]:p-2"')).toBe(true);
    expect(HAS_VARIANT.test('className="md:has-[[data-a]]:p-2"')).toBe(true);
    expect(HAS_VARIANT.test('className="[&:has([data-a])]:p-2"')).toBe(true);
    expect(HAS_VARIANT.test('className="group/tab flex has_not"')).toBe(false);
    expect(HAS_VARIANT.test("this.hasError = true")).toBe(false);
  });

  it("appears in none of the column frame, the shell or the root route components", () => {
    const offences = APP_SCOPE_TSX.filter((file) =>
      HAS_VARIANT.test(
        readFileSync(path.join(SRC_DIR, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      ),
    );
    expect(offences).toEqual([]);
  });
});
