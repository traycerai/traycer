import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import {
  BrowserSessionsHostProvider,
  BrowserSessionsProvider,
} from "@/components/epic-canvas/renderers/browser-sessions-provider";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  durableTransport: null as FakeDurableTransport | null,
  durableTransportsByHostId: new Map<string, FakeDurableTransport>(),
  durableTransportQueuesByHostId: new Map<string, FakeDurableTransport[]>(),
  hostEntriesByHostId: new Map<string, HostDirectoryEntry>(),
  ownerIdentityKeysByClient: new Map<object, string>(),
  openedHostIds: [] as string[],
  hostEntry: {
    hostId: "host-test",
    label: "Test host",
    kind: "local" as const,
    websocketUrl: null as string | null,
    version: "test-version",
    status: "available" as const,
  },
  hostClient: {
    getRequestContext: () => ({ credentials: null }),
    getRequestContextUserId: () => "user-test",
  },
  transportKey: "authenticated-host-test",
  ownerIdentityKey: "local\u0000host-test\u0000user-test",
  browserViewBridge: null as FakeBridge | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hookState.hostEntriesByHostId.get(hostId) ??
    (hostId === hookState.hostEntry.hostId ? hookState.hostEntry : null),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  authenticatedHostStreamKey: (
    _hostClient: object,
    hostEntry: HostDirectoryEntry | null,
  ) =>
    hostEntry?.websocketUrl === null || hostEntry === null
      ? null
      : hookState.transportKey,
  authenticatedOwnerIdentityKey: (hostClient: object) =>
    hookState.ownerIdentityKeysByClient.get(hostClient) ??
    hookState.ownerIdentityKey,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => hookState.hostClient,
}));

const openTransport = vi.hoisted(
  () =>
    (hostId: string): FakeDurableTransport => {
      hookState.openedHostIds.push(hostId);
      const queuedTransport =
        hookState.durableTransportQueuesByHostId.get(hostId)?.shift() ?? null;
      const transport =
        queuedTransport ??
        hookState.durableTransportsByHostId.get(hostId) ??
        hookState.durableTransport;
      if (transport === null) {
        throw new Error("expected durable stream transport");
      }
      transport.open();
      return transport;
    },
);

vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransport,
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

const runnerHostMock = vi.hoisted(() => ({
  get browserView() {
    return hookState.browserViewBridge;
  },
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostMock,
}));

/**
 * Fake browser.sessions transport. When `dropUntilLive` is true, every client
 * frame is discarded until the stream reports `open` (provider lifecycle
 * `live`) - matching host behavior that drops pre-live readiness frames.
 */
class FakeStreamSession {
  readonly sentFrames: Array<Record<string, unknown>> = [];
  readonly droppedFrames: Array<Record<string, unknown>> = [];
  throwOnNextSend: Error | null = null;
  private readonly dropUntilLive: boolean;
  private transportLive = false;
  private serverHandler:
    | ((
        envelope: Record<string, unknown>,
        binaryPayload: Uint8Array | null,
      ) => void)
    | null = null;
  private statusHandler:
    | ((status: StreamConnectionStatus, reason: null) => void)
    | null = null;
  closed = false;

  constructor(options: { readonly dropUntilLive: boolean }) {
    this.dropUntilLive = options.dropUntilLive;
  }

  sendClientFrame(
    frame: Record<string, unknown>,
    _binaryPayload: Uint8Array | null,
  ): void {
    if (this.throwOnNextSend !== null) {
      const error = this.throwOnNextSend;
      this.throwOnNextSend = null;
      throw error;
    }
    if (this.dropUntilLive && !this.transportLive) {
      this.droppedFrames.push(frame);
      return;
    }
    this.sentFrames.push(frame);
  }

  onServerFrame(
    handler: (
      envelope: Record<string, unknown>,
      binaryPayload: Uint8Array | null,
    ) => void,
  ): void {
    this.serverHandler = handler;
  }

  onStatusChange(
    handler: (status: StreamConnectionStatus, reason: null) => void,
  ): void {
    this.statusHandler = handler;
  }

  close(): void {
    this.closed = true;
  }

  emitStatus(status: StreamConnectionStatus): void {
    if (this.dropUntilLive) {
      this.transportLive = status === "open";
    }
    this.statusHandler?.(status, null);
  }

