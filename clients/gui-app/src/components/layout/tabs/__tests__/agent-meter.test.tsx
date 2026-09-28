import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import {
  SideTabMeter,
  type SideTabLiveAgents,
} from "../side-strip/agent-meter";
import {
  NO_LIVE_AGENTS,
  useSideTabLiveAgents,
} from "../side-strip/side-tab-live-agents";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
  __setHostAgentActivityHealthForTests,
  TEST_LOCAL_ACTIVITY_HOST_ID,
} from "@/stores/agent-activity-store";

// `useSideTabLiveAgents` reads `useAccountActivityCoverage`, which asks the
// host directory (via `useHostBinding()`) for the account's known hosts. This
// suite has no `HostRuntimeProvider`, so the binding is `null` - an unsettled
// fleet - throughout.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
}));

afterEach(() => {
  cleanup();
  useThemeLibraryStore.setState({ panelAnimations: true });
  __resetAgentActivityStoreForTests();
});

function agents(
  turn: number,
  background: number,
  coverage: AgentActivityCoverage,
): SideTabLiveAgents {
  return { turn, background, coverage };
}

function meter(): HTMLElement {
  return screen.getByTestId("side-tab-meter");
}

function pipKinds(root: HTMLElement): ReadonlyArray<string | undefined> {
  return Array.from(root.querySelectorAll("[data-pip]")).map(
    (el) => (el as HTMLElement).dataset.pip,
  );
}

describe("SideTabMeter", () => {
  it("draws no pips and no accessible name for an empty task", () => {
    render(
      <SideTabMeter agents={NO_LIVE_AGENTS} attention={null} size="tile" />,
    );
    const root = meter();
    expect(root.querySelectorAll("[data-pip]")).toHaveLength(0);
    expect(root.getAttribute("role")).toBeNull();
    expect(root.getAttribute("aria-label")).toBeNull();
    expect(screen.queryByTestId("side-tab-meter-more")).toBeNull();
  });

  it("draws one breathing pip for a single running agent", () => {
    render(
      <SideTabMeter
        agents={agents(1, 0, "covered")}
        attention={null}
        size="tile"
      />,
    );
    const root = meter();
    expect(pipKinds(root)).toEqual(["turn"]);
    const pip = root.querySelector("[data-pip]");
    expect(pip?.getAttribute("data-breathing")).toBe("true");
    expect(root.getAttribute("role")).toBe("img");
  });

  it("draws all four pips at exactly the cap, with no +N", () => {
    render(
      <SideTabMeter
        agents={agents(4, 0, "covered")}
        attention={null}
        size="tile"
      />,
    );
    const root = meter();
    expect(pipKinds(root)).toEqual(["turn", "turn", "turn", "turn"]);
    expect(screen.queryByTestId("side-tab-meter-more")).toBeNull();
  });

  it("caps at four pips and folds the rest into +N", () => {
    render(
      <SideTabMeter
        agents={agents(6, 0, "covered")}
        attention={null}
        size="tile"
      />,
    );
    const root = meter();
    expect(pipKinds(root)).toEqual(["turn", "turn", "turn", "turn"]);
    expect(screen.getByTestId("side-tab-meter-more").textContent).toBe("+2");
  });

  it("orders turn pips before background pips", () => {
    render(
      <SideTabMeter
        agents={agents(2, 2, "covered")}
        attention={null}
        size="tile"
      />,
    );
    expect(pipKinds(meter())).toEqual([
      "turn",
      "turn",
      "background",
      "background",
    ]);
  });

  it("places the attention pip after the agent pips and is never itself cut", () => {
    render(
      <SideTabMeter
        agents={agents(2, 1, "covered")}
        attention="approval"
        size="tile"
      />,
    );
    const root = meter();
    expect(pipKinds(root)).toEqual(["turn", "turn", "background", "waiting"]);
    expect(screen.queryByTestId("side-tab-meter-more")).toBeNull();
  });

  it("keeps the attention pip when agents are capped: 6 agents + waiting -> 3 agent pips, waiting, +3", () => {
    render(
      <SideTabMeter
        agents={agents(6, 0, "covered")}
        attention="approval"
        size="tile"
      />,
    );
    const root = meter();
    expect(pipKinds(root)).toEqual(["turn", "turn", "turn", "waiting"]);
    expect(screen.getByTestId("side-tab-meter-more").textContent).toBe("+3");
  });

  it.each([
    ["approval", "waiting"],
    ["reply", "waiting"],
    ["failed", "failed"],
    ["unread", "unread"],
  ] as const)("maps the %s badge to the %s pip colour", (badge, pip) => {
    render(
      <SideTabMeter agents={NO_LIVE_AGENTS} attention={badge} size="tile" />,
    );
    expect(pipKinds(meter())).toEqual([pip]);
  });

  it("breathes turn pips only while motion is enabled", () => {
    useThemeLibraryStore.getState().setAppearancePreference({
      panelAnimations: false,
    });
    render(
      <SideTabMeter
        agents={agents(2, 1, "covered")}
        attention={null}
        size="tile"
      />,
    );
    const pips = Array.from(meter().querySelectorAll("[data-pip]"));
    for (const pip of pips) {
      expect((pip as HTMLElement).dataset.breathing).toBeUndefined();
    }
  });

  it("never marks a background or attention pip as breathing", () => {
    render(
      <SideTabMeter
        agents={agents(1, 1, "covered")}
        attention="failed"
        size="tile"
      />,
    );
    const pips = Array.from(meter().querySelectorAll("[data-pip]"));
    const byKind = new Map(
      pips.map((pip) => [
        (pip as HTMLElement).dataset.pip,
        (pip as HTMLElement).dataset.breathing,
      ]),
    );
    expect(byKind.get("turn")).toBe("true");
    expect(byKind.get("background")).toBeUndefined();
    expect(byKind.get("failed")).toBeUndefined();
  });
});

