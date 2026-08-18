import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  WsStreamClient,
  type ParamsOf,
  type StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  LogicalStream,
  type LogicalStreamPort,
} from "@traycer-clients/shared/host-transport/remote/logical-stream";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
  type HostRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { TerminalPlainSubscribeListServerFrame } from "@traycer/protocol/host/terminal/plain-subscribe-list";
import type { HostStreamClientBinding } from "@/hooks/host/use-host-stream-client-for";
import { useLandingTerminalDurableLifecycle } from "@/components/home/terminal-panel/landing-terminal-durable-bootstrap";
import { reconcileCapableLandingTerminals } from "@/components/home/terminal-panel/use-landing-terminal-reconciliation";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  PLAIN_TERMINAL_RPC_METHODS,
  replacePlainTerminalSnapshot,
  type PlainTerminalCollection,
  upsertPlainTerminal,
} from "@/lib/terminals/plain-terminal-authority";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: () => ({ data: undefined }),
}));

import { usePlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";

const HOST_ID = "host-authority";
const SCOPE = { kind: "epic", epicId: "epic-1" } as const;
const INDEPENDENT_SCOPE = { kind: "independent" } as const;

function terminal(
  revision: number,
  manualTitle: string | null,
): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: HOST_ID,
      scope: SCOPE,
      launch: { cwd: "/work", shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle,
      revision,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    },
    runtime: { status: "dormant" },
  };
}

function scopedTerminal(args: {
  readonly terminalId: string;
  readonly scope: typeof SCOPE | typeof INDEPENDENT_SCOPE;
  readonly revision: number;
}): PlainTerminalProjection {
  const projection = terminal(args.revision, null);
  return {
    ...projection,
    record: {
      ...projection.record,
      terminalId: args.terminalId,
      scope: args.scope,
    },
  };
}

class ControlledSession implements IStreamSession {
  private frameHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;
  closeCount = 0;

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.frameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
  }

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return { major: 1, minor: 0 };
  }

  close(): void {
    this.closeCount += 1;
    this.statusHandler?.("closed", { kind: "caller" });
  }

  emitStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    this.statusHandler?.(status, reason);
  }

  emitFrame(frame: TerminalPlainSubscribeListServerFrame): void {
    this.frameHandler?.(frame, null);
  }

  emitInitialized(): void {
    this.emitFrame({ kind: "initialized", hasBinaryPayload: false });
  }
}

class ControlledStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly sessions: ControlledSession[] = [];
  private readonly negotiatedVersion: SchemaVersion = { major: 1, minor: 0 };
  private readonly supportListeners = new Set<() => void>();
  subscribeCount = 0;

  constructor(private support: StreamMethodSupport) {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      webSocketFactory: {
        create: () => {
          throw new Error("controlled stream must not dial");
        },
      },
      // Evidence became a construction input when transports began reporting
      // dial outcomes to the selection authority; this fixture never dials.
      evidence: NO_TRANSPORT_EVIDENCE,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCount += 1;
    const session = new ControlledSession();
    this.sessions.push(session);
    return session;
  }

  override getMethodSupport<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): StreamMethodSupport {
    return this.support;
  }

  override getMethodSchemaVersion<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): SchemaVersion | null {
    return this.support === "supported" ? this.negotiatedVersion : null;
  }

  override subscribeMethodSupport(listener: () => void): () => void {
    this.supportListeners.add(listener);
    return () => this.supportListeners.delete(listener);
  }

  setSupport(support: StreamMethodSupport): void {
    this.support = support;
    for (const listener of this.supportListeners) listener();
  }

  get session(): ControlledSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error("stream was not subscribed");
    return session;
  }
}

const logicalStreamPort: LogicalStreamPort = {
  sendStreamFrame: () => undefined,
  closeStream: () => undefined,
  requestSessionReconnect: () => undefined,
};

/** Uses the production remote per-stream implementation and its frame/open order. */
class LogicalOrderingStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly sessions: LogicalStream[] = [];
  private readonly negotiatedVersion: SchemaVersion = { major: 1, minor: 0 };

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      webSocketFactory: {
        create: () => {
          throw new Error("logical stream fixture must not dial");
        },
      },
      // Evidence became a construction input when transports began reporting
      // dial outcomes to the selection authority; this fixture never dials.
      evidence: NO_TRANSPORT_EVIDENCE,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    const session = new LogicalStream({
      streamId: this.sessions.length + 1,
      method: "terminal.plain.subscribeList",
      paramsProvider: () => ({ scope: SCOPE }),
      schemaVersion: { major: 1, minor: 0 },
      qos: 1,
      port: logicalStreamPort,
    });
    this.sessions.push(session);
    return session;
  }

  override getMethodSupport<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): StreamMethodSupport {
    return "supported";
  }

  override getMethodSchemaVersion<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): SchemaVersion | null {
    return this.negotiatedVersion;
  }

  get session(): LogicalStream {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error("stream was not subscribed");
    return session;
  }
}

