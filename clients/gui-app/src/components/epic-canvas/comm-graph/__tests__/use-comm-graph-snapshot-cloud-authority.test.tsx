import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useCommGraphSnapshot } from "@/components/epic-canvas/comm-graph/use-comm-graph-snapshot";
import {
  __setCommGraphCloudSubscriptionOpenerForTests,
  __setCommGraphSubscriptionOpenerForTests,
} from "@/lib/comm-graph/comm-graph-opener-override";
import { __resetCommGraphRegistryForTests } from "@/lib/comm-graph/comm-graph-registry";
import { __resetCommGraphCloudRegistryForTests } from "@/lib/comm-graph/comm-graph-cloud-registry";
import type { CommGraphSubscriptionRequest } from "@/lib/comm-graph/comm-graph-subscription";
import type { CommGraphCloudSubscriptionRequest } from "@/lib/comm-graph/comm-graph-cloud-subscription";

const directoryEntries = vi.hoisted(() => ({
  current: [] as ReadonlyArray<HostDirectoryEntry>,
}));

vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => vi.fn(),
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
      directoryEntry("unavailable-relay", { status: "unavailable" }),
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
});

function directoryEntry(
  hostId: string,
  overrides: Partial<HostDirectoryEntry> | undefined,
): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: `ws://${hostId}/rpc`,
    status: "available",
    version: null,
    ...overrides,
  };
}
