import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import { __setCommGraphCloudSubscriptionOpenerForTests } from "@/lib/comm-graph/comm-graph-opener-override";
import {
  __resetCommGraphCloudRegistryForTests,
  getCommGraphCloudSubscriptionManager,
} from "@/lib/comm-graph/comm-graph-cloud-registry";
import {
  acquireCommGraphSubscription,
  getCommGraphSubscriptionManager,
  releaseCommGraphSubscription,
  __resetCommGraphRegistryForTests,
} from "@/lib/comm-graph/comm-graph-registry";
import type { CommGraphCloudSubscriptionRequest } from "@/lib/comm-graph/comm-graph-cloud-subscription";
import {
  readCommGraphTimelineEpicState,
  useCommGraphTimelineStore,
} from "@/stores/epics/comm-graph-timeline-store";
import { commGraphCursorForEvent } from "@/lib/comm-graph/comm-graph-timeline";
import { useAuthStore } from "@/stores/auth/auth-store";

const PROFILE = { userId: "user-1", userName: "U", email: "u@example.com" };
const CONTEXT = { userId: "user-1", username: "U" };

const directoryEntries = vi.hoisted(() => ({
  current: [] as ReadonlyArray<HostDirectoryEntry>,
}));

// ONE hoisted spy, not `() => vi.fn()`.
//
// The old form minted a NEW spy on every render, which is worse than merely
// unstable: it is unassertable by construction, because any expectation would
// be reading a spy the component had already replaced. Nothing here asserts on
// it today, which is the only reason that read as harmless. Stability also
// matters for its own sake — the real hook returns one opener for a
// component's life, and effects depend on it; see
// `lib/registries/__tests__/chat-session-registry.test.ts`.
const openTransportStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: directoryEntries.current,
  }),
}));

function cloudEvent(
  overrides: Partial<HostCommunicationGraphCloudFeedEvent>,
): HostCommunicationGraphCloudFeedEvent {
  return {
    eventId: "cloud-event",
    originHostId: "origin-a",
    originSequence: 9,
    ingestVersion: 20,
    kind: "a2a_message",
    capturedAt: 2_000,
    senderAgentId: "agent-a",
    receiverAgentId: "agent-b",
    responseId: null,
    inReplyTo: null,
    expectReply: true,
    messageText: "from cloud",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    peerEpicId: null,
    historicalUpload: false,
    ...overrides,
  };
}

