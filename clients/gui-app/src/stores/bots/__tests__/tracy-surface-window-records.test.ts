import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import type { DesktopPerWindowSnapshot } from "@/lib/windows/types";
import { forgetClosedTracySurfaceWindows } from "@/stores/bots/tracy-surface-store";
import type { TabRef } from "@/stores/tabs/types";

/**
 * Each desktop window is its own renderer: it loads the stores afresh and
 * shares only localStorage with the others. A boot here is the same, a fresh
 * module graph over the shared storage, run through the window's real bind and
 * layout restore.
 */

const SURFACE_KEY = persistKey(STORE_KEYS.botTabs);

const SYSTEM_TABS = { history: null, settings: null };

const TRACY_REF: TabRef = { kind: "tracy", id: "tracy" };

function snapshotWithTracyTab(botId: string): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    revision: 1,
    tabStripLayout: {
      version: 2,
      items: [
        {
          kind: "tab",
          id: "tab:tracy:tracy",
          ref: { kind: "tracy", id: "tracy" },
        },
      ],
      activeItemId: "tab:tracy:tracy",
      systemTabs: SYSTEM_TABS,
    },
    activeRoute: `/bot/${botId}`,
  };
}

interface SurfaceRecord {
  readonly open: boolean;
  readonly hostId: string | null;
  readonly botId: string | null;
}

interface WindowBoot {
  readonly surface: SurfaceRecord;
  readonly refs: ReadonlyArray<TabRef>;
  readonly openSurface: (hostId: string, botId: string) => void;
  readonly closeSurface: () => void;
}

async function bootWindow(
  windowId: string,
  snapshot: DesktopPerWindowSnapshot,
): Promise<WindowBoot> {
  vi.resetModules();
  const surfaceModule = await import("@/stores/bots/tracy-surface-store");
  const persistence = await import("@/stores/tabs/desktop-tabs-persistence");
  const layout = await import("@/stores/tabs/layout");
  const tabs = await import("@/stores/tabs/store");
  const { useTracySurfaceStore } = surfaceModule;
  surfaceModule.bindTracySurfaceToWindow(windowId);
  persistence.hydrateDesktopTabs(snapshot, true, null);
  const { open, hostId, botId } = useTracySurfaceStore.getState();
  return {
    surface: { open, hostId, botId },
    refs: layout.flattenLayoutRefs(tabs.useTabsStore.getState()),
    openSurface: (nextHostId, nextBotId) => {
      useTracySurfaceStore.getState().openSurface(nextHostId);
      useTracySurfaceStore.getState().selectChannel(nextBotId);
    },
    closeSurface: () => useTracySurfaceStore.getState().closeSurface(),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("Tracy surface records per desktop window", () => {
  it("restores each window's own host and channel and keeps its Tracy tab", async () => {
    const firstA = await bootWindow("win-a", snapshotWithTracyTab("bot-x"));
    firstA.openSurface("host-1", "bot-x");
    const firstB = await bootWindow("win-b", snapshotWithTracyTab("bot-y"));
    firstB.openSurface("host-2", "bot-y");

    const restartedA = await bootWindow("win-a", snapshotWithTracyTab("bot-x"));
    const restartedB = await bootWindow("win-b", snapshotWithTracyTab("bot-y"));

    expect({
      a: { surface: restartedA.surface, refs: restartedA.refs },
      b: { surface: restartedB.surface, refs: restartedB.refs },
    }).toEqual({
      a: {
        surface: { open: true, hostId: "host-1", botId: "bot-x" },
        refs: [TRACY_REF],
      },
      b: {
        surface: { open: true, hostId: "host-2", botId: "bot-y" },
        refs: [TRACY_REF],
      },
    });
  });

  it("keeps another window's surface open when one window closes its own", async () => {
    const firstA = await bootWindow("win-a", snapshotWithTracyTab("bot-x"));
    firstA.openSurface("host-1", "bot-x");
    const firstB = await bootWindow("win-b", snapshotWithTracyTab("bot-y"));
    firstB.openSurface("host-2", "bot-y");
    const closingA = await bootWindow("win-a", snapshotWithTracyTab("bot-x"));
    closingA.closeSurface();

    const restartedA = await bootWindow("win-a", snapshotWithTracyTab("bot-x"));
    const restartedB = await bootWindow("win-b", snapshotWithTracyTab("bot-y"));

    expect({
      aOpen: restartedA.surface.open,
      aRefs: restartedA.refs,
      bOpen: restartedB.surface.open,
      bRefs: restartedB.refs,
    }).toEqual({ aOpen: false, aRefs: [], bOpen: true, bRefs: [TRACY_REF] });
  });

  describe("a record saved before windows had their own", () => {
    const GLOBAL_RECORDS: ReadonlyArray<readonly [string, string]> = [
      [
        "version 2",
        JSON.stringify({
          state: { open: true, hostId: "host-1", botId: "bot-x" },
          version: 2,
        }),
      ],
      [
        "version 1",
        JSON.stringify({
          state: {
            tabs: {
              "bot-x": {
                botId: "bot-x",
                hostId: "host-1",
                openedAt: 1,
                title: "Bot x",
              },
            },
            fixedBotId: null,
          },
          version: 1,
        }),
      ],
    ];

    it.each(GLOBAL_RECORDS)(
      "goes to the first window that binds and no other (%s)",
      async (_label, payload) => {
        window.localStorage.setItem(SURFACE_KEY, payload);

        const first = await bootWindow("win-a", snapshotWithTracyTab("bot-x"));
        const globalAfterFirst = window.localStorage.getItem(SURFACE_KEY);
        const second = await bootWindow("win-b", snapshotWithTracyTab("bot-x"));
        const restartedFirst = await bootWindow(
          "win-a",
          snapshotWithTracyTab("bot-x"),
        );

        expect({
          first: first.surface,
          globalAfterFirst,
          second: second.surface,
          secondRefs: second.refs,
          restartedFirst: restartedFirst.surface,
        }).toEqual({
          first: { open: true, hostId: "host-1", botId: "bot-x" },
          globalAfterFirst: null,
          second: { open: false, hostId: null, botId: null },
          secondRefs: [],
          restartedFirst: { open: true, hostId: "host-1", botId: "bot-x" },
        });
      },
    );
  });

  it("forgets the records of windows that are gone and nothing else", () => {
    const record = JSON.stringify({
      state: { open: true, hostId: "host-1", botId: "bot-x" },
      version: 2,
    });
    const otherStoreKey = persistKey(STORE_KEYS.settings);
    for (const key of [
      SURFACE_KEY,
      `${SURFACE_KEY}:win-live`,
      `${SURFACE_KEY}:win-closed`,
      `${SURFACE_KEY}:win-also-closed`,
      otherStoreKey,
    ]) {
      window.localStorage.setItem(key, record);
    }

    forgetClosedTracySurfaceWindows(new Set(["win-live"]));

    expect(
      Array.from({ length: window.localStorage.length }, (_, index) =>
        window.localStorage.key(index),
      ).sort(),
    ).toEqual([SURFACE_KEY, `${SURFACE_KEY}:win-live`, otherStoreKey].sort());
  });
});
