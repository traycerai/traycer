/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Two selectors that make a style recalculation reach far past the element
 * that changed, kept out by reading the source text (jsdom cannot measure
 * style invalidation):
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
 * - `container-type: size` inside the transcript list or its rows makes every
 *   row's size a layout dependency of the container. The outer chat tile's
 *   container and the minimaps are outside this rule.
 */

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const BROAD_SUBJECT =
  /^(?:html|body|:root|\.wco)(?![\w-])|^\[data-layout-column\]/;
/** Files whose classes style the whole window; a `has` variant here is app-scope. */
const APP_SCOPE_TSX = [
  "components/layout/app-column-frame.tsx",
  "components/layout/app-shell.tsx",
  "routes/root-route-components.tsx",
];
const HAS_VARIANT = /(?<![\w-])(?:group-|peer-)?has-|\[&:has\(/;
const SIZE_CONTAINER = /\[container-type:size\]|container-type:\s*size\b/;

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

/** `line: compound` for every `:has()` that is unqualified or on a broad subject. */
function broadHasSelectors(css: string): string[] {
  // Blank comments in place so reported line numbers stay true.
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const found: string[] = [];
  for (const match of flat.matchAll(/:has\(/g)) {
    const before = flat.slice(0, match.index);
    const compound = /[^\s>+~,{}]*$/.exec(before)?.[0] ?? "";
    if (compound === "" || BROAD_SUBJECT.test(compound)) {
      found.push(`${before.split("\n").length}: ${compound}:has(`);
    }
  }
  return found;
}

describe("broad :has() selectors", () => {
  it("flags an unqualified :has() and a :has() on a document or app-column subject", () => {
    expect(
      broadHasSelectors(":has([data-a]) > [data-b] { x: y }"),
    ).toHaveLength(1);
    expect(broadHasSelectors(":root:has([data-a]) { x: y }")).toHaveLength(1);
    expect(
      broadHasSelectors(".wco:has([data-a]) [data-layout-column] { x: y }"),
    ).toHaveLength(1);
    expect(
      broadHasSelectors("[data-layout-column]:has([data-a]) { x: y }"),
    ).toHaveLength(1);
  });

  it("allows a :has() on a local component root, a :not(:has()) filter, and a commented mention", () => {
    expect(
      broadHasSelectors(
        ".group\\/tab:has(:focus-visible) .title { x: y }\n" +
          "#root:has(> [data-boot-ground]) { x: y }\n" +
          "[data-a] > :not(:has([data-b])) { x: y }\n" +
          "/* :root:has([data-a]) */",
      ),
    ).toEqual([]);
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

describe("container-type: size in the transcript", () => {
  it("matches size containers but not inline-size ones", () => {
    expect(SIZE_CONTAINER.test('className="[container-type:size]"')).toBe(true);
    expect(SIZE_CONTAINER.test("container-type: size;")).toBe(true);
    expect(
      SIZE_CONTAINER.test('className="[container-type:inline-size]"'),
    ).toBe(false);
  });

  it("is used nowhere under components/chat except the turn minimap", () => {
    const offences = sourceFiles(path.join(SRC_DIR, "components", "chat"), [
      ".tsx",
      ".ts",
      ".css",
    ])
      .filter((file) => !/minimap/.test(path.basename(file)))
      .filter((file) => SIZE_CONTAINER.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_DIR, file));
    expect(offences).toEqual([]);
  });
});
