/**
 * A chat session's lifecycle refusal, end to end on the local transport: it
 * reaches the store as a counted retry that carries the host's code, never as a
 * terminal close or a failure notification.
 *
 * Every layer between the socket and the store is the production one: a real
 * `WsStreamClient` over a scripted socket, a real `ChatStreamClient`, and the
 * store's own status handling, failure-notification gate included. A fake
 * stream client at the store boundary could not prove that gate stays quiet:
 * it fires only on a `closed` status with a non-retryable fatal reason, so a
 * fake that reports `reconnecting` never reaches it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  SESSION_CLOSED_FATAL_CODE,
  SESSION_NOT_READY_FATAL_CODE,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer-clients/shared/host-transport/ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";

const HOST_ID = "host-a";
const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const OWNER_ID = "owner-1";

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

  close(): void {
    // The client tears its own socket down; nothing here observes it.
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }
}

interface Rig {
  readonly handle: ChatSessionStoreHandle;
  readonly sockets: StubStreamWebSocket[];
}

function makeRig(): Rig {
  const sockets: StubStreamWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(): StreamWebSocketLike {
      const socket = new StubStreamWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  const context = createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "token",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  const wsStreamClient = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => context.credentials,
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
    initialBackoffMs: 5,
    maxBackoffMs: 50,
  });
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (epicId, chatId, callbacks) => {
      const client = new ChatStreamClient({
        wsStreamClient,
        epicId,
        chatId,
        callbacks,
      });
      return {
        sendAction: (frame) => {
          client.sendAction(frame);
        },
        sameTurnSteeringProtocolSupported: () =>
          client.sameTurnSteeringProtocolSupported(),
        requestTranscriptRange: (request) => {
          client.requestTranscriptRange(request);
        },
        requestResnapshot: () => {
          client.requestResnapshot();
        },
        interviewSettlementActionsProtocolSupported: () =>
          client.interviewSettlementActionsProtocolSupported(),
        close: () => {
          client.close();
        },
      };
    },
  });
  return { handle, sockets };
}

/** Waits for something to happen, bounded, on real timers. */
async function pollUntil(
  label: string,
  predicate: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fires the socket's open and echoes the client's manifest as the openAck. */
function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const openFrame = socket.textSent.at(0);
  if (openFrame === undefined) throw new Error("Expected the open frame");
  const parsed = JSON.parse(openFrame) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({ kind: "openAck", manifest: parsed.manifest });
}

async function openedRig(): Promise<Rig> {
  const rig = makeRig();
  await pollUntil("the first dial", () => rig.sockets.length > 0);
  const socket = rig.sockets.at(0);
  if (socket === undefined) throw new Error("Expected the first socket");
  completeHandshake(socket);
  expect(rig.handle.store.getState().connectionStatus).toBe("open");
  return rig;
}

function notificationFor(code: string): unknown {
  return useAppLocalNotificationsStore.getState().byId[
    `stream.transport.error:${HOST_ID}:${CHAT_ID}:${code}`
  ];
}

describe("a chat session's lifecycle refusal reaches the store as a coded retry", () => {
  // The notifications store drops every write until an identity is active, so
  // without this the control could not fire and the absences would hold for
  // that reason alone.
  beforeEach(() => {
    useAppLocalNotificationsStore.getState().activateIdentity(OWNER_ID);
  });

  afterEach(() => {
    __resetAppLocalNotificationsStoreForTests();
  });

  it.each([SESSION_NOT_READY_FATAL_CODE, SESSION_CLOSED_FATAL_CODE])(
    "%s without `retryable` reconnects, records the host's code, and raises no failure notification",
    async (code) => {
      const rig = await openedRig();
      try {
        // The frame a host released before these codes were flagged sends:
        // a plain fatal, no `retryable`.
        const details: FatalErrorDetails = {
          code,
          reason: `${code}: Chat session is not ready`,
          incompatibleMethods: null,
          upgradeGuidance: null,
        };
        rig.sockets.at(0)?.fireText({ kind: "fatalError", details });

        const state = rig.handle.store.getState();
        expect(state.connectionStatus).toBe("reconnecting");
        expect(state.fatalClose).toBeNull();
        expect(state.preSnapshotRetries).toMatchObject({
          count: 1,
          code,
          reason: details.reason,
        });
        expect(typeof state.preSnapshotRetries?.firstAt).toBe("number");
        expect(notificationFor(code)).toBeUndefined();
        // Still retrying, not merely quiet: the transport dials again.
        await pollUntil("the redial", () => rig.sockets.length > 1);
      } finally {
        rig.handle.dispose();
      }
    },
  );

  // The control, in the same rig: a real verdict still ends the stream and
  // still raises the notification. Without it, the absence above could be a
  // rig in which the gate never fires at all.
  it("CHAT_NOT_VISIBLE, a verdict on the chat, still closes and raises the notification", async () => {
    const rig = await openedRig();
    try {
      rig.sockets.at(0)?.fireText({
        kind: "fatalError",
        details: {
          code: "CHAT_NOT_VISIBLE",
          reason: "CHAT_NOT_VISIBLE: Chat is not visible to this user",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });

      const state = rig.handle.store.getState();
      expect(state.connectionStatus).toBe("closed");
      expect(state.fatalClose?.code).toBe("CHAT_NOT_VISIBLE");
      expect(state.preSnapshotRetries).toBeNull();
      expect(notificationFor("CHAT_NOT_VISIBLE")).toBeDefined();
      // Elapsed time is the assertion here: nothing redials a verdict.
      await wait(50);
      expect(rig.sockets).toHaveLength(1);
    } finally {
      rig.handle.dispose();
    }
  });
});
