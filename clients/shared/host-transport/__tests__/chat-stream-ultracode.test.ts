import { describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeClientFrameSchema,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "../chat-stream-client";
import type { IStreamClient } from "../i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";

/**
 * The shared client carries the supplied Ultracode request on every settings
 * mutation when the negotiated line is 1.41 or later, and drops the key on
 * older lines so they look exactly like the release before the feature. Only
 * the property's presence and value are compared, never the frame or its
 * environment.
 */

const LATEST: SchemaVersion = { major: 1, minor: 41 };
const PRE_ULTRACODE: SchemaVersion = { major: 1, minor: 40 };

const OWNER = {
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
  clientActionId: "action-1",
};

const SETTINGS = {
  harnessId: "claude",
  model: "claude-sonnet-4-20250514",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const MUTATIONS = [
  "send",
  "editUserMessage",
  "queueSettingsUpdate",
  "queueSettingsRestamp",
  "queueSteerNow",
] as const;

type MutationKind = (typeof MUTATIONS)[number];

class StubStreamSession implements IStreamSession {
  readonly sentFrames: StreamFrameEnvelope[] = [];

  constructor(private readonly version: SchemaVersion) {}

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    void binaryPayload;
    this.sentFrames.push(envelope);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    void handler;
  }

  onStatusChange(): void {}

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion {
    return this.version;
  }

  close(): void {}
}

function noopCallbacks(): ChatStreamCallbacks {
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
  };
}

function connect(version: SchemaVersion): {
  readonly client: ChatStreamClient;
  readonly session: StubStreamSession;
} {
  const session = new StubStreamSession(version);
  const wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry> = {
    subscribe: () => session,
    subscribeWithParamsProvider: () => session,
    getMethodSchemaVersion: () => version,
  };
  const client = new ChatStreamClient({
    wsStreamClient,
    epicId: "epic-1",
    chatId: "chat-1",
    callbacks: noopCallbacks(),
  });
  return { client, session };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawMutation(kind: MutationKind, ultracode: boolean) {
  const settings = { ...SETTINGS, ultracode };
  const content = { type: "doc", content: [] };
  const sender = { type: "user", userId: "user-1" };
  const accountContext = { type: "PERSONAL" };
  switch (kind) {
    case "send":
      return {
        kind,
        ...OWNER,
        messageId: "message-1",
        content,
        sender,
        settings,
        accountContext,
        browserAnnotations: [],
      };
    case "editUserMessage":
      return {
        kind,
        ...OWNER,
        targetMessageId: "message-0",
        messageId: "message-1",
        content,
        sender,
        settings,
        accountContext,
        revertFileChanges: false,
        browserAnnotations: [],
      };
    case "queueSettingsUpdate":
      return {
        kind,
        ...OWNER,
        queueItemId: "queue-1",
        settings,
        accountContext,
      };
    case "queueSettingsRestamp":
      return {
        kind,
        ...OWNER,
        settings,
        accountContext,
        excludeQueueItemId: null,
      };
    case "queueSteerNow":
      return { kind, ...OWNER, queueItemId: "queue-1", newSettings: settings };
  }
}

function frameFor(
  kind: MutationKind,
  ultracode: boolean,
): ChatSubscribeClientFrame {
  return chatSubscribeClientFrameSchema.parse(rawMutation(kind, ultracode));
}

/** The one tuple the sent frame carries, wherever its kind keeps it. */
function sentSettings(session: StubStreamSession): Record<string, unknown> {
  const sent = session.sentFrames.at(-1);
  if (!isRecord(sent)) throw new Error("no frame was sent");
  const settings =
    sent.kind === "queueSteerNow" ? sent.newSettings : sent.settings;
  if (!isRecord(settings)) throw new Error("the sent frame has no tuple");
  return settings;
}

describe("ChatStreamClient.sendAction", () => {
  describe.each(MUTATIONS)("%s", (kind) => {
    it.each([false, true])(
      "carries a supplied %s request on the latest line and keeps the rest of the tuple",
      (supplied) => {
        const { client, session } = connect(LATEST);

        client.sendAction(frameFor(kind, supplied));

        const settings = sentSettings(session);
        expect(settings.ultracode).toBe(supplied);
        expect(settings.model).toBe(SETTINGS.model);
        client.close();
      },
    );

    it("drops the request on 1.40 and keeps the rest of the tuple", () => {
      const { client, session } = connect(PRE_ULTRACODE);

      client.sendAction(frameFor(kind, true));

      const settings = sentSettings(session);
      expect(Object.hasOwn(settings, "ultracode")).toBe(false);
      expect(settings.model).toBe(SETTINGS.model);
      client.close();
    });
  });

  it("sends a frame with no tuple unchanged", () => {
    const { client, session } = connect(LATEST);
    const frame = chatSubscribeClientFrameSchema.parse({
      kind: "resumeQueue",
      ...OWNER,
    });

    client.sendAction(frame);

    expect(session.sentFrames).toEqual([frame]);
    client.close();
  });
});
