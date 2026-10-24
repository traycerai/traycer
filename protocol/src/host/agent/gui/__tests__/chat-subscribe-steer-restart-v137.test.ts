import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV136,
  chatSubscribeV137,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatActionAckForVersion,
  projectChatClientFrameForVersion,
} from "@traycer/protocol/host/agent/gui/chat-frame-compat";

/**
 * `chat.subscribe@1.37`: a queued steer that would end the running turn needs
 * the person's confirmation. `queueSteerNow` carries `restartConfirmed`, and
 * a rejected ack names each cause in `steerRestartReasons`.
 *
 * `1.36` and below keep neither: a released client never sends the
 * confirmation and a released host never names a reason, so each side
 * projects the key away for a lower peer rather than relying on the
 * receiver's leniency.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
} as const;

const steerFrame = {
  kind: "queueSteerNow",
  ...envelope,
  clientActionId: "action-1",
  queueItemId: "queue-1",
  newSettings: null,
} as const;

const rejectedAck = {
  kind: "actionAck",
  ...envelope,
  clientActionId: "action-1",
  action: "queueSteerNow",
  status: "rejected",
  reason: "Steering this message ends the current turn.",
  code: "QUEUE_STEER_RESTART_UNCONFIRMED",
  backgroundStopTaskIds: [],
  steerRestartReasons: ["images", "skills"],
} as const;

describe("chat.subscribe@1.37 registration", () => {
  it("binds chatSubscribeV137 as the latest minor over the frozen 1.36", () => {
    expect(line.latestMinor).toBe(37);
    expect(line.versions[37].contract).toBe(chatSubscribeV137);
    expect(chatSubscribeV137.schemaVersion).toEqual({ major: 1, minor: 37 });
    expect(chatSubscribeV137.openRequestSchema).toBe(
      chatSubscribeV136.openRequestSchema,
    );
  });
});

describe("queueSteerNow restart confirmation", () => {
  it("1.37 reads restartConfirmed, false when omitted", () => {
    expect(
      chatSubscribeV137.clientFrameSchema.parse({
        ...steerFrame,
        restartConfirmed: true,
      }),
    ).toMatchObject({ kind: "queueSteerNow", restartConfirmed: true });
    expect(chatSubscribeV137.clientFrameSchema.parse(steerFrame)).toMatchObject(
      { kind: "queueSteerNow", restartConfirmed: false },
    );
  });

  it("1.36 has no such key", () => {
    const parsed = chatSubscribeV136.clientFrameSchema.parse({
      ...steerFrame,
      restartConfirmed: true,
    });
    expect(parsed).not.toHaveProperty("restartConfirmed");
  });

  it("the client projects it away below 1.37 and keeps it on 1.37", () => {
    const frame: ChatSubscribeClientFrame = {
      ...steerFrame,
      restartConfirmed: true,
    };
    expect(
      projectChatClientFrameForVersion(frame, { major: 1, minor: 36 }),
    ).not.toHaveProperty("restartConfirmed");
    expect(
      projectChatClientFrameForVersion(frame, { major: 1, minor: 37 }),
    ).toMatchObject({ restartConfirmed: true });
  });
});

describe("actionAck steer restart reasons", () => {
  it("1.37 reads every reason; 1.36 has no such key", () => {
    expect(
      chatSubscribeV137.serverFrameSchema.parse(rejectedAck),
    ).toMatchObject({ steerRestartReasons: ["images", "skills"] });
    expect(
      chatSubscribeV136.serverFrameSchema.parse(rejectedAck),
    ).not.toHaveProperty("steerRestartReasons");
  });

  it("1.37 refuses a reason outside the vocabulary", () => {
    expect(
      chatSubscribeV137.serverFrameSchema.safeParse({
        ...rejectedAck,
        steerRestartReasons: ["workspace"],
      }).success,
    ).toBe(false);
  });

  it("the host strips the reasons below 1.37 and keeps the draft-image cause from 1.12", () => {
    const ack = { ...rejectedAck, cause: "too-large" };
    const onV136 = projectChatActionAckForVersion(ack, { major: 1, minor: 36 });
    expect(onV136).not.toHaveProperty("steerRestartReasons");
    expect(onV136).toMatchObject({ cause: "too-large" });
    const onV111 = projectChatActionAckForVersion(ack, { major: 1, minor: 11 });
    expect(onV111).not.toHaveProperty("steerRestartReasons");
    expect(onV111).not.toHaveProperty("cause");
    expect(
      projectChatActionAckForVersion(ack, { major: 1, minor: 37 }),
    ).toMatchObject({ steerRestartReasons: ["images", "skills"] });
  });
});
