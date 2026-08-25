import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

const mocks = vi.hoisted(() => {
  const initialAuthorityStatus = (): "legacy" | "capable" | "unknown" =>
    "legacy";
  const terminalsById: Readonly<Record<string, unknown>> = {};
  // Whether the registry has answered for the fleet, held in a cell so
  // `binding` can stay one stable object: it sits in a dependency list, and a
  // fresh identity per render would recompute on every commit. The fleet ITSELF
  // is `entries`, exactly as the bridge reads it.
  const fleetSettled: { current: boolean } = { current: false };
  const directoryListeners = new Set<() => void>();
  return {
    entries: [] as readonly HostDirectoryEntry[],
    // The bridge's legacy drain now dispatches through `mutateAsync` so a
    // rejection can be retried; one fn backs both so existing call
    // assertions keep describing the same dispatch.
    kill: vi.fn(() => Promise.resolve()),
    readySessionHosts: new Set<string>(),
    authorityStatus: initialAuthorityStatus(),
    canMutate: false,
    /** Bump to make the fleet mock re-emit an entry with the current status. */
    authorityRevision: 0,
    terminalsById,
    closeAsync: vi.fn(() => Promise.resolve()),
    /** The host ids the authority fleet was last asked to probe. */
    probedHostIds: [] as readonly string[],
    /** `false` models a registry nobody has successfully reached yet. */
    fleetSettled,
    /** Drives the directory's `onChange`, which is how settlement propagates. */
    emitDirectoryChange: (): void => {
      for (const listener of directoryListeners) listener();
    },
    binding: {
      directory: {
        hasSettledFleet: (): boolean => fleetSettled.current,
        onChange: (listener: () => void): { dispose: () => void } => {
          directoryListeners.add(listener);
          return {
            dispose: () => {
              directoryListeners.delete(listener);
            },
          };
        },
      },
    },
  };
});

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: mocks.entries }),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => mocks.binding };
});
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => ({
      mutate: mocks.kill,
      mutateAsync: mocks.kill,
    }),
  }),
);
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-authority-fleet",
  async () => {
    const { useEffect } = await import("react");
    return {
      LandingTerminalAuthorityFleet: (props: {
        readonly hostIds: readonly string[];
        readonly onEntry: (hostId: string, entry: unknown) => void;
      }) => {
        const { onEntry } = props;
        const hostKey = props.hostIds.join("\u0000");
        const revision = mocks.authorityRevision;
        useEffect(() => {
          const hostIds = hostKey.length === 0 ? [] : hostKey.split("\u0000");
          mocks.probedHostIds = hostIds;
          hostIds.forEach((hostId) => {
            onEntry(hostId, {
              authority: {
                capability:
                  mocks.authorityStatus === "capable"
                    ? {
                        status: "capable",
                        schemaVersion: { major: 1, minor: 0 },
                      }
                    : { status: mocks.authorityStatus },
                canMutate: mocks.canMutate,
                collection: {
                  terminalsByIdentity: Object.fromEntries(
                    Object.entries(mocks.terminalsById).map(
                      ([terminalId, value]) => [
                        JSON.stringify([hostId, terminalId]),
                        value,
                      ],
                    ),
                  ),
                },
              },
              mutations: { close: { mutateAsync: mocks.closeAsync } },
            });
          });
          return () => {
            hostIds.forEach((hostId) => onEntry(hostId, null));
          };
        }, [hostKey, onEntry, revision]);
        return null;
      },
    };
  },
);
// The ready-session evidence the bridge now subscribes to; the poll hook
// re-reads it on its tick, so tests drive it with fake timers.
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        mocks.readySessionHosts.has(hostId),
    };
  },
);

import { LandingTerminalTombstoneRecoveryBridge } from "@/providers/landing-terminal-tombstone-recovery-bridge";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";

/**
 * The account axis the wire no longer carries: `hostListItemToDirectoryEntry`
 * stamps it onto every entry at projection time. These fixtures describe an
 * entitled account unless a case says otherwise.
 */
const PLAN_ALLOWS_REMOTE = true;

const offlineHost: HostDirectoryEntry = {
  hostId: "host-b",
  label: "Host B",
  kind: "remote",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "not-dialable",
};

/**
 * This machine's own host. It reaches a snapshot through the local arm alone,
 * so it is present with or without a registry listing - which is what makes a
 * row count useless as evidence that the fleet is known.
 */