describe("useCommGraphSnapshot cloud authority", () => {
  beforeEach(() => {
    directoryEntries.current = [];
    // The cloud claim is held only under a cloud verdict; every case here
    // models a verified session unless it says otherwise.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
    __resetCommGraphCloudRegistryForTests();
    __resetCommGraphRegistryForTests();
  });

  afterEach(() => {
    // Unmount BEFORE the store flips: a hook left mounted by an earlier case
    // re-renders on every auth change the next case makes, re-claims the
    // relay through the next case's opener override, and its release then
    // redials the orphaned host - an extra open attributed to nobody.
    cleanup();
    useAuthStore.getState().setSignedOut();
    __setCommGraphCloudSubscriptionOpenerForTests(null);
    __resetCommGraphCloudRegistryForTests();
    __resetCommGraphRegistryForTests();
  });

  it("never opens a local subscription while the cloud relay is pending or available", async () => {
    // No `__setCommGraphSubscriptionOpenerForTests` exists any more - the
    // seam was deleted along with the fallback it fed. The only thing left to
    // assert is structural: the epic's LOCAL registry manager (still exported
    // for a possible future explicit local-only mode, see
    // `use-comm-graph-snapshot.ts`) must never be attached by this hook.
    const localManager = getCommGraphSubscriptionManager("epic-1");
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));

    // Pending: the relay has not answered yet.
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(localManager.isAttached()).toBe(false);

    act(() => cloudRequests[0].handlers.onAvailability("available"));
    // Available: still never touches the local plane.
    expect(localManager.isAttached()).toBe(false);
  });

  it("never opens a local subscription once every candidate relay is unsupported", async () => {
    const localManager = getCommGraphSubscriptionManager("epic-1");
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));

    act(() => cloudRequests[0].handlers.onStatus("unsupported"));

    expect(
      getCommGraphCloudSubscriptionManager("epic-1").getAvailability(),
    ).toBe("unsupported");
    expect(localManager.isAttached()).toBe(false);
  });

  it("ignores rows already cached in the local manager from a prior session", async () => {
    // Simulates upgrading from a build that still fed the local fan-in: an
    // epic can carry a populated, detached local manager from before this
    // change. `useCommGraphSnapshot` must never read it, in any cloud state.
    const staleClaim = {};
    const staleClose = vi.fn();
    // `acquireCommGraphSubscription` requires the registry entry to already
    // exist (it early-returns otherwise) - resolving the manager first is
    // what creates it, exactly as the real hook's `useMemo` does at render.
    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription(
      "epic-1",
      staleClaim,
      (request) => {
        request.handlers.onSnapshot(
          [
            {
              id: 1,
              kind: "a2a_message",
              timestamp: 1_000,
              senderAgentId: "agent-a",
              receiverAgentId: "agent-b",
              responseId: null,
              inReplyTo: null,
              expectReply: true,
              messageText: "stale local row",
              noticeReason: null,
              originKind: null,
              originChatId: null,
              originRefId: null,
              peerEpicId: null,
            },
          ],
          1,
        );
        return { close: staleClose };
      },
      ["origin-a"],
    );
    releaseCommGraphSubscription("epic-1", staleClaim);
    expect(
      getCommGraphSubscriptionManager("epic-1")
        .getSnapshot()
        .events.map((event) => event.messageText),
    ).toEqual(["stale local row"]);

    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { result } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["origin-a"], null),
    );
    // Pending: the stale row must not leak in before the relay answers.
    expect(result.current.events).toEqual([]);

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    act(() => {
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([cloudEvent({})], 20, null);
    });
    // Available: only the cloud row appears.
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);

    act(() => cloudRequests[0].handlers.onStatus("unsupported"));
    // Unsupported: still no reach for the stale local cache.
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
  });

  it("retains cloud rows through relay disconnect, unsupported, and an auth demotion, and resumes on restoration", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { result } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["origin-a"], null),
    );
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    act(() => {
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([cloudEvent({})], 20, null);
    });
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);

    // Transient relay disconnect: the row stays.
    act(() => cloudRequests[0].handlers.onStatus("reconnecting"));
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);

    // Every candidate now unsupported: the row still stays.
    act(() => cloudRequests[0].handlers.onStatus("unsupported"));
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
    expect(result.current.hosts[0]?.status).toBe("unsupported");

    // Auth demotion: the claim releases, the manager detaches, and the row
    // is still readable - only the reported feed goes non-live.
    const cloudOpenedBeforeDemotion = cloudRequests.length;
    act(() => {
      useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    });
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
    expect(result.current.hosts[0]?.status).toBe("reconnecting");

    // Restoration: re-verification re-claims the relay. Reattaching clears
    // the prior cycle's sticky `unsupported` verdict, so the same host is
    // retried rather than staying permanently rejected.
    act(() => {
      useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    });
    await waitFor(() =>
      expect(cloudRequests.length).toBeGreaterThan(cloudOpenedBeforeDemotion),
    );
    act(() => {
      cloudRequests[cloudRequests.length - 1].handlers.onStatus("live");
    });
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
    expect(result.current.hosts[0]?.status).toBe("live");
  });

  it("reports initialHistoryCaughtUp false after a bounded snapshot and true only once onCaughtUp fires", async () => {
    // Snapshot and caught-up progress are distinct wire frames - a bounded
    // initial snapshot is not itself a completeness claim, and the hook must
    // not treat the two as one signal.
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { result } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["origin-a"], null),
    );
    await waitFor(() => expect(cloudRequests).toHaveLength(1));

    act(() => {
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([cloudEvent({})], 20, null);
    });
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
    expect(result.current.initialHistoryCaughtUp).toBe(false);

    act(() =>
      cloudRequests[0].handlers.onCaughtUp(
        { ingestVersion: 20, eventId: "cloud-event" },
        20,
      ),
    );
    expect(result.current.initialHistoryCaughtUp).toBe(true);
  });

  it("rebases a held local cursor onto the equivalent canonical cloud row", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    // A cursor persisted by a build that still read the local plane - the
    // migration path this reconciliation exists for.
    const localEvent = {
      id: 9,
      hostId: "origin-a",
      kind: "a2a_message" as const,
      timestamp: 2_000,
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      responseId: null,
      inReplyTo: null,
      expectReply: true,
      messageText: "from local",
      noticeReason: null,
      originKind: null,
      originChatId: null,
      originRefId: null,
      peerEpicId: null,
    };
    act(() => {
      useCommGraphTimelineStore
        .getState()
        .setCursor("epic-1", commGraphCursorForEvent(localEvent));
    });

    act(() => cloudRequests[0].handlers.onAvailability("available"));
    expect(readCommGraphTimelineEpicState("epic-1").cursor).toEqual(
      commGraphCursorForEvent(localEvent),
    );

    act(() => {
      cloudRequests[0].handlers.onSnapshot([cloudEvent({})], 20, null);
      cloudRequests[0].handlers.onCaughtUp(
        { ingestVersion: 20, eventId: "cloud-event" },
        20,
      );
    });

    await waitFor(() =>
      expect(readCommGraphTimelineEpicState("epic-1").cursor?.eventId).toBe(
        "cloud-event",
      ),
    );
  });

  it("holds a local cursor until bounded cloud history reaches its initial head", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    const localEvent = {
      id: 9,
      hostId: "origin-a",
      kind: "a2a_message" as const,
      timestamp: 2_000,
      senderAgentId: "agent-a",
      receiverAgentId: "agent-b",
      responseId: null,
      inReplyTo: null,
      expectReply: true,
      messageText: "from local",
      noticeReason: null,
      originKind: null,
      originChatId: null,
      originRefId: null,
      peerEpicId: null,
    };
    const localCursor = commGraphCursorForEvent(localEvent);
    act(() => {
      useCommGraphTimelineStore.getState().setCursor("epic-1", localCursor);
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot(
        [
          {
            ...cloudEvent({}),
            eventId: "cloud-before",
            originSequence: 8,
            ingestVersion: 10,
            capturedAt: 1_000,
          },
        ],
        20,
        null,
      );
    });

    expect(readCommGraphTimelineEpicState("epic-1").cursor).toEqual(
      localCursor,
    );

    act(() => {
      cloudRequests[0].handlers.onEvent(cloudEvent({}));
      cloudRequests[0].handlers.onCaughtUp(
        { ingestVersion: 20, eventId: "cloud-event" },
        20,
      );
    });

    await waitFor(() =>
      expect(readCommGraphTimelineEpicState("epic-1").cursor?.eventId).toBe(
        "cloud-event",
      ),
    );
  });

  it("releases a held local cursor when the cloud head ends in a skipped row", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    const localCursor = {
      timestamp: 3_000,
      hostId: "origin-a",
      id: 12,
    };
    act(() => {
      useCommGraphTimelineStore.getState().setCursor("epic-1", localCursor);
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([cloudEvent({})], 21, null);
    });
    expect(readCommGraphTimelineEpicState("epic-1").cursor).toEqual(
      localCursor,
    );

    act(() =>
      cloudRequests[0].handlers.onCaughtUp(
        { ingestVersion: 21, eventId: "unrepresentable-row" },
        21,
      ),
    );

    await waitFor(() =>
      expect(readCommGraphTimelineEpicState("epic-1").cursor).toBeNull(),
    );
    expect(cloudRequests[0].readSinceCursor()).toEqual({
      ingestVersion: 21,
      eventId: "unrepresentable-row",
    });
  });

  it("holds the cloud claim only while the session holds a cloud verdict", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    // One close spy PER handle: the manager may redial the same relay on a
    // readiness-key change, so "the stream is closed" is a claim about every
    // handle it opened, not about a call count on one shared spy.
    const cloudCloses: Mock<() => void>[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      const close = vi.fn<() => void>();
      cloudCloses.push(close);
      return { close };
    });
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));

    // No history authority and no local plane to serve the unverified
    // session either - the relay is simply not claimed without a verdict.
    expect(cloudRequests).toHaveLength(0);

    // Non-vacuity: the verdict returning is what claims the relay...
    act(() => {
      useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    });
    await waitFor(() => expect(cloudRequests.length).toBeGreaterThan(0));

    // ...and withdrawing it while the tile stays mounted closes every handle
    // and opens no other.
    const openedBeforeDemotion = cloudRequests.length;
    act(() => {
      useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    });
    await waitFor(() =>
      expect(cloudCloses.every((close) => close.mock.calls.length > 0)).toBe(
        true,
      ),
    );
    expect(cloudRequests).toHaveLength(openedBeforeDemotion);
  });

  it("uses a signed-in non-origin host to relay the cloud feed", async () => {
    directoryEntries.current = [directoryEntry("relay-b", undefined)];
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() =>
      useCommGraphSnapshot("epic-1", ["offline-origin-a"], null),
    );

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("relay-b");
  });

  it("skips unavailable directory entries when choosing a cloud relay", async () => {
    // Both halves of this fixture are load-bearing, and it used to have
    // neither.
    //
    // `transportDialability: "not-dialable"` ALONE does not make an entry
    // undialable: the memo's predicate is `dialableHostEndpointFor`, which
    // refuses only a missing `websocketUrl` or a CONFIRMED refusal, and
    // `hostUnavailability` reads a `not-dialable` remote entry whose
    // `connectivity` is still `connectable` as `indeterminate` - which
    // deliberately DIALS. So the entry has to carry the offline connectivity
    // that produced the coarse bit, or it is merely a `dialable` entry
    // wearing a `not-dialable` label.
    //
    // And the unavailable host has to sort FIRST, or the assertion is
    // satisfied by ID order rather than by the filter. That is exactly how
    // this test passed while pinning nothing: "available-relay" sorts before
    // "unavailable-relay", so removing the filter entirely left it green.
    //
    // Falsification: delete the `.filter(...)` on `hostDirectory.data` in the
    // `relayHostIds` memo and this reddens - "aaa-unavailable-relay" sorts
    // first among the non-local entries and would be dialed.
    directoryEntries.current = [
      directoryEntry("aaa-unavailable-relay", {
        transportDialability: "not-dialable",
        remoteStatus: {
          connectivity: "offline",
          viewerReachability: "ok",
          clientCloud: "ok",
          updateState: "current",
          appVersion: null,
          lastSeenAt: null,
        },
      }),
      directoryEntry("zzz-available-relay", undefined),
    ];
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() =>
      useCommGraphSnapshot("epic-1", ["offline-origin-a"], null),
    );

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("zzz-available-relay");
  });

  it("retries a rejected fallback relay when that same host publishes its endpoint", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    let endpointPublished = false;
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      if (!endpointPublished) throw new Error("host endpoint is not ready");
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { rerender } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["relay-a"], null),
    );
    expect(cloudRequests).toHaveLength(0);

    endpointPublished = true;
    directoryEntries.current = [directoryEntry("relay-a", { version: "2.0" })];
    rerender();

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("relay-a");
  });

  it("retries a rejected remote relay after its public key rotates", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    let acceptsRelay = false;
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      if (!acceptsRelay) throw new Error("remote relay key rejected");
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    directoryEntries.current = [
      directoryEntry("relay-a", { publicKey: "public-key-a" }),
    ];
    const { rerender } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["relay-a"], null),
    );
    expect(cloudRequests).toHaveLength(0);

    acceptsRelay = true;
    directoryEntries.current = [
      directoryEntry("relay-a", { publicKey: "public-key-b" }),
    ];
    rerender();

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("relay-a");
  });

  it("keeps a healthy relay attached when an unrelated host entry changes", async () => {
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    const cloudClose = vi.fn();
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: cloudClose };
    });

    directoryEntries.current = [directoryEntry("relay-a", undefined)];
    const { rerender } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["relay-a"], null),
    );
    await waitFor(() => expect(cloudRequests).toHaveLength(1));

    directoryEntries.current = [
      directoryEntry("relay-a", undefined),
      directoryEntry("relay-z", { publicKey: "public-key-z" }),
    ];
    rerender();

    expect(cloudClose).not.toHaveBeenCalled();
    expect(cloudRequests).toHaveLength(1);
  });

  describe("tab-host relay ordering", () => {
    it("relays through the tab's host even when another directory host sorts first", async () => {
      // The tab host sorts LAST, so this can only pass if the memo hoists it;
      // under the plain id order it would dial "aaa-other".
      directoryEntries.current = [
        directoryEntry("aaa-other", undefined),
        directoryEntry("zzz-tab", undefined),
      ];
      const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
      __setCommGraphCloudSubscriptionOpenerForTests((request) => {
        cloudRequests.push(request);
        return { close: vi.fn() };
      });

      renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], "zzz-tab"));

      await waitFor(() => expect(cloudRequests).toHaveLength(1));
      // Falsification: delete the tab-host hoist at the end of the
      // `relayHostIds` memo (return `orderedHostIds` unconditionally) and this
      // reddens - "aaa-other" sorts first and would be dialed instead.
      expect(cloudRequests[0].hostId).toBe("zzz-tab");
    });

    it("falls back to id order when the tab host is not a dialable directory entry", async () => {
      // Insertion order is the reverse of id order, so this also pins the
      // `.sort()`. The tab host names a machine the directory cannot dial.
      directoryEntries.current = [
        directoryEntry("zzz-remote", undefined),
        directoryEntry("aaa-remote", undefined),
      ];
      const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
      __setCommGraphCloudSubscriptionOpenerForTests((request) => {
        cloudRequests.push(request);
        return { close: vi.fn() };
      });

      renderHook(() =>
        useCommGraphSnapshot("epic-1", ["origin-a"], "absent-from-directory"),
      );

      await waitFor(() => expect(cloudRequests).toHaveLength(1));
      // Falsification, two ways: drop the `orderedHostIds.includes(tabHostId)`
      // guard and the memo prepends a host the directory cannot dial, so
      // "absent-from-directory" is dialed; or delete the `.sort()` and
      // insertion order dials "zzz-remote". Either reddens this.
      expect(cloudRequests[0].hostId).toBe("aaa-remote");
    });

    it("rides a remote tab host when the directory holds no local host at all, and a directory re-emit never closes it", async () => {
      // The mobile shape: no `kind === "local"` entry exists anywhere, so the
      // feed has to work through the remote host the tab was opened on.
      directoryEntries.current = [
        directoryEntry("aaa-other-remote", undefined),
        directoryEntry("zzz-tab-remote", undefined),
      ];
      const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
      const cloudClose = vi.fn();
      __setCommGraphCloudSubscriptionOpenerForTests((request) => {
        cloudRequests.push(request);
        return { close: cloudClose };
      });

      const { rerender } = renderHook(() =>
        useCommGraphSnapshot("epic-1", ["origin-a"], "zzz-tab-remote"),
      );
      await waitFor(() => expect(cloudRequests).toHaveLength(1));
      expect(cloudRequests[0].hostId).toBe("zzz-tab-remote");
      expect(
        directoryEntries.current.some((entry) => entry.kind === "local"),
      ).toBe(false);

      // Same directory CONTENT, fresh entry objects - the benign re-emit the
      // hook sees constantly. Both memos rebuild by identity; nothing may move.
      directoryEntries.current = [
        directoryEntry("aaa-other-remote", undefined),
        directoryEntry("zzz-tab-remote", undefined),
      ];
      rerender();

      // Falsification: make `reconcileRelays` close the incumbent
      // unconditionally (delete its incumbent-close condition) and this
      // reddens - the healthy remote relay is torn down and redialed by a
      // re-emit that changed nothing.
      expect(cloudClose).not.toHaveBeenCalled();
      expect(cloudRequests).toHaveLength(1);
    });

    it("keeps a healthy tab-host relay when another candidate joins ahead of the others", async () => {
      directoryEntries.current = [
        directoryEntry("mmm-other", undefined),
        directoryEntry("zzz-tab", undefined),
      ];
      const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
      const cloudClose = vi.fn();
      __setCommGraphCloudSubscriptionOpenerForTests((request) => {
        cloudRequests.push(request);
        return { close: cloudClose };
      });

      const { rerender } = renderHook(() =>
        useCommGraphSnapshot("epic-1", ["origin-a"], "zzz-tab"),
      );
      await waitFor(() => expect(cloudRequests).toHaveLength(1));
      expect(cloudRequests[0].hostId).toBe("zzz-tab");

      // A host that sorts before every other candidate appears. The tab host
      // stays at the head, and the tail reorders beneath it.
      directoryEntries.current = [
        directoryEntry("mmm-other", undefined),
        directoryEntry("zzz-tab", undefined),
        directoryEntry("aaa-newcomer", undefined),
      ];
      rerender();

      // Falsification: delete the incumbent-close condition in
      // `reconcileRelays` (always close) and this reddens - a candidate
      // joining the list would tear down a healthy relay.
      expect(cloudClose).not.toHaveBeenCalled();
      expect(cloudRequests).toHaveLength(1);
    });

    it("resolves a late directory arrival to exactly the origin then the tab host, and nothing else", async () => {
      const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
      __setCommGraphCloudSubscriptionOpenerForTests((request) => {
        cloudRequests.push(request);
        return { close: vi.fn() };
      });

      // No directory entries yet: the memo falls back to the epic's origin
      // hostIds, dialed under a "directory-pending" readiness key.
      directoryEntries.current = [];
      const { rerender } = renderHook(() =>
        useCommGraphSnapshot("epic-1", ["aaa-origin"], "zzz-tab"),
      );
      await waitFor(() => expect(cloudRequests).toHaveLength(1));
      expect(cloudRequests[0].hostId).toBe("aaa-origin");

      // The directory arrives carrying the tab's host. "aaa-origin" is not a
      // directory entry, so it leaves the candidate set and the incumbent's
      // own readiness key changes ("directory-pending" -> gone), reopening
      // onto the new order.
      directoryEntries.current = [directoryEntry("zzz-tab", undefined)];
      rerender();

      await waitFor(() => expect(cloudRequests).toHaveLength(2));
      // Falsification: split the hook's one `reconcileRelays` effect back
      // into the two setter effects it supersedes, in the order the hook used
      // to run them (readiness keys, then host ids), and this reddens with
      // `["aaa-origin", "aaa-origin", "zzz-tab"]`. The readiness effect runs
      // while the host list is still the fallback `["aaa-origin"]`, sees the
      // incumbent's own key change ("directory-pending" -> absent), and
      // closes and REDIALS aaa-origin before the list effect has replaced it.
      // That intermediate open against half-installed state is what the
      // exact-array assertion below refuses.
      expect(cloudRequests.map((request) => request.hostId)).toEqual([
        "aaa-origin",
        "zzz-tab",
      ]);
    });
  });
});

function directoryEntry(
  hostId: string,
  overrides: Partial<RemoteHostDirectoryEntry> | undefined,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: `ws://${hostId}/rpc`,
    transportDialability: "dialable",
    version: null,
    publicKey: "public-key-a",
    relayFuseGrace: false,
    recentHostCheckIn: false,
    planAllowsRemote: true,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    ...overrides,
  };
}