describe("SideTabMeter accessible label", () => {
  it("joins running, background and attention parts", () => {
    render(
      <SideTabMeter
        agents={agents(2, 1, "covered")}
        attention="approval"
        size="tile"
      />,
    );
    expect(meter().getAttribute("aria-label")).toBe(
      "2 running, 1 background, waiting for your approval",
    );
  });

  it("names a reply wait distinctly from an approval wait", () => {
    render(
      <SideTabMeter agents={NO_LIVE_AGENTS} attention="reply" size="tile" />,
    );
    expect(meter().getAttribute("aria-label")).toBe("waiting for your reply");
  });

  it("omits a zero tier", () => {
    render(
      <SideTabMeter
        agents={agents(3, 0, "covered")}
        attention={null}
        size="tile"
      />,
    );
    expect(meter().getAttribute("aria-label")).toBe("3 running");
    cleanup();

    render(
      <SideTabMeter
        agents={agents(0, 2, "covered")}
        attention={null}
        size="tile"
      />,
    );
    expect(meter().getAttribute("aria-label")).toBe("2 background");
  });
});

// `size` only picks class tables in `agent-meter.tsx`; the floor logic below
// is the same for both, so one size carries it.
describe("SideTabMeter floor (F8 round 3: R1-A1, the meter carries coverage)", () => {
  it("draws the floor marker under unserved but not under covered, same counts", () => {
    render(
      <SideTabMeter
        agents={agents(2, 1, "covered")}
        attention={null}
        size="tile"
      />,
    );
    expect(screen.queryByTestId("side-tab-meter-floor")).toBeNull();
    cleanup();

    render(
      <SideTabMeter
        agents={agents(2, 1, "unserved")}
        attention={null}
        size="tile"
      />,
    );
    expect(screen.getByTestId("side-tab-meter-floor")).not.toBeNull();
  });

  it("appends '+' to the label under unserved and not under covered, same counts", () => {
    render(
      <SideTabMeter
        agents={agents(2, 1, "covered")}
        attention={null}
        size="tile"
      />,
    );
    expect(meter().getAttribute("aria-label")).toBe("2 running, 1 background");
    cleanup();

    render(
      <SideTabMeter
        agents={agents(2, 1, "unserved")}
        attention={null}
        size="tile"
      />,
    );
    expect(meter().getAttribute("aria-label")).toBe(
      "2+ running, 1+ background",
    );
  });

  it("treats indeterminate coverage like covered - no floor marker, plain label", () => {
    render(
      <SideTabMeter
        agents={agents(2, 1, "indeterminate")}
        attention={null}
        size="tile"
      />,
    );
    expect(screen.queryByTestId("side-tab-meter-floor")).toBeNull();
    expect(meter().getAttribute("aria-label")).toBe("2 running, 1 background");
  });

  it("draws no floor marker under unserved coverage with zero agents", () => {
    render(
      <SideTabMeter
        agents={agents(0, 0, "unserved")}
        attention={null}
        size="tile"
      />,
    );
    expect(screen.queryByTestId("side-tab-meter-floor")).toBeNull();
  });

  it("still draws and announces the attention pip under unserved coverage", () => {
    render(
      <SideTabMeter
        agents={agents(2, 1, "unserved")}
        attention="approval"
        size="tile"
      />,
    );
    const root = meter();
    expect(pipKinds(root)).toEqual(["turn", "turn", "background", "waiting"]);
    expect(root.getAttribute("aria-label")).toBe(
      "2+ running, 1+ background, waiting for your approval",
    );
  });
});

describe("useSideTabLiveAgents", () => {
  it("splits an epic's working set into turn and background counts", () => {
    __setAgentActivityStateForTests(
      {
        "epic-1": {
          working: ["a", "b", "c"],
          turn: ["a", "b"],
        },
      },
      "local",
      "connected",
    );
    const { result } = renderHook(() => useSideTabLiveAgents("epic-1"));
    // `useAccountActivityCoverage` reads the host directory through
    // `useHostBinding()`, which is `null` with no `HostRuntimeProvider`
    // ancestor (the default this bare `renderHook` gives it) - an unsettled
    // fleet, so `selectKnownHostsActivityCoverage` reads "indeterminate"
    // regardless of what this slice's own union says.
    expect(result.current).toEqual({
      turn: 2,
      background: 1,
      coverage: "indeterminate",
    });
  });

  it("is NO_LIVE_AGENTS (plus coverage) for a null or unknown epic", () => {
    const { result: nullEpic } = renderHook(() => useSideTabLiveAgents(null));
    expect(nullEpic.current).toEqual({
      ...NO_LIVE_AGENTS,
      coverage: "indeterminate",
    });

    const { result: unknown } = renderHook(() =>
      useSideTabLiveAgents("epic-unknown"),
    );
    expect(unknown.current).toEqual({
      ...NO_LIVE_AGENTS,
      coverage: "indeterminate",
    });
  });

  it("carries covered coverage through when the plane spans every host - the fleet shortcut needs no directory", () => {
    __setHostAgentActivityHealthForTests(TEST_LOCAL_ACTIVITY_HOST_ID, {
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "connected",
      stateFrameSeenThisEpoch: true,
    });
    const { result } = renderHook(() => useSideTabLiveAgents("epic-unknown"));
    expect(result.current).toEqual({
      turn: 0,
      background: 0,
      coverage: "covered",
    });
  });
});
