import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { BrowserOpenedTab } from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  useLandingPanelStore,
  type LandingBrowserTabRef,
} from "@/stores/home/landing-panel-store";

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import type { LandingBrowserSessionEntries } from "../landing-terminal-authority-fleet";
import {
  LANDING_BROWSER_WATCHED_HOST_CAP,
  landingBrowserOpenBudgetMessage,
  landingBrowserWatchedHostIds,
} from "../landing-browser-presentation";
import { reserveLandingBrowserOpen } from "../landing-browser-open-reservations";
import {
  useLandingBrowserOpenLink,
  useLandingBrowserOpenTab,
} from "../use-landing-browser-open-tab";

const HOST_ID = "host-a";

const RAISING_TAB: LandingBrowserTabRef = {
  kind: "browser",
  instanceId: "raising-instance",
  hostId: HOST_ID,
  sessionId: "raising-session",
  tabId: "raising-tab",
  name: "example.com",
  titleSource: "default",
};

function sessionsState(
  overrides: Partial<BrowserSessionsState>,
): BrowserSessionsState {
  return {
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used in this test")),
    closeTab: () => Promise.reject(new Error("not used in this test")),
    attachTab: () => Promise.reject(new Error("not used in this test")),
    moveTab: () => Promise.reject(new Error("not used in this test")),
    ...overrides,
  };
}

/** The two ways a browser open reaches a device, both of which pin its stream. */
interface HarnessOpeners {
  readonly fromChooser: () => void;
  readonly fromPage: () => void;
}

/** An `openTab` this test settles by hand, so an open can be held in flight. */
function deferredOpenTab(): {
  readonly openTab: BrowserSessionsState["openTab"];
  settle: ((identity: BrowserOpenedTab) => void) | null;
} {
  const handle: {
    openTab: BrowserSessionsState["openTab"];
    settle: ((identity: BrowserOpenedTab) => void) | null;
  } = { openTab: () => Promise.reject(new Error("unset")), settle: null };
  handle.openTab = () =>
    new Promise<BrowserOpenedTab>((resolve) => {
      handle.settle = resolve;
    });
  return handle;
}

/**
 * The panel's mount decision, driven through the parts that actually make it.
 *
 * Not a call to `landingBrowserWatchedHostIds` with a hand-written pending
 * list: the harness renders the real openers, dispatches a real open through
 * the real mutation cache, and reads the pending set back off the link opener -
 * which is where a wrong mutation-key shape or a missed opener would show up
 * and a pure-function test would not.
 *
 * `onWatched` records what `LandingTerminalAuthorityFleet` is given, which maps
 * one `LandingBrowserSessionsRegistration` per device. It is the list that
 * decides whether a device's stream is held.
 */
function Harness(props: {
  readonly paneVisible: boolean;
  readonly browserSessions: LandingBrowserSessionEntries;
  readonly onWatched: (hostIds: ReadonlyArray<string>) => void;
  readonly onReady: (openers: HarnessOpeners) => void;
}): ReactNode {
  const { browserSessions, onReady, onWatched, paneVisible } = props;
  const link = useLandingBrowserOpenLink({ browserSessions });
  const chooser = useLandingBrowserOpenTab({
    canDriveTabs: true,
    hostId: HOST_ID,
    browserSessions,
    onOpened: () => undefined,
  });
  const watched = landingBrowserWatchedHostIds({
    targetHostId: HOST_ID,
    activeBrowserHostId: null,
    recentlyActivatedHostIds: [],
    tabHostIds: [],
    paneVisible,
    // The panel is collapsed throughout, so the target pin is the only thing
    // that could hold this device - which is exactly the leak's shape.
    panelWatching: false,
    pendingOpenHostIds: link.pendingHostIds,
  });
  const chooserOpen = chooser.open;
  const linkOpen = link.open;
  useEffect(() => {
    onReady({
      fromChooser: () => chooserOpen({ placeholderInstanceId: null }),
      fromPage: () =>
        linkOpen(RAISING_TAB, "https://example.com/next", "background"),
    });
  }, [chooserOpen, linkOpen, onReady]);
  useEffect(() => {
    onWatched(watched);
  });
  return link.openers;
}

