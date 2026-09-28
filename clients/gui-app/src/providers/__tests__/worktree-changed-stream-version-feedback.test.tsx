import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer-clients/shared/host-transport/ws-factory";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { FakeStreamSession } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import {
  WorktreeChangedStreamClient,
  type WorktreeChangedCursorStore,
} from "@traycer-clients/shared/host-transport/worktree-changed-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  StreamRuntimeContext,
  useStreamMethodSchemaVersion,
} from "@/lib/host/stream-runtime-context";
import { createAppQueryClient } from "@/lib/query-client";
import { WorktreeChangedStreamMount } from "@/providers/worktree-changed-stream-mount";

interface HostViewSocket {
  readonly socket: HostViewWebSocket;
  readonly sent: Array<Record<string, unknown>>;
}

class HostViewWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  callerClose: { readonly code: number; readonly reason: string } | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.kind === "open") {
      queueMicrotask(() => {
        this.onmessage?.({
          type: "text",
          data: JSON.stringify({ kind: "openAck", manifest: frame.manifest }),
        });
      });
    }
  }

  close(code: number, reason: string): void {
    this.callerClose = { code, reason };
  }

  accept(): void {
    this.onopen?.({ type: "open" });
  }
}

afterEach(() => {
  cleanup();
});

it("does not close and recreate the worktree subscription when live and predicted versions publish", async () => {
  const sockets: HostViewSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create: () => {
      const socket = new HostViewWebSocket();
      sockets.push({ socket, sent: socket.sent });
      // Let at most two host sessions complete, so a regression is captured
      // as a bounded trace rather than spinning indefinitely on the broken
      // effect feedback loop.
      if (sockets.length <= 4) {
        queueMicrotask(() => socket.accept());
      }
      return socket;
    },
  };
  const requestContext = createRequestContextFixture({
    origin: "renderer",
    bearerToken: "tok-stream-test",
  });
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => requestContext.credentials,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 5_000,
    maxBackoffMs: 5_000,
  });
  // Establish the initial supported/predicted snapshot before mounting the
  // consumer. The field failure starts after a previous successful handshake;
  // beginning at `unknown` also exercises the separate initial support edge.
  const warmSession = client.subscribe("worktree.changed", {});
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  });
  expect(sockets[0]?.sent.map((frame) => frame.kind)).toContain("subscribe");
  act(() => warmSession.close());
  sockets.length = 0;

  const queryClient = createAppQueryClient();
  const binding = {
    wsStreamClient: client,
    hostId: mockLocalHostEntry.hostId,
    retain: null,
  } as const;

  render(
    <QueryClientProvider client={queryClient}>
      <StreamRuntimeContext.Provider value={binding}>
        <WorktreeChangedStreamMount />
      </StreamRuntimeContext.Provider>
    </QueryClientProvider>,
  );

  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
  // Allow React's external-store notifications and effect cleanups to settle.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  const acceptedSubscriptions = sockets.flatMap(({ sent }) =>
    sent.filter((frame) => frame.kind === "subscribe"),
  );
  const callerClosedSockets = sockets.filter(
    ({ socket }) => socket.callerClose !== null,
  );
  // Host-view regression contract: one accepted subscription must remain
  // alive across the real client's live-version and predicted-version
  // publications; these are not host closes and must not start another dial.
  expect(acceptedSubscriptions).toHaveLength(1);
  expect(callerClosedSockets).toHaveLength(0);

  client.close("test-complete");
});

it("preserves negotiated-version object identity when a session closes to the same predicted version", async () => {
  const sockets: HostViewWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create: () => {
      const socket = new HostViewWebSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.accept());
      return socket;
    },
  };
  const requestContext = createRequestContextFixture({
    origin: "renderer",
    bearerToken: "tok-version-identity-test",
  });
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => requestContext.credentials,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 5_000,
    maxBackoffMs: 5_000,
  });
  const binding = {
    wsStreamClient: client,
    hostId: mockLocalHostEntry.hostId,
    retain: null,
  } as const;
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <StreamRuntimeContext.Provider value={binding}>
      {children}
    </StreamRuntimeContext.Provider>
  );
  const session = client.subscribe("worktree.changed", {});
  const { result } = renderHook(
    () => useStreamMethodSchemaVersion("worktree.changed"),
    { wrapper },
  );
  await waitFor(() => expect(result.current?.minor).toBe(1));
  expect(result.current?.major).toBe(1);
  const negotiatedVersion = result.current;

  act(() => session.close());
  expect(result.current).toBe(negotiatedVersion);
  expect(sockets[0]?.callerClose?.reason).toBe("closed-by-caller");
  client.close("test-complete");
});

it("paces rapid worktree stream replacements on a shared cursor from 250ms up to 5s", () => {
  vi.useFakeTimers();
  const admissionTimes: number[] = [];
  class CountingTransport extends FakeStreamClient {
    constructor() {
      super(true);
    }

    override subscribeWithParamsProvider(
      method: string,
      paramsProvider: (version: SchemaVersion | null) => unknown,
    ): FakeStreamSession {
      admissionTimes.push(Date.now());
      return super.subscribeWithParamsProvider(method, paramsProvider);
    }
  }
  const transport = new CountingTransport();
  const cursor: WorktreeChangedCursorStore = { current: null };
  const callbacks = {
    onChanged: () => true,
    onConnectionStatus: () => undefined,
  };
  const delays = [
    250,
    500,
    1_000,
    2_000,
    4_000,
    ...Array<number>(14).fill(5_000),
  ];
  const admittedClients: WorktreeChangedStreamClient[] = [];
  const admit = (): WorktreeChangedStreamClient => {
    const client = new WorktreeChangedStreamClient({
      wsStreamClient: transport,
      cursor,
      callbacks,
    });
    admittedClients.push(client);
    return client;
  };

  try {
    admit().close();
    const firstAdmissionAt = Date.now();
    expect(admissionTimes).toEqual([firstAdmissionAt]);

    for (const delay of delays) {
      const before = transport.subscribes.length;
      const next = admit();
      // A replacement created in the rapid-close window must not gain socket
      // admission before the shared cursor's current backoff rung expires.
      vi.advanceTimersByTime(delay - 1);
      expect(transport.subscribes).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(transport.subscribes).toHaveLength(before + 1);
      next.close();
    }

    expect(
      admissionTimes
        .slice(1)
        .map((time, index) => time - admissionTimes[index]),
    ).toEqual(delays);
  } finally {
    for (const client of admittedClients) client.close();
    vi.useRealTimers();
  }
});
