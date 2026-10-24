import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV137,
  chatSubscribeV138,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatActionAckForVersion,
  projectChatClientFrameForVersion,
} from "@traycer/protocol/host/agent/gui/chat-frame-compat";

/**
 * `chat.subscribe@1.38`: a queued steer that would end the running turn needs
 * the person's confirmation. `queueSteerNow` carries `restartConfirmed`, and
 * a rejected ack names each cause in `steerRestartReasons`.
 *
 * `1.37` and below keep neither. A host strips the reasons from an ack to a
 * lower peer, as it does `cause` below `1.12`. A client sends the frame as
 * is, as it does a `send`'s `browserAnnotations`: a lower host has no field
 * for the confirmation, drops it, and restarts the turn as it always did.
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

describe("chat.subscribe@1.38 registration", () => {
  it("binds chatSubscribeV138 as the latest minor over the frozen 1.37", () => {
    expect(line.latestMinor).toBe(38);
    expect(line.versions[38].contract).toBe(chatSubscribeV138);
    expect(chatSubscribeV138.schemaVersion).toEqual({ major: 1, minor: 38 });
    expect(chatSubscribeV138.openRequestSchema).toBe(
      chatSubscribeV137.openRequestSchema,
    );
  });
});

describe("queueSteerNow restart confirmation", () => {
  it("1.38 reads restartConfirmed, false when omitted", () => {
    expect(
      chatSubscribeV138.clientFrameSchema.parse({
        ...steerFrame,
        restartConfirmed: true,
      }),
    ).toMatchObject({ kind: "queueSteerNow", restartConfirmed: true });
    expect(chatSubscribeV138.clientFrameSchema.parse(steerFrame)).toMatchObject(
      { kind: "queueSteerNow", restartConfirmed: false },
    );
  });

  it("the client sends it as is; a 1.37 host drops the key it has no field for", () => {
    const frame: ChatSubscribeClientFrame = {
      ...steerFrame,
      restartConfirmed: true,
    };
    const sent = projectChatClientFrameForVersion(frame, {
      major: 1,
      minor: 37,
    });
    expect(sent).toBe(frame);
    expect(chatSubscribeV137.clientFrameSchema.parse(sent)).not.toHaveProperty(
      "restartConfirmed",
    );
  });
});

describe("actionAck steer restart reasons", () => {
  it("1.38 reads every reason; 1.37 has no such key", () => {
    expect(
      chatSubscribeV138.serverFrameSchema.parse(rejectedAck),
    ).toMatchObject({ steerRestartReasons: ["images", "skills"] });
    expect(
      chatSubscribeV137.serverFrameSchema.parse(rejectedAck),
    ).not.toHaveProperty("steerRestartReasons");
  });

  it("1.38 refuses a reason outside the vocabulary", () => {
    expect(
      chatSubscribeV138.serverFrameSchema.safeParse({
        ...rejectedAck,
        steerRestartReasons: ["workspace"],
      }).success,
    ).toBe(false);
  });

  it("the host strips the reasons below 1.38 and keeps the draft-image cause from 1.12", () => {
    const ack = { ...rejectedAck, cause: "too-large" };
    const onV137 = projectChatActionAckForVersion(ack, { major: 1, minor: 37 });
    expect(onV137).not.toHaveProperty("steerRestartReasons");
    expect(onV137).toMatchObject({ cause: "too-large" });
    const onV111 = projectChatActionAckForVersion(ack, { major: 1, minor: 11 });
    expect(onV111).not.toHaveProperty("steerRestartReasons");
    expect(onV111).not.toHaveProperty("cause");
    expect(
      projectChatActionAckForVersion(ack, { major: 1, minor: 38 }),
    ).toMatchObject({ steerRestartReasons: ["images", "skills"] });
  });
});
