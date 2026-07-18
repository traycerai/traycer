import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  AGENT_WORKING_AWARENESS_FIELD,
  AGENT_WORKING_TURN_AWARENESS_FIELD,
} from "@traycer/protocol/host/epic/subscribe";
import { useRegisteredEpicAgentActivityTiers } from "@/lib/epic-selectors";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const EPIC_ID = "epic-awareness";

/**
 * One awareness entry per host, exactly as the cloud merges them. Each entry
 * independently decides whether it carries the turn field, which is the whole
 * point of these tests: mixed shapes are the steady state, not a rollout
 * window.
 */
type HostEntry = {
  readonly working: unknown;
  readonly turn: unknown;
};

function buildEpicHandle(entries: readonly HostEntry[]): OpenEpicStoreHandle {
  const state = { bindingVersion: 0 };
  const storeCallable = (_selector: unknown): unknown => state;
  const storeBase: unknown = Object.assign(storeCallable, {
    getState: () => state as never,
    subscribe: () => () => undefined,
  });
  const awareness = {
    getStates: () =>
      new Map<number, Record<string, unknown>>(
        entries.map((entry, index) => [
          index,
          entry.turn === undefined
            ? { [AGENT_WORKING_AWARENESS_FIELD]: entry.working }
            : {
                [AGENT_WORKING_AWARENESS_FIELD]: entry.working,
                [AGENT_WORKING_TURN_AWARENESS_FIELD]: entry.turn,
              },
        ]),
      ),
    on: () => undefined,
    off: () => undefined,
  };
  return {
    epicId: EPIC_ID,
    userId: null,
    doc: {} as never,
    awareness: awareness as never,
    store: storeBase as OpenEpicStoreHandle["store"],
    dispose: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => true,
  };
}

function renderTiers(entries: readonly HostEntry[]) {
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
    buildEpicHandle(entries),
  );
  return renderHook(() => useRegisteredEpicAgentActivityTiers(EPIC_ID));
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
});

describe("agent activity tiers from awareness", () => {
  it("resolves every working id to 'turn' for a host that omits the turn field", () => {
    // An older host: no `agentWorkingTurn` at all. Its agents are unclassified,
    // so they must keep the pre-existing conservative reading.
    const { result } = renderTiers([{ working: ["a", "b"], turn: undefined }]);
    expect(result.current.get("a")).toBe("turn");
    expect(result.current.get("b")).toBe("turn");
  });

  it("splits turn from background for a host that publishes the turn field", () => {
    const { result } = renderTiers([{ working: ["a", "b"], turn: ["a"] }]);
    expect(result.current.get("a")).toBe("turn");
    // Working but absent from the turn list => genuinely background-only.
    expect(result.current.get("b")).toBe("background");
  });

  it("treats an empty turn list as 'all background', not as absent", () => {
    const { result } = renderTiers([{ working: ["a"], turn: [] }]);
    expect(result.current.get("a")).toBe("background");
  });

  it("applies the absence rule per host, not globally", () => {
    // Old host and new host visible at the same time. The old host's agent
    // must NOT be downgraded to background just because another host
    // publishes the field.
    const { result } = renderTiers([
      { working: ["old"], turn: undefined },
      { working: ["new-turn", "new-bg"], turn: ["new-turn"] },
    ]);
    expect(result.current.get("old")).toBe("turn");
    expect(result.current.get("new-turn")).toBe("turn");
    expect(result.current.get("new-bg")).toBe("background");
  });

  it("lets 'turn' win when the same agent appears under two hosts", () => {
    const { result } = renderTiers([
      { working: ["shared"], turn: [] },
      { working: ["shared"], turn: ["shared"] },
    ]);
    expect(result.current.get("shared")).toBe("turn");
  });

  it("ignores entries whose agentWorking is not an array", () => {
    const { result } = renderTiers([
      { working: { not: "an array" }, turn: ["x"] },
      { working: ["real"], turn: undefined },
    ]);
    expect(result.current.has("x")).toBe(false);
    expect(result.current.get("real")).toBe("turn");
  });

  it("ignores a malformed turn field by falling back to 'turn'", () => {
    // Not an array => unreadable => treat as absent (conservative), rather
    // than dropping the agent or calling it background.
    const { result } = renderTiers([{ working: ["a"], turn: "nonsense" }]);
    expect(result.current.get("a")).toBe("turn");
  });

  it("filters non-string ids on both fields", () => {
    const { result } = renderTiers([
      { working: ["a", 7, null], turn: ["a", 9] },
    ]);
    expect(result.current.size).toBe(1);
    expect(result.current.get("a")).toBe("turn");
  });
});