const localHost: HostDirectoryEntry = {
  hostId: "host-local",
  label: "This Mac",
  kind: "local",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "dialable",
};

describe("<LandingTerminalTombstoneRecoveryBridge />", () => {
  beforeEach(() => {
    mocks.entries = [offlineHost];
    mocks.kill.mockReset();
    mocks.kill.mockImplementation(() => Promise.resolve());
    mocks.readySessionHosts = new Set();
    mocks.authorityStatus = "legacy";
    mocks.canMutate = false;
    mocks.authorityRevision = 0;
    mocks.terminalsById = {};
    mocks.closeAsync.mockReset();
    mocks.closeAsync.mockImplementation(() => Promise.resolve());
    // Drain cases run with the registry unanswered, so every tombstoned host
    // is probed and probe scoping cannot be confused for what they assert.
    mocks.fleetSettled.current = false;
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useLandingTerminalStore.getState().resetForTests();
  });

  it("drains an offline close after navigation leaves the landing page", async () => {
    useLandingTerminalStore.getState().addTab({
      instanceId: "closed-tab",
      sessionId: "session-b",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "closed-tab");
    const view = render(<LandingTerminalTombstoneRecoveryBridge />);

    expect(mocks.kill).not.toHaveBeenCalled();

    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-b",
      });
    });
  });

  it("retries an acknowledged capable-host close only through shared authority", async () => {
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-capable": {} };
    useLandingTerminalStore.getState().addTab({
      instanceId: "capable-tab",
      sessionId: "session-capable",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "capable-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.closeAsync).toHaveBeenCalledWith({
        hostId: "host-b",
        terminalId: "session-capable",
      });
      expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
    });
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("routes an unsettled create to terminal.kill rather than discarding its tombstone", async () => {
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    // The create has not landed, so the host projects nothing for this id yet.
    mocks.terminalsById = {};
    useLandingTerminalStore.getState().addTab({
      instanceId: "creating-tab",
      sessionId: "session-creating",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      pendingCreate: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "creating-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-creating",
      });
    });
    // `terminal.plain.close` would REJECT for a terminal this host has not
    // created yet, and the tombstone names the id the CLIENT gave `create` - so
    // the terminal that lands next is precisely the one owed this kill.
    expect(mocks.closeAsync).not.toHaveBeenCalled();
  });

  it("kills a legacy session on a host that came back upgraded", async () => {
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    // Closed while the host was legacy; it returns negotiating the plain
    // protocol, which is the ordinary shape of a host that was offline BECAUSE
    // it was upgrading.
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = {};
    useLandingTerminalStore.getState().addTab({
      instanceId: "legacy-tab",
      sessionId: "session-legacy",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "legacy-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-legacy",
      });
    });
    // A session that was never a plain terminal has no projection to vanish
    // from, so the capable arm must not read its absence as death.
    expect(mocks.closeAsync).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-b",
        sessionId: "session-legacy",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
  });

  it("does not drain capable-host tombstones while authority is stale", async () => {
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = false;
    mocks.terminalsById = { "session-stale": {} };
    useLandingTerminalStore.getState().addTab({
      instanceId: "stale-tab",
      sessionId: "session-stale",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "stale-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.closeAsync).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-b",
        sessionId: "session-stale",
        hostAuthorityAcknowledged: true,
        pendingCreate: false,
      },
    ]);
  });

  it("keeps retrying a kill the host resolved without killing anything", async () => {
    // `terminal.kill` reports an already-gone session as DATA (`killed: false`),
    // and the kill mutation deliberately KEEPS the tombstone for the one shape
    // where that answer means "not created yet" rather than "gone" - a session
    // whose `terminal.plain.create` had not settled, whose terminal lands
    // afterwards under this same client-supplied id.
    //
    // The bridge used to read ANY resolution as success and clear the retry, so
    // nothing was left to send the kill: the reject arm never runs for a
    // resolved promise, and the drain skips a key it has already attempted on
    // this arm. The PTY then outlived its tab until an unrelated route or
    // capability flap. An outstanding record after a resolved close is a kill
    // that is still owed.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    useLandingTerminalStore.getState().addTab({
      instanceId: "unsettled-kill-tab",
      sessionId: "session-unsettled-kill",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      pendingCreate: true,
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "unsettled-kill-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(mocks.kill).toHaveBeenCalledTimes(2);
  });

  it("switches to the plain arm the moment the projection appears, without waiting out the kill backoff", async () => {
    // An unacknowledged tombstone routes to `terminal.kill` while its create is
    // still in flight. When that create lands and the terminal is published,
    // the correct arm becomes `plain` - but the host has been `capable`
    // throughout, so a mark keyed on CAPABILITY read "already attempted" and
    // the new arm sat out the old one's backoff, up to the 300s ceiling, with
    // the PTY running the whole time.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = {};
    mocks.kill.mockRejectedValueOnce(new Error("not created yet"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "arm-swap-tab",
      sessionId: "session-arm-swap",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      pendingCreate: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "arm-swap-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(mocks.closeAsync).not.toHaveBeenCalled();

    // The create lands: this session is now a plain terminal the host
    // publishes, so `terminal.plain.close` is the arm that names it.
    mocks.terminalsById = { "session-arm-swap": {} };
    mocks.authorityRevision += 1;
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    // No timer advanced. The arm changed, so the drain must not sit on a
    // backoff the other arm ran up.
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("sends terminal.kill on a capable host whose listing is merely stale", async () => {
    // `canMutate` tracks LIST-STREAM freshness, not terminal liveness, and only
    // one arm reads a listing: `terminal.plain.close` names a row in the
    // projection, while `terminal.kill` is unary and never consults it. Gating
    // BOTH on freshness parked exactly the tombstones that never needed it -
    // and cancelled their retry records on the way past, so nothing was left to
    // wake when the stream recovered.
    //
    // The acknowledged case above still waits: `plain` is its arm, and that arm
    // genuinely needs a fresh listing.
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = false;
    mocks.terminalsById = {};
    useLandingTerminalStore.getState().addTab({
      instanceId: "stale-kill-tab",
      sessionId: "session-stale-kill",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "stale-kill-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-stale-kill",
      });
    });
    expect(mocks.closeAsync).not.toHaveBeenCalled();
  });

  it("leaves a joined close's tombstone to whoever owns the request", async () => {
    // The coordinator keys by the terminal's LIFETIME, not by RPC, so this
    // plain close can join an in-flight `terminal.kill` sent by the panel's
    // fast path. That kill answers an already-gone session with `killed: false`
    // as data, and for a `pendingCreate` record the kill mutation deliberately
    // KEEPS the tombstone. Clearing here off the joined promise would overrule
    // the owner and strand the PTY the create is about to produce.
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-joined": {} };
    useLandingTerminalStore.getState().addTab({
      instanceId: "joined-tab",
      sessionId: "session-joined",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "joined-tab");

    // Someone else's request is already in flight for this lifetime, and it
    // settles WITHOUT retiring the record.
    let releaseOwner = (): void => undefined;
    const ownerClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseOwner = resolve;
        }),
    );
    void requestLandingTerminalClose({
      hostId: "host-b",
      sessionId: "session-joined",
      close: ownerClose,
    });
    await waitFor(() => expect(ownerClose).toHaveBeenCalledTimes(1));

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    // It joined rather than sending a second request.
    expect(mocks.closeAsync).not.toHaveBeenCalled();

    await act(async () => {
      releaseOwner();
      await Promise.resolve();
    });

    expect(mocks.closeAsync).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("re-arms the plain close after joining a kill that kept the tombstone", async () => {
    // Declining to conclude is only HALF of what a joiner owes. It learned
    // nothing about its own arm, and the drain admits a key on exactly three
    // things: a drainability edge, FIRST SIGHT of the arm, or a due retry. A
    // joiner that returned having dropped its retry - while `attemptedRef`
    // still carried the `plain` mark - produced none of the three, so no close
    // was ever sent and the PTY the create is about to produce outlived its
    // tombstone. The test above stops at the settlement and passes either way;
    // the strand is only visible past it.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-rearm": {} };
    useLandingTerminalStore.getState().addTab({
      instanceId: "rearm-tab",
      sessionId: "session-rearm",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "rearm-tab");

    // Someone else owns the in-flight request for this lifetime and settles it
    // WITHOUT retiring the record - what `terminal.kill` does for a
    // `pendingCreate` tombstone it answers `killed: false` about.
    let releaseOwner = (): void => undefined;
    const ownerClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseOwner = resolve;
        }),
    );
    void requestLandingTerminalClose({
      hostId: "host-b",
      sessionId: "session-rearm",
      close: ownerClose,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ownerClose).toHaveBeenCalledTimes(1);

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.closeAsync).not.toHaveBeenCalled();

    await act(async () => {
      releaseOwner();
      await vi.advanceTimersByTimeAsync(0);
    });
    // The joined settlement is not this arm's answer, so nothing is concluded
    // from it and nothing is dispatched off it either.
    expect(mocks.closeAsync).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);

    // The re-arm. The key is free now, so this close is OWNED and may retire
    // the record on its own settlement.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
  });

  it("wakes a plain close when listing freshness returns", async () => {
    // The plain arm's first close rejects while the list stream happens to be
    // stale. No retry can be scheduled for an arm that is undrainable, so the
    // ONLY way back is the drainability edge - and keying that edge on `kill`
    // lost it, because `kill` stayed true the whole time. The mark still named
    // `plain`, so the drain skipped this key forever and the PTY outlived its
    // tombstone.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-refresh": {} };
    mocks.closeAsync.mockRejectedValueOnce(new Error("stream went stale"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "refresh-tab",
      sessionId: "session-refresh",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "refresh-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    // The stream goes stale as that first close rejects. `kill` is unaffected -
    // it never reads a listing - so nothing about the HOST's drainability moved.
    mocks.canMutate = false;
    mocks.authorityRevision += 1;
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    // Freshness returns. That is this arm's recovery edge even though the host
    // was continuously dialable and continuously `capable`.
    mocks.canMutate = true;
    mocks.authorityRevision += 1;
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);
  });

  it("retires a pending-create tombstone once its reprieve is spent", async () => {
    // `pendingCreate` makes `killed: false` ambiguous, so the kill mutation
    // keeps the record. Nothing here can ever falsify it: the tile that
    // dispatched the create is unmounted and its lifecycle hook drops the
    // settlement, so a create that REJECTED leaves a tombstone no answer can
    // retire - an RPC and an invalidation every five minutes, forever.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    useLandingTerminalStore.getState().addTab({
      instanceId: "doomed-create-tab",
      sessionId: "session-doomed-create",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      pendingCreate: true,
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "doomed-create-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).toHaveBeenCalledTimes(1);

    // Walk the ladder to one answer short of the budget. Every answer resolves
    // without killing anything, which is exactly what a create that never
    // landed looks like.
    for (let attempt = 1; attempt < 9; attempt += 1) {
      await act(async () => {
        vi.advanceTimersByTime(500 * 2 ** (attempt - 1));
        await Promise.resolve();
      });
    }
    expect(mocks.kill).toHaveBeenCalledTimes(9);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);

    // The tenth answer spends the budget, and the record retires on that same
    // pass rather than arming an eleventh attempt.
    await act(async () => {
      vi.advanceTimersByTime(128_000);
      await Promise.resolve();
    });
    expect(mocks.kill).toHaveBeenCalledTimes(10);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);

    // And it stays retired - no timer left armed to ask an eleventh time.
    await act(async () => {
      vi.advanceTimersByTime(600_000);
      await Promise.resolve();
    });
    expect(mocks.kill).toHaveBeenCalledTimes(10);
  });

  it("does not spend the pending-create reprieve on rejected kills", async () => {
    // A rejection is the transport failing to ask, not the host reporting the
    // session absent. Both settlement arms schedule a retry, so an
    // ATTEMPT-counted budget burned down on pure rejections and discarded a
    // tombstone nobody had answered for - leaking the PTY if the create landed.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    mocks.kill.mockRejectedValue(new Error("transport flap"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "rejected-kill-tab",
      sessionId: "session-rejected-kill",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      pendingCreate: true,
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "rejected-kill-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    // Walk well past the budget. Every attempt rejects, so no answer is earned.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await act(async () => {
        vi.advanceTimersByTime(300_000);
        await Promise.resolve();
      });
    }
    expect(mocks.kill.mock.calls.length).toBeGreaterThan(10);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("closes a terminal that appears after the reprieve is spent", async () => {
    // The final `killed: false` can race the create landing. A pass that sees
    // both an exhausted budget and a fresh projection must believe the positive
    // evidence: discarding there drops the tombstone in front of a live PTY.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = {};
    useLandingTerminalStore.getState().addTab({
      instanceId: "late-create-tab",
      sessionId: "session-late-create",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      pendingCreate: true,
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "late-create-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    // Nine answers against an absent projection: one short of the budget.
    for (let attempt = 1; attempt < 9; attempt += 1) {
      await act(async () => {
        vi.advanceTimersByTime(500 * 2 ** (attempt - 1));
        await Promise.resolve();
      });
    }
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);

    // Hold the TENTH kill in flight - the one whose answer spends the budget.
    let releaseFinalKill: (() => void) | null = null;
    mocks.kill.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFinalKill = () => resolve();
        }),
    );
    await act(async () => {
      vi.advanceTimersByTime(128_000);
      await Promise.resolve();
    });
    expect(mocks.kill).toHaveBeenCalledTimes(10);

    // The create lands WHILE that kill is in flight, so the host is publishing
    // the terminal by the time the answer comes back.
    mocks.terminalsById = { "session-late-create": {} };
    mocks.authorityRevision += 1;
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    // Now the tenth answer arrives. This pass holds BOTH a spent budget and a
    // live projection; the projection has to win.
    await act(async () => {
      releaseFinalKill?.();
      await Promise.resolve();
    });

    expect(mocks.closeAsync).toHaveBeenCalledWith({
      hostId: "host-b",
      terminalId: "session-late-create",
    });
  });

  it("retries a capable close after rejection and retires on acknowledgement", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-retry": {} };
    mocks.closeAsync
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    useLandingTerminalStore.getState().addTab({
      instanceId: "retry-tab",
      sessionId: "session-retry",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Retry",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "retry-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
  });

  it("retries a LEGACY kill after a transient rejection", async () => {
    // The legacy arm used to be a bare `mutate` with no rejection handling.
    // That was survivable only while an offline close was impossible; now this
    // is the path a legacy host's deferred kill travels, so a single transient
    // failure would otherwise strand the PTY until a route flap or a reload.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    mocks.kill
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    useLandingTerminalStore.getState().addTab({
      instanceId: "legacy-retry-tab",
      sessionId: "session-legacy-retry",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "legacy-retry-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(mocks.kill).toHaveBeenCalledTimes(2);
    expect(mocks.kill).toHaveBeenLastCalledWith({
      hostId: "host-b",
      sessionId: "session-legacy-retry",
    });
  });

  it("backs off repeated capable close failures without concurrent retries", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-backoff": {} };
    mocks.closeAsync.mockRejectedValue(new Error("still unavailable"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "backoff-tab",
      sessionId: "session-backoff",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Backoff",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "backoff-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(499);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(999);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(3);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("cancels capable retries when the bound host route disappears", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-host-change": {} };
    mocks.closeAsync.mockRejectedValue(new Error("transient"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "host-change-tab",
      sessionId: "session-host-change",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Host change",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "host-change-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    mocks.entries = [offlineHost];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("cancels capable retries when the bridge unmounts", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-unmount": {} };
    mocks.closeAsync.mockRejectedValue(new Error("transient"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "unmount-tab",
      sessionId: "session-unmount",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Unmount",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "unmount-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("fires the kill on offline -> connectable even when the offline stretch sat inside the relay-fuse window", async () => {
    // Production-shaped entries: a registry-`offline` REMOTE host carries the
    // shared relay `websocketUrl`, and inside the fuse window
    // `dialableHostEndpoint` is non-null - PERMISSION to attempt a recovery
    // dial, not availability. Recording that permission as "available" made
    // the later genuine offline -> connectable recovery a `true -> true`
    // non-edge: `terminal.kill` never fired and the supposedly-closed PTY
    // stayed alive until relaunch (only mutation success clears a tombstone).
    const remoteItem = (
      connectivity: HostConnectivity,
      lastSeenAt: string,
    ): HostListItem => ({
      hostId: "host-b",
      displayName: "Host B",
      platform: "Ubuntu",
      kind: "personal",
      publicKey: "pubkey-b",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatePolicy: "manual",
      status: {
        connectivity,
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.0.0",
        lastSeenAt,
      },
    });
    const relayUrl = "wss://relay.example/attach";
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();

    // Bridge is mounted while the host is genuinely attached.
    mocks.entries = [
      hostListItemToDirectoryEntry(
        remoteItem("connectable", recentLastSeen),
        relayUrl,
        PLAN_ALLOWS_REMOTE,
      ),
    ];
    const view = render(<LandingTerminalTombstoneRecoveryBridge />);

    // The host drops to `offline` with a recent lastSeenAt - the fuse window.
    mocks.entries = [
      hostListItemToDirectoryEntry(
        remoteItem("offline", recentLastSeen),
        relayUrl,
        PLAN_ALLOWS_REMOTE,
      ),
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    // A terminal on it is closed during that window.
    act(() => {
      useLandingTerminalStore.getState().addTab({
        instanceId: "fuse-tab",
        sessionId: "session-fuse",
        hostId: "host-b",
        cwd: "/workspace/project",
        name: "project",
        titleSource: "default",
      });
      useLandingTerminalStore.getState().closeTab("landing-page", "fuse-tab");
    });
    expect(mocks.kill).not.toHaveBeenCalled();

    // The genuine recovery edge: the relay re-attaches the host.
    mocks.entries = [
      hostListItemToDirectoryEntry(
        remoteItem("connectable", new Date().toISOString()),
        relayUrl,
        PLAN_ALLOWS_REMOTE,
      ),
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-fuse",
      });
    });
  });

  it("treats a READY remote session as confirmed recovery while the registry stays offline", async () => {
    // The registry never leaves `offline` for the whole credential-plane
    // incident, so the directory alone can never provide the recovery edge.
    // The recovery dial the fuse window kept open SUCCEEDS instead - the
    // resulting ready session is both the proof of recovery and the route the
    // kill travels, and the bridge learns about it through its readiness
    // subscription (the session cache is pull-only and emits nothing).
    vi.useFakeTimers();
    try {
      const remoteItem = (lastSeenAt: string): HostListItem => ({
        hostId: "host-b",
        displayName: "Host B",
        platform: "Ubuntu",
        kind: "personal",
        publicKey: "pubkey-b",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatePolicy: "manual",
        status: {
          connectivity: "offline",
          viewerReachability: "unknown",
          clientCloud: "ok",
          updateState: "current",
          appVersion: "1.0.0",
          lastSeenAt,
        },
      });
      const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
      mocks.entries = [
        hostListItemToDirectoryEntry(
          remoteItem(recentLastSeen),
          "wss://relay.example/attach",
          PLAN_ALLOWS_REMOTE,
        ),
      ];
      const view = render(<LandingTerminalTombstoneRecoveryBridge />);

      act(() => {
        useLandingTerminalStore.getState().addTab({
          instanceId: "incident-tab",
          sessionId: "session-incident",
          hostId: "host-b",
          cwd: "/workspace/project",
          name: "project",
          titleSource: "default",
        });
        useLandingTerminalStore
          .getState()
          .closeTab("landing-page", "incident-tab");
      });
      expect(mocks.kill).not.toHaveBeenCalled();

      // The recovery dial succeeds; the registry row is unchanged.
      mocks.readySessionHosts = new Set(["host-b"]);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
      // The close boundary dispatches on a microtask, so let it run.
      await act(async () => Promise.resolve());

      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-incident",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds the authority probe for a host that left the account, and keeps its tombstone", async () => {
    // host-b stays listed (the default fixture); the tombstone below names a
    // DIFFERENT host that has left the account entirely - deregistration, not
    // merely offline. Nothing is destroyed: deregistration revokes a credential
    // and leaves the machine untouched, so the record that its shell needs
    // killing has to outlive the probe that would have delivered it.
    mocks.entries = [offlineHost];
    mocks.fleetSettled.current = true;
    useLandingTerminalStore.getState().addTab({
      instanceId: "gone-tab",
      sessionId: "session-gone",
      hostId: "host-gone",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "gone-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.probedHostIds).toEqual([]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-gone",
        sessionId: "session-gone",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
  });

  it("probes again, and drains, when a deregistered host is re-enrolled under the same id", async () => {
    // `host-deregister-fetcher` documents that removal revokes the credential
    // and nothing else - "the hostId survives" and "re-enrollment re-adopts the
    // SAME id". Deleting the tombstone would have destroyed the kill record at
    // the exact moment it became useful again.
    mocks.entries = [offlineHost];
    mocks.fleetSettled.current = true;
    useLandingTerminalStore.getState().addTab({
      instanceId: "gone-tab",
      sessionId: "session-gone",
      hostId: "host-gone",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "gone-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.probedHostIds).toEqual([]);

    // The machine is set up again and re-adopts its old id.
    mocks.fleetSettled.current = true;
    mocks.entries = [offlineHost, { ...offlineHost, hostId: "host-gone" }];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.probedHostIds).toEqual(["host-gone"]);
  });

  it("probes every tombstoned host while the registry is unanswered, even though a local host keeps the snapshot non-empty", async () => {
    // Absence from a fleet nobody has answered for is not evidence of
    // anything. A directory snapshot is `localEntry` + `remoteEntries`, so a
    // machine running a local host renders one ordinary row whether the
    // registry answered or not - scoping on row count would strand host-b's
    // drain at every launch that started offline.
    mocks.entries = [localHost];
    mocks.fleetSettled.current = false;
    useLandingTerminalStore.getState().addTab({
      instanceId: "boot-tab",
      sessionId: "session-boot",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "boot-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.probedHostIds).toEqual(["host-b"]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-b",
        sessionId: "session-boot",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
  });

  it("keeps probing a host that is offline but still listed in the settled fleet", async () => {
    mocks.entries = [offlineHost];
    mocks.fleetSettled.current = true;
    useLandingTerminalStore.getState().addTab({
      instanceId: "offline-tab",
      sessionId: "session-offline",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "offline-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.probedHostIds).toEqual(["host-b"]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-b",
        sessionId: "session-offline",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
    expect(mocks.closeAsync).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("withholds probes for an ANSWERED empty fleet without discarding the tombstones", async () => {
    // An answered `[]` is knowledge - it is how a single-host account
    // deregisters - so the probe is withheld. The tombstone is still not
    // destroyed, because that same account can re-enroll the machine under the
    // id the tombstone already names.
    mocks.entries = [];
    mocks.fleetSettled.current = true;
    useLandingTerminalStore.getState().addTab({
      instanceId: "solo-tab",
      sessionId: "session-solo",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "solo-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.probedHostIds).toEqual([]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-b",
        sessionId: "session-solo",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
  });

  it("dispatches a tombstone recorded while its host was ALREADY drainable", async () => {
    // No route transition to ride in on, and no retry record yet. The two
    // conditions the drain gates on would both be false, so without a
    // first-sight rule this kill waits for the host to flap - and a close under
    // an unresolved probe dispatches nothing itself, so the bridge is the only
    // thing that would ever send it.
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    useLandingTerminalStore.getState().addTab({
      instanceId: "first-tab",
      sessionId: "session-first",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "first-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-first",
      });
    });
    // Counted, not just matched: `toHaveBeenCalledWith` passes on a duplicate,
    // and one gesture sending two kills is the thing the shared close boundary
    // exists to prevent.
    expect(mocks.kill).toHaveBeenCalledTimes(1);

    // Host stays drainable throughout - only the tombstone set changes.
    act(() => {
      useLandingTerminalStore.getState().addTab({
        instanceId: "second-tab",
        sessionId: "session-second",
        hostId: "host-b",
        cwd: "/workspace/project",
        name: "project",
        titleSource: "default",
      });
      useLandingTerminalStore.getState().closeTab("landing-page", "second-tab");
    });

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-second",
      });
    });
    // One dispatch per tombstone - the first close is not re-sent.
    expect(mocks.kill).toHaveBeenCalledTimes(2);
  });

  it("rescopes probes when settlement flips without the directory rows changing", async () => {
    // TanStack's structural sharing hands back the SAME `data` array when a
    // fetch produces deeply-equal rows - a desktop whose one local host is the
    // whole snapshot, with an empty remote listing. A derivation keyed on the
    // rows would never observe the flag move, so settlement is subscribed
    // through `onChange` instead. `mocks.entries` is deliberately NOT touched
    // here; only the flag moves.
    mocks.entries = [localHost];
    mocks.fleetSettled.current = false;
    useLandingTerminalStore.getState().addTab({
      instanceId: "gone-tab",
      sessionId: "session-gone",
      hostId: "host-gone",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "gone-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.probedHostIds).toEqual(["host-gone"]);

    mocks.fleetSettled.current = true;
    await act(async () => {
      mocks.emitDirectoryChange();
      await Promise.resolve();
    });

    expect(mocks.probedHostIds).toEqual([]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-gone",
        sessionId: "session-gone",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
  });

  it("re-dispatches with the NEW capability when authority flips during an in-flight close", async () => {
    // A `terminal.plain.close` incompatibility can drop a host back to legacy
    // while it stays dialable. The capable request then rejects, but
    // `closeRetryStillWarranted` refuses a retry because the capability no
    // longer matches the one that dispatched - and the authority-change render
    // had already skipped this key for being in flight. Clearing that ref
    // renders nothing, so without a capability-aware mark plus a signal on
    // settlement the correct close is never sent.
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-flip": {} };
    let rejectClose: (reason: Error) => void = () => undefined;
    mocks.closeAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectClose = reject;
        }),
    );
    useLandingTerminalStore.getState().addTab({
      instanceId: "flip-tab",
      sessionId: "session-flip",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "flip-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.kill).not.toHaveBeenCalled();

    // The host drops to legacy while that close is still outstanding.
    mocks.authorityStatus = "legacy";
    mocks.canMutate = false;
    mocks.authorityRevision += 1;
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).not.toHaveBeenCalled();

    await act(async () => {
      rejectClose(new Error("plain close unsupported"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-flip",
      });
    });
  });

  it("re-dispatches the other way too: legacy in flight, authority becomes capable", async () => {
    // The mirror of the case above. Same suppression in
    // `closeRetryStillWarranted`, same invisible `finally`, so the capability
    // -keyed mark has to work in both directions rather than only capable ->
    // legacy.
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    let rejectKill: (reason: Error) => void = () => undefined;
    mocks.kill.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectKill = reject;
        }),
    );
    useLandingTerminalStore.getState().addTab({
      instanceId: "mirror-tab",
      sessionId: "session-mirror",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "mirror-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(mocks.closeAsync).not.toHaveBeenCalled();

    // The probe resolves to the plain protocol while the kill is outstanding.
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-mirror": {} };
    mocks.authorityRevision += 1;
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).not.toHaveBeenCalled();

    await act(async () => {
      rejectKill(new Error("legacy kill unsupported"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.closeAsync).toHaveBeenCalledWith({
        hostId: "host-b",
        terminalId: "session-mirror",
      });
    });
  });

  it("backs a permanently failing kill off to a long interval, and never gives up", async () => {
    // The cost this guards is a permanent failure retrying every 8s for as long
    // as the app is open. It is answered by GROWING the interval rather than by
    // an attempt budget: a budget reaches a state the drain cannot leave, and a
    // tombstone is a kill that is still owed.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    mocks.kill.mockImplementation(() =>
      Promise.reject(new Error("permanently rejected")),
    );
    useLandingTerminalStore.getState().addTab({
      instanceId: "doomed-tab",
      sessionId: "session-doomed",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "doomed-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.kill).toHaveBeenCalledTimes(1);

    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // An hour of wall clock. Under the old 8s ceiling this would be ~450 calls.
    for (let round = 0; round < 60; round += 1) await advance(60_000);
    const afterAnHour = mocks.kill.mock.calls.length;
    expect(afterAnHour).toBeLessThan(30);

    // Still owed, and still trying - the drain has not parked itself.
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-b",
        sessionId: "session-doomed",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
    for (let round = 0; round < 10; round += 1) await advance(60_000);
    expect(mocks.kill.mock.calls.length).toBeGreaterThan(afterAnHour);
  });

  it("restarts the backoff when the host changes capability", async () => {
    // A protocol change deserves a prompt attempt rather than inheriting a long
    // interval the other arm ran up while failing.
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "legacy";
    mocks.kill.mockImplementation(() =>
      Promise.reject(new Error("permanently rejected")),
    );
    useLandingTerminalStore.getState().addTab({
      instanceId: "budget-tab",
      sessionId: "session-budget",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "budget-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // Run the legacy arm out to its long interval.
    for (let round = 0; round < 30; round += 1) await advance(60_000);

    // The host comes back speaking the plain protocol, still failing.
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-budget": {} };
    mocks.authorityRevision += 1;
    mocks.closeAsync.mockImplementation(() =>
      Promise.reject(new Error("still failing")),
    );
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    // Let the dispatch AND its rejection settle, so the retry timer is armed
    // before the clock moves.
    await advance(0);
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    // Retried on the SHORT end of the schedule, not the ceiling the legacy arm
    // had climbed to.
    await advance(1_000);
    expect(mocks.closeAsync.mock.calls.length).toBeGreaterThan(1);
  });
});