function fixture(list: readonly PlainTerminalProjection[]): {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-1",
    handlers: {
      "terminal.plain.list": () => ({ terminals: [...list] }),
    },
  });
  // `bind()` was removed with the runtime slot (redesign P4.2); a requester
  // for a named host is now built from a spine with `findHostById` plus
  // `createRequesterForHostId`, so the context is set on the spine first.
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === HOST_ID ? { ...mockLocalHostEntry, hostId: HOST_ID } : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "token",
    }),
  );
  const client = spine.createRequesterForHostId(HOST_ID);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return { queryClient, client, messenger, Wrapper };
}

function recordCapableManifest(): void {
  const manifest: Record<string, SchemaVersion> = {
    "host.status": { major: 1, minor: 0 },
  };
  for (const method of PLAIN_TERMINAL_RPC_METHODS) {
    manifest[method] = { major: 1, minor: 0 };
  }
  recordNegotiatedHostManifest(HOST_ID, manifest);
}

function seedPresentationRefs(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Epic" },
    },
    canvasByTabId: {
      "tab-1": {
        root: {
          kind: "pane",
          id: "pane-1",
          tabInstanceIds: ["epic-ref-1", "epic-ref-2"],
          activeTabId: "epic-ref-1",
          previewTabId: null,
          activationHistory: ["epic-ref-1", "epic-ref-2"],
        },
        activePaneId: "pane-1",
        tilesByInstanceId: {
          "epic-ref-1": {
            id: "terminal-1",
            instanceId: "epic-ref-1",
            type: "terminal",
            name: "Terminal",
            hostId: HOST_ID,
            authority: "host",
            legacyFallback: {
              name: "Terminal",
              titleSource: "manual",
              cwd: "/work",
            },
          },
          "epic-ref-2": {
            id: "terminal-1",
            instanceId: "epic-ref-2",
            type: "terminal",
            name: "Terminal duplicate",
            hostId: HOST_ID,
            authority: "host",
            legacyFallback: {
              name: "Terminal duplicate",
              titleSource: "manual",
              cwd: "/work",
            },
          },
        },
        sizesByGroupId: {},
      },
    },
  });
  useLandingTerminalStore.getState().resetForTests();
  useLandingTerminalStore.getState().addTab({
    instanceId: "landing-ref",
    sessionId: "terminal-1",
    hostId: HOST_ID,
    cwd: "/work",
    name: "Landing terminal",
    titleSource: "manual",
    hostAuthorityAcknowledged: true,
  });
}

function presentationRefsRemain(): boolean {
  const epicRefs = Object.values(
    useEpicCanvasStore.getState().canvasByTabId["tab-1"]?.tilesByInstanceId ??
      {},
  ).filter((ref) => ref?.id === "terminal-1");
  const landingRefs = useLandingTerminalStore
    .getState()
    .tabs.filter((tab) => tab.sessionId === "terminal-1");
  return epicRefs.length === 2 && landingRefs.length === 1;
}

function seedDeferredDeletionRefs(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab("epic-1", "Epic");
  store.openTileInTab(tabId, {
    id: "terminal-1",
    instanceId: "epic-legacy-live",
    type: "terminal",
    name: "Legacy live",
    hostId: HOST_ID,
    titleSource: "manual",
    cwd: "/legacy",
  });
  useEpicCanvasStore.setState((state) => ({
    closedTilePayloadsByTabId: {
      ...state.closedTilePayloadsByTabId,
      [tabId]: {
        "epic-legacy-closed": {
          node: {
            id: "terminal-1",
            instanceId: "epic-legacy-closed",
            type: "terminal",
            name: "Legacy closed",
            hostId: HOST_ID,
            titleSource: "manual",
            cwd: "/legacy",
          },
          pendingCreate: false,
        },
      },
    },
  }));
  useLandingTerminalStore.getState().resetForTests();
  useLandingTerminalStore.getState().addTab({
    instanceId: "landing-legacy",
    sessionId: "terminal-1",
    hostId: HOST_ID,
    cwd: "/legacy",
    name: "Legacy",
    titleSource: "manual",
    hostAuthorityAcknowledged: false,
  });
  useLandingTerminalStore.getState().addTab({
    instanceId: "landing-pending",
    sessionId: "terminal-1",
    hostId: HOST_ID,
    cwd: "/pending",
    name: "Pending",
    titleSource: "default",
    hostAuthorityAcknowledged: false,
    pendingCreate: true,
  });
}

function deferredDeletionRefsRemain(): boolean {
  return (
    epicTerminalIds().has("terminal-1") &&
    useLandingTerminalStore
      .getState()
      .tabs.some((tab) => tab.sessionId === "terminal-1")
  );
}

function seedEpicOmissionEligibilityRefs(): void {
  const store = useEpicCanvasStore.getState();
  const tabId = store.openEpicTab("epic-1", "Epic");
  store.openTileInTab(tabId, {
    id: "acknowledged-live",
    instanceId: "acknowledged-live-instance",
    type: "terminal",
    name: "Acknowledged",
    hostId: HOST_ID,
    authority: "host",
    legacyFallback: {
      name: "Acknowledged",
      titleSource: "manual",
      cwd: "/work",
    },
  });
  store.openTileInTab(tabId, {
    id: "legacy-live",
    instanceId: "legacy-live-instance",
    type: "terminal",
    name: "Legacy evidence",
    hostId: HOST_ID,
    titleSource: "manual",
    cwd: "/legacy",
  });
  useEpicCanvasStore.setState((state) => ({
    closedTilePayloadsByTabId: {
      ...state.closedTilePayloadsByTabId,
      [tabId]: {
        "acknowledged-closed-instance": {
          node: {
            id: "acknowledged-closed",
            instanceId: "acknowledged-closed-instance",
            type: "terminal",
            name: "Acknowledged closed",
            hostId: HOST_ID,
            authority: "host",
            legacyFallback: {
              name: "Acknowledged closed",
              titleSource: "manual",
              cwd: "/work",
            },
          },
          pendingCreate: false,
        },
        "legacy-closed-instance": {
          node: {
            id: "legacy-closed",
            instanceId: "legacy-closed-instance",
            type: "terminal",
            name: "Legacy closed",
            hostId: HOST_ID,
            titleSource: "manual",
            cwd: "/legacy",
          },
          pendingCreate: false,
        },
      },
    },
  }));
}

