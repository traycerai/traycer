import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const KINDS_DIR = resolve(__dirname, "../../stores/tabs/kinds");
const WARMER = resolve(__dirname, "../warm-route-chunks.ts");

/**
 * Every top-level surface is reached through `tabSurfaceDescriptor(kind).render()`,
 * which returns a `lazy()` component, so no static import chain reaches these
 * modules. If one is missing from `warmRouteChunks()`, the first open of that tab
 * kind pays a cold dynamic import behind `Suspense fallback={null}` - a blank pane
 * for as long as the chunk takes, which is a multi-second ESM transform waterfall
 * in dev. That regression shipped once already: the epic canvas graph moved out of
 * `epic-tab-route-components` (which was warmed) into `epic-surface` (which was
 * not), and nothing failed.
 */
function lazyImportSpecifiers(): ReadonlyArray<{
  readonly file: string;
  readonly specifier: string;
}> {
  return readdirSync(KINDS_DIR)
    .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
    .flatMap((file) => {
      const source = readFileSync(resolve(KINDS_DIR, file), "utf8");
      // Only `lazy(() => import("..."))` - a bare dynamic import elsewhere in
      // these modules is not a surface mount and needs no warming.
      const matches = source.matchAll(
        /lazy\(\s*\(\)\s*=>\s*\n?\s*import\(\s*"([^"]+)"/g,
      );
      return [...matches].map((match) => ({ file, specifier: match[1] }));
    });
}

describe("lazy surface modules are warmed at startup", () => {
  it("finds the lazy surface mounts to check", () => {
    // Guards the extraction itself: if the `lazy(() => import(...))` shape is
    // refactored, every assertion below would pass against an empty list.
    const specifiers = lazyImportSpecifiers();
    expect(specifiers.map((entry) => entry.specifier)).toEqual(
      expect.arrayContaining([
        "@/components/epic-tabs/epic-surface",
        "@/components/home/landing-draft-surface",
        "@/providers/draft-surface-provider",
        "@/components/epics/history-surface",
        "@/components/settings/settings-surface",
      ]),
    );
  });

  it("warms every lazily-mounted tab-kind surface module", () => {
    const warmer = readFileSync(WARMER, "utf8");
    const missing = lazyImportSpecifiers().filter(
      (entry) => !warmer.includes(`import("${entry.specifier}")`),
    );
    expect(missing).toEqual([]);
  });
});
