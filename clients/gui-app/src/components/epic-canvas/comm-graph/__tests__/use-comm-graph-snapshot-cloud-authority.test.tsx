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
      useCommGraphSnapshot("epic-1", ["origin-a"]),
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
      useCommGraphSnapshot("epic-1", ["origin-a"]),
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
      useCommGraphSnapshot("epic-1", ["origin-a"]),
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

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"]));
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

    renderHook(() => useCommGraphSnapshot("epic-1", ["origin-a"]));
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

    renderHook(() => useCommGraphSnapshot("epic-1", ["offline-origin-a"]));

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("relay-b");
  });

  it("skips unavailable directory entries when choosing a cloud relay", async () => {
    directoryEntries.current = [
      directoryEntry("unavailable-relay", {
        transportDialability: "not-dialable",
      }),
      directoryEntry("available-relay", undefined),
    ];
    __setCommGraphSubscriptionOpenerForTests(() => ({ close: vi.fn() }));
    const cloudRequests: CommGraphCloudSubscriptionRequest[] = [];
    __setCommGraphCloudSubscriptionOpenerForTests((request) => {
      cloudRequests.push(request);
      return { close: vi.fn() };
    });

    renderHook(() => useCommGraphSnapshot("epic-1", ["offline-origin-a"]));

    await waitFor(() => expect(cloudRequests).toHaveLength(1));
    expect(cloudRequests[0].hostId).toBe("available-relay");
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
      useCommGraphSnapshot("epic-1", ["relay-a"]),
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
      useCommGraphSnapshot("epic-1", ["relay-a"]),
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
      useCommGraphSnapshot("epic-1", ["relay-a"]),
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
