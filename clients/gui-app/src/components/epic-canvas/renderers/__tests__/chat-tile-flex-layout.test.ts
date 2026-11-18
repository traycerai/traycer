import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * H1 pin: the wrapper around `ChatSessionMessagesSurface` + the composer
 * overlay must be a flex CONTAINER (`flex flex-col`), not merely a flex ITEM
 * (`flex-1` alone). Without that, `ChatMessages`' `flex-1` root has no
 * definite containing block and the transcript can collapse to zero height
 * in real layout. jsdom has no flex layout engine and this repo does not
 * load Tailwind into computed styles, so a source-level class snapshot is
 * the practical regression guard.
 */
describe("chat-tile transcript flex container (H1)", () => {
  it("keeps the messages/composer wrapper a flex column container", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../chat-tile.tsx"), "utf8");

    // Assert the required tokens independently of their source ordering.
    expect(source).toMatch(
      /className="(?=[^"]*\brelative\b)(?=[^"]*\bflex(?![-\w]))(?=[^"]*\bmin-h-0\b)(?=[^"]*\bflex-1\b)(?=[^"]*\bflex-col\b)[^"]*"/,
    );
    // Pre-fix regression: was only a flex item, never a flex container.
    // Guard against silently reverting that exact broken string.
    expect(source).not.toMatch(
      /className="relative min-h-0 flex-1"(?!\s+flex)/,
    );
  });
});