function epicTerminalIds(): ReadonlySet<string> {
  const state = useEpicCanvasStore.getState();
  return new Set([
    ...Object.values(state.canvasByTabId).flatMap((canvas) =>
      Object.values(canvas?.tilesByInstanceId ?? {}).flatMap((ref) =>
        ref?.type === "terminal" ? [ref.id] : [],
      ),
    ),
    ...Object.values(state.closedTilePayloadsByTabId).flatMap((forTab) =>
      Object.values(forTab ?? {}).flatMap((payload) =>
        payload?.node.type === "terminal" ? [payload.node.id] : [],
      ),
    ),
  ]);
}

describe("usePlainTerminalAuthority integration", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetNegotiatedManifests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingTerminalStore.getState().resetForTests();
  });

  it("settles production LogicalStream snapshot-before-open ordering on initial connect and reconnect", async () => {
    recordCapableManifest();
    seedPresentationRefs();
    const test = fixture([terminal(1, null)]);
    const stream = new LogicalOrderingStreamClient();
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "logical-stream-first-frame",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );

    act(() => {
      expect(
        stream.session.deliverServerFrame(
          { kind: "snapshot", hasBinaryPayload: false, terminals: [] },
          null,
        ),
      ).toBe(true);
    });
    expect(
      test.queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.streamStatus,
    ).toBe("open");
    expect(rendered.result.current.canMutate).toBe(false);
    expect(presentationRefsRemain()).toBe(true);

    act(() => {
      stream.session.deliverServerFrame(
        {
          kind: "upsert",
          hasBinaryPayload: false,
          terminal: terminal(2, "buffered initial winner"),
        },
        null,
      );
      stream.session.deliverServerFrame(
        { kind: "initialized", hasBinaryPayload: false },
        null,
      );
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));
    expect(presentationRefsRemain()).toBe(true);

    act(() => {
      stream.session.notifyStatus("reconnecting", null);
      stream.session.deliverServerFrame(
        { kind: "snapshot", hasBinaryPayload: false, terminals: [] },
        null,
      );
      stream.session.deliverServerFrame(
        { kind: "initialized", hasBinaryPayload: false },
        null,
      );
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));
    expect(rendered.result.current.terminals).toEqual([]);
    expect(presentationRefsRemain()).toBe(false);
  });

  it("carries an accepted deferred deletion through stream replacement and fans out once", async () => {
    recordCapableManifest();
    seedDeferredDeletionRefs();
    const epicRemove = vi.spyOn(
      useEpicCanvasStore.getState(),
      "removeHostTerminalRefs",
    );
    const landingRemove = vi.spyOn(
      useLandingTerminalStore.getState(),
      "removeHostTerminal",
    );
    epicRemove.mockClear();
    landingRemove.mockClear();
    const test = fixture([terminal(1, null)]);
    const first = new ControlledStreamClient("supported");
    const second = new ControlledStreamClient("supported");
    const rendered = renderHook(
      ({ streamClient }) =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient,
          capabilityIncarnation: "deferred-delete-replacement",
        }),
      { initialProps: { streamClient: first }, wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );

    act(() => {
      first.session.emitStatus("open", null);
      first.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
      first.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 2,
      });
    });
    expect(deferredDeletionRefsRemain()).toBe(true);
    expect(
      test.queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.pendingPresentationDeletionRevisionById["terminal-1"],
    ).toBe(2);
    const sequenceAfterDelete =
      test.queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.projectionSequence;

    rendered.rerender({ streamClient: second });
    await waitFor(() => expect(second.subscribeCount).toBe(1));
    act(() => {
      first.session.emitStatus("open", null);
      first.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: terminal(99, "late old generation"),
      });
      first.session.emitInitialized();
      second.session.emitStatus("open", null);
      second.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      second.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 2,
      });
      second.session.emitInitialized();
      first.session.emitStatus("closed", { kind: "caller" });
    });

    await waitFor(() => expect(deferredDeletionRefsRemain()).toBe(false));
    expect(epicRemove).toHaveBeenCalledTimes(1);
    expect(landingRemove).toHaveBeenCalledTimes(1);
    expect(
      rendered.result.current.collection
        ?.pendingPresentationDeletionRevisionById["terminal-1"],
    ).toBeUndefined();
    expect(rendered.result.current.collection?.projectionSequence).toBe(
      (sequenceAfterDelete ?? 0) + 1,
    );
  });

  it("cancels a deferred deletion only for a genuinely higher accepted upsert", async () => {
    recordCapableManifest();
    seedDeferredDeletionRefs();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "deferred-delete-upsert-cancellation",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
      stream.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 2,
      });
      stream.session.emitStatus("reconnecting", null);
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      stream.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: terminal(2, "equal revision rejected"),
      });
    });
    expect(
      test.queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.pendingPresentationDeletionRevisionById["terminal-1"],
    ).toBe(2);
    expect(deferredDeletionRefsRemain()).toBe(true);

    act(() => {
      stream.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: terminal(3, "new lifecycle"),
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));
    expect(
      rendered.result.current.collection?.terminalsById["terminal-1"]?.record
        .manualTitle,
    ).toBe("new lifecycle");
    expect(
      rendered.result.current.collection
        ?.pendingPresentationDeletionRevisionById["terminal-1"],
    ).toBeUndefined();
    expect(deferredDeletionRefsRemain()).toBe(true);
  });

  it("settles snapshot initialization after its buffered upsert before classifying omission", async () => {
    recordCapableManifest();
    seedPresentationRefs();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "snapshot-buffered-upsert",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.terminals).toHaveLength(1),
    );

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
    });
    expect(presentationRefsRemain()).toBe(true);
    expect(rendered.result.current.canMutate).toBe(false);

    act(() => {
      stream.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: terminal(2, "buffered winner"),
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => {
      expect(rendered.result.current.canMutate).toBe(true);
      expect(
        rendered.result.current.collection?.terminalsById["terminal-1"]?.record
          .manualTitle,
      ).toBe("buffered winner");
    });
    expect(presentationRefsRemain()).toBe(true);
  });

  it("sweeps only acknowledged epic pointers on initial omission settlement", async () => {
    recordCapableManifest();
    seedEpicOmissionEligibilityRefs();
    const test = fixture([]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "acknowledged-initial-omission",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      stream.session.emitInitialized();
    });

    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));
    expect(epicTerminalIds()).toEqual(
      new Set(["legacy-live", "legacy-closed"]),
    );
  });

  it("preserves unacknowledged and pending landing refs on reconnect omission but explicit deletes sweep them", async () => {
    recordCapableManifest();
    const test = fixture([]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: INDEPENDENT_SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "landing-reconnect-eligibility",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );
    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    useLandingTerminalStore.getState().addTab({
      instanceId: "landing-acknowledged",
      sessionId: "landing-acknowledged",
      hostId: HOST_ID,
      cwd: "/work",
      name: "Acknowledged",
      titleSource: "manual",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().addTab({
      instanceId: "landing-legacy",
      sessionId: "landing-legacy",
      hostId: HOST_ID,
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "manual",
      hostAuthorityAcknowledged: false,
    });
    useLandingTerminalStore.getState().addTab({
      instanceId: "landing-pending",
      sessionId: "landing-pending",
      hostId: HOST_ID,
      cwd: "/pending",
      name: "Pending",
      titleSource: "default",
      hostAuthorityAcknowledged: false,
      pendingCreate: true,
    });

    act(() => {
      stream.session.emitStatus("reconnecting", null);
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() =>
      expect(
        useLandingTerminalStore.getState().tabs.map((tab) => tab.sessionId),
      ).toEqual(["landing-legacy", "landing-pending"]),
    );

    const legacyWinner = scopedTerminal({
      terminalId: "landing-legacy",
      scope: INDEPENDENT_SCOPE,
      revision: 1,
    });
    const importLegacy = vi.fn(() => {
      test.queryClient.setQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, INDEPENDENT_SCOPE),
        (current) => upsertPlainTerminal(current, legacyWinner),
      );
      return Promise.resolve({
        status: "existing" as const,
        terminal: legacyWinner,
      });
    });
    await act(() =>
      reconcileCapableLandingTerminals({
        activeHostId: HOST_ID,
        landingPageId: "landing-page",
        capability: {
          status: "capable",
          schemaVersion: { major: 1, minor: 0 },
        },
        canMutate: true,
        closeTerminal: () => Promise.resolve(),
        importLegacyTerminal: importLegacy,
        queryClient: test.queryClient,
      }),
    );
    expect(importLegacy).toHaveBeenCalledTimes(1);

    const pendingWinner = scopedTerminal({
      terminalId: "landing-pending",
      scope: INDEPENDENT_SCOPE,
      revision: 1,
    });
    const createPending = vi.fn(() => {
      test.queryClient.setQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, INDEPENDENT_SCOPE),
        (current) => upsertPlainTerminal(current, pendingWinner),
      );
      return Promise.resolve(pendingWinner);
    });
    const bootstrap = renderHook(() => {
      const pending = useLandingTerminalStore((state) =>
        state.tabs.find((tab) => tab.instanceId === "landing-pending"),
      );
      return useLandingTerminalDurableLifecycle({
        projectionStatus: "missing",
        pendingCreate: pending?.pendingCreate === true,
        active: true,
        canMutate: true,
        gridReady: true,
        dispatch: createPending,
        adopt: (winner) =>
          useLandingTerminalStore
            .getState()
            .adoptHostTerminal("landing-pending", winner),
      });
    });
    await waitFor(() => expect(createPending).toHaveBeenCalledTimes(1));
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.find((tab) => tab.instanceId === "landing-pending"),
    ).toMatchObject({
      hostAuthorityAcknowledged: true,
      pendingCreate: false,
    });
    bootstrap.unmount();

    act(() => {
      stream.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "landing-legacy",
        revision: 2,
      });
      stream.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "landing-pending",
        revision: 2,
      });
    });
    await waitFor(() =>
      expect(useLandingTerminalStore.getState().tabs).toEqual([]),
    );
  });

  it("accepts initialization only for the current open episode's pending snapshot", async () => {
    recordCapableManifest();
    seedPresentationRefs();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "episode-marker-validation",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(false));
    expect(presentationRefsRemain()).toBe(true);

    act(() => {
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
      test.queryClient.setQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
        (current) =>
          replacePlainTerminalSnapshot(current, [terminal(2, "newer epoch")]),
      );
      stream.session.emitInitialized();
    });
    expect(rendered.result.current.canMutate).toBe(false);

    act(() => {
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(3, null)],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));
    const settled = test.queryClient.getQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
    );
    act(() => stream.session.emitInitialized());
    expect(
      test.queryClient.getQueryData(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      ),
    ).toBe(settled);

    act(() => {
      stream.session.emitStatus("reconnecting", null);
      stream.session.emitStatus("open", null);
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(false));
    expect(presentationRefsRemain()).toBe(true);

    act(() => {
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(2, null)],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    act(() => {
      stream.session.emitStatus("closed", { kind: "caller" });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(false));
  });

  it.each(["true omission", "buffered delete"] as const)(
    "sweeps both surfaces once after a settled %s",
    async (scenario) => {
      recordCapableManifest();
      seedPresentationRefs();
      const epicRemove = vi.spyOn(
        useEpicCanvasStore.getState(),
        "removeHostTerminalRefs",
      );
      const landingRemove = vi.spyOn(
        useLandingTerminalStore.getState(),
        "removeHostTerminal",
      );
      epicRemove.mockClear();
      landingRemove.mockClear();
      const test = fixture([terminal(1, null)]);
      const stream = new ControlledStreamClient("supported");
      const rendered = renderHook(
        () =>
          usePlainTerminalAuthority({
            hostId: HOST_ID,
            scope: SCOPE,
            client: test.client,
            streamClient: stream,
            capabilityIncarnation: scenario,
          }),
        { wrapper: test.Wrapper },
      );
      await waitFor(() =>
        expect(rendered.result.current.terminals).toHaveLength(1),
      );

      act(() => {
        stream.session.emitStatus("open", null);
        stream.session.emitFrame({
          kind: "snapshot",
          hasBinaryPayload: false,
          terminals: scenario === "buffered delete" ? [terminal(1, null)] : [],
        });
        if (scenario === "buffered delete") {
          stream.session.emitFrame({
            kind: "deleted",
            hasBinaryPayload: false,
            terminalId: "terminal-1",
            revision: 2,
          });
        }
        stream.session.emitInitialized();
      });
      await waitFor(() =>
        expect(rendered.result.current.terminals).toHaveLength(0),
      );
      expect(presentationRefsRemain()).toBe(false);
      expect(epicRemove).toHaveBeenCalledTimes(1);
      expect(landingRemove).toHaveBeenCalledTimes(1);
    },
  );

  it("seeds by list and converges snapshot/upsert/deleted frames across reconnect", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "1.0.0",
        }),
      { wrapper: test.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.terminals).toHaveLength(1);
    });
    expect(rendered.result.current.canMutate).toBe(false);
    expect(stream.subscribeCount).toBe(1);

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => {
      expect(rendered.result.current.canMutate).toBe(true);
    });

    act(() => {
      stream.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: terminal(2, "updated"),
      });
    });
    await waitFor(() => {
      expect(rendered.result.current.terminals[0]?.record.manualTitle).toBe(
        "updated",
      );
    });

    act(() => {
      stream.session.emitStatus("reconnecting", null);
      stream.session.emitFrame({
        kind: "upsert",
        hasBinaryPayload: false,
        terminal: terminal(3, "buffered"),
      });
    });
    await waitFor(() => {
      expect(rendered.result.current.canMutate).toBe(false);
    });

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(4, "reconnected")],
      });
      stream.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 5,
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => {
      expect(rendered.result.current.terminals).toHaveLength(0);
    });
    expect(rendered.result.current.canMutate).toBe(true);
  });

  it("keeps a fresh snapshot mutable across an availability-triggered list refetch", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "availability-refetch",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(
        test.messenger.calls.filter(
          (call) => call.method === "terminal.plain.list",
        ),
      ).toHaveLength(1),
    );
    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    // Renamed to take the host explicitly once the no-arg form (which read
    // the runtime slot) was removed with it (redesign P4.2).
    act(() => test.client.notifyHostAvailabilityRecovered(HOST_ID));
    await waitFor(() => {
      expect(
        test.messenger.calls.filter(
          (call) => call.method === "terminal.plain.list",
        ),
      ).toHaveLength(2);
      expect(rendered.result.current.collection?.streamSnapshotFresh).toBe(
        true,
      );
      expect(rendered.result.current.canMutate).toBe(true);
    });
  });

  it("keeps a new client on legacy authority when the old host lacks the family", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "host.status": { major: 1, minor: 0 },
    });
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "old",
        }),
      { wrapper: test.Wrapper },
    );
    expect(rendered.result.current.capability).toEqual({ status: "legacy" });
    expect(rendered.result.current.query.fetchStatus).toBe("idle");
    expect(stream.subscribeCount).toBe(0);
  });

  it("starts when support becomes available without replacing the established session", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("unsupported");
    renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "support-transition",
        }),
      { wrapper: test.Wrapper },
    );
    expect(stream.subscribeCount).toBe(0);

    act(() => stream.setSupport("supported"));
    await waitFor(() => expect(stream.subscribeCount).toBe(1));
    act(() => stream.setSupport("unknown"));
    await waitFor(() => expect(stream.subscribeCount).toBe(1));
    expect(stream.session.closeCount).toBe(0);
  });

  it("preserves an established and reconnecting session across registry reset", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("unknown");
    renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "registry-reset",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() => expect(stream.subscribeCount).toBe(1));

    act(() => stream.setSupport("supported"));
    expect(stream.subscribeCount).toBe(1);
    act(() => {
      stream.session.emitStatus("reconnecting", null);
      stream.setSupport("unknown");
    });
    await waitFor(() => expect(stream.subscribeCount).toBe(1));
    expect(stream.session.closeCount).toBe(0);
  });

  it("retries a fatal incompatibility only for a newer capability incarnation", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      ({ capabilityIncarnation }) =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation,
        }),
      {
        initialProps: { capabilityIncarnation: "host-v1" },
        wrapper: test.Wrapper,
      },
    );
    await waitFor(() => expect(stream.subscribeCount).toBe(1));
    const incompatibleSession = stream.session;
    act(() => {
      incompatibleSession.emitStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "old host lacks terminal.plain.subscribeList",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      incompatibleSession.emitInitialized();
      stream.setSupport("unsupported");
      stream.setSupport("unknown");
    });
    await waitFor(() =>
      expect(rendered.result.current.capability.status).toBe("legacy"),
    );
    expect(stream.subscribeCount).toBe(1);
    expect(incompatibleSession.closeCount).toBe(0);

    rendered.rerender({ capabilityIncarnation: "host-v2" });
    await waitFor(() => expect(stream.subscribeCount).toBe(2));
    expect(incompatibleSession.closeCount).toBe(1);
    act(() => {
      stream.setSupport("supported");
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(2, "upgraded")],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    rendered.unmount();
    expect(stream.session.closeCount).toBe(1);
  });

  it("replaces only an actual client generation and closes it on unmount", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const first = new ControlledStreamClient("supported");
    const second = new ControlledStreamClient("supported");
    const rendered = renderHook(
      ({ streamClient }) =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient,
          capabilityIncarnation: "client-generation",
        }),
      { initialProps: { streamClient: first }, wrapper: test.Wrapper },
    );
    await waitFor(() => expect(first.subscribeCount).toBe(1));
    act(() => {
      first.session.emitStatus("open", null);
      first.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
    });

    rendered.rerender({ streamClient: second });
    await waitFor(() => expect(second.subscribeCount).toBe(1));
    expect(first.session.closeCount).toBe(1);
    act(() => {
      second.session.emitStatus("open", null);
      second.session.emitInitialized();
      first.session.emitInitialized();
    });
    expect(rendered.result.current.canMutate).toBe(false);
    act(() => {
      second.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(2, "new generation")],
      });
      second.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    rendered.unmount();
    expect(second.session.closeCount).toBe(1);
  });

  it("shares one stream until the final owner unmounts", async () => {
    recordCapableManifest();
    const test = fixture([terminal(1, null)]);
    const firstStream = new ControlledStreamClient("supported");
    const secondStream = new ControlledStreamClient("supported");
    const renderOwner = (streamClient: ControlledStreamClient) =>
      renderHook(
        () =>
          usePlainTerminalAuthority({
            hostId: HOST_ID,
            scope: SCOPE,
            client: test.client,
            streamClient,
            capabilityIncarnation: "shared-owner",
          }),
        { wrapper: test.Wrapper },
      );
    const first = renderOwner(firstStream);
    const second = renderOwner(secondStream);

    await waitFor(() => expect(firstStream.subscribeCount).toBe(1));
    expect(secondStream.subscribeCount).toBe(0);
    act(() => {
      firstStream.session.emitStatus("open", null);
      firstStream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(1, null)],
      });
      firstStream.session.emitInitialized();
    });
    await waitFor(() => {
      expect(first.result.current.canMutate).toBe(true);
      expect(second.result.current.canMutate).toBe(true);
    });

    first.unmount();
    expect(firstStream.session.closeCount).toBe(0);
    expect(second.result.current.canMutate).toBe(true);

    act(() => firstStream.session.emitStatus("reconnecting", null));
    await waitFor(() => expect(second.result.current.canMutate).toBe(false));
    act(() => {
      firstStream.session.emitStatus("open", null);
      firstStream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [terminal(2, "reconnected")],
      });
      firstStream.session.emitInitialized();
    });
    await waitFor(() => expect(second.result.current.canMutate).toBe(true));
    expect(firstStream.subscribeCount).toBe(1);
    expect(secondStream.subscribeCount).toBe(0);

    second.unmount();
    expect(firstStream.session.closeCount).toBe(1);
    expect(
      test.queryClient.getQueryData<{
        readonly streamStatus: StreamConnectionStatus | null;
        readonly streamSnapshotFresh: boolean;
      }>(hostQueryKeys.plainTerminals(HOST_ID, SCOPE)),
    ).toMatchObject({ streamStatus: "closed", streamSnapshotFresh: false });
  });

  it.each(["panel-first", "bridge-first"] as const)(
    "hands a staggered transport generation across two consumers with %s final unmount",
    async (unmountOrder) => {
      recordCapableManifest();
      const test = fixture([terminal(1, null)]);
      const oldPanelStream = new ControlledStreamClient("supported");
      const oldBridgeStream = new ControlledStreamClient("supported");
      const newPanelStream = new ControlledStreamClient("supported");
      const newBridgeStream = new ControlledStreamClient("supported");
      const oldPanelBinding = {
        client: oldPanelStream,
        transportKey: "transport-old",
        pin: vi.fn(),
        unpin: vi.fn(),
      } satisfies HostStreamClientBinding;
      const oldBridgeBinding = {
        client: oldBridgeStream,
        transportKey: "transport-old",
        pin: vi.fn(),
        unpin: vi.fn(),
      } satisfies HostStreamClientBinding;
      const newPanelBinding = {
        client: newPanelStream,
        transportKey: "transport-new",
        pin: vi.fn(),
        unpin: vi.fn(),
      } satisfies HostStreamClientBinding;
      const newBridgeBinding = {
        client: newBridgeStream,
        transportKey: "transport-new",
        pin: vi.fn(),
        unpin: vi.fn(),
      } satisfies HostStreamClientBinding;
      const renderOwner = (initialBinding: HostStreamClientBinding) =>
        renderHook(
          ({ binding }: { readonly binding: HostStreamClientBinding }) =>
            usePlainTerminalAuthority({
              hostId: HOST_ID,
              scope: SCOPE,
              client: test.client,
              streamClient: binding.client,
              streamBinding: binding,
              capabilityIncarnation: "stable-capability",
            }),
          {
            initialProps: { binding: initialBinding },
            wrapper: test.Wrapper,
          },
        );

      const panel = renderOwner(oldPanelBinding);
      await waitFor(() => expect(oldPanelStream.subscribeCount).toBe(1));
      const bridge = renderOwner(oldBridgeBinding);
      await waitFor(() =>
        expect(bridge.result.current.query.isSuccess).toBe(true),
      );
      expect(oldPanelBinding.pin).toHaveBeenCalledTimes(1);
      expect(oldBridgeBinding.pin).not.toHaveBeenCalled();
      expect(oldBridgeStream.subscribeCount).toBe(0);
      const initialListRequestCount = test.messenger.calls.filter(
        (call) => call.method === "terminal.plain.list",
      ).length;

      act(() => {
        oldPanelStream.session.emitStatus("open", null);
        oldPanelStream.session.emitFrame({
          kind: "snapshot",
          hasBinaryPayload: false,
          terminals: [terminal(1, "old-generation")],
        });
        oldPanelStream.session.emitInitialized();
      });
      await waitFor(() => {
        expect(panel.result.current.canMutate).toBe(true);
        expect(bridge.result.current.canMutate).toBe(true);
      });

      panel.rerender({ binding: newPanelBinding });
      await waitFor(() => expect(newPanelStream.subscribeCount).toBe(1));
      expect(oldPanelStream.session.closeCount).toBe(1);
      expect(oldPanelBinding.unpin).toHaveBeenCalledTimes(1);
      expect(newPanelBinding.pin).toHaveBeenCalledTimes(1);
      expect(oldBridgeStream.subscribeCount).toBe(0);

      bridge.rerender({ binding: newBridgeBinding });
      await waitFor(() => expect(newBridgeBinding.pin).not.toHaveBeenCalled());
      expect(newBridgeStream.subscribeCount).toBe(0);
      expect(newPanelStream.subscribeCount).toBe(1);
      expect(oldPanelStream.session.closeCount).toBe(1);
      expect(oldBridgeBinding.unpin).not.toHaveBeenCalled();

      act(() => {
        newPanelStream.session.emitStatus("open", null);
        newPanelStream.session.emitFrame({
          kind: "snapshot",
          hasBinaryPayload: false,
          terminals: [terminal(2, "new-generation")],
        });
        newPanelStream.session.emitInitialized();
      });
      await waitFor(() => {
        expect(panel.result.current.canMutate).toBe(true);
        expect(bridge.result.current.canMutate).toBe(true);
        expect(bridge.result.current.terminals[0]?.record.manualTitle).toBe(
          "new-generation",
        );
      });

      act(() => newPanelStream.session.emitStatus("reconnecting", null));
      await waitFor(() => {
        expect(panel.result.current.canMutate).toBe(false);
        expect(bridge.result.current.canMutate).toBe(false);
      });
      act(() => {
        newPanelStream.session.emitStatus("open", null);
        newPanelStream.session.emitFrame({
          kind: "snapshot",
          hasBinaryPayload: false,
          terminals: [terminal(3, "fresh-again")],
        });
        newPanelStream.session.emitInitialized();
      });
      await waitFor(() => {
        expect(panel.result.current.canMutate).toBe(true);
        expect(bridge.result.current.canMutate).toBe(true);
      });

      const firstUnmount = unmountOrder === "panel-first" ? panel : bridge;
      const finalUnmount = unmountOrder === "panel-first" ? bridge : panel;
      firstUnmount.unmount();
      expect(newPanelStream.session.closeCount).toBe(0);
      expect(newPanelBinding.unpin).not.toHaveBeenCalled();
      finalUnmount.unmount();
      expect(newPanelStream.session.closeCount).toBe(1);
      expect(newPanelBinding.unpin).toHaveBeenCalledTimes(1);
      expect(newPanelStream.subscribeCount).toBe(1);
      expect(newBridgeStream.subscribeCount).toBe(0);
      expect(oldPanelBinding.unpin).toHaveBeenCalledTimes(1);
      expect(
        test.messenger.calls.filter(
          (call) => call.method === "terminal.plain.list",
        ),
      ).toHaveLength(initialListRequestCount);
    },
  );

  it("prunes a late closed-only epic ref from a retained tombstone without a unary response", async () => {
    recordCapableManifest();
    const test = fixture([]);
    const stream = new ControlledStreamClient("supported");
    const rendered = renderHook(
      () =>
        usePlainTerminalAuthority({
          hostId: HOST_ID,
          scope: SCOPE,
          client: test.client,
          streamClient: stream,
          capabilityIncarnation: "closed-only-retained-tombstone",
        }),
      { wrapper: test.Wrapper },
    );
    await waitFor(() =>
      expect(rendered.result.current.query.isSuccess).toBe(true),
    );

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    act(() => {
      stream.session.emitFrame({
        kind: "deleted",
        hasBinaryPayload: false,
        terminalId: "terminal-1",
        revision: 2,
      });
    });
    expect(
      test.queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.deletedRevisionById["terminal-1"],
    ).toBe(2);

    act(() => {
      stream.session.emitStatus("reconnecting", null);
    });
    expect(
      test.queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.streamStatus,
    ).toBe("reconnecting");
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(false));

    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic");
    act(() => {
      store.openTileInTab(tabId, {
        id: "terminal-1",
        instanceId: "late-legacy-live",
        type: "terminal",
        name: "Late legacy",
        hostId: HOST_ID,
        titleSource: "manual",
        cwd: "/legacy",
      });
      const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
      if (canvas === undefined) throw new Error("expected canvas");
      useEpicCanvasStore.setState((state) => ({
        canvasByTabId: {
          ...state.canvasByTabId,
          [tabId]: {
            ...canvas,
            root: {
              kind: "pane",
              id: "pane-late",
              tabInstanceIds: [
                "late-future",
                "late-agent",
                "late-other-host",
                "late-other-id",
              ],
              activeTabId: "late-future",
              previewTabId: null,
              activationHistory: [
                "late-future",
                "late-agent",
                "late-other-host",
                "late-other-id",
              ],
            },
            activePaneId: "pane-late",
            tilesByInstanceId: {
              "late-future": {
                id: "terminal-1",
                instanceId: "late-future",
                type: "terminal",
                name: "Future authority",
                hostId: HOST_ID,
                authority: "unsupported",
                rawAuthority: "future-v2",
                legacyFallback: {
                  name: "Future authority",
                  titleSource: "manual",
                  cwd: "/repo",
                },
              },
              "late-agent": {
                id: "terminal-1",
                instanceId: "late-agent",
                type: "terminal-agent",
                name: "Agent",
                hostId: HOST_ID,
              },
              "late-other-host": {
                id: "terminal-1",
                instanceId: "late-other-host",
                type: "terminal",
                name: "Other host",
                hostId: "other-host",
                titleSource: "manual",
                cwd: "/other-host",
              },
              "late-other-id": {
                id: "terminal-other",
                instanceId: "late-other-id",
                type: "terminal",
                name: "Other terminal",
                hostId: HOST_ID,
                titleSource: "manual",
                cwd: "/other",
              },
            },
          },
        },
        closedTilePayloadsByTabId: {
          ...state.closedTilePayloadsByTabId,
          [tabId]: {
            "late-legacy-live": {
              node: {
                id: "terminal-1",
                instanceId: "late-legacy-live",
                type: "terminal",
                name: "Late legacy",
                hostId: HOST_ID,
                titleSource: "manual",
                cwd: "/legacy",
              },
              pendingCreate: false,
            },
          },
        },
      }));
    });

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
          "late-legacy-live"
        ],
      ).toBeUndefined();
    });

    act(() => {
      stream.session.emitStatus("open", null);
      stream.session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        terminals: [],
      });
      stream.session.emitInitialized();
    });
    await waitFor(() => expect(rendered.result.current.canMutate).toBe(true));

    expect(
      test.messenger.calls.filter(
        (call) =>
          call.method === "terminal.plain.importLegacy" ||
          call.method === "terminal.plain.close",
      ),
    ).toEqual([]);
    expect(epicTerminalIds()).toEqual(
      new Set(["terminal-1", "terminal-other"]),
    );
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "late-future"
      ],
    ).toBeDefined();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "late-agent"
      ],
    ).toBeDefined();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "late-other-host"
      ],
    ).toBeDefined();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "late-other-id"
      ],
    ).toBeDefined();
  });
});
