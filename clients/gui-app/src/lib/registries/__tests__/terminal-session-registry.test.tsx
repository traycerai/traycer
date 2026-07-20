import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";

// `useTerminalSessionHandle`'s own module state (the process-wide registry) is
// exercised for real below - only its collaborators are mocked, so the
// rotation drives the REAL `authenticatedOwnerIdentityKey` computation, not a
// test-seam override (`__setTerminalStreamClientFactoryForTests` collapses
// BOTH `transportKey` and `ownerIdentityKey` to one hardcoded string,
// structurally unable to prove this discriminator).
const hostEntryRef = vi.hoisted((): { value: HostDirectoryEntry | null } => ({
  value: null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hostEntryRef.value,
}));

const globalClientRef = vi.hoisted(
  (): { value: HostClient<HostRpcRegistry> | null } => ({ value: null }),
);
vi.mock("@/lib/host", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test: globalClientRef not configured");
    }
    return globalClientRef.value;
  },
}));

// The real `useDurableStreamTransportFactory` returns a referentially-STABLE
// opener (a `useCallback` with an empty dep array) - the acquire effect below
// depends on it, so a mock returning a FRESH closure on every render would
// re-run that effect every commit and loop forever. `stableOpenTransport` is
// defined once, here, and indirects through the mutable ref so tests can still
// swap behavior per-case.
const openTransportRef = vi.hoisted(
  (): { fn: ((hostId: string) => DurableStreamTransport) | null } => ({
    fn: null,
  }),
);
const stableOpenTransport = vi.hoisted(() => {
  return (hostId: string) => {
    if (openTransportRef.fn === null) {
      throw new Error("test: openTransportRef not configured");
    }
    return openTransportRef.fn(hostId);
  };
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => stableOpenTransport,
}));

import { useTerminalSessionHandle } from "@/lib/registries/terminal-session-registry";
import { disposeAllTerminalSessions } from "@/lib/registries/terminal-session-registry";

/** Matches `createRequestContextFixture`'s default identity. */
const FIXTURE_USER_ID = "user-fixture-1";
const RELAY_URL = "wss://relay.test/attach";
const REMOTE_HOST_ID = "terminal-registry-remote-host";

function remoteTarget(publicKey: string): RemoteHostDirectoryEntry {
  return {
    hostId: REMOTE_HOST_ID,
    label: REMOTE_HOST_ID,
    kind: "remote",
    // Every remote host shares one fixed relay attach URL - a rotation is a
    // same-URL event by construction, so this stays identical across A/B.
    websocketUrl: RELAY_URL,
    version: "1.0.0",
    status: "available",
    publicKey,
    remoteStatus: {
      presenceLease: "fresh",
      hostRelayAttached: true,
      viewerReachability: "ok",
      clientCloud: "ok",
      busy: false,
      busySessionCount: 0,
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function fakeStreamSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    close: () => undefined,
  };
}

function fakeWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => fakeStreamSession(),
    close: () => undefined,
    isClosed: () => false,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-stream-client",
  };
}

interface TrackedTransportRecord {
  readonly hostId: string;
  closeCount: number;
}

function createTrackedOpenTransport(): {
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly records: () => ReadonlyArray<TrackedTransportRecord>;
} {
  const records: TrackedTransportRecord[] = [];
  const openTransport = (hostId: string): DurableStreamTransport => {
    const record: TrackedTransportRecord = { hostId, closeCount: 0 };
    records.push(record);
    return {
      wsStreamClient: fakeWsStreamClient(),
      close: () => {
        record.closeCount += 1;
      },
    };
  };
  return { openTransport, records: () => records };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useTerminalSessionHandle owner identity (R-1)", () => {
  afterEach(() => {
    cleanup();
    disposeAllTerminalSessions();
    hostEntryRef.value = null;
    globalClientRef.value = null;
    openTransportRef.fn = null;
  });

  it("forces a release + reacquire on a same-host remote public-key rotation, isolated from every other field", async () => {
    const tracked = createTrackedOpenTransport();
    openTransportRef.fn = tracked.openTransport;
    const globalClient = buildGlobalClient();
    expect(globalClient.getRequestContextUserId()).toBe(FIXTURE_USER_ID);
    globalClientRef.value = globalClient;
    hostEntryRef.value = remoteTarget("pubkey-a");

    const { result, rerender } = renderHook(
      () =>
        useTerminalSessionHandle({
          hostId: REMOTE_HOST_ID,
          scope: { kind: "epic", epicId: "epic-1" },
          sessionId: "terminal-1",
          instanceId: "inst-1",
          cols: 80,
          rows: 24,
          reattachMode: "fresh",
          // `terminal-agent`, not `terminal`: `TerminalSessionRegistry` only
          // keeps a lease-free entry WARM for a `terminal-agent` kind
          // (`shouldKeepLeaseFree`) - a plain `terminal` is always torn down
          // and rebuilt on the effect's own release/reacquire cleanup cycle
          // regardless of `ownerIdentityKey`, which would make this test pass
          // even with the fix reverted (confirmed: see negative control).
          // Only the warm path actually exercises the `existingOwnerIdentityKey`
          // comparison this discriminator depends on.
          kind: "terminal-agent",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    const firstHandle = result.current;
    if (firstHandle === null) {
      throw new Error("expected initial handle");
    }
    expect(tracked.records()).toHaveLength(1);
    expect(tracked.records()[0].closeCount).toBe(0);

    // Same hostId/epicId/sessionId/instanceId, same signed-in user, same
    // websocketUrl/version/status - ONLY the remote host's public key rotates
    // (re-enrollment / corruption recovery). `args.hostId` never changes here
    // (a terminal tab is bound for life), so a pass proves `ownerIdentityKey`
    // alone forces the `forceRelease` + reacquire.
    hostEntryRef.value = remoteTarget("pubkey-b");
    rerender();

    await waitFor(() => {
      expect(result.current).not.toBe(firstHandle);
    });

    expect(tracked.records()).toHaveLength(2);
    expect(tracked.records()[0].closeCount).toBe(1);
    expect(tracked.records()[1].closeCount).toBe(0);
  });
});
