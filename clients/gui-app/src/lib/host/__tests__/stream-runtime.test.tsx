import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
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
import { REMOTE_SESSION_LINGER_MS } from "@traycer-clients/shared/host-transport/remote/config";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
}));

// Stable hoisted stubs: both feed the value-memo / effect deps, so a fresh
// reference each render would churn the stream client.
const authServiceRef = vi.hoisted(() => ({
  value: { revalidateCurrentContext: () => Promise.resolve(null) },
}));

const runnerHostRef = vi.hoisted(() => {
  const handlers = new Set<() => void>();
  return {
    handlers,
    host: {
      onSystemResumed: (handler: () => void) => {
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
      },
    },
  };
});

const streamFactorySpy = vi.hoisted(() => ({
  // Typed so the recorded build target reads back as concrete values, not
  // `any` - the assertions that compare them against the published name and
  // against the identity handed to the pacer depend on it. The public key is
  // recorded alongside the host id because a same-host ROTATION is the only
  // build-target move this provider can still observe under a host-pinned
  // requester (see `remoteAwareOwnerIdentity`), so the host id alone can no
  // longer discriminate which row a client was built from.
  build: vi.fn<(hostId: string, publicKey: string | null) => void>(),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
  useAuthService: () => authServiceRef.value,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostRef.host,
}));

// `createRemoteHostTransport` is the network boundary a remote-kind target
// crosses (Noise-NK handshake + relay socket) - out of scope for a React
// stream-lifecycle test. Every other named export of this barrel (notably
// `RemoteHostMessenger` / `RemoteStreamClient`) stays REAL, and the mock
// implementation below drives the REAL `acquireRemoteSession` cache, so the
// test exercises the actual production ref-counting/rotation behavior, not a
// hand-rolled substitute (mirrors `use-host-client-for-strict-mode.test.tsx`).
const mocks = vi.hoisted(() => ({
  createRemoteHostTransport: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      createRemoteHostTransport: mocks.createRemoteHostTransport,
    };
  },
);

vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/host/use-host-stream-client-for")
    >();
  return {
    ...actual,
    buildHostStreamClient: (
      params: Parameters<typeof actual.buildHostStreamClient>[0],
    ) => {
      streamFactorySpy.build(
        params.target.hostId,
        isRemoteHostDirectoryEntry(params.target)
          ? params.target.publicKey
          : null,
      );
      return actual.buildHostStreamClient(params);
    },
  };
});

// Records the transport identity the provider hands the shared backoff, while
// the REAL pacing runs underneath - the streak semantics themselves (what a
// changed identity does to a running streak) are owned by
// the reconnect engine's own suite. What is only observable here is the input:
// which endpoint the provider claims it just built for.
const backoffSpy = vi.hoisted(() => ({
  markBuilt: vi.fn<(transportIdentity: string | null) => void>(),
}));

vi.mock(
  "@traycer-clients/shared/host-client/host-connection-reconnect-engine",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-reconnect-engine")
      >();
    return {
      ...actual,
      // The provider gets its pacer off the PROCESS-scoped engine
      // (`processReconnectEngine().createRebuildPacer()`), not a module-level
      // export - `createRebuildPacer` was never a named export of this module,
      // even before the consolidation. Wrap the engine singleton instead so the
      // spy sees the same calls production makes.
      processReconnectEngine: () => {
        const real = actual.processReconnectEngine();
        return {
          ...real,
          createRebuildPacer: () => {
            const pacer = real.createRebuildPacer();
            return {
              ...pacer,
              markBuilt: (
                nowMs: number,
                transportIdentity: string | null,
              ): void => {
                backoffSpy.markBuilt(transportIdentity);
                pacer.markBuilt(nowMs, transportIdentity);
              },
            };
          },
        };
      },
    };
  },
);

import { HostStreamProvider } from "@/lib/host/stream-runtime";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  useStreamHostId,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";

