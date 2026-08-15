import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";

// Same harness as `use-host-client-for-host-id.test.ts`: the runtime's default
// client is a real `HostClient` whose `findHostById` is the LIVE directory,
// while the directory Query snapshot (`useHostDirectoryList().data`) is
// controlled separately - so a test can hold the snapshot at `undefined`
// (first render, before the query resolves) while the live directory already
// knows the host.
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
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

const TAB_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "tab-host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

function buildGlobalClient(
  listDirectory: () => readonly HostDirectoryEntry[],
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
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
  return client;
}

function tabWrapper(hostId: string) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <TabHostProvider hostId={hostId}>{children}</TabHostProvider>;
  };
}

interface BothClients {
  readonly tab: HostClient<HostRpcRegistry> | null;
  readonly byId: HostClient<HostRpcRegistry> | null;
}

/**
 * The exact pairing a chat tab produces: its toolbar store reads
 * `useTabHostClient()` while the picker beside it is handed the same id as a
 * plain `runTargetHostId` and resolves `useHostClientForHostId(id)`. Both in
 * ONE render, so the assertions below compare what a single paint sees.
 */
function useBothClients(hostId: string): BothClients {
  const tab = useTabHostClient();
  const byId = useHostClientForHostId(hostId);
  return { tab, byId };
}

describe("useTabHostClient", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    directoryState.data = undefined;
  });

  it("resolves on the FIRST render from the live directory, in the same paint as useHostClientForHostId, before the directory Query snapshot has data", () => {
    globalClientRef.value = buildGlobalClient(() => [
      mockLocalHostEntry,
      TAB_HOST,
    ]);
    // First render: the Query snapshot is still `undefined`.
    directoryState.data = undefined;
    let renders = 0;

    const { result } = renderHook(
      () => {
        renders += 1;
        return useBothClients(TAB_HOST.hostId);
      },
      { wrapper: tabWrapper(TAB_HOST.hostId) },
    );

    // Neither hook has effects, so this IS the first (and only) render.
    expect(renders).toBe(1);
    expect(result.current.tab).not.toBeNull();
    expect(result.current.byId).not.toBeNull();
    expect(result.current.tab?.getActiveHostId()).toBe(TAB_HOST.hostId);
    expect(result.current.byId?.getActiveHostId()).toBe(TAB_HOST.hostId);
  });

  it("agrees with useHostClientForHostId on `null` when the tab's host is nowhere in the directory", () => {
    globalClientRef.value = buildGlobalClient(() => [mockLocalHostEntry]);
    directoryState.data = [mockLocalHostEntry];
    const { result } = renderHook(() => useBothClients("host-nobody-knows"), {
      wrapper: tabWrapper("host-nobody-knows"),
    });

    expect(result.current.tab).toBeNull();
    expect(result.current.byId).toBeNull();
  });

  it("stays a pinned requester - never the mutable default client - even when the tab's host IS the app-wide default", () => {
    const globalClient = buildGlobalClient(() => [mockLocalHostEntry]);
    globalClientRef.value = globalClient;
    directoryState.data = undefined;
    const { result } = renderHook(
      () => useBothClients(mockLocalHostEntry.hostId),
      {
        wrapper: tabWrapper(mockLocalHostEntry.hostId),
      },
    );

    expect(result.current.tab).not.toBeNull();
    expect(result.current.tab).not.toBe(globalClient);
    expect(result.current.tab?.getActiveHostId()).toBe(
      mockLocalHostEntry.hostId,
    );
  });

  it("returns null with no authenticated request context (signed out), like its sibling", () => {
    const globalClient = buildGlobalClient(() => [
      mockLocalHostEntry,
      TAB_HOST,
    ]);
    globalClient.setRequestContext(null);
    globalClientRef.value = globalClient;
    directoryState.data = [mockLocalHostEntry, TAB_HOST];
    const { result } = renderHook(() => useBothClients(TAB_HOST.hostId), {
      wrapper: tabWrapper(TAB_HOST.hostId),
    });

    expect(result.current.tab).toBeNull();
    expect(result.current.byId).toBeNull();
  });
});
