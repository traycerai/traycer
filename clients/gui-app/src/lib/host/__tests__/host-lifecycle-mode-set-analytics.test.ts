import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostLifecycleMode,
  HostLifecyclePolicyWriter,
  HostLifecycleView,
} from "@traycer-clients/shared/platform/runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { HostLifecycleModeSetAnalytics } from "@/lib/host/host-lifecycle-mode-set-analytics";

// The tracker's attribution rules, one window at a time. The cross-window
// behaviour (the leader lock, main's fan-out) is covered end to end in
// `components/layout/bridges/__tests__/host-lifecycle-mode-set-analytics.test.tsx`.

function view(
  mode: HostLifecycleMode,
  rev: number,
  updatedBy: HostLifecyclePolicyWriter | null,
): HostLifecycleView {
  return {
    desired: { mode, rev, updatedBy, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: "enforcing",
      admittedAs: null,
    },
    pending: "none",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spies on `track` and returns a reader of the mode-set payloads so far. */
function spyModeSets(): () => unknown[] {
  const trackSpy = vi
    .spyOn(Analytics.getInstance(), "track")
    .mockImplementation(() => true);
  return () =>
    trackSpy.mock.calls
      .filter((call) => call[0] === AnalyticsEvent.HostLifecycleModeSet)
      .map((call) => call[1]);
}

describe("HostLifecycleModeSetAnalytics", () => {
  it("a desktop push this window expected reports once, with the expecting surface", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.seed(view("ask", 1, null));
    tracker.expect("linked", "quit-modal");

    tracker.observe(view("linked", 2, "desktop"));
    tracker.observe(view("linked", 2, "desktop"));

    expect(modeSetCalls()).toEqual([{ mode: "linked", source: "quit-modal" }]);
  });

  it("a desktop push nobody here expected reports nothing (another window's write, or the tray's)", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.setLeader(true);
    tracker.seed(view("ask", 1, null));

    tracker.observe(view("background", 2, "desktop"));

    expect(modeSetCalls()).toEqual([]);
  });

  it("an expectation for the mode already on file registers nothing (main writes nothing for it)", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.seed(view("linked", 2, "desktop"));
    tracker.expect("linked", "quit-modal");

    tracker.observe(view("linked", 3, "desktop"));

    expect(modeSetCalls()).toEqual([]);
  });

  it("a withdrawn expectation reports nothing when that mode is written later", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.seed(view("ask", 1, null));
    tracker.expect("background", "quit-modal");
    tracker.withdraw("quit-modal");

    tracker.observe(view("background", 2, "desktop"));

    expect(modeSetCalls()).toEqual([]);
  });

  it("withdraw is per surface: another surface's expectation stands", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.seed(view("ask", 1, null));
    tracker.expect("background", "settings");
    tracker.withdraw("quit-modal");

    tracker.observe(view("background", 2, "desktop"));

    expect(modeSetCalls()).toEqual([
      { mode: "background", source: "settings" },
    ]);
  });

  it("the applied reply reports once whether it lands before or after the push", () => {
    const modeSetCalls = spyModeSets();
    const replyFirst = new HostLifecycleModeSetAnalytics();
    replyFirst.seed(view("ask", 1, null));
    replyFirst.expect("background", "settings");
    replyFirst.settle("settings", view("background", 2, "desktop"));
    replyFirst.observe(view("background", 2, "desktop"));

    const pushFirst = new HostLifecycleModeSetAnalytics();
    pushFirst.seed(view("ask", 1, null));
    pushFirst.expect("background", "settings");
    pushFirst.observe(view("background", 2, "desktop"));
    pushFirst.settle("settings", view("background", 2, "desktop"));

    expect(modeSetCalls()).toEqual([
      { mode: "background", source: "settings" },
      { mode: "background", source: "settings" },
    ]);
  });

  it("a reply that is not applied reports nothing, and a later push of that mode is not attributed to it", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.seed(view("background", 1, null));
    tracker.expect("none", "settings");
    tracker.settle("settings", null);

    tracker.observe(view("none", 2, "desktop"));

    expect(modeSetCalls()).toEqual([]);
  });

  it("a cli push reports only in the leader window", () => {
    const modeSetCalls = spyModeSets();
    const leader = new HostLifecycleModeSetAnalytics();
    leader.setLeader(true);
    leader.seed(view("ask", 1, null));
    const follower = new HostLifecycleModeSetAnalytics();
    follower.seed(view("ask", 1, null));

    leader.observe(view("background", 2, "cli"));
    follower.observe(view("background", 2, "cli"));

    expect(modeSetCalls()).toEqual([{ mode: "background", source: "cli" }]);
  });

  it("a cli push while no window leads (leadership changing hands) is not reported: missed, never doubled", () => {
    const modeSetCalls = spyModeSets();
    const releasing = new HostLifecycleModeSetAnalytics();
    releasing.seed(view("ask", 1, null));
    releasing.setLeader(true);
    releasing.setLeader(false);
    const waiting = new HostLifecycleModeSetAnalytics();
    waiting.seed(view("ask", 1, null));

    releasing.observe(view("background", 2, "cli"));
    waiting.observe(view("background", 2, "cli"));
    waiting.setLeader(true);

    expect(modeSetCalls()).toEqual([]);
  });

  it("a cli write of the mode this window expected is reported as cli, and spends the expectation", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.setLeader(true);
    tracker.seed(view("ask", 1, null));
    tracker.expect("linked", "settings");

    tracker.observe(view("linked", 2, "cli"));
    tracker.settle("settings", view("linked", 2, "cli"));

    expect(modeSetCalls()).toEqual([{ mode: "linked", source: "cli" }]);
  });

  it("before any baseline, a cli push only becomes the baseline", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.setLeader(true);

    tracker.observe(view("background", 2, "cli"));
    tracker.seed(view("ask", 1, null));
    tracker.observe(view("background", 2, "cli"));

    expect(modeSetCalls()).toEqual([]);
  });

  it("a rev that moved without a mode change, or a mode seen again at the same rev, reports nothing", () => {
    const modeSetCalls = spyModeSets();
    const tracker = new HostLifecycleModeSetAnalytics();
    tracker.setLeader(true);
    tracker.seed(view("ask", 1, null));

    tracker.observe(view("ask", 2, "cli"));
    tracker.observe(view("ask", 2, "cli"));

    expect(modeSetCalls()).toEqual([]);
  });
});
