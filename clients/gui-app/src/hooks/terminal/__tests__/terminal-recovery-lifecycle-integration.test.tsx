import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { useStore } from "zustand";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithLifecycleOwner,
  TerminalScope,
  TerminalSessionKind,
} from "@traycer/protocol/host/terminal/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { useTerminalCreate } from "@/hooks/terminal/use-terminal-create-mutation";
import {
  useTerminalSessionRecovery,
  type TerminalSessionRecovery,
} from "@/hooks/terminal/use-terminal-session-recovery";
import type { TerminalSessionStoreHandle } from "@/stores/terminals/terminal-session-store";

/**
 * Integrated regression coverage for the reaped/lost-handle recovery cycle:
 * the REAL `useTerminalSessionRecovery` + the REAL module-singleton
 * `TerminalSessionRegistry` (via the REAL `useTerminalSessionHandle`) + a
 * REAL `QueryClient` driving REAL `terminal.list` / `terminal.create` TanStack
 * hooks. Only the host RPC boundary (a `MockHostMessenger`-backed `HostClient`)
 * and the terminal stream boundary (`__setTerminalStreamClientFactoryForTests`)
 * are faked - the same seam the unit-level registry/hook tests in this suite
 * already fake, just wired through the real production hooks together instead
 * of individually.
 *
 * This is deliberately NOT `useTerminalTileBootstrap` reused wholesale (that
 * hook additionally owns measure-grid timing and the lazy xterm engine, which
 * would drag in a much larger, less focused fixture) - `BootstrapSubtree`
 * below reproduces only its recovery-relevant contract: `terminal.list`
 * decides `reattachMode` ("live" if the host still lists the session
 * running, "fresh" otherwise, dispatching `terminal.create` first), keyed by
 * `recoverNonce` exactly as the real tile bodies key their bootstrap subtree.
 */

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

vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  // Never invoked: `__setTerminalStreamClientFactoryForTests` below bypasses
  // this opener entirely (same seam `lib/registries/__tests__/
  // terminal-session-registry.test.tsx` uses).
  useDurableStreamTransportFactory: () => () => {
    throw new Error("test: the durable transport opener must not be called");
  },
}));

import {
  __setTerminalStreamClientFactoryForTests,
  disposeAllTerminalSessions,
  useTerminalSessionHandle,
} from "@/lib/registries/terminal-session-registry";

const HOST_ID = "lifecycle-harness-host";
const SCOPE: TerminalScope = { kind: "epic", epicId: "epic-1" };

function canonicalSession(
  sessionId: string,
  kind: TerminalSessionKind,
): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: SCOPE,
    sessionKind: kind,
    cwd: "/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 0,
    title: null,
  };
}

function listedSession(
  sessionId: string,
  kind: TerminalSessionKind,
): CanonicalTerminalSessionInfoWithLifecycleOwner {
  return {
    ...canonicalSession(sessionId, kind),
    currentCwd: "/repo",
    lifecycleOwner: "registry",
  };
}

interface HostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  /** Toggle what `terminal.list` reports for the harness's one session. */
  setSessionStillRunning: (running: boolean) => void;
  createCallCount: () => number;
}

function requireHandle(
  handle: TerminalSessionStoreHandle | null,
): TerminalSessionStoreHandle {
  if (handle === null) throw new Error("expected terminal session handle");
  return handle;
}