/**
 * HOW THIS SUITE POINTS THE PROVIDER AT A HOST, and why it never calls
 * `HostClient.bind()` (redesign P4.1 Leg D).
 *
 * P4.2 deletes `bind()` and the active slot. Every case below therefore drives
 * the provider the way production will after that deletion: the window holds a
 * requester pinned to the EFFECTIVE host id (`createRequesterForHostId`), which
 * re-reads its directory row on every property access, and the thing that tells
 * a React consumer to look again is the connection registry's row-changed
 * signal - not a slot event.
 *
 * That gives the two spellings this file uses, and they are not
 * interchangeable:
 *
 *  - **A row move** (endpoint change, public-key rotation, the row landing or
 *    leaving) is a fact about ONE host: mutate the directory and emit. The
 *    pinned requester is untouched; the registry's coarse arm wakes the
 *    provider's three reactive projections and they re-read.
 *  - **A host SWAP** is not a row move at all post-slot - it is the effective
 *    host id changing, which re-points the window at a DIFFERENT requester.
 *    Spelled here as a new `bindingRef` value plus a `rerender()`, because
 *    `useHostBinding` is the reactive read that delivers it in production.
 *
 * Conflating the two is how a post-slot suite goes quietly vacuous: a "swap"
 * written as a row mutation under a pinned requester cannot change the host id
 * the provider resolves, so it would assert nothing.
 */

/** The window's directory. Rows move; the requester pinned to an id does not. */
class TestHostDirectory {
  private rows: readonly HostDirectoryEntry[] = [];
  private readonly listeners = new Set<() => void>();

  findById(hostId: string): HostDirectoryEntry | null {
    const found = this.rows.find((row) => row.hostId === hostId);
    // A FRESH object per read, like production: the local row is rebuilt per
    // snapshot and crosses the IPC bridge as a new object. A registry that
    // compared by reference would report a change on every emit.
    return found === undefined ? null : { ...found };
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Moves the directory and announces it - the ordinary path. */
  publish(rows: readonly HostDirectoryEntry[]): void {
    this.rows = rows;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Moves the directory WITHOUT announcing it, for the commit-to-effect window:
   * the live row has already changed and nothing has been told yet, which is
   * exactly the gap between a render's snapshot and the passive effect's live
   * read. Never use this to model an ordinary directory update.
   */
  publishUnannounced(rows: readonly HostDirectoryEntry[]): void {
    this.rows = rows;
  }
}

function buildClient(
  directory: TestHostDirectory,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
    findHostById: (hostId) => directory.findById(hostId),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function installDirectory(directory: TestHostDirectory): void {
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => directory.findById(hostId),
      onDirectoryChanged: (listener) => directory.onChange(listener),
    },
    leases: null,
  });
}

/**
 * Points the window at `hostId` - the post-slot replacement for `bind(entry)`.
 * `null` is ∅ ("no host is effective"), the replacement for `bind(null)`.
 *
 * Creates a NEW requester each call on purpose: re-pointing the window is a
 * change of binding, and the provider's build effect depends on the binding
 * identity. Callers that are not swapping hosts must call this exactly once.
 */
function pointWindowAt(
  client: HostClient<HostRpcRegistry>,
  hostId: string | null,
): void {
  bindingRef.value = { hostClient: client.createRequesterForHostId(hostId) };
  // The POINTER moves too, and both halves are load-bearing. The binding is
  // what production's `useHostBinding()` delivers; the store is what the
  // provider resolves its own requester from (`createRequesterForHostId(
  // effectiveHostId)`), because in production `binding.hostClient` is the
  // SPINE and names no host of its own. Seeding only the binding would leave
  // the provider resolving ∅ and every case asserting against no host at all.
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  });
}

/** The common arrangement: one local host, resolvable, window pointed at it. */
function mountLocalHost(): {
  readonly directory: TestHostDirectory;
  readonly client: HostClient<HostRpcRegistry>;
} {
  const directory = new TestHostDirectory();
  directory.publishUnannounced([mockLocalHostEntry]);
  const client = buildClient(directory);
  installDirectory(directory);
  pointWindowAt(client, mockLocalHostEntry.hostId);
  return { directory, client };
}

