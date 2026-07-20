import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  RemoteHostMessenger,
  RemoteStreamClient,
  type IRemoteSession,
} from "@traycer-clients/shared/host-transport/remote/index";
import {
  acquireRemoteSession,
  remoteSessionRefCountForTest,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import type { BuiltHostMessenger } from "@/lib/host/host-messenger";

// Regression test for S1 review finding #1 (MAJOR): a `useMemo`-built remote
// transport acquire is not lifecycle-safe under React's guarantee that a
// factory may run more than once per committed render while only one result
// is ever cleaned up (StrictMode dev double-invoke - GUARANTEED, since the
// desktop shell wraps the app in `<StrictMode>` - or a discarded concurrent
// render in prod). `useHostClientFor` now acquires+releases inside a
// `useEffect` instead, so this drives the REAL hook under `<StrictMode>` and
// asserts the shared `(hostId, userId)` cache's refCount returns to exactly 0
// after unmount - proving no orphaned reference survives the double-invoke.
//
// `buildRawHostMessengerForTarget` is mocked (a real Noise/relay handshake is
// out of scope for a React-lifecycle test) but the mock calls the REAL
// `acquireRemoteSession` from the REAL shared cache, so this exercises the
// actual production ref-counting the hook's effect drives.

const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  },
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "https://authn.test" }),
}));

const mocks = vi.hoisted(() => ({
  buildRawHostMessengerForTarget: vi.fn(),
}));

vi.mock("@/lib/host/host-messenger", () => ({
  buildRawHostMessengerForTarget: mocks.buildRawHostMessengerForTarget,
  defaultHostRpcRequestId: () => "req-1",
}));

import { useHostClientFor } from "@/hooks/host/use-host-client-for";

function fakeRemoteSession(): IRemoteSession<
  HostRpcRegistry,
  HostStreamRpcRegistry
> {
  return {
    start: vi.fn(),
    isClosed: () => false,
    isReady: () => true,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    close: vi.fn(),
  };
}

const REMOTE_TARGET: RemoteHostDirectoryEntry = {
  hostId: "remote-host-a",
  label: "remote-host-a",
  kind: "remote",
  websocketUrl: "wss://relay.test/attach",
  version: null,
  status: "available",
  publicKey: "aa".repeat(32),
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
  client.bind(REMOTE_TARGET);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

describe("useHostClientFor under React StrictMode (S1 finding #1 regression)", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    mocks.buildRawHostMessengerForTarget.mockReset();
  });

  it("releases exactly its one committed acquire - the shared session's refCount returns to 0 after unmount even under StrictMode's double-invoke", () => {
    globalClientRef.value = buildGlobalClient();
    const identity: RemoteSessionIdentity = {
      hostId: REMOTE_TARGET.hostId,
      // Matches `createAuthenticatedUserFixture`'s default `user.id`.
      userId: "user-fixture-1",
      hostPublicKey: REMOTE_TARGET.publicKey,
      // `REMOTE_TARGET.websocketUrl` is known non-null in this fixture, but
      // typed `string | null` on the base `HostDirectoryEntry` shape.
      relayAttachUrl: "wss://relay.test/attach",
    };

    mocks.buildRawHostMessengerForTarget.mockImplementation(
      (params: { userId: string }): BuiltHostMessenger<HostRpcRegistry> => {
        const session = acquireRemoteSession(
          { ...identity, userId: params.userId },
          fakeRemoteSession,
        );
        return {
          messenger: new RemoteHostMessenger(session),
          remoteTransport: {
            session,
            messenger: new RemoteHostMessenger(session),
            streamClient: new RemoteStreamClient(session),
          },
        };
      },
    );

    const { result, unmount } = renderHook(
      () => useHostClientFor(REMOTE_TARGET),
      { wrapper: StrictMode },
    );

    // Confirms StrictMode's dev double-invoke actually fired for this
    // effect (not a vacuous pass) - the effect body itself runs at least
    // twice for the one committed mount.
    expect(
      mocks.buildRawHostMessengerForTarget.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);

    // The committed render sees a working client (StrictMode's double-invoke
    // of the acquire effect settles on a fresh, live session - "re-acquire,
    // not resurrect" per the S1 guardrail).
    expect(result.current).toBeInstanceOf(HostClient);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    unmount();

    // No orphaned reference: the shared session's refCount must return to
    // exactly 0, proving every acquire this hook made (including whatever
    // StrictMode's double-invoke triggered) had a guaranteed matching
    // release.
    expect(remoteSessionRefCountForTest(identity)).toBe(0);
  });
});
