import { describe, expect, it } from "vitest";
import type { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
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
  closed = false;

  constructor(private readonly version: SchemaVersion | null) {}

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    void envelope;
    void binaryPayload;
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(): void {}

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.version;
  }

  close(): void {
    this.closed = true;
  }

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

interface Reading {
  readonly turnId: string;
  readonly estimate: number;
}

function recordingCallbacks(readings: Reading[]): ChatStreamCallbacks {
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
    onThinkingTokens: (frame) => {
      readings.push({ turnId: frame.turnId, estimate: frame.estimate });
    },
    onConnectionStatus: () => undefined,
  };
}

function thinkingTokensFrame(
  turnId: string,
  estimate: number,
): StreamFrameEnvelope {
  return {
    kind: "thinkingTokens",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    turnId,
    estimate,
  };
}

describe("ChatStreamClient thinkingTokens frame", () => {
  it("reaches onThinkingTokens on a windowed 1.17 session", () => {
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: 17,
    });
    const readings: Reading[] = [];
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: recordingCallbacks(readings),
    });

    session.deliver(thinkingTokensFrame("turn-1", 120));
    session.deliver(thinkingTokensFrame("turn-1", 480));

    expect(readings).toEqual([
      { turnId: "turn-1", estimate: 120 },
      { turnId: "turn-1", estimate: 480 },
    ]);
    client.close();
  });

  it("reaches onThinkingTokens on the legacy (non-windowed) switch", () => {
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: 7,
    });
    const readings: Reading[] = [];
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: recordingCallbacks(readings),
    });

    session.deliver(thinkingTokensFrame("turn-9", 33));

    expect(readings).toEqual([{ turnId: "turn-9", estimate: 33 }]);
    client.close();
  });
});
