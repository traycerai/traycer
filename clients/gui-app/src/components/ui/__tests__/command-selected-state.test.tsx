/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { compile } from "tailwindcss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Command,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

/**
 * The selected-state utilities every cmdk row in the app relies on. All four
 * of a row's channels - fill, border, shadow and icon tint - are driven by
 * this one variant, which is why getting it wrong looked like a theme rather
 * than a bug.
 */
const SELECTED_UTILITIES = [
  "data-[selected=true]:bg-primary/12",
  "data-[selected=true]:border-primary/35",
  "data-[selected=true]:shadow-sm",
  "data-[selected=true]:text-foreground",
  "data-[selected=true]:*:[svg]:text-primary",
  "group-data-[selected=true]/command-item:text-foreground",
] as const;

/**
 * The selectors Tailwind ACTUALLY emits, rather than ones the test invents.
 * The whole defect this file guards was a mismatch between the class an author
 * wrote and the selector Tailwind produced from it, so reconstructing the
 * selector here would reproduce the blind spot instead of closing it.
 */
async function emittedSelectors(
  candidates: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const entry = createRequire(join(process.cwd(), "package.json")).resolve(
    "tailwindcss/index.css",
  );
  // The app's own palette tokens, declared inline rather than by compiling
  // `src/index.css` (which pulls in `@plugin` and a nested `@import`). Only the
  // SELECTORS matter here - a `bg-primary` that cannot resolve its color emits
  // no rule at all, which would read as "the variant does not apply" - so
  // stand-in values are sufficient and keep the fixture independent of a
  // palette edit.
  const source = [
    '@import "tailwindcss";',
    "@theme { --color-primary: #7c3aed; --color-foreground: #111111; }",
  ].join("\n");
  const compiler = await compile(source, {
    base: process.cwd(),
    loadStylesheet: async (id: string, base: string) => {
      // Called exactly once, for the `@import` above: 4.3.3's `index.css`
      // INLINES its theme/base/utilities layers rather than `@import`ing the
      // sibling `theme.css` / `preflight.css` / `utilities.css` of those names.
      // Refuse any other id by name - a version that splits the entry again
      // should fail here saying which import went unresolved, rather than
      // further down as "the utility compiled to nothing".
      if (id !== "tailwindcss") {
        throw new Error(`Unexpected stylesheet import ${id} from ${base}`);
      }
      return {
        path: entry,
        base: dirname(entry),
        content: await readFile(entry, "utf8"),
      };
    },
  });
  const css = compiler.build([...candidates]);
  // Tailwind emits ONE FLAT selector per candidate - the condition is appended
  // to the class itself (`.data-\[selected\=true\]\:bg-primary\/12[data-selected="true"]`,
  // `:is(.…[data-selected="true"] > *):is(svg)`), never a nested `&` rule - so
  // the line carrying the escaped class IS the whole discriminating selector.
  // The only nesting in the output is the `@supports (color: color-mix(…))`
  // fallback inside a declaration block, which is what the `@` filter drops.
  const rules = css
    .split("\n")
    .flatMap((line) => {
      const rule = /^\s*(\S.*?)\s*\{\s*$/.exec(line);
      return rule === null ? [] : [rule[1]];
    })
    .filter((rule) => !rule.startsWith("@"));
  const selectors = new Map<string, string>();
  for (const candidate of candidates) {
    const escaped = candidate.replace(
      /[^a-zA-Z0-9_-]/g,
      (character) => `\\${character}`,
    );
    const hit = rules.find((rule) => rule.includes(`.${escaped}`));
    if (hit !== undefined) selectors.set(candidate, hit);
  }
  return selectors;
}

function renderRows(): ReadonlyArray<Element> {
  const { container } = render(
    <Command>
      <CommandList>
        <CommandItem value="alpha">
          Alpha
          <CommandShortcut>A</CommandShortcut>
        </CommandItem>
        <CommandItem value="beta">
          Beta
          <CommandShortcut>B</CommandShortcut>
        </CommandItem>
      </CommandList>
    </Command>,
  );
  return [...container.querySelectorAll('[data-slot="command-item"]')];
}

describe("cmdk selected-state styling", () => {
  let emitted: ReadonlyMap<string, string> = new Map();

  beforeAll(async () => {
    emitted = await emittedSelectors(SELECTED_UTILITIES);
  });

  afterEach(cleanup);

  it("marks unselected rows with the attribute rather than omitting it", () => {
    // The premise of the whole file. cmdk renders `"data-selected": !!selected`
    // and React stringifies `false`, so the attribute is PRESENT on every row -
    // which is what makes a presence-matching selector useless here. If cmdk
    // ever starts omitting it, the bare form would become correct and this
    // guard should be revisited rather than worked around.
    const rows = renderRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-selected")).toBe("true");
    expect(rows[1].getAttribute("data-selected")).toBe("false");
    expect(rows[1].matches("[data-selected]")).toBe(true);
  });

  it("applies each selected-state rule to the selected row only", () => {
    const rows = renderRows();
    const [selected, unselected] = rows;
    for (const candidate of SELECTED_UTILITIES) {
      const selector = emitted.get(candidate);
      expect(selector, candidate).toBeTypeOf("string");
      // `:not(*)` never matches, so a candidate that compiled to nothing fails
      // here instead of silently reporting "does not apply" for both rows.
      const rule = selector ?? ":not(*)";
      const matchIn = (row: Element): boolean =>
        row.matches(rule) || row.querySelector(rule) !== null;
      expect(matchIn(selected), `selected / ${candidate}`).toBe(true);
      expect(matchIn(unselected), `unselected / ${candidate}`).toBe(false);
    }
  });
});