  emit(
    envelope: Record<string, unknown>,
    binaryPayload: Uint8Array | null,
  ): void {
    this.serverHandler?.(envelope, binaryPayload);
  }
}

class FakeStreamClient {
  readonly sessions: FakeStreamSession[] = [];
  readonly subscribes: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  readonly wireSubscriptions: Array<{
    readonly endpoint: string;
    readonly method: string;
    readonly params: unknown;
  }> = [];
  readonly reconnects: Array<{
    readonly reason: string;
    readonly endpoint: string;
  }> = [];
  private readonly dropUntilLive: boolean;
  private endpoint: string;
  private readonly subscriptionBySession = new Map<
    FakeStreamSession,
    { readonly method: string; readonly params: unknown }
  >();
  closed = false;

  constructor(options: {
    readonly dropUntilLive: boolean;
    readonly endpoint: string;
  }) {
    this.dropUntilLive = options.dropUntilLive;
    this.endpoint = options.endpoint;
  }

  subscribe(method: string, params: unknown): FakeStreamSession {
    const session = new FakeStreamSession({
      dropUntilLive: this.dropUntilLive,
    });
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    this.subscriptionBySession.set(session, { method, params });
    this.wireSubscriptions.push({
      endpoint: this.endpoint,
      method,
      params,
    });
    return session;
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  reconnectAll(reason: string): void {
    if (this.closed) return;
    this.reconnects.push({ reason, endpoint: this.endpoint });
    for (const session of this.sessions) {
      const subscription = this.subscriptionBySession.get(session);
      if (subscription === undefined) continue;
      session.emitStatus("reconnecting");
      this.wireSubscriptions.push({
        endpoint: this.endpoint,
        ...subscription,
      });
      session.emitStatus("open");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions) {
      session.close();
    }
  }
}

class FakeDurableTransport {
  readonly wsStreamClient: FakeStreamClient;
  readonly dialedEndpoints: string[] = [];
  private readonly initialEndpoint: string;
  closed = false;
  private opened = false;

  constructor(options: {
    readonly dropUntilLive: boolean;
    readonly initialEndpoint: string;
  }) {
    this.initialEndpoint = options.initialEndpoint;
    this.wsStreamClient = new FakeStreamClient({
      dropUntilLive: options.dropUntilLive,
      endpoint: options.initialEndpoint,
    });
  }

  open(): void {
    if (this.opened || this.closed) return;
    this.opened = true;
    this.dialedEndpoints.push(this.initialEndpoint);
  }

