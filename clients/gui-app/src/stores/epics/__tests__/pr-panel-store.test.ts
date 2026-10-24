import { beforeEach, describe, expect, it } from "vitest";
import {
  migratePrPanelPersistedState,
  PR_PANEL_PERSIST_KEY,
  usePrPanelStore,
} from "../pr-panel-store";

function readPersistedOpenOnly(): unknown {
  const raw = window.localStorage.getItem(PR_PANEL_PERSIST_KEY);
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
    return undefined;
  }
  return parsed.state;
}

describe("pr-panel-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePrPanelStore.setState({ openOnly: false });
  });

  it("starts with every pull request shown", () => {
    // The initial state, not the `beforeEach` reset.
    expect(usePrPanelStore.getInitialState().openOnly).toBe(false);
  });

  it("sets and toggles the open-only filter", () => {
    usePrPanelStore.getState().setOpenOnly(true);
    expect(usePrPanelStore.getState().openOnly).toBe(true);

    usePrPanelStore.getState().toggleOpenOnly();
    expect(usePrPanelStore.getState().openOnly).toBe(false);

    usePrPanelStore.getState().toggleOpenOnly();
    expect(usePrPanelStore.getState().openOnly).toBe(true);
  });

  it("does not replace state when set to the value it already holds", () => {
    const before = usePrPanelStore.getState();
    usePrPanelStore.getState().setOpenOnly(false);
    expect(usePrPanelStore.getState()).toBe(before);
  });

  it("persists the filter under its own key", () => {
    expect(PR_PANEL_PERSIST_KEY).toBe("traycer-gui-app:pr-panel");
    usePrPanelStore.getState().setOpenOnly(true);

    expect(readPersistedOpenOnly()).toEqual({ openOnly: true });
  });

  it("restores a persisted filter on rehydrate", async () => {
    window.localStorage.setItem(
      PR_PANEL_PERSIST_KEY,
      JSON.stringify({ state: { openOnly: true }, version: 1 }),
    );
    await usePrPanelStore.persist.rehydrate();

    expect(usePrPanelStore.getState().openOnly).toBe(true);
  });

  it("coerces a corrupt persisted blob to the default on rehydrate", async () => {
    window.localStorage.setItem(
      PR_PANEL_PERSIST_KEY,
      JSON.stringify({ state: { openOnly: "yes" }, version: 1 }),
    );
    await usePrPanelStore.persist.rehydrate();

    expect(usePrPanelStore.getState().openOnly).toBe(false);
  });

  describe("migratePrPanelPersistedState", () => {
    it("tolerates a missing or non-object blob", () => {
      expect(migratePrPanelPersistedState(null)).toEqual({ openOnly: false });
      expect(migratePrPanelPersistedState(undefined)).toEqual({
        openOnly: false,
      });
      expect(migratePrPanelPersistedState("garbage")).toEqual({
        openOnly: false,
      });
    });

    it("rejects a non-boolean openOnly", () => {
      expect(migratePrPanelPersistedState({ openOnly: "yes" })).toEqual({
        openOnly: false,
      });
      expect(migratePrPanelPersistedState({})).toEqual({ openOnly: false });
    });

    it("keeps a boolean openOnly", () => {
      expect(migratePrPanelPersistedState({ openOnly: true })).toEqual({
        openOnly: true,
      });
      expect(migratePrPanelPersistedState({ openOnly: false })).toEqual({
        openOnly: false,
      });
    });
  });
});
