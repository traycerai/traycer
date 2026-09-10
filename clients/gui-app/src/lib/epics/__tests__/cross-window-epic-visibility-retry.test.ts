import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCrossWindowEpicVisibilityForTests,
  installCrossWindowEpicVisibility,
  isEpicVisibleInAnotherWindow,
} from "@/lib/epics/cross-window-epic-visibility";
import type {
  DesktopEpicVisibilityEntry,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

/**
 * Fixup 2, item 2: `installCrossWindowEpicVisibility`'s retry on a failed
 * report (`clients/gui-app/src/lib/epics/cross-window-epic-visibility.ts`).
 *
 * A separate file from `epic-parking.test.ts` on purpose. Pinning "the retry
 * re-reads `visibleEpicIds()` at execution time, never a captured array"
 * needs the visible set to change WITHOUT that change itself notifying
 * `subscribeEpicSurfaceVisibility`'s listener - in production every change to
 * `visibleEpicIds()` goes through `setEpicSurfaceVisibility`, which always
 * notifies, and that notification is exactly what `report()` uses to cancel
 * a pending retry and resend immediately. Driving the real module gives no
 * way to change the set out from under a still-pending retry, so this file
 * mocks `surface-host-opened-tab` to decouple "what `visibleEpicIds()`
 * answers" from "when the local-edge listener fires" and isolate the retry
 * timer's own read.
 */
const surfaceHostState = vi.hoisted(() => ({
  visibleIds: [] as string[],
  listener: null as ((epicId: string) => void) | null,
}));

vi.mock("@/lib/browser-view/tiles/surface-host-opened-tab", () => ({
  subscribeEpicSurfaceVisibility: (
    listener: (epicId: string) => void,
  ): (() => void) => {
    surfaceHostState.listener = listener;
    return () => {
      surfaceHostState.listener = null;
    };
  },
  visibleEpicIds: (): readonly string[] => surfaceHostState.visibleIds,
}));

function controllableEpicVisibilityChannel(): {
  readonly channel: NonNullable<DesktopWindowsBridge["epicVisibility"]>;
  readonly reportCalls: ReadonlyArray<readonly string[]>;
  // A property with a function type, not a method shorthand: every call site
  // DESTRUCTURES this off the result, and the type-aware `unbound-method` rule
  // reads a method shorthand as a `this`-bearing method being unbound.
  readonly setReportOutcome: (outcome: "resolve" | "reject") => void;
  // Leaves a call to `channel.report` unsettled until `settlePendingReport`
  // resolves or rejects it by hand - for pinning teardown against an invoke
  // that is still IN FLIGHT, not one that already settled.
  readonly setReportPending: () => void;
  readonly settlePendingReport: (outcome: "resolve" | "reject") => void;
  readonly snapshotCalls: { count: number };
  readonly setSnapshotOutcome: (
    outcome: "resolve" | "reject",
    entries: readonly DesktopEpicVisibilityEntry[],
  ) => void;
  readonly setSnapshotPending: () => void;
  readonly settlePendingSnapshot: (
    outcome: "resolve" | "reject",
    entries?: readonly DesktopEpicVisibilityEntry[],
  ) => void;
  readonly emitChange: (entries: readonly DesktopEpicVisibilityEntry[]) => void;
} {
  type Outcome = "resolve" | "reject" | "pending";
  let outcome: Outcome = "resolve";
  let snapshotOutcome: Outcome = "resolve";
  let snapshotEntries: readonly DesktopEpicVisibilityEntry[] = [];
  let changeHandler:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  const reportCalls: Array<readonly string[]> = [];
  const snapshotCalls = { count: 0 };
  let pendingReportSettlers: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  let pendingSnapshotSettlers: Array<{
    resolve: (entries: readonly DesktopEpicVisibilityEntry[]) => void;
    reject: (error: Error) => void;
  }> = [];
  return {
    reportCalls,
    snapshotCalls,
    setReportOutcome: (next) => {
      outcome = next;
    },
    setReportPending: () => {
      outcome = "pending";
    },
    settlePendingReport: (next) => {
      const settlers = pendingReportSettlers;
      pendingReportSettlers = [];
      for (const settler of settlers) {
        if (next === "resolve") {
          settler.resolve();
        } else {
          settler.reject(new Error("cross-window report failed"));
        }
      }
    },
    setSnapshotOutcome: (next, entries) => {
      snapshotOutcome = next;
      snapshotEntries = entries;
    },
    setSnapshotPending: () => {
      snapshotOutcome = "pending";
    },
    settlePendingSnapshot: (next, entries) => {
      const settlers = pendingSnapshotSettlers;
      pendingSnapshotSettlers = [];
      for (const settler of settlers) {
        if (next === "resolve") {
          settler.resolve(entries ?? snapshotEntries);
        } else {
          settler.reject(new Error("cross-window snapshot failed"));
        }
      }
    },
    emitChange: (entries) => {
      changeHandler?.(entries);
    },
    channel: {
      report: (epicIds) => {
        reportCalls.push([...epicIds]);
        if (outcome === "pending") {
          return new Promise<void>((resolve, reject) => {
            pendingReportSettlers.push({ resolve, reject });
          });
        }
        return outcome === "resolve"
          ? Promise.resolve()
          : Promise.reject(new Error("cross-window report failed"));
      },
      snapshot: () => {
        snapshotCalls.count += 1;
        if (snapshotOutcome === "pending") {
          return new Promise<readonly DesktopEpicVisibilityEntry[]>(
            (resolve, reject) => {
              pendingSnapshotSettlers.push({ resolve, reject });
            },
          );
        }
        return snapshotOutcome === "resolve"
          ? Promise.resolve(snapshotEntries)
          : Promise.reject(new Error("cross-window snapshot failed"));
      },
      onChange: (
        handler: (entries: readonly DesktopEpicVisibilityEntry[]) => void,
      ) => {
        changeHandler = handler;
        return {
          dispose: () => {
            changeHandler = null;
          },
        };
      },
    },
  };
}

function fakeDesktopWindowsBridge(
  windowId: string,
  epicVisibility: DesktopWindowsBridge["epicVisibility"],
): DesktopWindowsBridge {
  return {
    windowId,
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({ result: "moved" as const, windowId: "window-other" }),
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    epicVisibility,
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve({ outcome: "accepted" as const }),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

describe("installCrossWindowEpicVisibility - failed-report retry (fixup 2, item 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    surfaceHostState.visibleIds = [];
    surfaceHostState.listener = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a rejecting report after 250ms", async () => {
    const { channel, reportCalls, setReportOutcome } =
      controllableEpicVisibilityChannel();
    setReportOutcome("reject");
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      // The install-time push, which fails.
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls).toHaveLength(1);

      // Not yet - the first backoff delay is 250ms.
      await vi.advanceTimersByTimeAsync(249);
      expect(reportCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(reportCalls).toHaveLength(2);
    } finally {
      uninstall();
    }
  });

  it("the retry re-reads the visible set at execution time, never a captured array", async () => {
    const { channel, reportCalls, setReportOutcome } =
      controllableEpicVisibilityChannel();
    setReportOutcome("reject");
    surfaceHostState.visibleIds = ["epic-old"];
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      // The failed attempt captured (if buggy) or should have read "epic-old".
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls).toEqual([["epic-old"]]);

      // The visible set changes AFTER the failed call but BEFORE the
      // scheduled retry fires - and critically, without going through the
      // local-edge listener (which is never invoked here), so nothing
      // cancels or re-schedules the pending retry. Only a live read inside
      // the retry's own callback can see this.
      surfaceHostState.visibleIds = ["epic-new"];

      await vi.advanceTimersByTimeAsync(250);

      // The retry carried the NEW ids, not the ones in place when it failed
      // and was scheduled.
      expect(reportCalls).toEqual([["epic-old"], ["epic-new"]]);
    } finally {
      uninstall();
    }
  });

  it("teardown cancels a pending retry", async () => {
    const { channel, reportCalls, setReportOutcome } =
      controllableEpicVisibilityChannel();
    setReportOutcome("reject");
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reportCalls).toHaveLength(1);

    uninstall();

    // Advance past every backoff delay (250 + 1_000 + 4_000).
    await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000 + 1_000);
    expect(reportCalls).toHaveLength(1);
  });

  it("stops after exactly 3 retries when report always rejects", async () => {
    const { channel, reportCalls, setReportOutcome } =
      controllableEpicVisibilityChannel();
    setReportOutcome("reject");
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      // Attempt 1 (install push) + 3 retries = 4 total calls.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(reportCalls).toHaveLength(4);

      // Well past where a further retry would fire if the budget were not
      // bounded.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reportCalls).toHaveLength(4);
    } finally {
      uninstall();
    }
  });

  it("a successful report schedules nothing", async () => {
    const { channel, reportCalls, setReportOutcome } =
      controllableEpicVisibilityChannel();
    setReportOutcome("resolve");
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000 + 1_000);
      expect(reportCalls).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  it("does not report again if a still-pending report only rejects after teardown", async () => {
    const { channel, reportCalls, setReportPending, settlePendingReport } =
      controllableEpicVisibilityChannel();
    setReportPending();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    // The install-time push, still in flight - not yet settled.
    await vi.advanceTimersByTimeAsync(0);
    expect(reportCalls).toHaveLength(1);

    uninstall();

    // The invoke rejects AFTER teardown: this is what a `cancel()` that only
    // reaches an already-scheduled timer cannot prevent.
    settlePendingReport("reject");
    await vi.advanceTimersByTimeAsync(0);
    expect(reportCalls).toHaveLength(1);

    // Advance past the full backoff budget: no retry got armed by the
    // post-teardown rejection.
    await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000 + 1_000);
    expect(reportCalls).toHaveLength(1);
  });

  it("a stale completion from a superseded report attempt neither re-arms a retry nor resets the live leg's failure budget", async () => {
    const {
      channel,
      reportCalls,
      setReportOutcome,
      setReportPending,
      settlePendingReport,
    } = controllableEpicVisibilityChannel();
    setReportPending();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      // Attempt A - the install-time push - is still in flight.
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls).toHaveLength(1);

      // A fresh visibility edge supersedes A before it settles: `restart()`
      // cancels A and starts attempt B, which fails and arms its own retry.
      setReportOutcome("reject");
      surfaceHostState.listener?.("epic-x");
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls).toHaveLength(2);

      // A's stale promise settles now, well after B took over.
      settlePendingReport("resolve");
      await vi.advanceTimersByTimeAsync(0);
      // Synchronous observable: settling the stale attempt produced no call.
      expect(reportCalls).toHaveLength(2);

      // Drain B's own retry budget (250 + 1_000 + 4_000) plus margin. If A's
      // stale resolve had reset the failure counter (the bug), B would earn
      // an extra retry cycle out of it and this would land on 6, not 5.
      await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000 + 4_000 + 1_000);
      expect(reportCalls).toHaveLength(5);
    } finally {
      uninstall();
    }
  });
});