const OTHER_HOST_ID = "host-other";
const OTHER_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: OTHER_HOST_ID,
  websocketUrl: "ws://127.0.0.1:4918/rpc",
};

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return <HostStreamProvider>{props.children}</HostStreamProvider>;
}

const RELAY_URL = "wss://relay.test/attach";

function remoteTarget(publicKey: string): RemoteHostDirectoryEntry {
  return {
    hostId: "remote-host-a",
    label: "remote-host-a",
    kind: "remote",
    // Every remote host shares one fixed relay attach URL - a rotation is a
    // same-URL event by construction, so this stays identical across A/B.
    websocketUrl: RELAY_URL,
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey,
    relayFuseGrace: false,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

interface FakeRemoteSession extends IRemoteSession<
  HostRpcRegistry,
  HostStreamRpcRegistry
> {
  readonly closeCalls: number;
}

// A plain `closeCalls` counter - not a `vi.fn()` reference - so assertions
// read `session.closeCalls` instead of the bare method (`@typescript-eslint/
// unbound-method` flags referencing an interface method, since `close(): void`
// is method-shorthand syntax). Mirrors `active-remote-sessions.test.ts`'s
// `fakeSession()`.
function fakeRemoteSession(): FakeRemoteSession {
  let closeCalls = 0;
  const session: FakeRemoteSession = {
    get closeCalls() {
      return closeCalls;
    },
    start: vi.fn(),
    isClosed: () => closeCalls > 0,
    isReady: () => true,
    sendUnary: vi.fn(() => Promise.resolve({}) as never),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    // These provider tests never exercise fatal verdicts.
    terminalFatal: () => null,
    close: () => {
      closeCalls += 1;
    },
  };
  return session;
}

/** Matches `createRequestContextFixture`'s default identity. */
const FIXTURE_USER_ID = "user-fixture-1";
const FIXTURE_AUTH_EPOCH = "lease-fixture-1";

function remoteIdentity(publicKey: string): RemoteSessionIdentity {
  return {
    hostId: "remote-host-a",
    userId: FIXTURE_USER_ID,
    hostPublicKey: publicKey,
    relayAttachUrl: RELAY_URL,
    // The stream runtime always supplies the app revalidator.
    authRecovery: "revalidate",
    // One signed-in context for the whole fixture, so sharing is decided by
    // the fields under test rather than by an auth-context transition.
    authEpoch: FIXTURE_AUTH_EPOCH,
  };
}

/**
 * Drives the REAL `acquireRemoteSession` cache from the mocked transport
 * boundary, handing out one fake session per public key.
 */
function installRemoteTransport(sessionsByKey: {
  readonly [publicKey: string]: FakeRemoteSession;
}): void {
  mocks.createRemoteHostTransport.mockImplementation(
    (options: {
      readonly hostId: string;
      readonly userId: string;
      readonly relayAttachUrl: string;
      readonly hostPublicKey: string;
    }) => {
      const session = acquireRemoteSession(
        {
          hostId: options.hostId,
          userId: options.userId,
          hostPublicKey: options.hostPublicKey,
          relayAttachUrl: options.relayAttachUrl,
          authRecovery: "revalidate",
          authEpoch: FIXTURE_AUTH_EPOCH,
        },
        () => sessionsByKey[options.hostPublicKey] ?? fakeRemoteSession(),
      );
      return {
        session,
        messenger: new RemoteHostMessenger(session),
        streamClient: new RemoteStreamClient(session),
      };
    },
  );
}

const DEFAULT_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "remote",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

function streamController(ready: boolean): HostReadinessController {
  return {
    readinessFor: () =>
      ready ? { kind: "ready" } : { kind: "unavailable-host" },
    defaultHostPresentation: DEFAULT_PRESENTATION,
    hasBeenDefaultHostReady: false,
  };
}

describe("HostStreamProvider", () => {
  afterEach(() => {
    cleanup();
    bindingRef.value = null;
    useSelectionAuthorityStore.getState().reset();
    runnerHostRef.handlers.clear();
    mocks.createRemoteHostTransport.mockReset();
    streamFactorySpy.build.mockReset();
    backoffSpy.markBuilt.mockReset();
    resetHostConnectionRegistryForTest();
    vi.restoreAllMocks();
    // Tests that drive the session cache's keep-warm linger enable fake
    // timers; restore unconditionally so a mid-test failure cannot leak them.
    vi.useRealTimers();
  });

  it("force-reconnects all stream sessions on a shell system-resume signal", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    mountLocalHost();

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(runnerHostRef.handlers.size).toBe(1);

    act(() => {
      for (const handler of runnerHostRef.handlers) {
        handler();
      }
    });

    expect(reconnectSpy).toHaveBeenCalledWith("wake-resume");
  });

  it("keeps the SAME client across a same-host endpoint change and nudges an immediate re-dial", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const { directory } = mountLocalHost();

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A host restart keeps the same hostId but moves to a new websocketUrl. The
    // client is keyed on host IDENTITY, so the same instance survives - it is
    // neither rebuilt nor closed - and the live `endpoint()` re-dials the new
    // address. The endpoint move nudges an immediate re-dial instead of waiting
    // out the reconnect backoff.
    act(() => {
      directory.publish([
        {
          ...mockLocalHostEntry,
          websocketUrl: "ws://127.0.0.1:4918/rpc",
          transportDialability: "dialable",
        },
      ]);
    });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).toHaveBeenCalledWith("host-endpoint-change");
  });

  it("rebuilds and closes the client only on a host identity change", () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const { directory, client } = mountLocalHost();
    directory.publishUnannounced([mockLocalHostEntry, OTHER_HOST]);

    const { result, rerender } = renderHook(() => useWsStreamClient(), {
      wrapper,
    });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A DIFFERENT hostId is a genuine identity change (host swap): the old
    // client is replaced and closed, a fresh one built for the new host.
    // Post-slot that is the window re-pointing at another host's requester,
    // not a row moving under the one it holds.
    pointWindowAt(client, OTHER_HOST_ID);
    rerender();

    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });

  // Steady state only: `act()` flushes render and effects together, so this
  // cannot observe the commit-to-effect window (the test below does that).
  // Read TOGETHER on purpose - the interesting failure is not "the name is
  // wrong" but "the name and the client disagree".
  it("serves a client and a host name that agree once a swap settles", () => {
    const { directory, client } = mountLocalHost();
    directory.publishUnannounced([mockLocalHostEntry, OTHER_HOST]);

    const { result, rerender } = renderHook(
      () => ({
        client: useWsStreamClient(),
        hostId: useStreamHostId(),
      }),
      { wrapper },
    );
    const first = result.current.client;
    expect(first).toBeInstanceOf(WsStreamClient);
    expect(result.current.hostId).toBe(mockLocalHostEntry.hostId);

    pointWindowAt(client, OTHER_HOST_ID);
    rerender();

    expect(result.current.client).not.toBe(first);
    expect(result.current.hostId).toBe(OTHER_HOST_ID);
  });

  // WHERE THE OLD "publishes the host its client was built for, not the
  // render's" CASE WENT (redesign P4.1 Leg D).
  //
  // That case drove a `bind()` to a DIFFERENT hostId from a child's layout
  // effect, so the render's `readiness.hostId` and the effect's live
  // `getActiveHost()` named two machines, and publishing the render-time name
  // would have shipped `{ client for B, hostId: A }`.
  //
  // Post-slot that divergence is structurally unreachable, and the reason is
  // worth stating rather than leaving the case to rot green. The window holds a
  // requester PINNED to one host id: `getActiveHostId()` answers either that id
  // or `null` (row unresolved), and `getActiveHost()` answers either that host's
  // row or `null`. Both are read from the same requester in the same render, so
  // they move together - and the `null` arm cannot reach the publish at all,
  // because `identityKey === null` returns from the build effect before `target`
  // is ever read. The published pair therefore cannot disagree on the host id no
  // matter what lands between commit and effect.
  //
  // The DISCIPLINE that case protected - read `target` inside the effect, never
  // the render's value - is still reachable on the identity dimension (a remote
  // row's public key is part of the owner identity and is not part of the host
  // id), and that is what the case below now measures. Deleted with reason
  // rather than kept green: a case that can no longer fail is not coverage.
  //
  // The `hostId: target.hostId` publish itself is deliberately LEFT IN PLACE in
  // `stream-runtime.tsx`. It is correct, it is free, and P4.2 re-points this
  // provider next - a guard removed because today's binding shape cannot
  // exercise it is a guard missing when the shape changes again.

  // The commit-to-effect window, on the dimension that still moves under a
  // host-pinned requester. A child's LAYOUT effect rotates the row after the
  // render that fixed `identityKey` but before the passive effect that builds
  // the client - and it rotates it WITHOUT announcing, because "the live row
  // already moved and nobody has been told" is precisely the gap.
  //
  // The backoff decides whether a streak CARRIES by comparing the identity it is
  // handed against the previous build's, so a render-time value here names the
  // PREVIOUS key for a client dialed with the new one: the two look equal, the
  // streak survives the rotation, and a terminal-class close on the new session
  // gets paced by the old key's failures instead of rebuilding at once.
  it("keys the rebuild streak on the identity its client was built for", () => {
    const directory = new TestHostDirectory();
    directory.publishUnannounced([remoteTarget("pubkey-a")]);
    installRemoteTransport({
      "pubkey-a": fakeRemoteSession(),
      "pubkey-b": fakeRemoteSession(),
    });
    const client = buildClient(directory);
    installDirectory(directory);
    pointWindowAt(client, "remote-host-a");

    function RotateDuringCommit(props: { readonly children: ReactNode }) {
      useLayoutEffect(() => {
        directory.publishUnannounced([remoteTarget("pubkey-b")]);
      }, []);
      return props.children;
    }

    renderHook(() => useStreamHostId(), {
      wrapper: (props: { readonly children: ReactNode }) => (
        <HostStreamProvider>
          <RotateDuringCommit>{props.children}</RotateDuringCommit>
        </HostStreamProvider>
      ),
    });

    // Read together: the point is not that the identity mentions some key, but
    // that it names the SAME row the client was actually built from.
    const firstBuiltForKey = streamFactorySpy.build.mock.calls[0]?.[1];
    const firstIdentity = backoffSpy.markBuilt.mock.calls[0]?.[0];
    expect(firstBuiltForKey).toBe("pubkey-b");
    expect(firstIdentity).toContain("pubkey-b");
    expect(firstIdentity).not.toContain("pubkey-a");
  });

  // A live client always names a host; a dead one names nothing, so a consumer
  // cannot label output with a machine it has no working stream to.
  it("reports no host once the served client is closed", () => {
    mountLocalHost();

    const { result } = renderHook(
      () => ({
        client: useWsStreamClient(),
        hostId: useStreamHostId(),
      }),
      { wrapper },
    );
    expect(result.current.hostId).toBe(mockLocalHostEntry.hostId);

    const served = result.current.client;
    expect(served).not.toBeNull();
    act(() => {
      served?.close("test-close");
    });

    expect(result.current.client === null).toBe(result.current.hostId === null);
  });

  it("rebuilds the client when it is closed underneath the provider", () => {
    mountLocalHost();

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // Nothing legitimate closes the served client without also replacing it;
    // if it happens anyway (the closed-client-in-context wedge), the liveness
    // guard must mint a fresh client instead of serving the dead one until a
    // window reload.
    act(() => {
      first?.close("test-external-close");
    });

    expect(first?.isClosed()).toBe(true);
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(result.current?.isClosed()).toBe(false);
  });

  it("backs off consecutive quick underneath-closes instead of hot-looping the rebuild", () => {
    // A terminal-class close (incompatible protocol, plan restriction) would
    // otherwise loop: rebuild -> fresh dial (grant mint included) -> same
    // fatal -> onClosed -> rebuild, one full mint/dial cycle per round trip.
    // The first quick close still rebuilds immediately (the wedge-recovery
    // case above); the SECOND consecutive quick close must wait.
    vi.useFakeTimers();
    try {
      mountLocalHost();

      const { result } = renderHook(() => useWsStreamClient(), { wrapper });
      const first = result.current;
      expect(first).toBeInstanceOf(WsStreamClient);

      // Quick close #1: immediate rebuild.
      act(() => {
        first?.close("test-terminal-close");
      });
      const second = result.current;
      expect(second).not.toBe(first);
      expect(second?.isClosed()).toBe(false);

      // Quick close #2: the rebuild is DEFERRED. `useWsStreamClient` hides
      // the dead instance during the handoff, so consumers see null - what
      // must NOT happen is an instant fresh client (= a fresh mint+dial).
      act(() => {
        second?.close("test-terminal-close");
      });
      expect(result.current).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const third = result.current;
      expect(third).not.toBe(second);
      expect(third?.isClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nudges a re-dial exactly once under a StrictMode double-invoke", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const { directory } = mountLocalHost();

    // StrictMode runs each effect setup -> cleanup -> setup on mount. The
    // ref-based dedup in `useReconnectStreamOnEndpointChange` must absorb the
    // double-invoke: a stable mount fires NO nudge, and a later same-host
    // endpoint change fires EXACTLY one - never a spurious or doubled re-dial.
    const strictWrapper = (props: {
      readonly children: ReactNode;
    }): ReactNode => (
      <StrictMode>
        <HostStreamProvider>{props.children}</HostStreamProvider>
      </StrictMode>
    );
    const { result } = renderHook(() => useWsStreamClient(), {
      wrapper: strictWrapper,
    });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);
    expect(reconnectSpy).not.toHaveBeenCalled();

    act(() => {
      directory.publish([
        {
          ...mockLocalHostEntry,
          websocketUrl: "ws://127.0.0.1:4918/rpc",
          transportDialability: "dialable",
        },
      ]);
    });

    expect(result.current).toBe(first);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(reconnectSpy).toHaveBeenCalledWith("host-endpoint-change");
  });

  // R-1: the owner-layer discriminator the S1 cache test cannot provide (see
  // `active-remote-sessions.test.ts` "review finding #2" for the cache-layer
  // half). Drives the REAL production chain end to end - the directory row
  // move, the registry's row-changed signal, this provider's
  // `remoteAwareOwnerIdentity` `identityKey`, and the shared
  // `acquireRemoteSession` cache - so a regression in any one of those layers
  // fails this test.
  //
  // The rotation is the one row move that NOTHING else in this provider
  // observes: `hostTransportKey` is `(hostId, kind, version, websocketUrl)` and
  // a rotation leaves all four byte-identical, so the transport-key projection
  // cannot wake anyone. The registry's coarse arm is the only carrier, which is
  // exactly why it is compared field-wise including the public key.
  it("rebuilds and closes the client on a same-host remote public-key rotation, isolated from every other field", () => {
    // Fake timers so the cache's keep-warm linger can be driven to expiry -
    // a released stale-key session now closes when the window ends, not
    // synchronously in the release.
    vi.useFakeTimers();
    const sessionForKeyA = fakeRemoteSession();
    const sessionForKeyB = fakeRemoteSession();
    installRemoteTransport({
      "pubkey-a": sessionForKeyA,
      "pubkey-b": sessionForKeyB,
    });

    const directory = new TestHostDirectory();
    directory.publishUnannounced([remoteTarget("pubkey-a")]);
    const client = buildClient(directory);
    installDirectory(directory);
    pointWindowAt(client, "remote-host-a");

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    expect(result.current).toBeInstanceOf(RemoteStreamClient);
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(1);
    expect(remoteSessionRefCountForTest(remoteIdentity("pubkey-a"))).toBe(1);
    expect(sessionForKeyA.closeCalls).toBe(0);

    // hostId / kind / websocketUrl / version / status all held stable - ONLY
    // the public key rotates (re-enrollment / corruption recovery). A
    // coincident URL/version move would mask the gap this test targets.
    act(() => {
      directory.publish([remoteTarget("pubkey-b")]);
    });

    // The old owner released its reference...
    expect(remoteSessionRefCountForTest(remoteIdentity("pubkey-a"))).toBe(0);
    // ...and a FRESH one was acquired for the new key, not a resurrected
    // stale-key session.
    expect(mocks.createRemoteHostTransport).toHaveBeenCalledTimes(2);
    expect(remoteSessionRefCountForTest(remoteIdentity("pubkey-b"))).toBe(1);

    // The stale-key session is closed AT the rotation, not left to linger.
    // Keep-warm exists so a prompt re-acquire of the SAME identity is free,
    // and this identity can never be re-acquired - its cache key embeds the
    // old public key. Lingering would only hold an obsolete authenticated
    // relay socket open and, because `hasReadyRemoteSession` matches on
    // `hostId` alone, report live-session evidence for a host whose real
    // session is still dialing.
    expect(sessionForKeyA.closeCalls).toBe(1);
    expect(sessionForKeyB.closeCalls).toBe(0);

    // ...and nothing is left armed to close the successor when the window
    // that the old entry would have used elapses.
    act(() => {
      vi.advanceTimersByTime(REMOTE_SESSION_LINGER_MS);
    });
    expect(sessionForKeyA.closeCalls).toBe(1);
    expect(sessionForKeyB.closeCalls).toBe(0);
  });

  it("stops stream work when the window points at no host and recreates it only on re-point", () => {
    // The client is keyed on the resolved host identity (D5.3), not on
    // default-host surface readiness. Pointing the window at ∅ drops the
    // client; pointing it back mints a fresh one. Same-id endpoint loss
    // (websocketUrl null) is not an identity change for a local host - the
    // client survives and re-dials via the live endpoint() callback, which is
    // the whole point of holding the client across a restart so availability
    // recovery can fire.
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const { client } = mountLocalHost();

    const { result, rerender } = renderHook(() => useWsStreamClient(), {
      wrapper,
    });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);
    expect(streamFactorySpy.build).toHaveBeenCalledTimes(1);

    // ∅ - `createRequesterForHostId(null)` is the post-slot `bind(null)`.
    pointWindowAt(client, null);
    rerender();
    expect(result.current).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);

    pointWindowAt(client, mockLocalHostEntry.hostId);
    rerender();
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(streamFactorySpy.build).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("builds the stream client from the resolved host identity even while default-host readiness is non-ready", () => {
    // D5.3: availability recovery (notifyRecoveredForNamedHost) is the only
    // designed un-strand signal for host-scoped queries. Gating the stream
    // client on default-host readiness inverted that dependency - the
    // mechanism that restores readiness was disabled for exactly as long as
    // readiness was broken. The client is built from the resolved host
    // identity; surface readiness must not withhold it.
    mountLocalHost();
    const controller = streamController(false);
    const readinessWrapper = (props: {
      readonly children: ReactNode;
    }): ReactNode => (
      <HostReadinessControllerContext.Provider value={controller}>
        <HostStreamProvider>{props.children}</HostStreamProvider>
      </HostReadinessControllerContext.Provider>
    );

    const { result } = renderHook(() => useWsStreamClient(), {
      wrapper: readinessWrapper,
    });
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(streamFactorySpy.build).toHaveBeenCalledTimes(1);
  });
});
