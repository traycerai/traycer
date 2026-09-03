import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

const PERSIST_KEY = persistKey(STORE_KEYS.layout);

function resetStore(): void {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  window.localStorage.clear();
}

async function rehydrateFrom(state: unknown): Promise<void> {
  window.localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({ state, version: CURRENT_PERSIST_VERSION }),
  );
  await useLayoutStore.persist.rehydrate();
}

describe("useLayoutStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe("status bar slice", () => {
    it("starts with the usage controls in the header, everything visible", () => {
      expect(useLayoutStore.getState().statusBar).toEqual({
        placement: "header",
        rateLimits: {
          enabled: true,
          hiddenProviders: [],
          hiddenWindowKeys: [],
          percentMode: "used",
          showTimer: true,
          showBar: true,
        },
        resources: {
          enabled: true,
          metrics: ["cpu", "memory", "processes"],
          scope: "host-tree",
        },
      });
    });

    it("persists a placement move under the slice", async () => {
      useLayoutStore.getState().setStatusBarPlacement("status-bar");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: {
          statusBar: {
            ...DEFAULT_STATUS_BAR_LAYOUT,
            placement: "status-bar",
          },
        },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("rehydrates a fully valid slice verbatim", async () => {
      await rehydrateFrom({
        statusBar: {
          placement: "status-bar",
          rateLimits: {
            enabled: false,
            hiddenProviders: ["codex"],
            hiddenWindowKeys: ["claude-code:sevenDayOpus"],
            percentMode: "remaining",
            showTimer: false,
            showBar: false,
          },
          resources: {
            enabled: false,
            metrics: ["ramShare"],
            scope: "desktop-app",
          },
        },
      });

      expect(useLayoutStore.getState().statusBar).toEqual({
        placement: "status-bar",
        rateLimits: {
          enabled: false,
          hiddenProviders: ["codex"],
          hiddenWindowKeys: ["claude-code:sevenDayOpus"],
          percentMode: "remaining",
          showTimer: false,
          showBar: false,
        },
        resources: {
          enabled: false,
          metrics: ["ramShare"],
          scope: "desktop-app",
        },
      });
    });

    // Each field is re-derived independently, so one corrupt value must not
    // take its neighbours down with it.
    it("falls back per field when the slice is partially corrupt", async () => {
      await rehydrateFrom({
        statusBar: {
          placement: "footer",
          rateLimits: {
            enabled: "yes",
            hiddenProviders: "codex",
            hiddenWindowKeys: { 0: "codex:primary" },
            percentMode: "leftover",
            showTimer: 1,
            showBar: false,
          },
          resources: { enabled: null, metrics: "cpu", scope: "everything" },
        },
      });

      expect(useLayoutStore.getState().statusBar).toEqual({
        placement: "header",
        rateLimits: {
          enabled: true,
          hiddenProviders: [],
          hiddenWindowKeys: [],
          percentMode: "used",
          showTimer: true,
          showBar: false,
        },
        resources: {
          enabled: true,
          metrics: ["cpu", "memory", "processes"],
          scope: "host-tree",
        },
      });
    });

    it.each([
      ["the record is not an object", "layout"],
      ["the slice is missing", {}],
      ["the slice is not an object", { statusBar: 3 }],
    ])(
      "falls back to the whole default slice when %s",
      async (_label, state) => {
        await rehydrateFrom(state);

        expect(useLayoutStore.getState().statusBar).toEqual(
          DEFAULT_STATUS_BAR_LAYOUT,
        );
      },
    );

    it("keeps every setter reachable after rehydrating a corrupt record", async () => {
      await rehydrateFrom(42);

      useLayoutStore.getState().setStatusBarPlacement("status-bar");

      expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
    });

    it("drops a persisted provider id no build knows and dedupes the rest", async () => {
      await rehydrateFrom({
        statusBar: {
          rateLimits: {
            hiddenProviders: ["codex", "codex", "not-a-provider", "grok"],
          },
        },
      });

      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual(["codex", "grok"]);
    });

    it("dedupes persisted window keys and drops non-strings", async () => {
      await rehydrateFrom({
        statusBar: {
          rateLimits: {
            hiddenWindowKeys: [
              "codex:primary",
              "codex:primary",
              "",
              7,
              "grok:period",
            ],
          },
        },
      });

      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
      ).toEqual(["codex:primary", "grok:period"]);
    });

    it("returns a hidden provider to visible on the second toggle", () => {
      const { toggleStatusBarProvider } = useLayoutStore.getState();

      toggleStatusBarProvider("claude-code");
      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual(["claude-code"]);

      toggleStatusBarProvider("claude-code");
      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual([]);
    });

    it("returns a hidden window to visible on the second toggle", () => {
      const { toggleStatusBarWindow } = useLayoutStore.getState();

      toggleStatusBarWindow("claude-code:model:Fable");
      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
      ).toEqual(["claude-code:model:Fable"]);

      toggleStatusBarWindow("claude-code:model:Fable");
      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
      ).toEqual([]);
    });

    it("never lists a provider twice however often it is toggled", () => {
      const { toggleStatusBarProvider } = useLayoutStore.getState();

      toggleStatusBarProvider("codex");
      toggleStatusBarProvider("claude-code");
      toggleStatusBarProvider("codex");
      toggleStatusBarProvider("codex");

      expect(
        useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
      ).toEqual(["claude-code", "codex"]);
    });

    // The segment's reading order is the metric order, not the order the user
    // happened to switch things on in.
    it("holds metrics in display order regardless of toggle order", () => {
      const { toggleStatusBarResourceMetric } = useLayoutStore.getState();

      toggleStatusBarResourceMetric("cpu");
      toggleStatusBarResourceMetric("memory");
      toggleStatusBarResourceMetric("processes");
      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([]);

      toggleStatusBarResourceMetric("ramShare");
      toggleStatusBarResourceMetric("cpu");
      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([
        "cpu",
        "ramShare",
      ]);
    });

    it("re-orders and dedupes a persisted metric list, dropping unknown names", async () => {
      await rehydrateFrom({
        statusBar: {
          resources: {
            metrics: ["ramShare", "cpu", "cpu", "gpu", "processes"],
          },
        },
      });

      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([
        "cpu",
        "processes",
        "ramShare",
      ]);
    });

    // An empty selection is a real state (the segment shows nothing), unlike a
    // value that was never a list at all.
    it("keeps a persisted empty metric list instead of restoring the defaults", async () => {
      await rehydrateFrom({ statusBar: { resources: { metrics: [] } } });

      expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([]);
    });

    it("stores the display toggles a rendered window reads", () => {
      const store = useLayoutStore.getState();

      store.setStatusBarPercentMode("remaining");
      store.setStatusBarShowTimer(false);
      store.setStatusBarShowBar(false);
      store.setStatusBarRateLimitsEnabled(false);
      store.setStatusBarResourcesEnabled(false);
      store.setStatusBarResourceScope("desktop-app");

      const statusBar = useLayoutStore.getState().statusBar;
      expect(statusBar.rateLimits.percentMode).toBe("remaining");
      expect(statusBar.rateLimits.showTimer).toBe(false);
      expect(statusBar.rateLimits.showBar).toBe(false);
      expect(statusBar.rateLimits.enabled).toBe(false);
      expect(statusBar.resources.enabled).toBe(false);
      expect(statusBar.resources.scope).toBe("desktop-app");
    });

    it("leaves state untouched when a setter is handed the value already held", () => {
      const before = useLayoutStore.getState().statusBar;

      useLayoutStore.getState().setStatusBarPercentMode("used");

      expect(useLayoutStore.getState().statusBar).toBe(before);
    });
  });
});