/**
 * Fixup 2, the class sweep on item 2: the INBOUND startup read retries too.
 *
 * CodeRabbit flagged the outbound `report`; the `snapshot()` leg one line down
 * was the same fire-and-forget shape, and it is the worse of the two. A dropped
 * report is corrected by the next visibility edge; a dropped snapshot is not
 * corrected by anything this window does, because what it is missing is what
 * OTHER windows show, and that only arrives when one of THEM changes. A window
 * B sitting still on an epic produces no such change, so a single failed
 * snapshot leaves window A believing nothing is visible anywhere else - and
 * parking an epic that is on screen in B - for as long as B holds still.
 */
describe("installCrossWindowEpicVisibility - failed-snapshot retry (fixup 2, class sweep)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    surfaceHostState.visibleIds = [];
    surfaceHostState.listener = null;
    __resetCrossWindowEpicVisibilityForTests();
  });

  afterEach(() => {
    __resetCrossWindowEpicVisibilityForTests();
    vi.useRealTimers();
  });

  it("retries a rejecting snapshot and adopts the answer when it succeeds", async () => {
    const controls = controllableEpicVisibilityChannel();
    controls.setSnapshotOutcome("reject", []);
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", controls.channel),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(controls.snapshotCalls.count).toBe(1);
      // The state the bug leaves standing: nothing known about other windows.
      expect(isEpicVisibleInAnotherWindow("epic-in-window-b")).toBe(false);

      controls.setSnapshotOutcome("resolve", [
        { windowId: "window-b", epicIds: ["epic-in-window-b"] },
      ]);
      await vi.advanceTimersByTimeAsync(250);

      expect(controls.snapshotCalls.count).toBe(2);
      expect(isEpicVisibleInAnotherWindow("epic-in-window-b")).toBe(true);
    } finally {
      uninstall();
    }
  });

  it("stops after the retry budget rather than spinning forever", async () => {
    const controls = controllableEpicVisibilityChannel();
    controls.setSnapshotOutcome("reject", []);
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", controls.channel),
    );
    try {
      await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000);
      expect(controls.snapshotCalls.count).toBe(4);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(controls.snapshotCalls.count).toBe(4);
    } finally {
      uninstall();
    }
  });

  it("cancels a pending snapshot retry on teardown", async () => {
    const controls = controllableEpicVisibilityChannel();
    controls.setSnapshotOutcome("reject", []);
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", controls.channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.snapshotCalls.count).toBe(1);

    uninstall();
    await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000);
    expect(controls.snapshotCalls.count).toBe(1);
  });

  it("abandons the retry once a live onChange has landed, and never overwrites it", async () => {
    const controls = controllableEpicVisibilityChannel();
    controls.setSnapshotOutcome("reject", []);
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", controls.channel),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(controls.snapshotCalls.count).toBe(1);

      // The fact arrives by the better route while the retry is pending.
      controls.emitChange([{ windowId: "window-b", epicIds: ["epic-live"] }]);
      expect(isEpicVisibleInAnotherWindow("epic-live")).toBe(true);

      // A snapshot that would now succeed with an OLDER map must not be
      // applied, and the leg must stop retrying at all.
      controls.setSnapshotOutcome("resolve", []);
      await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000);

      expect(controls.snapshotCalls.count).toBe(1);
      expect(isEpicVisibleInAnotherWindow("epic-live")).toBe(true);
    } finally {
      uninstall();
    }
  });

  it("does not arm a new retry timer if a still-pending snapshot only rejects after teardown", async () => {
    const controls = controllableEpicVisibilityChannel();
    controls.setSnapshotPending();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", controls.channel),
    );
    // The startup snapshot read, still in flight - not yet settled.
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.snapshotCalls.count).toBe(1);

    uninstall();

    const timersBeforeRejection = vi.getTimerCount();

    // On THIS leg, a channel-call-count assertion here is NOT the pin: it
    // passes even under the reverted `cancel()`. `snapshotSuperseded()`
    // (`lifecycle.cancelled || lifecycle.fanOutSeen`) is the attempt's FIRST
    // line, before `channel.snapshot()` is ever called again - and on this
    // leg `lifecycle.cancelled` and the generation bump always flip together:
    // production `restart()`s this leg exactly once, at install, and only
    // ever `cancel()`s it at teardown, so there is no window where the
    // generation has moved on but `lifecycle.cancelled` has not. That guard
    // alone already stops a second `channel.snapshot()` call regardless of
    // the fix, so counting calls can't distinguish fixed from reverted here.
    // What the fix DOES still change on this leg: without the generation
    // check in `.catch`, a rejection landing after teardown still logs a
    // warning and arms a fresh `window.setTimeout` that will later fire and
    // no-op on the lifecycle guard - a leaked timer, not an extra call. That
    // timer is the load-bearing assertion below.
    controls.settlePendingSnapshot("reject");
    // Flush the microtask so `.catch` - and, on the reverted code, the
    // `window.setTimeout` it would arm - has run before we read the count.
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(timersBeforeRejection);

    // Kept as an extra guard, not the pin (see comment above): the retry
    // entry guard already keeps this at 1 either way.
    expect(controls.snapshotCalls.count).toBe(1);
    expect(isEpicVisibleInAnotherWindow("epic-in-window-b")).toBe(false);

    // Advance past the full backoff budget: nothing further got called or
    // published by the post-teardown rejection.
    await vi.advanceTimersByTimeAsync(250 + 1_000 + 4_000 + 1_000);
    expect(controls.snapshotCalls.count).toBe(1);
    expect(isEpicVisibleInAnotherWindow("epic-in-window-b")).toBe(false);
  });
});

