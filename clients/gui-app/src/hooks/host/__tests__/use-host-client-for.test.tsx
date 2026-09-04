import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { StaleHostBindingAuthorityError } from "@traycer-clients/shared/host-client/host-binding-authority-error";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

// One global client shared between the mocked `useHostClient` and the tests.
const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
}));
const remoteSessionReadyRef = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useRemoteSessionPollReadiness: () => remoteSessionReadyRef.value,
}));

// `useHostClientFor` builds a requester for an EXPLICITLY named host, so it
// reads the spine (redesign P2.1) - never the effective host's own requester.
vi.mock("@/lib/host/runtime", () => ({
  useHostRuntimeClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  },
}));

// The hook now reads `runnerHost.authnBaseUrl` (for the remote transport's
// attach-grant minting). Local targets never touch it; stub the minimum shape.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "https://authn.test" }),
}));

import {
  buildDialableHostClient,
  useHostClientFor,
} from "@/hooks/host/use-host-client-for";

class RetryTestWebSocket {
  static readonly instances: RetryTestWebSocket[] = [];

  readonly url: string;
  private readonly errorListeners = new Set<() => void>();

  constructor(url: string) {
    this.url = url;
    RetryTestWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "error") {
      this.errorListeners.add(listener);
    }
  }

  send(_data: string): void {}

  close(_code: number, _reason: string): void {}

  emitError(): void {
    for (const listener of this.errorListeners) {
      listener();
    }
  }

  static reset(): void {
    RetryTestWebSocket.instances.length = 0;
  }
}

// The SPINE `useHostRuntimeClient` hands back - never bound to any one host
// (redesign P4.2 deleted the active slot `.bind()` used to fill), so it must
// resolve every entry a test builds a transient client for on its own.
const knownHostEntries = new Map<string, HostDirectoryEntry>([
  [mockLocalHostEntry.hostId, mockLocalHostEntry],
]);

function buildGlobalClient(withContext: boolean): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) => knownHostEntries.get(hostId) ?? null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  if (withContext) {
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
  }
  return client;
}

const TARGET_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

const OFFLINE_REMOTE_TARGET: RemoteHostDirectoryEntry = {
  hostId: "host-remote",
  label: "Remote host",
  kind: "remote",
  websocketUrl: "wss://relay.test/attach",
  version: "1.2.3",
  transportDialability: "not-dialable",
  publicKey: "public-key",
  relayFuseGrace: false,
  recentHostCheckIn: false,
  planAllowsRemote: true,
  remoteStatus: {
    connectivity: "offline",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
  },
};

describe("useHostClientFor", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    remoteSessionReadyRef.value = false;
    knownHostEntries.delete(OFFLINE_REMOTE_TARGET.hostId);
    RetryTestWebSocket.reset();
    vi.unstubAllGlobals();
  });

  it("returns null when there is no target", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result } = renderHook(() => useHostClientFor(null));
    expect(result.current).toBeNull();
  });

  it("returns null when there is no authenticated request context", () => {
    globalClientRef.value = buildGlobalClient(false);
    const { result } = renderHook(() => useHostClientFor(TARGET_B));
    expect(result.current).toBeNull();
  });

  it("binds the chosen host and threads the shared request context without moving the global active host", () => {
    const globalClient = buildGlobalClient(true);
    globalClientRef.value = globalClient;
    const { result } = renderHook(() => useHostClientFor(TARGET_B));
    const client = result.current;
    expect(client).toBeInstanceOf(HostClient);
    expect(client?.getActiveHostId()).toBe("host-b");
    expect(client?.getActiveHost()?.websocketUrl).toBe(TARGET_B.websocketUrl);
    // Auth is per-user, not per-host: the transient client reuses the
    // global client's request context verbatim.
    expect(client?.getRequestContext()).toBe(globalClient.getRequestContext());
    // Building a transient client for host B must not give the global
    // SPINE an active host of its own (no global side effect) - it stays
    // unbound (redesign P4.2 deleted the active slot `.bind()` used to set).
    expect(globalClient.getActiveHostId()).toBeNull();
  });

  it("memoizes for a stable target and rebuilds for a different host", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostClientFor(target),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).not.toBeNull();

    rerender({ target: TARGET_B });
    expect(result.current).toBe(first);

    const targetC: HostDirectoryEntry = { ...TARGET_B, hostId: "host-c" };
    rerender({ target: targetC });
    expect(result.current).not.toBe(first);
    expect(result.current?.getActiveHostId()).toBe("host-c");
  });

  it("reacts to remote-session readiness without a directory-row replacement", () => {
    globalClientRef.value = buildGlobalClient(true);
    knownHostEntries.set(OFFLINE_REMOTE_TARGET.hostId, OFFLINE_REMOTE_TARGET);
    const { result, rerender } = renderHook(() =>
      useHostClientFor(OFFLINE_REMOTE_TARGET),
    );

    expect(result.current).toBeNull();

    remoteSessionReadyRef.value = true;
    rerender();
    expect(result.current?.getActiveHostId()).toBe(
      OFFLINE_REMOTE_TARGET.hostId,
    );

    remoteSessionReadyRef.value = false;
    rerender();
    expect(result.current).toBeNull();
  });

  it("routes through the provider client instead of creating a transient messenger", async () => {
    vi.stubGlobal("WebSocket", RetryTestWebSocket);
    const hostA: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: "host-a",
      websocketUrl: "ws://host-a/rpc",
    };
    const hostB: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: "host-b",
      websocketUrl: "ws://host-b/rpc",
    };
    knownHostEntries.set(hostA.hostId, hostA);
    const globalClient = buildGlobalClient(true);
    const client = buildDialableHostClient(globalClient, hostA);
    expect(client).not.toBeNull();
    if (client === null) {
      throw new Error("Expected a host-pinned transient client");
    }

    // Host A leaves the directory and B takes its place. This used to be
    // spelled `globalClient.bind(hostB)`, which made A unresolvable only as a
    // SIDE EFFECT of the slot moving - the staleness under test was always the
    // directory's answer, not the binding's. P4.2 deleted the slot, so the
    // fixture states the fact directly: `captureAuthority` re-resolves this
    // requester's entry and refuses one the directory no longer has.
    knownHostEntries.delete(hostA.hostId);
    knownHostEntries.set(hostB.hostId, hostB);
    const request = client.request("terminal.kill", { sessionId: "session-a" });
    await expect(request).rejects.toBeInstanceOf(
      StaleHostBindingAuthorityError,
    );
    expect(RetryTestWebSocket.instances).toHaveLength(0);
  });
});
