import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { FakeStreamClient } from "../__testing__/fake-stream-client";
import {
  SessionImportRunClient,
  type SessionImportRunCallbacks,
} from "../session-import-run-client";

const SELECTIONS: readonly SessionImportSelection[] = [
  { harness: "claude", nativeSessionId: "session-a" },
  { harness: "claude", nativeSessionId: "session-b" },
];
class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(_code: number, _reason: string): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }

  fireClose(code: number, reason: string): void {
    this.onclose?.({ code, reason, wasClean: false });
  }
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  return {
    factory: {
      create(): StreamWebSocketLike {
        const socket = new StubStreamWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    sockets,
  };
}

function makeClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const user = createAuthenticatedUserFixture(undefined);
  const context = createRequestContext({
    identity: identityFromAuthenticatedUser(user),
    bearerToken: "token",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => context.credentials,
    userId: context.identity.userId,
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
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
}

/** Mirrors the host: echo the client's own manifest so the method negotiates. */
function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const open = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({ kind: "openAck", manifest: open.manifest });
}

function subscribeFrame(socket: StubStreamWebSocket): Record<string, unknown> {
  const raw = socket.textSent[1];
  if (raw === undefined) throw new Error("no subscribe frame was sent");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("subscribe frame was not an object");
  }
  return parsed as Record<string, unknown>;
}

function subscribeParams(socket: StubStreamWebSocket): Record<string, unknown> {
  const params = subscribeFrame(socket).params;
  if (typeof params !== "object" || params === null) {
    throw new Error("subscribe frame carried no params");
  }
  return params as Record<string, unknown>;
}

const COUNTS = { imported: 2, skippedAlreadyImported: 0, failed: 0 };

type Recorded = {
  readonly started: string[];
  readonly completed: string[];
  readonly endedUnseen: (string | null)[];
};

function openRunClient(): {
  readonly fake: FakeStreamClient;
  readonly client: SessionImportRunClient;
  readonly recorded: Recorded;
} {
  const fake = new FakeStreamClient(true);
  const recorded: Recorded = { started: [], completed: [], endedUnseen: [] };
  const callbacks: SessionImportRunCallbacks = {
    onStarted: (payload) => recorded.started.push(payload.runId),
    onProgress: () => undefined,
    onComplete: (payload) => recorded.completed.push(payload.runId),
    onRunEndedUnseen: (runId) => recorded.endedUnseen.push(runId),
    onConnectionStatus: () => undefined,
  };
  const client = new SessionImportRunClient({
    wsStreamClient: fake,
    selections: SELECTIONS,
    permissionMode: "default",
    callbacks,
  });
  return { fake, client, recorded };
}

function selectionsSent(fake: FakeStreamClient): number[] {
  return fake.subscribes.map(
    (subscribe) =>
      (subscribe.params as { readonly selections: readonly unknown[] })
        .selections.length,
  );
}

function started(runId: string, attached: boolean, total: number) {
  return {
    kind: "started",
    runId,
    total,
    attached,
    hasBinaryPayload: false,
  };
}

function complete(runId: string, counts: typeof COUNTS) {
  return { kind: "complete", runId, counts, hasBinaryPayload: false };
}

describe("SessionImportRunClient reconnects", () => {
  it("re-subscribes attach-only after a drop that follows started, and keeps following its run", () => {
    const { fake, client, recorded } = openRunClient();
    fake.sessions[0]?.emit(started("run-1", false, 2), null);

    fake.sessions[0]?.emitContinuityStatus("reconnecting", null);
    fake.sessions[1]?.emitContinuityStatus("reconnecting", null);

    expect(fake.sessions[0]?.closed).toBe(true);
    expect(selectionsSent(fake)).toEqual([2, 0]);
    // The host replays the run in flight to the attach.
    fake.sessions[1]?.emit(started("run-1", true, 2), null);
    fake.sessions[1]?.emit(complete("run-1", COUNTS), null);
    expect(recorded.started).toEqual(["run-1", "run-1"]);
    expect(recorded.completed).toEqual(["run-1"]);
    expect(recorded.endedUnseen).toEqual([]);
    client.close();
  });

  it("never re-sends the selections after complete, and keeps the finished run over the host's empty answer", () => {
    const { fake, client, recorded } = openRunClient();
    fake.sessions[0]?.emit(started("run-1", false, 2), null);
    fake.sessions[0]?.emit(complete("run-1", COUNTS), null);

    fake.sessions[0]?.emitContinuityStatus("reconnecting", null);
    // The host is idle now: an empty run, started and completed at once.
    fake.sessions[1]?.emit(started("run-empty", false, 0), null);
    fake.sessions[1]?.emit(
      complete("run-empty", { imported: 0, skippedAlreadyImported: 0, failed: 0 }),
      null,
    );

    expect(selectionsSent(fake)).toEqual([2, 0]);
    expect(recorded.started).toEqual(["run-1"]);
    expect(recorded.completed).toEqual(["run-1"]);
    expect(recorded.endedUnseen).toEqual([]);
    client.close();
  });

  it("reports a run that ended while the connection was down, instead of an empty summary", () => {
    const { fake, client, recorded } = openRunClient();
    fake.sessions[0]?.emit(started("run-1", false, 2), null);

    fake.sessions[0]?.emitContinuityStatus("reconnecting", null);
    fake.sessions[1]?.emit(started("run-empty", false, 0), null);
    fake.sessions[1]?.emit(
      complete("run-empty", { imported: 0, skippedAlreadyImported: 0, failed: 0 }),
      null,
    );

    expect(recorded.endedUnseen).toEqual(["run-1"]);
    expect(recorded.completed).toEqual([]);
    client.close();
  });

  it("keeps the selections while the drop happened before the host was reached", () => {
    const fake = new FakeStreamClient(false);
    const client = new SessionImportRunClient({
      wsStreamClient: fake,
      selections: SELECTIONS,
      permissionMode: "default",
      callbacks: {
        onStarted: () => undefined,
        onProgress: () => undefined,
        onComplete: () => undefined,
        onRunEndedUnseen: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    fake.sessions[0]?.emitContinuityStatus("reconnecting", null);

    expect(fake.sessions[0]?.closed).toBe(false);
    expect(selectionsSent(fake)).toEqual([2]);
    client.close();
  });
});

describe("SessionImportRunClient over a real stream transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never lets the transport replay the selections once the host was reached", () => {
    const { factory, sockets } = makeFactory();
    const client = new SessionImportRunClient({
      wsStreamClient: makeClient(factory),
      selections: SELECTIONS,
      permissionMode: "default",
      callbacks: {
        onStarted: () => undefined,
        onProgress: () => undefined,
        onComplete: () => undefined,
        onRunEndedUnseen: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    expect(subscribeParams(sockets[0]).selections).toEqual(SELECTIONS);

    sockets[0].fireClose(1006, "abnormal");
    // The swap runs inside the `reconnecting` transition, so the attach-only
    // session dials before any backoff timer could replay the selections.
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1]);
    expect(subscribeParams(sockets[1]).selections).toEqual([]);

    sockets[1].fireClose(1006, "abnormal");
    vi.advanceTimersByTime(1_000);
    completeHandshake(sockets[2]);
    expect(subscribeParams(sockets[2]).selections).toEqual([]);
    client.close();
  });
});