function QueryWrapper(props: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

const HOSTS = Array.from({ length: 12 }, (_unused, i) => `host-${i + 1}`);
const pendingSeen: { current: ReadonlyArray<string> } = { current: [] };

interface RetargetOpeners {
  readonly fromChooser: () => void;
  readonly fromPage: (hostId: string) => void;
}

function neverSettles(): BrowserSessionsState["openTab"] {
  return () => new Promise(() => undefined);
}

function RetargetHarness(props: {
  readonly targetHostId: string;
  readonly browserSessions: LandingBrowserSessionEntries;
  readonly onWatched: (hostIds: ReadonlyArray<string>) => void;
  readonly onPending: ((hostIds: ReadonlyArray<string>) => void) | undefined;
  readonly onReady: (openers: RetargetOpeners) => void;
}): ReactNode {
  const { browserSessions, onPending, onReady, onWatched, targetHostId } =
    props;
  const link = useLandingBrowserOpenLink({ browserSessions });

  const chooser = useLandingBrowserOpenTab({
    canDriveTabs: true,
    hostId: targetHostId,
    browserSessions,
    onOpened: () => undefined,
  });
  const watched = landingBrowserWatchedHostIds({
    targetHostId,
    activeBrowserHostId: null,
    recentlyActivatedHostIds: [],
    tabHostIds: [],
    paneVisible: true,
    panelWatching: false,
    pendingOpenHostIds: link.pendingHostIds,
  });
  const pending = link.pendingHostIds;
  const chooserOpen = chooser.open;
  const linkOpen = link.open;
  useEffect(() => {
    onReady({
      fromChooser: () => chooserOpen({ placeholderInstanceId: null }),
      fromPage: (hostId) => {
        linkOpen(
          { ...RAISING_TAB, hostId, sessionId: `session-${hostId}` },
          "https://example.com/popup",
          "background",
        );
      },
    });
  }, [chooserOpen, linkOpen, onReady]);
  useEffect(() => {
    onWatched(watched);
    pendingSeen.current = pending;
    onPending?.(pending);
  });
  return link.openers;
}

describe("releasing a hidden Start Page's browser streams", () => {
  afterEach(() => {
    cleanup();
    mocks.toastError.mockReset();
    useLandingPanelStore.getState().resetForTests();
  });

  function renderHarness(browserSessions: LandingBrowserSessionEntries): {
    readonly watched: () => ReadonlyArray<string>;
    readonly openFromChooser: () => void;
    readonly openFromPage: () => void;
    readonly setPaneVisible: (visible: boolean) => void;
  } {
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: HarnessOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    // Visibility is driven by RE-RENDERING with a new prop rather than by a
    // `useState` setter captured out of the component: capturing one means
    // writing a variable from outside the component during render, which
    // `react-hooks/immutability` bans. A prop change is also closer to what
    // the panel sees, since `paneVisible` reaches it from a context above.
    const tree = (paneVisible: boolean): ReactNode => (
      <QueryWrapper>
        <Harness
          paneVisible={paneVisible}
          browserSessions={browserSessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>
    );
    const view = render(tree(true));
    return {
      watched: () => seen.current,
      openFromChooser: () => opener.current.fromChooser(),
      openFromPage: () => opener.current.fromPage(),
      setPaneVisible: (visible) => {
        act(() => {
          view.rerender(tree(visible));
        });
      },
    };
  }

  it("releases the target once the page is backgrounded", async () => {
    const view = renderHarness({ [HOST_ID]: sessionsState({}) });
    expect(view.watched()).toEqual([HOST_ID]);

    view.setPaneVisible(false);

    // Redden: pinning the target above the visibility gate leaves this
    // `[HOST_ID]` forever, which is the stream a retained Start Page held.
    await waitFor(() => {
      expect(view.watched()).toEqual([]);
    });
  });

  it("holds the target through a background while a chooser open is in flight, and releases it when the open settles", async () => {
    const deferred = deferredOpenTab();
    const view = renderHarness({
      [HOST_ID]: sessionsState({ openTab: deferred.openTab }),
    });

    await act(async () => {
      view.openFromChooser();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.settle).not.toBeNull();
    });

    view.setPaneVisible(false);

    // The carve-out: releasing here unmounts the coordinator whose `openTab`
    // this very promise came from.
    expect(view.watched()).toEqual([HOST_ID]);

    await act(async () => {
      deferred.settle?.({
        sessionId: "opened-session",
        tabId: "opened-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    // And the other direction: the carve-out has to END, or it is the same
    // leak behind a different condition.
    await waitFor(() => {
      expect(view.watched()).toEqual([]);
    });
  });

  it("holds the target through a background for a popup ask the page raised", async () => {
    const deferred = deferredOpenTab();
    const view = renderHarness({
      [HOST_ID]: sessionsState({ openTab: deferred.openTab }),
    });

    await act(async () => {
      view.openFromPage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(deferred.settle).not.toBeNull();
    });

    view.setPaneVisible(false);
    expect(view.watched()).toEqual([HOST_ID]);

    await act(async () => {
      deferred.settle?.({
        sessionId: "popup-session",
        tabId: "popup-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.watched()).toEqual([]);
    });
  });

  /**
   * The queue covers the commit the mutation cache cannot: an ask is queued in
   * one render and dispatched from the opener's effect, and a pane hidden in
   * between would otherwise release the device the ask is for.
   */
  it("holds the target for a popup ask queued but not yet dispatched", () => {
    const view = renderHarness({
      [HOST_ID]: sessionsState({ openTab: () => new Promise(() => undefined) }),
    });

    // Queue and hide with no `await` between them, so the opener's dispatch
    // effect has not run and nothing is pending in the mutation cache yet.
    act(() => {
      view.openFromPage();
    });
    view.setPaneVisible(false);

    expect(view.watched()).toEqual([HOST_ID]);
  });

  it("releases the target when an open FAILS, not only when it succeeds", async () => {
    const view = renderHarness({
      [HOST_ID]: sessionsState({
        openTab: () => Promise.reject(new Error("device refused")),
      }),
    });

    await act(async () => {
      view.openFromChooser();
      await Promise.resolve();
    });
    view.setPaneVisible(false);

    // A carve-out that only drained on success would hold the stream for every
    // device that ever refused an open - a worse leak than the original.
    await waitFor(() => {
      expect(view.watched()).toEqual([]);
    });
  });
});

/**
 * The case the release tests above never reach: the target MOVING while opens
 * on earlier targets are still unanswered.
 *
 * A single device with a single open cannot show this - the union never grows.
 * Opens on different devices run concurrently by design and nothing times them
 * out, so without admission control twelve successive targets held twelve
 * streams, which is the desktop's entire per-window allowance.
 *
 * Driven through the real chooser opener against a `openTab` that never
 * settles, so the holds are real holds rather than a hand-written list.
 */
describe("the open budget across successive targets", () => {
  afterEach(() => {
    cleanup();
    mocks.toastError.mockReset();
    useLandingPanelStore.getState().resetForTests();
  });

  it("never holds more than the watched cap, however many targets have unanswered opens", async () => {
    const sessions: Record<string, BrowserSessionsState> = {};
    for (const hostId of HOSTS) {
      sessions[hostId] = sessionsState({ hostId, openTab: neverSettles() });
    }
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    const tree = (targetHostId: string): ReactNode => (
      <QueryWrapper>
        <RetargetHarness
          targetHostId={targetHostId}
          browserSessions={sessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onPending={undefined}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>
    );
    const view = render(tree(HOSTS[0]));

    const widest: number[] = [];
    for (const hostId of HOSTS) {
      await act(async () => {
        view.rerender(tree(hostId));
        await Promise.resolve();
      });
      await act(async () => {
        opener.current.fromChooser();
        await Promise.resolve();
      });
      widest.push(seen.current.length);
    }

    // Redden: with the target admitted unconditionally and the pending loop
    // uncapped, this reaches 12 - the whole window allowance, held by a panel
    // showing nothing, and never released because no open ever answers.
    expect(Math.max(...widest)).toBeLessThanOrEqual(
      LANDING_BROWSER_WATCHED_HOST_CAP,
    );
    // And the bound is enforced by REFUSING, not by evicting: every device that
    // was accepted is still held.
    expect(mocks.toastError).toHaveBeenCalledWith(
      landingBrowserOpenBudgetMessage(),
    );
  });

  /**
   * The carve-out inside the bound, tested with the budget ACTUALLY FULL.
   *
   * A first draft asserted this with one device held, where `size < cap` is
   * true anyway - so it passed against a predicate with the already-held
   * shortcut deleted, and proved nothing. The budget has to be spent first for
   * the shortcut to be the only thing that can admit this ask.
   *
   * Driven through the popup opener, not the chooser: the chooser has its own
   * per-device idempotence guard that returns before admission is consulted,
   * so a repeat ask there could never reach the code under test.
   */
  it("still admits a repeat ask on an already-held device with the budget full", async () => {
    const sessions: Record<string, BrowserSessionsState> = {};
    for (const hostId of HOSTS) {
      sessions[hostId] = sessionsState({ hostId, openTab: neverSettles() });
    }
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    const tree = (targetHostId: string): ReactNode => (
      <QueryWrapper>
        <RetargetHarness
          targetHostId={targetHostId}
          browserSessions={sessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onPending={undefined}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>
    );
    const view = render(tree(HOSTS[0]));

    // Spend the whole budget on distinct devices. One more host than the cap,
    // because the ROUTING TARGET occupies a watched slot without being pending
    // - a first draft looped exactly `cap` times, left the pending set one
    // short, and so never actually filled the budget it claimed to be testing.
    for (const hostId of HOSTS.slice(0, LANDING_BROWSER_WATCHED_HOST_CAP + 1)) {
      await act(async () => {
        view.rerender(tree(hostId));
        await Promise.resolve();
      });
      await act(async () => {
        opener.current.fromChooser();
        await Promise.resolve();
      });
    }
    // The precondition this test is about, asserted rather than assumed.
    expect(pendingSeen.current).toHaveLength(LANDING_BROWSER_WATCHED_HOST_CAP);
    mocks.toastError.mockReset();

    // A page on the FIRST device raises a popup. Its stream is already up, so
    // this costs nothing and must not be refused.
    await act(async () => {
      opener.current.fromPage(HOSTS[0]);
      await Promise.resolve();
    });
    expect(mocks.toastError).not.toHaveBeenCalled();

    // A popup on a device outside the budget IS refused - the same call, the
    // only difference being whether this window already holds that stream.
    await act(async () => {
      opener.current.fromPage(HOSTS[11]);
      await Promise.resolve();
    });
    expect(mocks.toastError).toHaveBeenCalledWith(
      landingBrowserOpenBudgetMessage(),
    );
  });
});

/**
 * Admission has to be ATOMIC across the two openers, not merely correct in
 * each.
 *
 * Both `open()`s used to test a snapshot - the chooser a rendered prop, the
 * popup queue a ref written in an effect - and neither RESERVED the host it
 * was about to add. Two new-host opens inside ONE act therefore both read a
 * pre-batch value and both passed, so more devices were accepted than the
 * budget allows and the selector's truncation dropped one of them: an accepted
 * open losing the coordinator its own `openTab` came from.
 *
 * The aged case matters as much as the count. The pending list is sorted, so
 * truncation takes whatever falls off the END - the victim is chosen
 * alphabetically, not by age. A test that only ever dropped the newest host
 * would pass against the broken code.
 */
describe("admission across both openers in one act", () => {
  afterEach(() => {
    cleanup();
    mocks.toastError.mockReset();
    useLandingPanelStore.getState().resetForTests();
  });

  function harnessFor(hostIds: readonly string[]): {
    readonly sessions: LandingBrowserSessionEntries;
    readonly asked: string[];
  } {
    const asked: string[] = [];
    const sessions: Record<string, BrowserSessionsState> = {};
    for (const hostId of hostIds) {
      sessions[hostId] = sessionsState({
        hostId,
        openTab: () => {
          asked.push(hostId);
          return neverSettles()("", "");
        },
      });
    }
    return { sessions, asked };
  }

  it("never accepts more opens than it can hold, with two popups in one act", async () => {
    const HOSTS = ["a", "b", "c", "d", "e"];
    const { sessions, asked } = harnessFor(HOSTS);
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const pending: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    render(
      <QueryWrapper>
        <RetargetHarness
          targetHostId="a"
          browserSessions={sessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onPending={(hostIds) => {
            pending.current = hostIds;
          }}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>,
    );

    // Three established in separate acts, so each sees the previous.
    for (const hostId of ["a", "b", "c"]) {
      await act(async () => {
        opener.current.fromPage(hostId);
        await Promise.resolve();
      });
    }

    // Two NEW hosts in ONE act - neither can see the other's admission.
    await act(async () => {
      opener.current.fromPage("d");
      opener.current.fromPage("e");
      await Promise.resolve();
    });

    // Redden: without a reservation both are accepted, five opens are asked
    // for, and the selector holds only four - `e`'s coordinator is gone while
    // its open is still in flight.
    for (const hostId of pending.current) {
      expect(seen.current).toContain(hostId);
    }
    expect(asked.every((hostId) => pending.current.includes(hostId))).toBe(
      true,
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      landingBrowserOpenBudgetMessage(),
    );
  });

  it("never accepts more than it can hold with a chooser and a popup in one act", async () => {
    const HOSTS = ["a", "b", "c", "d", "e"];
    const { sessions, asked } = harnessFor(HOSTS);
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const pending: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    const tree = (targetHostId: string): ReactNode => (
      <QueryWrapper>
        <RetargetHarness
          targetHostId={targetHostId}
          browserSessions={sessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onPending={(hostIds) => {
            pending.current = hostIds;
          }}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>
    );
    const view = render(tree("a"));

    for (const hostId of ["a", "b", "c"]) {
      await act(async () => {
        opener.current.fromPage(hostId);
        await Promise.resolve();
      });
    }
    await act(async () => {
      view.rerender(tree("d"));
      await Promise.resolve();
    });

    // The chooser opens on its target `d` while a page raises one on `e`.
    await act(async () => {
      opener.current.fromChooser();
      opener.current.fromPage("e");
      await Promise.resolve();
    });

    for (const hostId of pending.current) {
      expect(seen.current).toContain(hostId);
    }
    expect(asked.every((hostId) => pending.current.includes(hostId))).toBe(
      true,
    );
  });

  it("drops nothing when the batch's victim would be an OLDER open", async () => {
    // Names chosen so the alphabetical truncation would take `e`, whose open
    // predates the batch entirely.
    const HOSTS = ["a", "b", "c", "d", "e"];
    const { sessions, asked } = harnessFor(HOSTS);
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const pending: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    render(
      <QueryWrapper>
        <RetargetHarness
          targetHostId="b"
          browserSessions={sessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onPending={(hostIds) => {
            pending.current = hostIds;
          }}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>,
    );

    for (const hostId of ["b", "c", "e"]) {
      await act(async () => {
        opener.current.fromPage(hostId);
        await Promise.resolve();
      });
    }
    await act(async () => {
      opener.current.fromPage("d");
      opener.current.fromPage("a");
      await Promise.resolve();
    });

    // Redden: the accepted set sorts to [a,b,c,d,e] and the truncation keeps
    // the first four, so `e` - the OLDEST of them - is the one dropped.
    expect(seen.current).toContain("e");
    for (const hostId of pending.current) {
      expect(seen.current).toContain(hostId);
    }
    expect(asked.every((hostId) => pending.current.includes(hostId))).toBe(
      true,
    );
  });
});

/**
 * A hold belongs to the ASK that took it, not to its device.
 *
 * The failure this pins: a popup is in flight when the panel unmounts, the
 * cleanup releases that ask's hold and clears its queue, the panel remounts and
 * a new popup takes a fresh hold on the SAME device - and then the old
 * mutation answers. Its options-level `onSettled` is copied onto the Mutation
 * at build time and still runs with the observer gone, so a settle that
 * released "one hold for this host" decremented the LIVE hold belonging to the
 * new ask. The device was then dropped from the watched set while its open was
 * still unanswered, which is the lost-tab failure by a longer route.
 *
 * A per-host count cannot fix this at any strength: it can say the host holds
 * nothing, never whether the release in hand belongs to the ask that took the
 * hold. Only a per-ask hold can.
 */
describe("hold ownership across an unmount", () => {
  afterEach(() => {
    cleanup();
    mocks.toastError.mockReset();
    useLandingPanelStore.getState().resetForTests();
  });

  it("keeps the remounted panel's hold when a stale popup settles", async () => {
    const settles: Array<(identity: BrowserOpenedTab) => void> = [];
    const sessions: LandingBrowserSessionEntries = {
      [HOST_ID]: sessionsState({
        openTab: () =>
          new Promise<BrowserOpenedTab>((resolve) => {
            settles.push(resolve);
          }),
      }),
    };
    const seen: { current: ReadonlyArray<string> } = { current: [] };
    const pending: { current: ReadonlyArray<string> } = { current: [] };
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    const tree = (): ReactNode => (
      <QueryWrapper>
        <RetargetHarness
          targetHostId={HOST_ID}
          browserSessions={sessions}
          onWatched={(hostIds) => {
            seen.current = hostIds;
          }}
          onPending={(hostIds) => {
            pending.current = hostIds;
          }}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>
    );

    const first = render(tree());
    await act(async () => {
      opener.current.fromPage(HOST_ID);
      await Promise.resolve();
    });
    expect(pending.current).toEqual([HOST_ID]);

    // The old panel goes away with its popup still unanswered - its cleanup
    // gives that ask's hold back (asserted on its own in the next test), which
    // is what makes the remount below take a genuinely NEW one rather than
    // find the device already held. Nothing is asserted through `pending` here
    // on purpose: the panel that writes it is gone, so it would only report
    // the last value it happened to render with.
    first.unmount();

    // A new panel, a new ask on the same device, a NEW hold.
    render(tree());
    await act(async () => {
      opener.current.fromPage(HOST_ID);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(pending.current).toEqual([HOST_ID]);
    });

    // The OLD popup answers. Its settle must not touch the new ask's hold.
    await act(async () => {
      settles[0]?.({
        sessionId: "stale-session",
        tabId: "stale-tab",
        handoffToken: null,
      });
      await Promise.resolve();
    });

    // Redden: releasing by host drops the live hold, so the device leaves both
    // the reservation set and the watched list while its open is outstanding.
    expect(pending.current).toEqual([HOST_ID]);
    expect(seen.current).toContain(HOST_ID);
  });

  /**
   * The other half of the same ownership, and the half a mutation found
   * missing: an ask that is still QUEUED when its panel goes away.
   *
   * Its settle never runs - the panel that would have dispatched it is gone -
   * so the unmount is the only thing that can give the hold back. Deleting that
   * loop reddened nothing until this existed, and the leak it leaves is
   * permanent: the budget stays spent for the life of the window, and the next
   * panel opens against a smaller one for devices nobody is watching.
   */
  it("gives back the holds of asks its panel never answered", async () => {
    const sessions: Record<string, BrowserSessionsState> = {};
    for (const hostId of HOSTS) {
      sessions[hostId] = sessionsState({ hostId, openTab: neverSettles() });
    }
    const opener: { current: RetargetOpeners } = {
      current: { fromChooser: () => undefined, fromPage: () => undefined },
    };
    const held = HOSTS.slice(0, LANDING_BROWSER_WATCHED_HOST_CAP);
    const view = render(
      <QueryWrapper>
        <RetargetHarness
          targetHostId={held[0]}
          browserSessions={sessions}
          onWatched={() => undefined}
          onPending={undefined}
          onReady={(openers) => {
            opener.current = openers;
          }}
        />
      </QueryWrapper>,
    );

    for (const hostId of held) {
      await act(async () => {
        opener.current.fromPage(hostId);
        await Promise.resolve();
      });
    }
    // The precondition this rests on, asserted rather than assumed: the budget
    // really is spent, so what the unmount gives back is what was taken.
    expect(reserveLandingBrowserOpen("a-fifth-device")).toBeNull();

    view.unmount();

    // Measured on devices the panel never touched, which is the whole
    // difference between this passing and this meaning something: re-reserving
    // the devices it HELD would be admitted by the already-held shortcut
    // whether or not a single hold was given back.
    const fresh = HOSTS.slice(
      LANDING_BROWSER_WATCHED_HOST_CAP,
      LANDING_BROWSER_WATCHED_HOST_CAP * 2,
    );
    expect(fresh).toHaveLength(LANDING_BROWSER_WATCHED_HOST_CAP);
    expect(
      fresh.map((hostId) => reserveLandingBrowserOpen(hostId)),
    ).not.toContain(null);
    // Every slot back, and no more than every slot.
    expect(reserveLandingBrowserOpen("one-too-many")).toBeNull();
  });
});
