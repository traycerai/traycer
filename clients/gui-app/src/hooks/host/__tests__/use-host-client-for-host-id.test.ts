import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const globalClientRef = vi.hoisted<{
  value: HostClient<HostRpcRegistry> | null;
}>(() => ({ value: null }));
const directoryState = vi.hoisted<{
  data: readonly HostDirectoryEntry[] | undefined;
}>(() => ({ data: undefined }));

function getGlobalClient(): HostClient<HostRpcRegistry> {
  if (globalClientRef.value === null) {
    throw new Error("test global client not configured");
  }
  return globalClientRef.value;
}

/**
 * Mirrors `lib/host/runtime.ts`'s `useHostClient` exactly: the SELECTION
 * LAYER's effective host id, resolved through the spine's uniform requester.
 *
 * Reads the authority store rather than the spine's bound slot. Those agree
 * in production, so a slot-derived mirror passed here for the wrong reason -
 * and would keep passing after the slot is deleted (P4.2), long after the
 * thing it claims to mirror had stopped existing. No case below reads this
 * branch; it is kept faithful so the first one that does gets ∅ and a fixture
 * that must NAME its effective host, rather than a quietly wrong answer.
 */
function getFollowingClient(): HostClient<HostRpcRegistry> {
  return getGlobalClient().createRequesterForHostId(
    useSelectionAuthorityStore.getState().effectiveHostId,
  );
}

vi.mock("@/lib/host", () => ({
  useHostClient: getFollowingClient,
  // `useHostClientForHostId` reads BOTH through the barrel: the spine for
  // the directory lookups, the effective host for the following branch.
  useHostRuntimeClient: getGlobalClient,
}));

// Two distinct hooks since redesign P2.1: `useHostRuntimeClient` is the
// SPINE (what a host id is resolved against) and `useHostClient` is the
// effective host resolved through it. These tests only exercise EXPLICIT ids,
// so the following-client mirror below exists to keep the mock honest about
// the shape, not because a case reads it.
vi.mock("@/lib/host/runtime", () => ({
  useHostRuntimeClient: getGlobalClient,
  useHostClient: getFollowingClient,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directoryState.data }),
}));

import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

const TARGET_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

function buildGlobalClient(
  listDirectory: () => readonly HostDirectoryEntry[],
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "terminal.kill": () => ({ killed: true }),
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (hostId) =>
      listDirectory().find((entry) => entry.hostId === hostId) ?? null,
  });
  // No binding: the spine names no host (P4.2 deleted the slot). Every
  // resolution below goes through `findHostById` above, which is what the
  // directory answers in production.
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return { client, messenger };
}

describe("useHostClientForHostId", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    directoryState.data = undefined;
    // The pointer is shared module state; a case that moved it would leak
    // into the next one's resolution.
    useSelectionAuthorityStore.getState().reset();
  });

  it("pins the directory's entry while its Query snapshot hydrates", () => {
    const { client: globalClient } = buildGlobalClient(() => [
      mockLocalHostEntry,
    ]);
    globalClientRef.value = globalClient;

    const { result } = renderHook(() =>
      useHostClientForHostId(mockLocalHostEntry.hostId),
    );

    expect(result.current).not.toBe(globalClient);
    expect(result.current?.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
  });

  it("builds a transient client for a different hydrated host", () => {
    const { client: globalClient } = buildGlobalClient(() => [
      mockLocalHostEntry,
      TARGET_B,
    ]);
    globalClientRef.value = globalClient;
    directoryState.data = [TARGET_B];

    const { result } = renderHook(() => useHostClientForHostId("host-b"));

    expect(result.current).not.toBe(globalClient);
    expect(result.current?.getActiveHostId()).toBe("host-b");
  });

  it("keeps an explicit requester pinned when the default host switches", async () => {
    const { client: globalClient, messenger } = buildGlobalClient(() => [
      mockLocalHostEntry,
      TARGET_B,
    ]);
    globalClientRef.value = globalClient;

    const { result } = renderHook(() =>
      useHostClientForHostId(mockLocalHostEntry.hostId),
    );
    const pinnedClient = result.current;
    expect(pinnedClient).not.toBeNull();
    expect(pinnedClient).not.toBe(globalClient);
    if (pinnedClient === null) {
      throw new Error("Expected an explicit-host requester");
    }

    // The switch happens without a React re-render, matching the vulnerable
    // window between the app-wide host moving and React consuming that move.
    // Expressed as a POINTER move now: the slot this used to bind is gone, and
    // "the default host switched" is a fact about the selection layer.
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: TARGET_B.hostId,
      targetHostId: TARGET_B.hostId,
      effectiveHostId: TARGET_B.hostId,
      leases: [],
      selectionRevision: 1,
    });
    await expect(
      pinnedClient.request("terminal.kill", { sessionId: "session-a" }),
    ).resolves.toEqual({ killed: true });

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      "host-b",
    );
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(
      mockLocalHostEntry.hostId,
    );
    expect(messenger.calls[0]?.authority.endpoint.websocketUrl).toBe(
      mockLocalHostEntry.websocketUrl,
    );
  });
});
