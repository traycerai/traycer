import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { BrowserSessionsProvider } from "@/components/epic-canvas/renderers/browser-session-dock";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { resetElectronTabsForTests } from "@/lib/browser-view/electron-tabs";
import type { DesktopElectronTabLifecycleBridge } from "@/lib/browser-view/desktop-browser-view";

type StreamConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

type CaptureBridge = {
  readonly capturePrimaryProfile: () => Promise<{
    readonly status: "captured" | "unavailable";
    readonly storageState: unknown;
    readonly reason: string | null;
  }>;
};

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  durableTransport: null as FakeDurableTransport | null,
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
  primaryProfileCaptureReady: true,
  browserViewBridge: null as
    CaptureBridge | DesktopElectronTabLifecycleBridge | null,
  electronTabLifecycle: null as DesktopElectronTabLifecycleBridge | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hookState.hostEntry,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  authenticatedHostStreamKey: () =>
    hookState.hostEntry.websocketUrl === null ? null : hookState.transportKey,
  authenticatedOwnerIdentityKey: () => hookState.ownerIdentityKey,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => hookState.hostClient,
}));

const openTransport = vi.hoisted(
  () =>
    (hostId: string): FakeDurableTransport => {
      hookState.openedHostIds.push(hostId);
      const transport = hookState.durableTransport;
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
  browserView: { capturePrimaryProfile: vi.fn() },
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostMock,
}));

vi.mock("@/lib/browser-view/desktop-browser-view", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/browser-view/desktop-browser-view")
    >();
  return {
    ...actual,
    resolveDesktopBrowserViewBridge: () => hookState.browserViewBridge,
    resolveDesktopElectronTabLifecycleBridge: () =>
      hookState.electronTabLifecycle,
    canCapturePrimaryProfile: () => hookState.primaryProfileCaptureReady,
  };
});

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
    ((status: StreamConnectionStatus, reason: null) => void) | null = null;
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

class FakeBridge implements DesktopElectronTabLifecycleBridge {
  readonly ensureTab = vi.fn<DesktopElectronTabLifecycleBridge["ensureTab"]>(
    async (input) => ({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      registrationId: `native:${input.tabId}`,
    }),
  );
  readonly acceptTab = vi.fn<DesktopElectronTabLifecycleBridge["acceptTab"]>(
    async () => {},
  );
  readonly attachSurface = vi.fn<
    DesktopElectronTabLifecycleBridge["attachSurface"]
  >(async () => {});
  readonly detachSurface = vi.fn<
    DesktopElectronTabLifecycleBridge["detachSurface"]
  >(async () => {});
  readonly releaseTab = vi.fn<DesktopElectronTabLifecycleBridge["releaseTab"]>(
    async () => true,
  );
  readonly controlElectronTab = vi.fn<
    DesktopElectronTabLifecycleBridge["controlElectronTab"]
  >(async () => {});
  readonly dispatchElectronTabCdp = vi.fn<
    DesktopElectronTabLifecycleBridge["dispatchElectronTabCdp"]
  >(async () => ({ kind: "cdpGetFrameTree", ok: true, frames: [] }));
  readonly onNativeTabStatusChange = vi.fn<
    DesktopElectronTabLifecycleBridge["onNativeTabStatusChange"]
  >(() => ({ dispose: () => {} }));
  readonly onNativeTabCdpSessionEnded = vi.fn<
    DesktopElectronTabLifecycleBridge["onNativeTabCdpSessionEnded"]
  >(() => ({ dispose: () => {} }));
  readonly onNativeTabCdpTargetAttached = vi.fn<
    DesktopElectronTabLifecycleBridge["onNativeTabCdpTargetAttached"]
  >(() => ({ dispose: () => {} }));
  readonly onElectronTabHandoff = vi.fn<
    DesktopElectronTabLifecycleBridge["onElectronTabHandoff"]
  >(() => ({ dispose: () => {} }));
}
const INITIAL_ENDPOINT = "ws://host-a/stream";
const RESTARTED_ENDPOINT = "ws://host-b/stream";

