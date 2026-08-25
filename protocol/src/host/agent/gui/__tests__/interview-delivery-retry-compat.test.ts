import { describe, expect, it } from "vitest";
import {
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatClientFrameForVersion,
  projectChatServerFrameForVersion,
} from "../chat-frame-compat";

const OWNER = {
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
  clientActionId: "retry-action-1",
};

const RETRY: ChatSubscribeClientFrame = {
  kind: "interviewDeliveryRetry",
  ...OWNER,
  blockId: "block-1",
  settlementId: "settlement-1",
  deliveryId: "delivery-1",
};

const RETRY_ACK = {
  kind: "actionAck" as const,
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
  clientActionId: "retry-action-1",
  action: "interviewDeliveryRetry" as const,
  status: "accepted" as const,
  reason: null,
  code: null,
  backgroundStopTaskIds: [],
};

const LEGACY_VERSIONS: ReadonlyArray<SchemaVersion | null> = [
  { major: 1, minor: 6 },
  { major: 1, minor: 5 },
  { major: 1, minor: 4 },
  null,
];

describe("interviewDeliveryRetry chat.subscribe@1.7 compatibility", () => {
  it("accepts the immutable block, settlement, and delivery identities on 1.7", () => {
    expect(chatSubscribeV17.clientFrameSchema.parse(RETRY)).toEqual(RETRY);
    expect(
      projectChatClientFrameForVersion(RETRY, { major: 1, minor: 7 }),
    ).toBe(RETRY);
  });

  it("rejects the retry action below 1.7 instead of silently projecting it", () => {
    for (const version of LEGACY_VERSIONS) {
      expect(() => projectChatClientFrameForVersion(RETRY, version)).toThrow(
        "interviewDeliveryRetry requires chat.subscribe@1.7 or newer",
      );
    }

    expect(() => chatSubscribeV16.clientFrameSchema.parse(RETRY)).toThrow();
    expect(() => chatSubscribeV15.clientFrameSchema.parse(RETRY)).toThrow();
    expect(() => chatSubscribeV14.clientFrameSchema.parse(RETRY)).toThrow();
  });

  it("round-trips the retry action through the 1.7 action acknowledgement", () => {
    expect(chatSubscribeV17.serverFrameSchema.parse(RETRY_ACK)).toEqual(
      RETRY_ACK,
    );
    expect(
      projectChatServerFrameForVersion(RETRY_ACK, { major: 1, minor: 7 }),
    ).toBe(RETRY_ACK);
  });

  it("rejects a retry action acknowledgement on every released pre-1.7 line", () => {
    for (const version of LEGACY_VERSIONS) {
      expect(() =>
        projectChatServerFrameForVersion(RETRY_ACK, version),
      ).toThrow("interviewDeliveryRetry action acknowledgement requires");
    }
    expect(() => chatSubscribeV16.serverFrameSchema.parse(RETRY_ACK)).toThrow();
    expect(() => chatSubscribeV15.serverFrameSchema.parse(RETRY_ACK)).toThrow();
    expect(() => chatSubscribeV14.serverFrameSchema.parse(RETRY_ACK)).toThrow();
  });
});
