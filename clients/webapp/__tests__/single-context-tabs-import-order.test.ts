import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The one thing about `single-context-tabs` that no runtime test can observe.
 *
 * Its correctness is its POSITION: the tab store reads persisted layout while
 * its own module evaluates, and modules evaluate in import order, so this
 * statement only lands in time while it stays ahead of everything that reaches
 * the shared renderer. Move it down and nothing throws, nothing logs, and
 * every other test still passes - a freshly opened tab just quietly inherits
 * another tab's surface again.
 *
 * So the source text is the subject here, deliberately. An import reorder by a
 * formatter, a refactor, or an editor's organise-imports is exactly the kind of
 * change that would otherwise ship unnoticed.
 */
const ENTRY = join(import.meta.dirname, "..", "src", "main.tsx");

function importedSpecifiersInOrder(source: string): string[] {
  return Array.from(source.matchAll(/^import\s[^;]*?["']([^"']+)["'];$/gm)).map(
    (match) => match[1],
  );
}

describe("web shell entry import order", () => {
  it("states the single-context tab policy before anything else", () => {
    const specifiers = importedSpecifiersInOrder(readFileSync(ENTRY, "utf8"));

    // Sanity: the parse found the entry's imports at all, so a regex that
    // silently matched nothing cannot pass as "it is first".
    expect(specifiers.length).toBeGreaterThan(3);
    expect(specifiers[0]).toBe("./single-context-tabs");
  });
});
