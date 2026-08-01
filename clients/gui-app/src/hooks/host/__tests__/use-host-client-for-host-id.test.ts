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

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

describe("useHostClientForHostId", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    directoryState.data = undefined;
  });

  it("keeps the bound default client while its directory snapshot hydrates", () => {
    const globalClient = buildGlobalClient();
    globalClientRef.value = globalClient;

    const { result } = renderHook(() =>
      useHostClientForHostId(mockLocalHostEntry.hostId),
    );

    expect(result.current).toBe(globalClient);
  });

  it("builds a transient client for a different hydrated host", () => {
    const globalClient = buildGlobalClient();
    globalClientRef.value = globalClient;
    directoryState.data = [TARGET_B];

    const { result } = renderHook(() => useHostClientForHostId("host-b"));

    expect(result.current).not.toBe(globalClient);
    expect(result.current?.getActiveHostId()).toBe("host-b");
  });
});
