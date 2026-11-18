/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `data-selected` is written in the arbitrary form, `data-[selected=true]:`.
 *
 * It matters because cmdk sets the attribute on every item it renders
 * (`"data-selected": !!selected`, which React stringifies to `"false"` rather
 * than omitting it), so a variant that matched by PRESENCE would style every
 * row in the list as selected at once - and would read as a theme rather than
 * as a bug, since the variant drives a row's fill, border, shadow and icon tint
 * together and there would be no unselected row to compare against.
 *
 * Both spellings do match by value. `shadcn/tailwind.css` registers
 * `@custom-variant data-selected { &:where([data-selected="true"]) { … } }`, so
 * the bare form is not the presence selector a bare `data-*` variant would
 * compile to unregistered. What the two forms do NOT share is specificity: the
 * registration is `:where()`-wrapped and contributes zero, while
 * `data-[selected=true]:` contributes a real attribute. A zero-specificity rule
 * holds only while nothing else states the same property, and loses silently
 * the moment something does - so this guard keeps the styling on the form that
 * can hold its own, and keeps the tree from depending on a registration living
 * in a dependency's stylesheet.
 *
 * Scoped to `data-selected` rather than banning bare `data-*` variants in
 * general: the other `data-*` attributes here are written as
 * `data-x={cond ? "true" : undefined}`, where presence and truth coincide.
 *
 * `components/ui/__tests__/command-selected-state.test.tsx` is the other half:
 * this file keeps the bare form out of the tree, that one checks the compiled
 * rules actually discriminate a selected row from an unselected one.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A Tailwind variant keyed on bare `data-selected`, in either the plain or the
 * `group-`/`peer-` scoped form. The negative lookbehind keeps this off the
 * attribute WRITE (`data-selected="true"`) and off the already-correct value
 * form (`data-[selected=true]:`), both of which contain the same letters.
 */
const BARE_VARIANT = /(?:group-|peer-)?data-selected(?:\/[a-z0-9-]+)?:/;

function collectSourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".tsx") || entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Prose explaining the rule is not markup - this file's own docstring included. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("{/*")
  );
}

describe("data-selected variants", () => {
  it("are matched by value, never by attribute presence", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (!BARE_VARIANT.test(line)) return;
        offenders.push(
          `${path.relative(SRC_DIR, file)}:${index + 1} - use data-[selected=true]: instead`,
        );
      });
    }
    expect(offenders).toEqual([]);
  });

  it("recognises the bare form it is meant to reject", () => {
    // Positive control: a guard whose matcher silently stopped matching would
    // report an empty offender list forever, which is indistinguishable from
    // a clean tree.
    expect(BARE_VARIANT.test('className="data-selected:bg-primary/12"')).toBe(
      true,
    );
    expect(
      BARE_VARIANT.test('className="group-data-selected/command-item:hidden"'),
    ).toBe(true);
    expect(BARE_VARIANT.test('data-selected="true"')).toBe(false);
    expect(
      BARE_VARIANT.test('data-selected={selected ? "true" : undefined}'),
    ).toBe(false);
    expect(
      BARE_VARIANT.test('className="data-[selected=true]:bg-primary/12"'),
    ).toBe(false);
    expect(
      BARE_VARIANT.test(
        'className="group-data-[selected=true]/command-item:hidden"',
      ),
    ).toBe(false);
  });
});
