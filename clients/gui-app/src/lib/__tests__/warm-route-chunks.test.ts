import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeChunkWarmers } from "@/lib/warm-route-chunks";

const EPIC_MODULES = [
  "@/routes/epics-layout-route-components",
  "@/routes/epic-tab-route-components",
  "@/components/epic-tabs/epic-surface",
];

const DESKTOP_MODULES = [
  ...EPIC_MODULES,
  "@/routes/draft-route-components",
  "@/components/home-focus/home-focus-view",
  "@/components/home/landing-draft-surface",
  "@/providers/draft-surface-provider",
  "@/components/epics/history-surface",
  "@/components/settings/settings-surface",
  "@/components/bots/bot-tab-surface",
  "@/components/sample-workspace/sample-workspace-surface",
];

// Every warmed module is replaced by a stub that records its own evaluation,
// so the assertions see what `warmRouteChunks` actually imported rather than
// what a list claims it would.
const imported = new Set<string>();

// Fresh module instances per test: `warmRouteChunks` runs once per module
// lifetime, and `isMobileApp()` must be read from the instance it imports.
// `doMock` rather than hoisted `mock`: a hoisted factory's module is cached
// across `resetModules`, so it would record only the first test's import.
// A module in `missing` fails to load the way a chunk the renderer cannot
// read does: its dynamic import rejects.
async function loadWarmer(mobileApp: boolean, missing: ReadonlyArray<string>) {
  vi.resetModules();
  for (const specifier of DESKTOP_MODULES) {
    vi.doMock(specifier, () => {
      if (missing.includes(specifier)) {
        throw new TypeError(
          `Failed to fetch dynamically imported module: ${specifier}`,
        );
      }
      imported.add(specifier);
      return {};
    });
  }
  const mobile = await import("@/lib/mobile-app");
  mobile.setMobileApp(mobileApp);
  return import("@/lib/warm-route-chunks");
}

async function settleImports(): Promise<void> {
  await vi.dynamicImportSettled();
}

describe("warmRouteChunks", () => {
  beforeEach(() => {
    imported.clear();
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", (run: () => void) =>
      window.setTimeout(run, 0),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const mobile = await import("@/lib/mobile-app");
    mobile.setMobileApp(false);
  });

  it("warms every surface at idle on desktop, without waiting for a render", async () => {
    const { warmRouteChunks } = await loadWarmer(false, []);

    warmRouteChunks();
    await settleImports();
    expect([...imported]).toEqual([]);
    await vi.runAllTimersAsync();
    await settleImports();

    expect([...imported].toSorted()).toEqual([...DESKTOP_MODULES].toSorted());
  });

  it("warms only the epic surface at idle on the phone, before the first render", async () => {
    const { warmRouteChunks } = await loadWarmer(true, []);

    warmRouteChunks();
    await settleImports();
    expect([...imported]).toEqual([]);
    await vi.runAllTimersAsync();
    await settleImports();
    expect([...imported].toSorted()).toEqual([...EPIC_MODULES].toSorted());

    warmRouteChunks();
    await vi.runAllTimersAsync();
    await settleImports();

    expect([...imported].toSorted()).toEqual([...EPIC_MODULES].toSorted());
    expect(imported).not.toContain("@/components/settings/settings-surface");
    expect(imported).not.toContain("@/components/epics/history-surface");
  });

  it("warms only the epic list on the phone when a router was warmed before setMobileApp", async () => {
    // Mirrors boot: `router.tsx` builds and warms a module-level router
    // before the mobile entry calls `setMobileApp(true)`, and that router
    // never renders.
    const { warmRouteChunks } = await loadWarmer(false, []);
    const mobile = await import("@/lib/mobile-app");

    warmRouteChunks();
    mobile.setMobileApp(true);
    warmRouteChunks();

    await vi.runAllTimersAsync();
    await settleImports();
    // Even the never-rendered module-level router warms the phone list.
    expect([...imported].toSorted()).toEqual([...EPIC_MODULES].toSorted());

    warmRouteChunks();
    await vi.runAllTimersAsync();
    await settleImports();

    expect([...imported].toSorted()).toEqual([...EPIC_MODULES].toSorted());
  });

  it("leaves no unhandled rejection when a warmed chunk fails to load", async () => {
    const missing = [
      "@/components/home/landing-draft-surface",
      "@/components/epics/history-surface",
    ];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { warmRouteChunks } = await loadWarmer(false, missing);
      // The warmer's own logger instance: `loadWarmer` resets the module graph.
      const { appLogger } = await import("@/lib/logger");
      const warn = vi.spyOn(appLogger, "warn");

      warmRouteChunks();
      await vi.runAllTimersAsync();
      await settleImports();
      // Node reports an unhandled rejection only after the microtask queue
      // drains, so give it one real macrotask.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect([...imported].toSorted()).toEqual(
        DESKTOP_MODULES.filter(
          (module) => !missing.includes(module),
        ).toSorted(),
      );
      expect(
        warn.mock.calls.map(([message, fields]) => [message, fields.module]),
      ).toEqual(
        missing.map((module) => [
          "[warm-route-chunks] chunk warm-up failed",
          module,
        ]),
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("routeChunkWarmers", () => {
  it("pins the exact phone warmer list, in order", () => {
    expect(routeChunkWarmers(true).map((warmer) => warmer.module)).toEqual([
      "@/routes/epics-layout-route-components",
      "@/routes/epic-tab-route-components",
      "@/components/epic-tabs/epic-surface",
    ]);
  });

  it("pins the exact desktop warmer list, in order", () => {
    expect(routeChunkWarmers(false).map((warmer) => warmer.module)).toEqual([
      "@/routes/epics-layout-route-components",
      "@/routes/epic-tab-route-components",
      "@/components/epic-tabs/epic-surface",
      "@/routes/draft-route-components",
      "@/components/home-focus/home-focus-view",
      "@/components/home/landing-draft-surface",
      "@/providers/draft-surface-provider",
      "@/components/epics/history-surface",
      "@/components/settings/settings-surface",
      "@/components/bots/bot-tab-surface",
      "@/components/sample-workspace/sample-workspace-surface",
    ]);
  });
});
