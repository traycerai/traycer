import { describe, expect, it } from "vitest";
import type { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { openUserMessageSchema } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  chatSubscribeV121,
  openChatSubscribeWindowedServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { IStreamClient } from "../i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "../chat-stream-client";

class StubStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;

  constructor(private readonly version: SchemaVersion | null) {}

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(): void {}

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.version;
  }

  close(): void {}

  deliver(envelope: StreamFrameEnvelope): void {
    this.serverFrameHandler?.(envelope, null);
  }
}

function stubClientAtVersion(version: SchemaVersion): {
  readonly wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry>;
  readonly session: StubStreamSession;
} {
  const session = new StubStreamSession(version);
  const wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry> = {
    subscribe: () => session,
    subscribeWithParamsProvider: () => session,
    getMethodSchemaVersion: () => version,
  };
  return { wsStreamClient, session };
}

function noopCallbacks(
  overrides: Partial<ChatStreamCallbacks>,
): ChatStreamCallbacks {
  return {
    onSnapshot: () => undefined,
    onWindowedSnapshot: () => undefined,
    onSkeletonChunk: () => undefined,
    onIndexChanged: () => undefined,
    onRange: () => undefined,
    onAccumulatedChanges: () => undefined,
    onActionAck: () => undefined,
    onMessageAccepted: () => undefined,
    onMessageDeliveryChanged: () => undefined,
    onQueueChanged: () => undefined,
    onTurnStateChanged: () => undefined,
    onBlockDelta: () => undefined,
    onApprovalRequested: () => undefined,
    onApprovalResolved: () => undefined,
    onFileEditApprovalRequested: () => undefined,
    onFileEditApprovalResolved: () => undefined,
    onInterviewRequested: () => undefined,
    onInterviewAnswered: () => undefined,
    onInterviewErrored: () => undefined,
    onEventAppended: () => undefined,
    onRestoreStarted: () => undefined,
    onRestoreProgress: () => undefined,
    onRestoreCompleted: () => undefined,
    onErrorNotice: () => undefined,
    onWorktreeStateChanged: () => undefined,
    onManagedCommandsChanged: () => undefined,
    onHeldUpdatesChanged: () => undefined,
    onPortForwardsChanged: () => undefined,
    onThinkingTokens: () => undefined,
    onConnectionStatus: () => undefined,
    readSkeletonResume: () => null,
    ...overrides,
  };
}

// A user row sent by an agent on a harness this build has never heard of.
const AGENT_ROW = {
  role: "user",
  messageId: "msg-1",
  sender: {
    type: "agent",
    harnessId: "zzz-future",
    agentId: "agent-1",
    displayName: "Future Agent",
    reply: { expectsReply: false },
    inReplyTo: null,
  },
  message: {
    kind: "agent",
    content: { type: "doc", content: [] },
    fromAgentId: "agent-1",
    senderTitle: "Future Agent",
    senderHarnessId: "zzz-future",
    reply: { expectsReply: false },
  },
  timestamp: 5,
  sessionAnchor: null,
};

const MESSAGE_ACCEPTED_ENVELOPE = {
  kind: "messageAccepted",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  message: AGENT_ROW,
} satisfies StreamFrameEnvelope;

describe("chat.subscribe open harness ids on messageAccepted", () => {
  it("the fixture is a valid open user message", () => {
    expect(openUserMessageSchema.safeParse(AGENT_ROW).success).toBe(true);
  });

  it("delivers a row from an unknown harness to onMessageAccepted on a negotiated 1.22 session", () => {
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: 22,
    });
    const heard: string[] = [];
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: noopCallbacks({
        onMessageAccepted: (frame) => {
          if (frame.message.sender.type === "agent") {
            heard.push(frame.message.sender.harnessId);
          }
        },
      }),
    });

    session.deliver(MESSAGE_ACCEPTED_ENVELOPE);

    expect(heard).toEqual(["zzz-future"]);
    client.close();
  });

  it("the live windowed union accepts the envelope", () => {
    expect(
      openChatSubscribeWindowedServerFrameSchema.safeParse(
        MESSAGE_ACCEPTED_ENVELOPE,
      ).success,
    ).toBe(true);
  });

  it("the frozen 1.21 union rejects the same envelope", () => {
    expect(
      chatSubscribeV121.serverFrameSchema.safeParse(MESSAGE_ACCEPTED_ENVELOPE)
        .success,
    ).toBe(false);
  });

  it("the frozen 1.21 union accepts the envelope once the harness id is a known one (the rejection is about the id alone)", () => {
    const known = {
      ...MESSAGE_ACCEPTED_ENVELOPE,
      message: {
        ...AGENT_ROW,
        sender: { ...AGENT_ROW.sender, harnessId: "claude" },
      },
    };

    expect(chatSubscribeV121.serverFrameSchema.safeParse(known).success).toBe(
      true,
    );
  });
});
