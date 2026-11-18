import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRegisteredEpicAgentActivityTiers } from "@/lib/epic-selectors";
import {
  publishAgentActivity,
  resetAgentActivity,
  type AgentActivityHostEntry,
} from "@/__tests__/agent-activity-harness";

const EPIC_ID = "epic-activity";
const OTHER_EPIC_ID = "epic-other";

type HostEntry = {
  readonly working: readonly string[];
  readonly turn: readonly string[];
};

function entriesFor(
  hosts: readonly HostEntry[],
): readonly AgentActivityHostEntry[] {
  return hosts.map((host, index) => ({
    hostId: `host-${index}`,
    byEpic: { [EPIC_ID]: host },
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
  resetAgentActivity();
});

describe("agent activity tiers", () => {
  it("splits turn from background in a host-served state", () => {
    const { result } = renderTiers([
      { working: ["turn", "background"], turn: ["turn"] },
    ]);
    expect(result.current.get("turn")).toBe("turn");
    expect(result.current.get("background")).toBe("background");
  });

  it("lets turn win when the same agent is contributed by two hosts", () => {
    const { result } = renderTiers([
      { working: ["shared"], turn: [] },
      { working: ["shared"], turn: ["shared"] },
    ]);
    expect(result.current.get("shared")).toBe("turn");
  });

  it("updates through the store subscription and clears idle state", () => {
    const { result } = renderTiers([{ working: ["agent"], turn: ["agent"] }]);
    act(() => {
      publish([{ working: ["agent"], turn: [] }]);
    });
    expect(result.current.get("agent")).toBe("background");
    act(() => {
      publishAgentActivity([]);
    });
    expect(result.current.size).toBe(0);
  });

  it("keeps unchanged epic and tier map identities stable", () => {
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