  moveEndpoint(endpoint: string): void {
    if (this.closed) return;
    this.dialedEndpoints.push(endpoint);
    this.wsStreamClient.setEndpoint(endpoint);
    this.wsStreamClient.reconnectAll("host-endpoint-change");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wsStreamClient.close();
  }
}

class FakeBridge {
  readonly ensureTab = vi.fn<BrowserViewBridge["ensureTab"]>((input) =>
    Promise.resolve({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      registrationId: `native:${input.tabId}`,
    }),
  );
  readonly acceptTab = vi.fn<BrowserViewBridge["acceptTab"]>(() =>
    Promise.resolve(),
  );
  readonly attachSurface = vi.fn<BrowserViewBridge["attachSurface"]>(() =>
    Promise.resolve(),
  );
  readonly detachSurface = vi.fn<BrowserViewBridge["detachSurface"]>(() =>
    Promise.resolve(),
  );
  readonly releaseTab = vi.fn<BrowserViewBridge["releaseTab"]>(() =>
    Promise.resolve(true),
  );
  readonly controlElectronTab = vi.fn<BrowserViewBridge["controlElectronTab"]>(
    () => Promise.resolve(),
  );
  readonly dispatchElectronTabCdp = vi.fn<
    BrowserViewBridge["dispatchElectronTabCdp"]
  >(() => Promise.resolve({ kind: "cdpGetFrameTree", ok: true, frames: [] }));
  readonly startPipCapture = vi.fn<BrowserViewBridge["startPipCapture"]>(() =>
    Promise.resolve(),
  );
  readonly stopPipCapture = vi.fn<BrowserViewBridge["stopPipCapture"]>(() =>
    Promise.resolve(),
  );
  readonly onPipCaptureFrame = vi.fn<BrowserViewBridge["onPipCaptureFrame"]>(
    () => ({ dispose: () => {} }),
  );
  readonly onNativeTabStatusChange = vi.fn<
    BrowserViewBridge["onNativeTabStatusChange"]
  >(() => ({ dispose: () => {} }));
  readonly onElectronTabHandoff = vi.fn<
    BrowserViewBridge["onElectronTabHandoff"]
  >(() => ({ dispose: () => {} }));
  readonly capturePrimaryProfile = vi.fn<
    BrowserViewBridge["capturePrimaryProfile"]
  >(() =>
    Promise.resolve({
      status: "captured",
      storageState: {
        cookies: [
          {
            name: "t09_auth",
            value: "signed-in",
            domain: "example.test",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      reason: null,
    }),
  );
}
const INITIAL_ENDPOINT = "ws://host-a/stream";
const RESTARTED_ENDPOINT = "ws://host-b/stream";

function Probe(): ReactNode {
  const sessions = useBrowserSessionsContext();
  const [closeTabStatus, setCloseTabStatus] = useState("idle");
  return (
    <div>
      <span data-testid="lifecycle">{sessions.lifecycle}</span>
      <span data-testid="inventory-ready">
        {sessions.inventoryReady ? "ready" : "loading"}
      </span>
      <span data-testid="count">{sessions.items.length}</span>
      <span data-testid="close-tab-status">{closeTabStatus}</span>
      <ul>
        {sessions.items.map((session) => (
          <li key={session.sessionId}>{session.sessionId}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          setCloseTabStatus("pending");
          void sessions.closeTab("sess-1", "tab-1").then(
            () => {
              setCloseTabStatus("ok");
            },
            (error: unknown) => {
              setCloseTabStatus(
                error instanceof Error ? error.message : "failed",
              );
            },
          );
        }}
      >
        close-tab
      </button>
    </div>
  );
}

function SharedProbe(props: { readonly id: string }): ReactNode {
  const sessions = useBrowserSessionsContext();
  return (
    <div>
      <span data-testid={`${props.id}-count`}>{sessions.items.length}</span>
      <span data-testid={`${props.id}-sessions`}>
        {sessions.items.map((session) => session.sessionId).join(",")}
      </span>
    </div>
  );
}

function renderProvider(): void {
  render(
    <BrowserSessionsProvider epicId="epic-1">
      <Probe />
    </BrowserSessionsProvider>,
  );
}

function electronLifecycleReadinessFrames(
  frames: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return frames.filter((frame) => frame.kind === "electronTabLifecycleReady");
}

function electronProvisionedFrames(
  frames: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return frames.filter((frame) => frame.kind === "electronTabProvisioned");
}

function installNativeBridge(bridge: FakeBridge): void {
  hookState.browserViewBridge = bridge;
}

async function expectCaptureServiced(
  stream: FakeStreamSession,
  requestId: string,
): Promise<void> {
  act(() => {
    stream.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId,
      },
      null,
    );
  });
  await waitFor(() => {
    expect(stream.sentFrames).toContainEqual(
      expect.objectContaining({
        kind: "primaryProfileCaptured",
        requestId,
        status: "captured",
      }),
    );
  });
}

function installTransport(dropUntilLive: boolean): void {
  const transport = new FakeDurableTransport({
    dropUntilLive,
    initialEndpoint: INITIAL_ENDPOINT,
  });
  hookState.durableTransport = transport;
  hookState.streamClient = transport.wsStreamClient;
  hookState.durableTransportsByHostId.clear();
  hookState.durableTransportQueuesByHostId.clear();
  hookState.hostEntriesByHostId.clear();
  hookState.ownerIdentityKeysByClient.clear();
  hookState.openedHostIds = [];
  hookState.hostEntry = {
    ...hookState.hostEntry,
    websocketUrl: INITIAL_ENDPOINT,
  };
}

function installTransportForHost(
  hostId: string,
  endpoint: string,
): FakeDurableTransport {
  const transport = new FakeDurableTransport({
    dropUntilLive: false,
    initialEndpoint: endpoint,
  });
  hookState.durableTransportsByHostId.set(hostId, transport);
  hookState.hostEntriesByHostId.set(hostId, {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: endpoint,
    version: "test-version",
    transportDialability: "dialable",
  });
  return transport;
}

function createTestHostClient(id: string): HostClient<HostRpcRegistry> {
  return new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${id}`,
      handlers: {},
    }),
  });
}

function browserSessionFixture(
  hostId: string,
  sessionId: string,
): BrowserSessionInfo {
  return {
    sessionId,
    epicId: "epic-1",
    hostId,
    profile: "primary",
    lastActivityAt: 2,
    runtime: { kind: "electron", revision: 0 },
    tabs: [],
  };
}

describe("BrowserSessionsProvider (ticket 08 epic subscription)", () => {
  beforeEach(() => {
    hookState.ownerIdentityKey = "local\u0000host-test\u0000user-test";
    installTransport(false);
    hookState.browserViewBridge = null;
  });

  afterEach(() => {
    cleanup();
    hookState.browserViewBridge = null;
  });

  it("opens exactly one epic-scoped browser.sessions subscription", () => {
    renderProvider();
    const client = hookState.streamClient;
    expect(client?.subscribes).toEqual([
      {
        method: "browser.sessions",
        params: { epicId: "epic-1" },
      },
    ]);
  });

  it("shares one coordinator until the last same-owner provider unmounts", async () => {
    const rendered = render(
      <>
        <BrowserSessionsProvider key="first" epicId="epic-1">
          <SharedProbe id="first" />
        </BrowserSessionsProvider>
        <BrowserSessionsProvider key="second" epicId="epic-1">
          <SharedProbe id="second" />
        </BrowserSessionsProvider>
      </>,
    );
    const transport = hookState.durableTransport;
    if (transport === null) throw new Error("expected durable transport");
    const client = transport.wsStreamClient;

    await waitFor(() => {
      expect(hookState.openedHostIds).toEqual(["host-test"]);
      expect(client.subscribes).toEqual([
        {
          method: "browser.sessions",
          params: { epicId: "epic-1" },
        },
      ]);
    });
    const stream = client.sessions[0];
    act(() => {
      stream.emitStatus("open");
      stream.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [browserSessionFixture("host-test", "shared-session")],
        },
        null,
      );
    });
    expect(screen.getByTestId("first-count").textContent).toBe("1");
    expect(screen.getByTestId("second-count").textContent).toBe("1");

    rendered.rerender(
      <BrowserSessionsProvider key="second" epicId="epic-1">
        <SharedProbe id="second" />
      </BrowserSessionsProvider>,
    );
    expect(transport.closed).toBe(false);
    expect(stream.closed).toBe(false);
    expect(client.subscribes).toHaveLength(1);
    expect(screen.getByTestId("second-sessions").textContent).toBe(
      "shared-session",
    );

    rendered.unmount();
    expect(transport.closed).toBe(true);
    expect(stream.closed).toBe(true);
  });

  it("keeps different hosts separate for the same owner identity", async () => {
    const hostATransport = installTransportForHost(
      "host-a",
      "ws://host-a/stream",
    );
    const hostBTransport = installTransportForHost(
      "host-b",
      "ws://host-b/stream",
    );
    const hostClientA = createTestHostClient("user-a");
    const hostClientB = createTestHostClient("user-b");
    hookState.ownerIdentityKeysByClient.set(
      hostClientA,
      "shared-owner-identity",
    );
    hookState.ownerIdentityKeysByClient.set(
      hostClientB,
      "shared-owner-identity",
    );

    const rendered = render(
      <>
        <BrowserSessionsHostProvider
          hostId="host-a"
          hostClient={hostClientA}
          epicId="epic-1"
        >
          <SharedProbe id="host-a" />
        </BrowserSessionsHostProvider>
        <BrowserSessionsHostProvider
          hostId="host-b"
          hostClient={hostClientB}
          epicId="epic-1"
        >
          <SharedProbe id="host-b" />
        </BrowserSessionsHostProvider>
      </>,
    );

    await waitFor(() => {
      expect([...hookState.openedHostIds].sort()).toEqual(["host-a", "host-b"]);
      expect(hostATransport.wsStreamClient.subscribes).toHaveLength(1);
      expect(hostBTransport.wsStreamClient.subscribes).toHaveLength(1);
    });
    const hostAStream = hostATransport.wsStreamClient.sessions[0];
    const hostBStream = hostBTransport.wsStreamClient.sessions[0];
    act(() => {
      hostAStream.emitStatus("open");
      hostAStream.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [browserSessionFixture("host-a", "session-a")],
        },
        null,
      );
      hostBStream.emitStatus("open");
      hostBStream.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [browserSessionFixture("host-b", "session-b")],
        },
        null,
      );
    });
    expect(screen.getByTestId("host-a-sessions").textContent).toBe("session-a");
    expect(screen.getByTestId("host-b-sessions").textContent).toBe("session-b");

    rendered.unmount();
    expect(hostATransport.closed).toBe(true);
    expect(hostBTransport.closed).toBe(true);
  });

  it("keeps different owners on one host in separate coordinators", async () => {
    const ownerATransport = new FakeDurableTransport({
      dropUntilLive: false,
      initialEndpoint: "ws://shared-host/owner-a",
    });
    const ownerBTransport = new FakeDurableTransport({
      dropUntilLive: false,
      initialEndpoint: "ws://shared-host/owner-b",
    });
    hookState.durableTransportQueuesByHostId.set("shared-host", [
      ownerATransport,
      ownerBTransport,
    ]);
    hookState.hostEntriesByHostId.set("shared-host", {
      hostId: "shared-host",
      label: "Shared host",
      kind: "local",
      websocketUrl: "ws://shared-host/stream",
      version: "test-version",
      transportDialability: "dialable",
    });
    const hostClientA = createTestHostClient("owner-a");
    const hostClientB = createTestHostClient("owner-b");
    hookState.ownerIdentityKeysByClient.set(hostClientA, "owner-a");
    hookState.ownerIdentityKeysByClient.set(hostClientB, "owner-b");

    const rendered = render(
      <>
        <BrowserSessionsHostProvider
          hostId="shared-host"
          hostClient={hostClientA}
          epicId="epic-1"
        >
          <SharedProbe id="owner-a" />
        </BrowserSessionsHostProvider>
        <BrowserSessionsHostProvider
          hostId="shared-host"
          hostClient={hostClientB}
          epicId="epic-1"
        >
          <SharedProbe id="owner-b" />
        </BrowserSessionsHostProvider>
      </>,
    );

    await waitFor(() => {
      expect(hookState.openedHostIds).toEqual(["shared-host", "shared-host"]);
      expect(ownerATransport.wsStreamClient.subscribes).toHaveLength(1);
      expect(ownerBTransport.wsStreamClient.subscribes).toHaveLength(1);
    });
    const ownerAStream = ownerATransport.wsStreamClient.sessions[0];
    const ownerBStream = ownerBTransport.wsStreamClient.sessions[0];
    act(() => {
      ownerAStream.emitStatus("open");
      ownerAStream.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [browserSessionFixture("shared-host", "owner-a-session")],
        },
        null,
      );
      ownerBStream.emitStatus("open");
      ownerBStream.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [browserSessionFixture("shared-host", "owner-b-session")],
        },
        null,
      );
    });
    expect(screen.getByTestId("owner-a-sessions").textContent).toBe(
      "owner-a-session",
    );
    expect(screen.getByTestId("owner-b-sessions").textContent).toBe(
      "owner-b-session",
    );

    rendered.unmount();
    expect(ownerATransport.closed).toBe(true);
    expect(ownerBTransport.closed).toBe(true);
  });

  it("advertises native capability only after the stream snapshot", () => {
    installNativeBridge(new FakeBridge());
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    if (stream === undefined) throw new Error("expected browser stream");

    act(() => {
      stream.emitStatus("open");
    });

    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(0);
    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("accepts a snapshot that arrives before the live status", () => {
    installNativeBridge(new FakeBridge());
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(0);

    act(() => {
      stream.emitStatus("open");
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("creates a native tab from the stream and returns the exact provisioned identity", async () => {
    const bridge = new FakeBridge();
    installNativeBridge(bridge);
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) throw new Error("expected browser stream");
    act(() => {
      stream.emit(
        {
          kind: "createElectronTab",
          hasBinaryPayload: false,
          requestId: "create-1",
          sessionId: "session-1",
          tabId: "tab-1",
          requestedUrl: "https://app.example",
          reason: "session-bootstrap",
          seedStorageState: null,
        },
        null,
      );
    });
    await waitFor(() => {
      expect(bridge.ensureTab).toHaveBeenCalledExactlyOnceWith({
        hostId: "host-test",
        sessionId: "session-1",
        tabId: "tab-1",
        requestedUrl: "https://app.example",
        seedStorageState: null,
      });
      expect(stream.sentFrames).toContainEqual({
        kind: "electronTabProvisioned",
        hasBinaryPayload: false,
        requestId: "create-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "native:tab-1",
      });
    });
  });

  it("redials the same durable transport on a host restart and replays readiness", async () => {
    installTransport(true);
    installNativeBridge(new FakeBridge());
    const transport = hookState.durableTransport;
    expect(transport).toBeDefined();
    if (transport === null) {
      throw new Error("expected durable stream transport");
    }
    const { rerender } = render(
      <BrowserSessionsProvider epicId="epic-1">
        <Probe />
      </BrowserSessionsProvider>,
    );
    const client = transport.wsStreamClient;
    await waitFor(() => {
      expect(hookState.openedHostIds).toEqual(["host-test"]);
      expect(client.subscribes).toEqual([
        {
          method: "browser.sessions",
          params: { epicId: "epic-1" },
        },
      ]);
    });
    expect(transport.dialedEndpoints).toEqual([INITIAL_ENDPOINT]);
    expect(client.wireSubscriptions).toEqual([
      {
        endpoint: INITIAL_ENDPOINT,
        method: "browser.sessions",
        params: { epicId: "epic-1" },
      },
    ]);

    const stream = client.sessions[0];
    expect(stream).toBeDefined();
    act(() => {
      stream.emitStatus("open");
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(0);
    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(stream.sentFrames).toContainEqual(
      expect.objectContaining({ kind: "electronTabLifecycleReady" }),
    );

    act(() => {
      hookState.hostEntry = {
        ...hookState.hostEntry,
        websocketUrl: null,
      };
      rerender(
        <BrowserSessionsProvider epicId="epic-1">
          <Probe />
        </BrowserSessionsProvider>,
      );
    });
    expect(hookState.openedHostIds).toEqual(["host-test"]);
    expect(transport.closed).toBe(false);
    expect(stream.closed).toBe(false);

    act(() => {
      hookState.hostEntry = {
        ...hookState.hostEntry,
        websocketUrl: RESTARTED_ENDPOINT,
      };
      rerender(
        <BrowserSessionsProvider epicId="epic-1">
          <Probe />
        </BrowserSessionsProvider>,
      );
      transport.moveEndpoint(RESTARTED_ENDPOINT);
    });
    expect(hookState.openedHostIds).toEqual(["host-test"]);
    expect(transport.dialedEndpoints).toEqual([
      INITIAL_ENDPOINT,
      RESTARTED_ENDPOINT,
    ]);
    expect(client.reconnects).toEqual([
      { reason: "host-endpoint-change", endpoint: RESTARTED_ENDPOINT },
    ]);
    // The durable client keeps the public subscription and re-declares it on
    // the new socket; the provider must not replace or close this session.
    expect(client.subscribes).toHaveLength(1);
    expect(client.wireSubscriptions).toHaveLength(2);
    expect(client.wireSubscriptions[1]).toEqual({
      endpoint: RESTARTED_ENDPOINT,
      method: "browser.sessions",
      params: { epicId: "epic-1" },
    });
    expect(stream.closed).toBe(false);
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(2);

    cleanup();
    expect(transport.closed).toBe(true);
    expect(stream.closed).toBe(true);
  });

  it("surfaces live snapshot sessions", () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    act(() => {
      stream?.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [
            {
              sessionId: "sess-1",
              epicId: "epic-1",
              hostId: "host-test",
              profile: "primary",
              lastActivityAt: 2,
              runtime: { kind: "electron", revision: 0 },
              tabs: [
                {
                  tabId: "tab-1",
                  url: "https://example.com",
                  originTier: "dev",
                  status: "ready",
                  title: "Example",
                  viewed: false,
                  drivenBy: [],
                },
              ],
            },
          ],
        },
        null,
      );
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByText("sess-1")).toBeTruthy();
  });

  it("hides inventory and blocks actions from a retired owner identity", async () => {
    const rendered = render(
      <BrowserSessionsProvider epicId="epic-1">
        <Probe />
      </BrowserSessionsProvider>,
    );
    const retiredTransport = hookState.durableTransport;
    const retiredStream = retiredTransport?.wsStreamClient.sessions[0];
    if (retiredTransport === null || retiredStream === undefined) {
      throw new Error("expected retired browser sessions stream");
    }
    act(() => {
      retiredStream.emitStatus("open");
      retiredStream.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [
            {
              sessionId: "sess-1",
              epicId: "epic-1",
              hostId: "host-test",
              profile: "primary",
              lastActivityAt: 2,
              runtime: { kind: "electron", revision: 0 },
              tabs: [
                {
                  tabId: "tab-1",
                  url: "https://example.com",
                  originTier: "dev",
                  status: "ready",
                  title: "Example",
                  viewed: false,
                  drivenBy: [],
                },
              ],
            },
          ],
        },
        null,
      );
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    act(() => {
      hookState.ownerIdentityKey = "local\u0000host-test\u0000other-user";
      installTransport(false);
      rendered.rerender(
        <BrowserSessionsProvider epicId="epic-1">
          <Probe />
        </BrowserSessionsProvider>,
      );
    });

    await waitFor(() => {
      expect(retiredTransport.closed).toBe(true);
      expect(hookState.streamClient?.sessions).toHaveLength(1);
    });
    expect(screen.getByTestId("count").textContent).toBe("0");
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("close-tab-status").textContent).toBe(
        "Browser sessions stream is not ready.",
      );
    });
    expect(
      retiredStream.sentFrames.filter((frame) => frame.kind === "closeTab"),
    ).toEqual([]);
  });

  it("makes each stream inventory authoritative only after its snapshot", () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    if (stream === undefined) throw new Error("expected browser stream");

    expect(screen.getByTestId("inventory-ready").textContent).toBe("loading");
    act(() => {
      stream.emitStatus("open");
    });
    expect(screen.getByTestId("inventory-ready").textContent).toBe("loading");

    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(screen.getByTestId("inventory-ready").textContent).toBe("ready");

    act(() => {
      stream.emitStatus("reconnecting");
    });
    expect(screen.getByTestId("inventory-ready").textContent).toBe("loading");
  });

  it("sends closeTab frames and settles them on actionAck", async () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    act(() => {
      stream?.emitStatus("open");
    });
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    const sent = stream?.sentFrames.find((frame) => frame.kind === "closeTab");
    expect(sent).toMatchObject({
      kind: "closeTab",
      hasBinaryPayload: false,
      sessionId: "sess-1",
      tabId: "tab-1",
    });
    expect(typeof sent?.requestId).toBe("string");
    const requestId =
      sent !== undefined && typeof sent.requestId === "string"
        ? sent.requestId
        : null;
    expect(requestId).not.toBeNull();
    if (requestId === null) throw new Error("expected closeTab requestId");
    act(() => {
      stream?.emit(
        {
          kind: "actionAck",
          hasBinaryPayload: false,
          requestId,
          ok: true,
          reason: null,
        },
        null,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("close-tab-status").textContent).toBe("ok");
    });
  });

  it("rejects closeTab when actionAck is not ok", async () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    act(() => {
      stream?.emitStatus("open");
    });
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    const sent = stream?.sentFrames.find((frame) => frame.kind === "closeTab");
    const requestId =
      sent !== undefined && typeof sent.requestId === "string"
        ? sent.requestId
        : null;
    expect(requestId).not.toBeNull();
    if (requestId === null) throw new Error("expected closeTab requestId");
    act(() => {
      stream?.emit(
        {
          kind: "actionAck",
          hasBinaryPayload: false,
          requestId,
          ok: false,
          reason: "Tab is already gone.",
        },
        null,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("close-tab-status").textContent).toBe(
        "Tab is already gone.",
      );
    });
  });

  it("rejects closeTab when the stream disconnects", async () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    act(() => {
      stream?.emitStatus("open");
    });
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    expect(screen.getByTestId("close-tab-status").textContent).toBe("pending");
    act(() => {
      stream?.emitStatus("closed");
    });
    await waitFor(() => {
      expect(screen.getByTestId("close-tab-status").textContent).toBe(
        "Browser sessions stream closed.",
      );
    });
  });

  it("rejects closeTab immediately while reconnecting without enqueueing a frame", async () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    act(() => {
      stream?.emitStatus("open");
    });
    act(() => {
      stream?.emitStatus("reconnecting");
    });
    const before = (stream?.sentFrames ?? []).filter(
      (frame) => frame.kind === "closeTab",
    ).length;
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("close-tab-status").textContent).toBe(
        "Browser sessions stream is not ready.",
      );
    });
    expect(
      (stream?.sentFrames ?? []).filter((frame) => frame.kind === "closeTab"),
    ).toHaveLength(before);
  });

  it("rejects closeTab and drops the pending waiter when sendClientFrame throws", async () => {
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    act(() => {
      stream?.emitStatus("open");
    });
    if (stream === undefined) throw new Error("expected stream");
    stream.throwOnNextSend = new Error("send failed");
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("close-tab-status").textContent).toBe(
        "send failed",
      );
    });
    act(() => {
      screen.getByRole("button", { name: "close-tab" }).click();
    });
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "closeTab"),
    ).toHaveLength(1);
  });
});

/**
 * Ticket-08-lift: real transport drops client frames until the stream is
 * live (`open`). Readiness therefore waits for the connection snapshot (and
 * repeats after reconnect), idempotently per connection.
 */
describe("BrowserSessionsProvider (ticket 08-lift live readiness)", () => {
  beforeEach(() => {
    hookState.ownerIdentityKey = "local\u0000host-test\u0000user-test";
    installTransport(true);
    hookState.browserViewBridge = null;
  });

  afterEach(() => {
    cleanup();
    hookState.browserViewBridge = null;
  });

  it("releases an unaccepted native guest on disconnect instead of replaying it", async () => {
    const bridge = new FakeBridge();
    installNativeBridge(bridge);
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    act(() => {
      stream.emitStatus("open");
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
      stream.emit(
        {
          kind: "createElectronTab",
          hasBinaryPayload: false,
          requestId: "create-reconnect",
          sessionId: "session-reconnect",
          tabId: "tab-reconnect",
          requestedUrl: "https://app.example/reconnect",
          reason: "restore",
          seedStorageState: null,
        },
        null,
      );
    });
    await waitFor(() => {
      expect(electronProvisionedFrames(stream.sentFrames)).toHaveLength(1);
    });

    const framesBeforeReconnect = stream.sentFrames.length;
    act(() => {
      stream.emitStatus("reconnecting");
      stream.emitStatus("open");
    });
    expect(electronProvisionedFrames(stream.sentFrames)).toHaveLength(1);
    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    const reconnectKinds = stream.sentFrames
      .slice(framesBeforeReconnect)
      .map((frame) => frame.kind);
    expect(reconnectKinds).not.toContain("electronTabProvisioned");
    expect(reconnectKinds).toContain("electronTabLifecycleReady");
    expect(bridge.ensureTab).toHaveBeenCalledTimes(1);
    expect(bridge.releaseTab).toHaveBeenCalledExactlyOnceWith({
      hostId: "host-test",
      sessionId: "session-reconnect",
      tabId: "tab-reconnect",
      registrationId: "native:tab-reconnect",
    });

    act(() => {
      stream.emitStatus("open");
    });
    expect(electronProvisionedFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("emits no native readiness pre-live, then exactly one after first live so primary capture is serviced", async () => {
    installNativeBridge(new FakeBridge());
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    // Pre-live: production may attempt sync readiness, but the gate drops it.
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(0);
    expect(screen.getByTestId("lifecycle").textContent).toBe("connecting");

    act(() => {
      stream.emitStatus("open");
    });
    expect(screen.getByTestId("lifecycle").textContent).toBe("live");
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(0);

    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);

    await expectCaptureServiced(stream, "req-fresh-primary-1");

    // Idempotent: repeated live notification on the same connection must not
    // duplicate readiness frames.
    act(() => {
      stream.emitStatus("open");
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("emits exactly one readiness on the next live after reconnect and services a fresh capture", async () => {
    installNativeBridge(new FakeBridge());
    renderProvider();
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    act(() => {
      stream.emitStatus("open");
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(0);
    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
    await expectCaptureServiced(stream, "req-primary-before-reconnect");

    act(() => {
      stream.emitStatus("reconnecting");
    });
    expect(screen.getByTestId("lifecycle").textContent).toBe("reconnecting");
    // Frames during reconnect are dropped; readiness count stays at one.
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);

    act(() => {
      stream.emitStatus("open");
    });
    expect(screen.getByTestId("lifecycle").textContent).toBe("live");
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
    act(() => {
      stream.emit(
        { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
        null,
      );
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(2);

    await expectCaptureServiced(stream, "req-primary-after-reconnect");

    act(() => {
      stream.emitStatus("open");
    });
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(2);
  });
});