function buildHostFixture(
  sessionId: string,
  kind: TerminalSessionKind,
): HostFixture {
  let sessionStillRunning = true;
  let createCalls = 0;
  let requestCounter = 0;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${(requestCounter += 1)}`,
    handlers: {
      "terminal.list": () => ({
        sessions: sessionStillRunning ? [listedSession(sessionId, kind)] : [],
        homeCwd: "/home",
      }),
      "terminal.create": () => {
        createCalls += 1;
        return { session: canonicalSession(sessionId, kind) };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (id) => ({ ...mockLocalHostEntry, hostId: id }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequesterForHostId(HOST_ID);
  return {
    client,
    queryClient,
    setSessionStillRunning: (running) => {
      sessionStillRunning = running;
    },
    createCallCount: () => createCalls,
  };
}

interface BootstrapSubtreeProps {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly kind: TerminalSessionKind;
  readonly client: HostClient<HostRpcRegistry>;
  readonly recovery: TerminalSessionRecovery;
  readonly onHandle: (handle: TerminalSessionStoreHandle | null) => void;
}

/** Reattach-vs-create contract only - the recovery-relevant slice of `useTerminalTileBootstrap`. */
function BootstrapSubtree(props: BootstrapSubtreeProps): ReactNode {
  const list = useTerminalListFor(props.client, SCOPE);
  const create = useTerminalCreate(props.client);

  const sessionListedRunning =
    list.data !== undefined &&
    list.data.sessions.some(
      (s) =>
        s.sessionId === props.sessionId &&
        s.sessionKind === props.kind &&
        s.status === "running",
    );
  const hostHasSession =
    list.data === undefined || list.isFetching ? null : sessionListedRunning;

  const createIsIdle = create.isIdle;
  const createMutate = create.mutate;
  useEffect(() => {
    if (hostHasSession === null) return;
    if (hostHasSession) return;
    if (!createIsIdle) return;
    createMutate({
      scope: SCOPE,
      sessionKind: props.kind,
      tuiHarnessId: null,
      cwd: "/repo",
      shellCommand: null,
      shellArgs: null,
      cols: 80,
      rows: 24,
      desiredSessionId: props.sessionId,
      worktreeBusyPaths: [],
    });
  }, [hostHasSession, createIsIdle, createMutate, props.kind, props.sessionId]);

  const sessionReady = sessionListedRunning || create.isSuccess;
  const reattachMode = sessionListedRunning ? "live" : "fresh";

  const handle = useTerminalSessionHandle({
    hostId: HOST_ID,
    scope: SCOPE,
    sessionId: props.sessionId,
    instanceId: props.instanceId,
    cols: 80,
    rows: 24,
    reattachMode,
    kind: props.kind,
    enabled: sessionReady,
  });

  const onHandle = props.onHandle;
  useEffect(() => {
    onHandle(handle);
  }, [handle, onHandle]);

  return handle === null ? null : (
    <HandleStatusWatcher handle={handle} recovery={props.recovery} />
  );
}

/** Mirrors `TerminalLive`'s status -> recovery-callback wiring in `terminal-tile.tsx`. */
function HandleStatusWatcher(props: {
  readonly handle: TerminalSessionStoreHandle;
  readonly recovery: TerminalSessionRecovery;
}): null {
  const status = useStore(props.handle.store, (s) => s.status);
  const { onSessionLost, onSessionHealthy } = props.recovery;
  useEffect(() => {
    if (status === "lost" || status === "reaped") onSessionLost();
  }, [status, onSessionLost]);
  useEffect(() => {
    if (status === "running") onSessionHealthy();
  }, [status, onSessionHealthy]);
  return null;
}

function LifecycleHarness(props: {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly kind: TerminalSessionKind;
  readonly client: HostClient<HostRpcRegistry>;
  readonly onHandle: (handle: TerminalSessionStoreHandle | null) => void;
}): ReactNode {
  const recovery = useTerminalSessionRecovery({
    hostId: HOST_ID,
    instanceId: props.instanceId,
    onRecoveryExhausted: () => undefined,
  });
  return (
    <BootstrapSubtree
      key={recovery.recoverNonce}
      instanceId={props.instanceId}
      sessionId={props.sessionId}
      kind={props.kind}
      client={props.client}
      recovery={recovery}
      onHandle={props.onHandle}
    />
  );
}

describe("terminal recovery lifecycle integration (real recovery + registry + list/create RPC)", () => {
  afterEach(() => {
    cleanup();
    disposeAllTerminalSessions();
    hostEntryRef.value = null;
    globalClientRef.value = null;
    __setTerminalStreamClientFactoryForTests(null);
  });

  it.each([
    { name: "terminal", kind: "terminal" as const },
    { name: "terminal-agent", kind: "terminal-agent" as const },
  ])(
    "reattaches live to a still-running $name session after the handle is reaped",
    async ({ kind }) => {
      const sessionId = `session-${kind}`;
      const instanceId = `inst-${kind}`;
      const fixture = buildHostFixture(sessionId, kind);
      hostEntryRef.value = { ...mockLocalHostEntry, hostId: HOST_ID };
      globalClientRef.value = fixture.client;
      __setTerminalStreamClientFactoryForTests(() => ({
        sendAction: () => undefined,
        close: () => undefined,
      }));

      let latestHandle: TerminalSessionStoreHandle | null = null;
      render(
        <QueryClientProvider client={fixture.queryClient}>
          <LifecycleHarness
            instanceId={instanceId}
            sessionId={sessionId}
            kind={kind}
            client={fixture.client}
            onHandle={(handle) => {
              latestHandle = handle;
            }}
          />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(latestHandle).not.toBeNull());
      const firstHandle = requireHandle(latestHandle);
      expect(firstHandle.store.getState().reattachMode).toBe("live");
      expect(fixture.createCallCount()).toBe(0);

      // The host confirms via TERMINAL_NOT_FOUND that THIS handle's PTY
      // incarnation is gone, but the host still lists the session running
      // under the same id (e.g. the host restarted and restored it) -
      // `terminal.list` keeps reporting it for the whole test.
      act(() => {
        firstHandle.store.setState({ status: "reaped" });
      });

      await waitFor(() => {
        expect(latestHandle).not.toBeNull();
        expect(latestHandle).not.toBe(firstHandle);
      });
      const secondHandle = requireHandle(latestHandle);
      expect(secondHandle.store.getState().reattachMode).toBe("live");
      expect(secondHandle.store.getState().status).not.toBe("reaped");
      // Reattached to the still-listed session - never created a new one.
      expect(fixture.createCallCount()).toBe(0);
    },
  );

  it.each([
    { name: "terminal", kind: "terminal" as const },
    { name: "terminal-agent", kind: "terminal-agent" as const },
  ])(
    "creates a fresh $name session when the host no longer lists it after the handle is lost",
    async ({ kind }) => {
      const sessionId = `session-${kind}`;
      const instanceId = `inst-${kind}`;
      const fixture = buildHostFixture(sessionId, kind);
      hostEntryRef.value = { ...mockLocalHostEntry, hostId: HOST_ID };
      globalClientRef.value = fixture.client;
      __setTerminalStreamClientFactoryForTests(() => ({
        sendAction: () => undefined,
        close: () => undefined,
      }));

      let latestHandle: TerminalSessionStoreHandle | null = null;
      render(
        <QueryClientProvider client={fixture.queryClient}>
          <LifecycleHarness
            instanceId={instanceId}
            sessionId={sessionId}
            kind={kind}
            client={fixture.client}
            onHandle={(handle) => {
              latestHandle = handle;
            }}
          />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(latestHandle).not.toBeNull());
      const firstHandle = requireHandle(latestHandle);
      expect(firstHandle.store.getState().reattachMode).toBe("live");

      // The transport drops (recoverable "lost", not a confirmed reap) AND
      // the host has genuinely lost the session by the time recovery
      // re-lists - the bootstrap must create a fresh PTY under the same
      // desired id rather than getting stuck waiting for a session that will
      // never come back as "running".
      fixture.setSessionStillRunning(false);
      act(() => {
        firstHandle.store.setState({ status: "lost" });
      });

      await waitFor(() => {
        expect(latestHandle).not.toBeNull();
        expect(latestHandle).not.toBe(firstHandle);
      });
      const secondHandle = requireHandle(latestHandle);
      expect(secondHandle.store.getState().reattachMode).toBe("fresh");
      expect(secondHandle.store.getState().status).not.toBe("lost");
      expect(fixture.createCallCount()).toBe(1);
    },
  );
});