// ── transcript-record-fingerprint-memo Fix 2: the report leg withdraws this
// window's claim while the document is hidden ───────────────────────────────
//
// `reportableEpicIds` (`cross-window-epic-visibility.ts`) is
// `isDocumentVisible() ? visibleEpicIds() : []`, read fresh inside the retry's
// own `attempt()` closure - same "read at execution time, never a captured
// array" discipline as `visibleEpicIds()` above, now composed with document
// visibility. `document-visibility.ts` is real here (only
// `surface-host-opened-tab` is mocked in this file), so
// `document.visibilityState` is stubbed directly and driven through a real
// `visibilitychange` dispatch - the same path production's
// `subscribeDocumentVisibility(report)` listens on.
function setDocumentVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("installCrossWindowEpicVisibility - document visibility gates the report (transcript-record-fingerprint-memo Fix 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    surfaceHostState.visibleIds = [];
    surfaceHostState.listener = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentVisibilityState("visible");
  });

  it("reports the empty set while the document is hidden, and the real set again once it is visible - read at report time, not a captured array", async () => {
    surfaceHostState.visibleIds = ["epic-a", "epic-b"];
    const { channel, reportCalls } = controllableEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      // The install-time push, document visible.
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls.at(-1)).toEqual(["epic-a", "epic-b"]);

      setDocumentVisibilityState("hidden");
      // Synchronous: `report()` calls `channel.report` inline from inside the
      // `visibilitychange` listener, no await needed to observe it.
      expect(reportCalls.at(-1)).toEqual([]);

      // The visible set changes WHILE hidden - proves the empty report was a
      // live "document hidden" gate, not a snapshot of the old set taken at
      // the moment of hiding.
      surfaceHostState.visibleIds = ["epic-a", "epic-b", "epic-c"];

      setDocumentVisibilityState("visible");
      expect(reportCalls.at(-1)).toEqual(["epic-a", "epic-b", "epic-c"]);
    } finally {
      uninstall();
    }
  });
});
