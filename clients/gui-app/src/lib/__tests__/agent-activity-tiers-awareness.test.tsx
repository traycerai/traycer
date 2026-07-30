import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRegisteredEpicAgentActivityTiers } from "@/lib/epic-selectors";
import {
  publishAgentActivity,
  resetAgentActivityPresence,
  type AgentActivityHostEntry,
} from "@/__tests__/agent-activity-presence-harness";

const EPIC_ID = "epic-awareness";
const OTHER_EPIC_ID = "epic-other";

/**
 * One awareness entry per host on the per-user notification room, exactly as
 * the cloud merges them. Each entry independently decides whether it carries a
 * usable `turn` list, which is the whole point of these tests: mixed shapes are
 * the steady state, not a rollout window.
 *
 * The epic this suite asserts on is never opened in this window - no session,
 * no per-epic collaboration room - so every reading here comes from the global
 * source alone. That is the defect the per-user room exists to fix.
 */
type HostEntry = {
  readonly working: unknown;
  readonly turn: unknown;
};

function entriesFor(
  hosts: readonly HostEntry[],
): readonly AgentActivityHostEntry[] {
  return hosts.map((host, index) => ({
    hostId: `host-${index}`,
    byEpic: {
      [EPIC_ID]:
        host.turn === undefined
          ? { working: host.working }
          : { working: host.working, turn: host.turn },
    },
  }));
}

function publish(hosts: readonly HostEntry[]): void {
  publishAgentActivity(entriesFor(hosts));
}

function renderTiers(hosts: readonly HostEntry[]) {
  publish(hosts);
  return renderHook(() => useRegisteredEpicAgentActivityTiers(EPIC_ID));
}

afterEach(() => {
  resetAgentActivityPresence();
});

describe("agent activity tiers from notification-room presence", () => {
  it("resolves every working id to 'turn' for a host that omits the turn field", () => {
    // An unclassified host: no `turn` list at all. Its agents keep the
    // pre-existing conservative reading.
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
    // An unclassified host and a classifying host visible at the same time. The
    // unclassified one's agent must NOT be downgraded to background just
    // because another host publishes the field.
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

  it("ignores entries whose activity field is not an object", () => {
    publishAgentActivity([
      { hostId: "host-broken", byEpic: "not an object" },
      { hostId: "host-ok", byEpic: { [EPIC_ID]: { working: ["real"] } } },
    ]);
    const { result } = renderHook(() =>
      useRegisteredEpicAgentActivityTiers(EPIC_ID),
    );
    expect(result.current.get("real")).toBe("turn");
    expect(result.current.size).toBe(1);
  });

  it("ignores buckets whose working list is not an array", () => {
    const { result } = renderTiers([
      { working: { not: "an array" }, turn: ["x"] },
      { working: ["real"], turn: undefined },
    ]);
    expect(result.current.has("x")).toBe(false);
    expect(result.current.get("real")).toBe("turn");
  });

  it("skips only the malformed bucket, not the host's other epics", () => {
    // Rule 3 of the frozen shape: one bad bucket must not blank out the rest of
    // the SAME host's map.
    publishAgentActivity([
      {
        hostId: "host-mixed",
        byEpic: {
          [EPIC_ID]: "garbage",
          [OTHER_EPIC_ID]: { working: ["healthy"], turn: ["healthy"] },
        },
      },
    ]);
    const broken = renderHook(() =>
      useRegisteredEpicAgentActivityTiers(EPIC_ID),
    );
    const healthy = renderHook(() =>
      useRegisteredEpicAgentActivityTiers(OTHER_EPIC_ID),
    );
    expect(broken.result.current.size).toBe(0);
    expect(healthy.result.current.get("healthy")).toBe("turn");
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

  it("reads idle for an epic no host reports", () => {
    const { result } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    const other = renderHook(() =>
      useRegisteredEpicAgentActivityTiers(OTHER_EPIC_ID),
    );
    expect(result.current.size).toBe(1);
    expect(other.result.current.size).toBe(0);
  });

  it("re-renders with the new tier when presence changes", () => {
    // Drives the real subscription path: the hook must re-read on an inbound
    // awareness frame, not just on first render.
    const { result } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    expect(result.current.get("a")).toBe("turn");

    // The turn ends but a background task keeps the agent working.
    act(() => {
      publish([{ working: ["a"], turn: [] }]);
    });
    expect(result.current.get("a")).toBe("background");

    // The agent goes fully idle.
    act(() => {
      publish([{ working: [], turn: [] }]);
    });
    expect(result.current.has("a")).toBe(false);
  });

  it("clears an epic's tiers when the publishing host drops out", () => {
    // A host that dies or disconnects ages out of awareness; its spinners must
    // clear with no cleanup protocol.
    const { result } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    expect(result.current.get("a")).toBe("turn");
    act(() => {
      publishAgentActivity([]);
    });
    expect(result.current.size).toBe(0);
  });

  it("keeps the same Map ref when a change leaves tiers untouched", () => {
    // Ref stability is what lets a consumer bail the re-render; an unrelated
    // presence event must not churn every indicator.
    const { result } = renderTiers([{ working: ["a"], turn: ["a"] }]);
    const first = result.current;
    act(() => {
      publish([{ working: ["a"], turn: ["a"] }]);
    });
    expect(result.current).toBe(first);
  });

  it("keeps one epic's slice stable while another epic changes", () => {
    publishAgentActivity([
      {
        hostId: "host-0",
        byEpic: {
          [EPIC_ID]: { working: ["a"], turn: ["a"] },
          [OTHER_EPIC_ID]: { working: ["b"], turn: ["b"] },
        },
      },
    ]);
    const { result } = renderHook(() =>
      useRegisteredEpicAgentActivityTiers(EPIC_ID),
    );
    const first = result.current;
    act(() => {
      publishAgentActivity([
        {
          hostId: "host-0",
          byEpic: {
            [EPIC_ID]: { working: ["a"], turn: ["a"] },
            [OTHER_EPIC_ID]: { working: [], turn: [] },
          },
        },
      ]);
    });
    expect(result.current).toBe(first);
  });
});
