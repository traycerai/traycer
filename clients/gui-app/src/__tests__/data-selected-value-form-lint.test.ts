/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `data-selected` must always be matched by VALUE, never by presence.
 *
 * cmdk sets the attribute on every item it renders (`"data-selected":
 * !!selected`, which React stringifies to `"false"` rather than omitting it),
 * while Tailwind compiles the shorter bare `data-selected:` variant to
 * `[data-selected]` - an attribute-PRESENCE selector. Every row in a cmdk list
 * therefore matched, and "selected" styling applied to all of them at once.
 *
 * It read as a theme rather than as a bug because the variant drives all four
 * of a row's channels together - fill, border, shadow and icon tint - so
 * nothing looked half-applied; there was simply no unselected state to compare
 * against. It shipped that way in the command palette, the worktree folder
 * list, the theme-preset picker and the prompt stash simultaneously.
 *
 * The other `data-*` attributes in this codebase are written as
 * `data-x={cond ? "true" : undefined}`, where presence and truth coincide and
 * the bare form is correct - so this guard is deliberately scoped to
 * `data-selected` rather than banning bare `data-*` variants in general.
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
