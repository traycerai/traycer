import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
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

function awarenessStates(
  entries: readonly HostEntry[],
): Map<number, Record<string, unknown>> {
  return new Map<number, Record<string, unknown>>(
    entries.map((entry, index) => [
      index,
      entry.turn === undefined
        ? { [AGENT_WORKING_AWARENESS_FIELD]: entry.working }
        : {
            [AGENT_WORKING_AWARENESS_FIELD]: entry.working,
            [AGENT_WORKING_TURN_AWARENESS_FIELD]: entry.turn,
          },
    ]),
  );
}

/**
 * A real emitter, not a no-op stub: `on`/`off` register listeners and
 * `publish` fires them, so a test can mutate awareness and assert the hook
 * re-subscribes, recomputes, and re-renders - covering the subscription wiring
 * and not just the first snapshot.
 */
function buildAwarenessEmitter(initial: readonly HostEntry[]) {
  const listeners = new Set<() => void>();
  let states = awarenessStates(initial);
  let onCalls = 0;
  let offCalls = 0;
  return {
    awareness: {
      getStates: () => states,
      on: (_event: string, listener: () => void) => {
        onCalls += 1;
        listeners.add(listener);
      },
      off: (_event: string, listener: () => void) => {
        offCalls += 1;
        listeners.delete(listener);
      },
    },
    publish: (next: readonly HostEntry[]) => {
      states = awarenessStates(next);
      for (const listener of listeners) listener();
    },
    subscribeBalance: () => ({ onCalls, offCalls }),
  };
}

function buildEpicHandle(awareness: unknown): OpenEpicStoreHandle {
  const state = { bindingVersion: 0 };
  const storeCallable = (_selector: unknown): unknown => state;
  const storeBase: unknown = Object.assign(storeCallable, {
    getState: () => state as never,
    subscribe: () => () => undefined,
  });
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
  const emitter = buildAwarenessEmitter(entries);
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
    buildEpicHandle(emitter.awareness),
  );
  return {
    ...renderHook(() => useRegisteredEpicAgentActivityTiers(EPIC_ID)),
    emitter,
  };
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

  it("re-renders with the new tier when awareness changes", () => {
    // Drives the real subscription path: the hook must re-read the snapshot on
    // an awareness "change" event, not just on first render.
    const { result, emitter } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    expect(result.current.get("a")).toBe("turn");

    // The turn ends but a background task keeps the agent working.
    act(() => {
      emitter.publish([{ working: ["a"], turn: [] }]);
    });
    expect(result.current.get("a")).toBe("background");

    // The agent goes fully idle.
    act(() => {
      emitter.publish([{ working: [], turn: [] }]);
    });
    expect(result.current.has("a")).toBe(false);
  });

  it("keeps the same Map ref when a change leaves tiers untouched", () => {
    // Ref stability is what lets useSyncExternalStore bail the re-render; an
    // unrelated awareness event must not churn every consumer.
    const { result, emitter } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    const first = result.current;
    act(() => {
      emitter.publish([{ working: ["a"], turn: ["a"] }]);
    });
    expect(result.current).toBe(first);
  });

  it("subscribes to awareness while mounted", () => {
    const { emitter } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    expect(emitter.subscribeBalance().onCalls).toBeGreaterThan(0);
  });
});
