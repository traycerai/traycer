import { beforeEach, describe, expect, it } from "vitest";
import {
  PR_PANEL_PERSIST_KEY,
  usePrPanelStore,
  type PrStateFilter,
} from "../pr-panel-store";

function readPersisted(): unknown {
  const raw = window.localStorage.getItem(PR_PANEL_PERSIST_KEY);
  if (raw === null) return undefined;
  return JSON.parse(raw);
}

async function rehydrateFrom(state: unknown, version: number): Promise<void> {
  window.localStorage.setItem(
    PR_PANEL_PERSIST_KEY,
    JSON.stringify({ state, version }),
  );
  await usePrPanelStore.persist.rehydrate();
}

describe("pr-panel-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePrPanelStore.setState({ stateFilter: "open" });
  });

  it("starts with open pull requests listed", () => {
    // The initial state, not the `beforeEach` reset.
    expect(usePrPanelStore.getInitialState().stateFilter).toBe("open");
  });

  it("persists the chosen filter under its own key", () => {
    expect(PR_PANEL_PERSIST_KEY).toBe("traycer-gui-app:pr-panel");
    usePrPanelStore.getState().setStateFilter("merged");

    expect(usePrPanelStore.getState().stateFilter).toBe("merged");
    expect(readPersisted()).toEqual({
      state: { stateFilter: "merged" },
      version: 2,
    });
  });

  it("does not replace state when set to the value it already holds", () => {
    const before = usePrPanelStore.getState();
    usePrPanelStore.getState().setStateFilter("open");
    expect(usePrPanelStore.getState()).toBe(before);
  });

  it("restores a persisted filter on rehydrate", async () => {
    await rehydrateFrom({ stateFilter: "closed" }, 2);

    expect(usePrPanelStore.getState().stateFilter).toBe("closed");
  });

  it("coerces a corrupt current-version blob to the default on rehydrate", async () => {
    usePrPanelStore.setState({ stateFilter: "all" });
    await rehydrateFrom({ stateFilter: "draft" }, 2);

    expect(usePrPanelStore.getState().stateFilter).toBe("open");
  });

  describe("migration from the v1 openOnly flag", () => {
    it.each<[string, unknown, PrStateFilter]>([
      ["openOnly on lists open rows", { openOnly: true }, "open"],
      ["openOnly off lists every row", { openOnly: false }, "all"],
      ["a non-boolean openOnly takes the default", { openOnly: "yes" }, "open"],
      ["a non-object blob takes the default", "garbage", "open"],
    ])("%s", async (_name, persisted, expected) => {
      usePrPanelStore.setState({ stateFilter: "merged" });
      await rehydrateFrom(persisted, 1);

      expect(usePrPanelStore.getState().stateFilter).toBe(expected);
      // Written back at the current version, so the next load skips this.
      expect(readPersisted()).toEqual({
        state: { stateFilter: expected },
        version: 2,
      });
    });
  });
});
