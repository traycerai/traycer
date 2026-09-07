import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import {
  __setCommGraphCloudSubscriptionOpenerForTests,
  __setCommGraphSubscriptionOpenerForTests,
} from "@/lib/comm-graph/comm-graph-opener-override";
import { __resetCommGraphRegistryForTests } from "@/lib/comm-graph/comm-graph-registry";
import { __resetCommGraphCloudRegistryForTests } from "@/lib/comm-graph/comm-graph-cloud-registry";
import type { CommGraphSubscriptionRequest } from "@/lib/comm-graph/comm-graph-subscription";
import type { CommGraphCloudSubscriptionRequest } from "@/lib/comm-graph/comm-graph-cloud-subscription";
import {
  readCommGraphTimelineEpicState,
  useCommGraphTimelineStore,
} from "@/stores/epics/comm-graph-timeline-store";
import { commGraphCursorForEvent } from "@/lib/comm-graph/comm-graph-timeline";

const directoryEntries = vi.hoisted(() => ({
  current: [] as ReadonlyArray<HostDirectoryEntry>,
}));

// Nothing here asserts on it today, which is the only reason that read as harmless.
const openTransportStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: directoryEntries.current,
  }),
}));

function cloudEvent(): HostCommunicationGraphCloudFeedEvent {
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
    historicalUpload: false,
  };
}

describe("useCommGraphSnapshot cloud authority", () => {
  beforeEach(() => {
    directoryEntries.current = [];
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
    __resetCommGraphCloudRegistryForTests();
    __resetCommGraphRegistryForTests();
  });

  afterEach(() => {
    __setCommGraphCloudSubscriptionOpenerForTests(null);
    __setCommGraphSubscriptionOpenerForTests(null);
    __resetCommGraphCloudRegistryForTests();
    __resetCommGraphRegistryForTests();
  });

  it("detaches local on host-confirmed cloud authority and never unions it back during relay failure", async () => {
    const localRequests: CommGraphSubscriptionRequest[] = [];
    const localClose = vi.fn();
    __setCommGraphSubscriptionOpenerForTests((request) => {
      localRequests.push(request);
      return { close: localClose };
    });
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { result } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["origin-a"], null),
    );
    await waitFor(() => expect(localRequests).toHaveLength(1));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("origin-a");

    act(() => {
      localRequests[0].handlers.onSnapshot(
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
            messageText: "local only",
            noticeReason: null,
            originKind: null,
            originChatId: null,
            originRefId: null,
          },
        ],
        1,
      );
    });
    expect(result.current.events[0]?.messageText).toBe("local only");

    act(() => {
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([cloudEvent()], 20, null);
    });
    await waitFor(() => expect(localClose).toHaveBeenCalledTimes(1));
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);

    act(() => cloudRequests[0].handlers.onStatus("reconnecting"));
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
    expect(localRequests).toHaveLength(1);
  });

  it("selects an empty cloud snapshot instead of retaining local rows", async () => {
    const localRequests: CommGraphSubscriptionRequest[] = [];
    const localClose = vi.fn();
    __setCommGraphSubscriptionOpenerForTests((request) => {
      localRequests.push(request);
      return { close: localClose };
    });
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { result } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["origin-a"], null),
    );
    await waitFor(() => expect(localRequests).toHaveLength(1));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));

    act(() => {
      localRequests[0].handlers.onSnapshot(
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
            messageText: "local only",
            noticeReason: null,
            originKind: null,
            originChatId: null,
            originRefId: null,
          },
        ],
        1,
      );
    });
    expect(result.current.events[0]?.messageText).toBe("local only");

    act(() => {
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([], 0, null);
    });

    await waitFor(() => expect(localClose).toHaveBeenCalledTimes(1));
    expect(result.current.events).toEqual([]);
  });

  it("rebases a held local cursor onto the equivalent canonical cloud row", async () => {
    const localRequests: CommGraphSubscriptionRequest[] = [];
    __setCommGraphSubscriptionOpenerForTests((request) => {
      localRequests.push(request);
      return { close: vi.fn() };
    });
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    const { result } = renderHook(() =>
      useCommGraphSnapshot("epic-1", ["origin-a"], null),
    );
    await waitFor(() => expect(localRequests).toHaveLength(1));
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
    };
    act(() => {
      localRequests[0].handlers.onSnapshot([localEvent], 9);
      useCommGraphTimelineStore
        .getState()
        .setCursor("epic-1", commGraphCursorForEvent(localEvent));
    });

    act(() => cloudRequests[0].handlers.onAvailability("available"));
    expect(readCommGraphTimelineEpicState("epic-1").cursor).toEqual(
      commGraphCursorForEvent(localEvent),
    );

    act(() => {
      cloudRequests[0].handlers.onSnapshot([cloudEvent()], 20, null);
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
    expect(result.current.events.map((event) => event.eventId)).toEqual([
      "cloud-event",
    ]);
  });

  it("holds a local cursor until bounded cloud history reaches its initial head", async () => {
    const localRequests: CommGraphSubscriptionRequest[] = [];
    __setCommGraphSubscriptionOpenerForTests((request) => {
      localRequests.push(request);
      return { close: vi.fn() };
    });
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));
    await waitFor(() => expect(localRequests).toHaveLength(1));
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
    };
    const localCursor = commGraphCursorForEvent(localEvent);
    act(() => {
      localRequests[0].handlers.onSnapshot([localEvent], 9);
      useCommGraphTimelineStore.getState().setCursor("epic-1", localCursor);
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot(
        [
          {
            ...cloudEvent(),
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
      cloudRequests[0].handlers.onEvent(cloudEvent());
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
    const localRequests: CommGraphSubscriptionRequest[] = [];
    __setCommGraphSubscriptionOpenerForTests((request) => {
      localRequests.push(request);
      return { close: vi.fn() };
    });
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"], null));
    await waitFor(() => expect(localRequests).toHaveLength(1));
    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    const localCursor = {
      timestamp: 3_000,
      hostId: "origin-a",
      id: 12,
    };
    act(() => {
      useCommGraphTimelineStore.getState().setCursor("epic-1", localCursor);
      cloudRequests[0].handlers.onAvailability("available");
      cloudRequests[0].handlers.onSnapshot([cloudEvent()], 21, null);
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

  it("uses a signed-in non-origin host to relay the cloud feed", async () => {
    directoryEntries.current = [directoryEntry("relay-b", undefined)];
    __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
    __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
    __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
    __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
    __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
      __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
      __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
      __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
      __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
      __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
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
