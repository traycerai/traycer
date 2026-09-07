/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Require `data-[selected=true]:`. cmdk sets `data-selected` on every item (including `"false"`), so a presence matcher would select every row. The registered `data-selected` variant is `:where()`-wrapped (zero specificity) and would lose silently. */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bare data-selected variant (plain/group-/peer-). Lookbehind skips the attribute write and data-[selected=true]:. */
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
