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

vi.mock("@/lib/host", () => ({
  useHostClient: getGlobalClient,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: getGlobalClient,
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
  client.bind(mockLocalHostEntry);
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
  });

  it("pins the bound default host while its Query snapshot hydrates", () => {
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
    // window between a HostClient change event and React consuming that event.
    globalClient.bind(TARGET_B);
    await expect(
      pinnedClient.request("terminal.kill", { sessionId: "session-a" }),
    ).resolves.toEqual({ killed: true });

    expect(globalClient.getActiveHostId()).toBe("host-b");
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(
      mockLocalHostEntry.hostId,
    );
    expect(messenger.calls[0]?.authority.endpoint.websocketUrl).toBe(
      mockLocalHostEntry.websocketUrl,
    );
  });
});
