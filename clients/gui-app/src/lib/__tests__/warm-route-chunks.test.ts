import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  "@/components/settings/settings-modal-content",
  "@/components/epics/history-modal-content",
];

interface FakeRouter {
  readonly subscribe: (eventType: "onRendered", fn: () => void) => () => void;
  readonly render: () => void;
  readonly listenerCount: () => number;
}

function fakeRouter(): FakeRouter {
  const listeners = new Set<() => void>();
  return {
    subscribe: (_eventType, fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    render: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

// Every warmed module is replaced by a stub that records its own evaluation,
// so the assertions see what `warmRouteChunks` actually imported rather than
// what a list claims it would.
const imported = new Set<string>();

// Fresh module instances per test: `warmRouteChunks` runs once per module
// lifetime, and `isMobileApp()` must be read from the instance it imports.
// `doMock` rather than hoisted `mock`: a hoisted factory's module is cached
// across `resetModules`, so it would record only the first test's import.
async function loadWarmer(mobileApp: boolean) {
  vi.resetModules();
  for (const specifier of DESKTOP_MODULES) {
    vi.doMock(specifier, () => {
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
    vi.stubGlobal("requestAnimationFrame", (run: () => void) =>
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
    const { warmRouteChunks } = await loadWarmer(false);
    const router = fakeRouter();

    warmRouteChunks(router);
    await vi.runAllTimersAsync();
    await settleImports();

    expect(router.listenerCount()).toBe(0);
    expect([...imported].toSorted()).toEqual([...DESKTOP_MODULES].toSorted());
  });

  it("warms only the epic surface in the mobile app, and only after the first render", async () => {
    const { warmRouteChunks } = await loadWarmer(true);
    const router = fakeRouter();

    warmRouteChunks(router);
    await vi.runAllTimersAsync();
    await settleImports();
    expect([...imported]).toEqual([]);

    router.render();
    await vi.runAllTimersAsync();
    await settleImports();

    expect([...imported].toSorted()).toEqual([...EPIC_MODULES].toSorted());
    expect(imported).not.toContain("@/components/settings/settings-surface");
    expect(imported).not.toContain(
      "@/components/settings/settings-modal-content",
    );
    expect(imported).not.toContain("@/components/epics/history-surface");
    expect(imported).not.toContain("@/components/epics/history-modal-content");
    // One warm-up per launch: later navigations render again and must not
    // re-arm anything.
    expect(router.listenerCount()).toBe(0);
  });
});
