import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
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
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "../chat-stream-client";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(): StreamWebSocketLike {
      const socket = new StubStreamWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  return { factory, sockets };
}

function makeWsStreamClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx = makeRequestContext("token");
  return new WsStreamClient({
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1000,
  });
}

function makeRequestContext(bearer: string): RequestContext {
  const fixture = createAuthenticatedUserFixture(undefined);
  return createRequestContext({
    identity: identityFromAuthenticatedUser(fixture),
    bearerToken: bearer,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const openParsed = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest: openParsed.manifest,
  });
}

function parseText(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object text frame");
  }
  return value as Record<string, unknown>;
}

describe("ChatStreamClient", () => {
  it("subscribes to chat.subscribe and dispatches typed frames", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: string[] = [];
    const worktreeBindings: Array<{
      readonly hasWorktree: boolean;
      readonly entryCount: number;
    } | null> = [];
    const fileEditApprovalFrames: string[] = [];
    const interviewFrames: string[] = [];
    const restoreFrames: string[] = [];
    const callbacks: ChatStreamCallbacks = {
      onSnapshot: (frame) => {
        snapshots.push(frame.snapshot.chat.id);
      },
      onActionAck: () => undefined,
      onMessageAccepted: () => undefined,
      onQueueChanged: () => undefined,
      onTurnStateChanged: () => undefined,
      onBlockDelta: () => undefined,
      onApprovalRequested: () => undefined,
      onApprovalResolved: () => undefined,
      onFileEditApprovalRequested: (frame) => {
        fileEditApprovalFrames.push(frame.approval.approvalId);
      },
      onFileEditApprovalResolved: (frame) => {
        fileEditApprovalFrames.push(frame.approvalId);
      },
      onInterviewRequested: (frame) => {
        interviewFrames.push(`${frame.kind}:${frame.blockId}`);
      },
      onInterviewAnswered: (frame) => {
        interviewFrames.push(`${frame.kind}:${frame.blockId}`);
      },
      onInterviewErrored: (frame) => {
        interviewFrames.push(`${frame.kind}:${frame.blockId}`);
      },
      onEventAppended: () => undefined,
      onRestoreStarted: (frame) => {
        restoreFrames.push(frame.kind);
      },
      onRestoreProgress: (frame) => {
        restoreFrames.push(frame.kind);
      },
      onRestoreCompleted: (frame) => {
        restoreFrames.push(frame.kind);
      },
      onErrorNotice: () => undefined,
      onWorktreeStateChanged: (frame) => {
        worktreeBindings.push(
          frame.worktreeBinding === null
            ? null
            : {
                hasWorktree: frame.worktreeBinding.entries.some(
                  (e) => e.mode === "worktree",
                ),
                entryCount: frame.worktreeBinding.entries.length,
              },
        );
      },
      onConnectionStatus: () => undefined,
    };

    const client = new ChatStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks,
    });
    completeHandshake(sockets[0]);

    // The advertised version tracks the registry's canonical chat.subscribe
    // line - a literal here rots every time a minor lands.
    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: buildStreamManifest(hostStreamRpcRegistry)[
        "chat.subscribe"
      ],
      params: { epicId: "epic-1", chatId: "chat-1" },
    });

    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          id: "chat-1",
          parentId: null,
          userId: "owner-1",
          hostId: "test-host",
          title: "Chat",
          createdAt: 1,
          updatedAt: 1,
          isTitleEditedByUser: false,
          sessionRef: null,
          messages: [],
          events: [],
        },
        access: { role: "owner", ownerUserId: "owner-1", canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
      },
    });

    sockets[0].fireText({
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      missingWorktreePaths: [],
      worktreeBinding: {
        entries: [
          {
            workspacePath: "/repo",
            mode: "worktree",
            repoIdentifier: { owner: "acme", repo: "app" },
            worktreePath: "/repo-wt",
            branch: "feat/x",
            isPrimary: true,
            isImported: false,
            setupState: "running",
            setupTerminalSessionId: "term-1",
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: 10,
            ownedSubmodules: [],
          },
        ],
      },
    });

    sockets[0].fireText({
      kind: "fileEditApprovalRequested",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      approval: {
        approvalId: "file-approval-1",
        toolName: "apply_patch",
        description: "Edit source files",
        paths: ["/repo/src/app.ts"],
        operation: "edit",
        input: null,
        requestedAt: 2,
      },
    });
    sockets[0].fireText({
      kind: "fileEditApprovalResolved",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "file-approval-1",
      decision: { approved: true },
      resolvedAt: 3,
    });
    sockets[0].fireText({
      kind: "interviewRequested",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "question-1",
      requestedAt: 4,
    });
    sockets[0].fireText({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "question-1",
      answers: [],
      resolvedAt: 5,
    });
    sockets[0].fireText({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "question-2",
      reason: "Skipped",
      resolvedAt: 6,
    });

    sockets[0].fireText({
      kind: "restoreStarted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      checkpointId: "turn-1",
      restoringUserId: "owner-1",
      restoringHostId: "host-1",
      startedAt: 2,
    });
    sockets[0].fireText({
      kind: "restoreProgress",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      checkpointId: "turn-1",
      processedCount: 1,
      totalCount: 2,
    });
    sockets[0].fireText({
      kind: "restoreCompleted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      checkpointId: "turn-1",
      finishedAt: 3,
      results: [
        {
          filePath: "/repo/src/app.ts",
          status: "restored",
          operation: "edit",
          reason: null,
        },
      ],
    });

    const frame: ChatSubscribeClientFrame = {
      kind: "resumeQueue",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
    };
    client.sendAction(frame);

    expect(snapshots).toEqual(["chat-1"]);
    expect(worktreeBindings).toEqual([{ hasWorktree: true, entryCount: 1 }]);
    expect(fileEditApprovalFrames).toEqual([
      "file-approval-1",
      "file-approval-1",
    ]);
    expect(interviewFrames).toEqual([
      "interviewRequested:question-1",
      "interviewAnswered:question-1",
      "interviewErrored:question-2",
    ]);
    expect(restoreFrames).toEqual([
      "restoreStarted",
      "restoreProgress",
      "restoreCompleted",
    ]);
    expect(parseText(sockets[0].textSent[2])).toEqual(frame);

    client.close();
    expect(sockets[0].closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });
  });
});
