/**
 * The build without bots (`unreleased-features.ts`) never opens a bot tab, so
 * it does not warm the bot tab surface at first idle; every other lazily
 * mounted surface is still warmed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { routeChunkWarmers } from "@/lib/warm-route-chunks";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const KINDS_DIR = resolve(__dirname, "../../stores/tabs/kinds");
const BOT_TAB_SURFACE = "@/components/bots/bot-tab-surface";

function lazyImportSpecifiers(): ReadonlyArray<string> {
  return readdirSync(KINDS_DIR)
    .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
    .flatMap((file) => {
      const source = readFileSync(resolve(KINDS_DIR, file), "utf8");
      const matches = source.matchAll(
        /lazy\(\s*\(\)\s*=>\s*\n?\s*import\(\s*"([^"]+)"/g,
      );
      return [...matches].map((match) => match[1]);
    });
}

describe("lazy surface modules without bots", () => {
  it("warms every lazily-mounted surface but the bot tab's", () => {
    const specifiers = lazyImportSpecifiers();
    expect(specifiers).toContain(BOT_TAB_SURFACE);
    const warmed = new Set(
      routeChunkWarmers(false).map((warmer) => warmer.module),
    );
    expect(warmed.has(BOT_TAB_SURFACE)).toBe(false);
    expect(
      specifiers.filter(
        (specifier) => specifier !== BOT_TAB_SURFACE && !warmed.has(specifier),
      ),
    ).toEqual([]);
  });
});