function Probe(): ReactNode {
  const sessions = useBrowserSessionsContext();
  const [closeTabStatus, setCloseTabStatus] = useState("idle");
  return (
    <div>
      <span data-testid="lifecycle">{sessions.lifecycle}</span>
      <span data-testid="count">{sessions.items.length}</span>
      <span data-testid="routing">{sessions.routingChatId ?? "null"}</span>
      <span data-testid="close-tab-status">{closeTabStatus}</span>
      <ul>
        {sessions.items.map((session) => (
          <li key={session.sessionId}>{session.name}</li>
        ))}
      </ul>
      <button type="button" onClick={() => sessions.closeSession("sess-1")}>
        close
      </button>
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

function renderProvider(routingChatId: string | null): void {
  render(
    <BrowserSessionsProvider epicId="epic-1" routingChatId={routingChatId}>
      <Probe />
    </BrowserSessionsProvider>,
  );
}

/**
 * Mirrors `EpicBrowserSessionsScope` in epic-surface.tsx: lexicographic first
 * chat id is the deterministic transport routing metadata for the one epic
 * browser.sessions stream mounted above sidebar + canvas.
 */
function selectRoutingChatId(chatIds: readonly string[]): string | null {
  return (
    [...chatIds].toSorted((left, right) => left.localeCompare(right))[0] ?? null
  );
}

function readinessFrames(
  frames: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return frames.filter((frame) => frame.kind === "primaryProfileCaptureReady");
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

function installCaptureBridge(): void {
  const capturePrimaryProfile = vi.fn(() =>
    Promise.resolve({
      status: "captured" as const,
      storageState: {
        cookies: [{ name: "t09_auth", value: "signed-in" }],
      },
      reason: null,
    }),
  );
  hookState.browserViewBridge = { capturePrimaryProfile };
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
  hookState.openedHostIds = [];
  hookState.hostEntry = {
    ...hookState.hostEntry,
    websocketUrl: INITIAL_ENDPOINT,
  };
}

describe("BrowserSessionsProvider (ticket 08 epic subscription)", () => {
  beforeEach(() => {
    installTransport(false);
    hookState.primaryProfileCaptureReady = true;
    hookState.browserViewBridge = null;
    hookState.electronTabLifecycle = null;
    resetElectronTabsForTests();
  });

  afterEach(() => {
    cleanup();
    hookState.browserViewBridge = null;
    hookState.electronTabLifecycle = null;
    resetElectronTabsForTests();
  });

  it("opens exactly one browser.sessions subscription with the routing chat id", () => {
    renderProvider("chat-beta");
    const client = hookState.streamClient;
    expect(client?.subscribes).toEqual([
      {
        method: "browser.sessions",
        params: { epicId: "epic-1", chatId: "chat-beta" },
      },
    ]);
    expect(screen.getByTestId("routing").textContent).toBe("chat-beta");
  });

  it("selects the lexicographically first chat for deterministic reconnect routing", () => {
    expect(selectRoutingChatId(["chat-z", "chat-a", "chat-m"])).toBe("chat-a");
    expect(selectRoutingChatId([])).toBeNull();
  });

  it("does not open a stream when routingChatId is null (zero-chat epic)", () => {
    renderProvider(null);
    expect(hookState.streamClient?.subscribes).toEqual([]);
    expect(screen.getByTestId("routing").textContent).toBe("null");
  });

  it("emits primaryProfileCaptureReady once when capture is available", () => {
    renderProvider("chat-alpha");
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }
    // Readiness is advertised on the live transition, not post-subscribe.
    act(() => {
      stream.emitStatus("open");
    });
    expect(stream.sentFrames).toContainEqual(
      expect.objectContaining({
        kind: "primaryProfileCaptureReady",
        hasBinaryPayload: false,
      }),
    );
    expect(readinessFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("skips primaryProfileCaptureReady when capture is unavailable", () => {
    hookState.primaryProfileCaptureReady = false;
    renderProvider("chat-alpha");
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }
    act(() => {
      stream.emitStatus("open");
    });
    expect(
      stream.sentFrames.some(
        (frame) => frame.kind === "primaryProfileCaptureReady",
      ),
    ).toBe(false);
  });

  it("advertises Electron lifecycle independently of profile capture", () => {
    hookState.primaryProfileCaptureReady = false;
    hookState.electronTabLifecycle = new FakeBridge();
    renderProvider("chat-alpha");
    const stream = hookState.streamClient?.sessions[0];
    if (stream === undefined) throw new Error("expected browser stream");

    act(() => {
      stream.emitStatus("open");
    });

    expect(readinessFrames(stream.sentFrames)).toHaveLength(0);
    expect(electronLifecycleReadinessFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("creates a native tab from the stream and returns the exact provisioned identity", async () => {
    const bridge = new FakeBridge();
    hookState.electronTabLifecycle = bridge;
    renderProvider("chat-alpha");
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
    const transport = hookState.durableTransport;
    expect(transport).toBeDefined();
    if (transport === null) {
      throw new Error("expected durable stream transport");
    }
    const { rerender } = render(
      <BrowserSessionsProvider epicId="epic-1" routingChatId="chat-alpha">
        <Probe />
      </BrowserSessionsProvider>,
    );
    const client = transport.wsStreamClient;
    await waitFor(() => {
      expect(hookState.openedHostIds).toEqual(["host-test"]);
      expect(client.subscribes).toEqual([
        {
          method: "browser.sessions",
          params: { epicId: "epic-1", chatId: "chat-alpha" },
        },
      ]);
    });
    expect(transport.dialedEndpoints).toEqual([INITIAL_ENDPOINT]);
    expect(client.wireSubscriptions).toEqual([
      {
        endpoint: INITIAL_ENDPOINT,
        method: "browser.sessions",
        params: { epicId: "epic-1", chatId: "chat-alpha" },
      },
    ]);

    const stream = client.sessions[0];
    expect(stream).toBeDefined();
    act(() => {
      stream.emitStatus("open");
    });
    expect(stream.sentFrames).toContainEqual(
      expect.objectContaining({ kind: "primaryProfileCaptureReady" }),
    );

    act(() => {
      hookState.hostEntry = {
        ...hookState.hostEntry,
        websocketUrl: null,
      };
      rerender(
        <BrowserSessionsProvider epicId="epic-1" routingChatId="chat-alpha">
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
        <BrowserSessionsProvider epicId="epic-1" routingChatId="chat-alpha">
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
      params: { epicId: "epic-1", chatId: "chat-alpha" },
    });
    expect(stream.closed).toBe(false);
    expect(readinessFrames(stream.sentFrames)).toHaveLength(2);

    cleanup();
    expect(transport.closed).toBe(true);
    expect(stream.closed).toBe(true);
  });

  it("surfaces live snapshot sessions and closeSession delete frames", () => {
    renderProvider("chat-alpha");
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
              name: "Main",
              createdBy: { chatId: "chat-alpha", agentRunId: "run-1" },
              createdAt: 1,
              lastActivityAt: 2,
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
    expect(screen.getByText("Main")).toBeTruthy();

    act(() => {
      screen.getByRole("button", { name: "close" }).click();
    });
    expect(stream?.sentFrames).toContainEqual(
      expect.objectContaining({
        kind: "closeSession",
        sessionId: "sess-1",
      }),
    );
  });

  it("sends closeTab frames and settles them on actionAck", async () => {
    renderProvider("chat-alpha");
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
    renderProvider("chat-alpha");
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
    renderProvider("chat-alpha");
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
    renderProvider("chat-alpha");
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
    renderProvider("chat-alpha");
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
 * live (`open`). Synchronous post-subscribe readiness is therefore lost;
 * readiness must be emitted on the live transition (and again after
 * reconnect), idempotently per connection.
 */
describe("BrowserSessionsProvider (ticket 08-lift live readiness)", () => {
  beforeEach(() => {
    installTransport(true);
    hookState.primaryProfileCaptureReady = true;
    hookState.browserViewBridge = null;
    hookState.electronTabLifecycle = null;
    resetElectronTabsForTests();
  });

  afterEach(() => {
    cleanup();
    hookState.browserViewBridge = null;
    hookState.electronTabLifecycle = null;
    resetElectronTabsForTests();
  });

  it("releases an unaccepted native guest on disconnect instead of replaying it", async () => {
    const bridge = new FakeBridge();
    hookState.electronTabLifecycle = bridge;
    renderProvider("chat-alpha");
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    act(() => {
      stream.emitStatus("open");
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

  it("emits no capture-ready pre-live, then exactly one after first live so a fresh primary capture is serviced", async () => {
    installCaptureBridge();
    renderProvider("chat-alpha");
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    // Pre-live: production may attempt sync readiness, but the gate drops it.
    expect(readinessFrames(stream.sentFrames)).toHaveLength(0);
    expect(screen.getByTestId("lifecycle").textContent).toBe("connecting");

    act(() => {
      stream.emitStatus("open");
    });
    expect(screen.getByTestId("lifecycle").textContent).toBe("live");
    // Desired behavior: re-publish readiness on the live transition.
    expect(readinessFrames(stream.sentFrames)).toHaveLength(1);

    await expectCaptureServiced(stream, "req-fresh-primary-1");

    // Idempotent: repeated live notification on the same connection must not
    // duplicate readiness frames.
    act(() => {
      stream.emitStatus("open");
    });
    expect(readinessFrames(stream.sentFrames)).toHaveLength(1);
  });

  it("emits exactly one readiness on the next live after reconnect and services a fresh capture", async () => {
    installCaptureBridge();
    renderProvider("chat-alpha");
    const stream = hookState.streamClient?.sessions[0];
    expect(stream).toBeDefined();
    if (stream === undefined) {
      throw new Error("expected browser.sessions stream session");
    }

    act(() => {
      stream.emitStatus("open");
    });
    expect(readinessFrames(stream.sentFrames)).toHaveLength(1);
    await expectCaptureServiced(stream, "req-primary-before-reconnect");

    act(() => {
      stream.emitStatus("reconnecting");
    });
    expect(screen.getByTestId("lifecycle").textContent).toBe("reconnecting");
    // Frames during reconnect are dropped; readiness count stays at one.
    expect(readinessFrames(stream.sentFrames)).toHaveLength(1);

    act(() => {
      stream.emitStatus("open");
    });
    expect(screen.getByTestId("lifecycle").textContent).toBe("live");
    // Next live transition: exactly one additional readiness frame.
    expect(readinessFrames(stream.sentFrames)).toHaveLength(2);

    await expectCaptureServiced(stream, "req-primary-after-reconnect");

    act(() => {
      stream.emitStatus("open");
    });
    expect(readinessFrames(stream.sentFrames)).toHaveLength(2);
  });
});
