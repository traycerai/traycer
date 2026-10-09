import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tab registry has to be whole whichever module a graph loads first.
 *
 * `registry.ts` imports every kind, so a kind that imports anything reaching
 * back to the registry closes a cycle: loading that kind FIRST evaluates the
 * registry while the kind is still mid-evaluation, and `TAB_KINDS` is built
 * around a binding that does not exist yet (a TDZ in the browser, an
 * `undefined` entry here). The app's entry happens to load the registry first,
 * which is why the cycle was invisible until a browser fixture imported
 * `chat-dock-panel-row` (which reaches the registry through the sidebar tree)
 * ahead of everything else.
 *
 * Each case starts a fresh module graph, loads one kind first, then reads the
 * registry that graph built. Entering at a kind is what reddens every back
 * edge here; a far entry point such as `chat-dock-panel-row` stayed green
 * under vite-node even before the cut, so the browser fixture
 * (`composer-queue-dock.tsx`, which imports it first) covers that one.
 */
const FIRST_IMPORTS: ReadonlyArray<readonly [string, () => Promise<unknown>]> =
  [
    [
      "kinds/sample-workspace",
      () => import("@/stores/tabs/kinds/sample-workspace"),
    ],
    ["kinds/epic", () => import("@/stores/tabs/kinds/epic")],
    ["kinds/draft", () => import("@/stores/tabs/kinds/draft")],
    ["kinds/history", () => import("@/stores/tabs/kinds/history")],
    ["kinds/settings", () => import("@/stores/tabs/kinds/settings")],
    ["kinds/home", () => import("@/stores/tabs/kinds/home")],
  ];

describe("tab registry import order", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each(FIRST_IMPORTS)(
    "builds every kind when %s is imported first",
    async (_name, importFirst) => {
      await importFirst();
      const { TAB_KINDS } = await import("@/stores/tabs/registry");
      for (const [kind, module] of Object.entries(TAB_KINDS)) {
        expect(module, kind).toBeDefined();
        expect(module.kind).toBe(kind);
      }
    },
  );
});
