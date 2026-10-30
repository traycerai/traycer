import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV139,
  chatSubscribeV140,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  projectChatActionAckForVersion,
  projectChatClientFrameForVersion,
} from "@traycer/protocol/host/agent/gui/chat-frame-compat";

/**
 * `chat.subscribe@1.40`: a queued steer that would end the running turn needs
 * the person's confirmation. `queueSteerNow` carries `restartConfirmed`, and
 * a rejected ack names each cause in `steerRestartReasons`.
 *
 * `1.39` and below keep neither. A host strips the reasons from an ack to a
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
  steerRestartReasons: ["settings", "images"],
} as const;

describe("chat.subscribe@1.40 registration", () => {
  it("binds chatSubscribeV140 as the latest minor over the frozen 1.39", () => {
    expect(line.latestMinor).toBe(40);
    expect(line.versions[40].contract).toBe(chatSubscribeV140);
    expect(chatSubscribeV140.schemaVersion).toEqual({ major: 1, minor: 40 });
    expect(chatSubscribeV140.openRequestSchema).toBe(
      chatSubscribeV139.openRequestSchema,
    );
  });
});

describe("queueSteerNow restart confirmation", () => {
  it("1.40 reads restartConfirmed, false when omitted", () => {
    expect(
      chatSubscribeV140.clientFrameSchema.parse({
        ...steerFrame,
        restartConfirmed: true,
      }),
    ).toMatchObject({ kind: "queueSteerNow", restartConfirmed: true });
    expect(chatSubscribeV140.clientFrameSchema.parse(steerFrame)).toMatchObject(
      { kind: "queueSteerNow", restartConfirmed: false },
    );
  });

  it("the client sends it as is; a 1.39 host drops the key it has no field for", () => {
    const frame: ChatSubscribeClientFrame = {
      ...steerFrame,
      restartConfirmed: true,
    };
    const sent = projectChatClientFrameForVersion(frame, {
      major: 1,
      minor: 39,
    });
    expect(sent).toBe(frame);
    expect(chatSubscribeV139.clientFrameSchema.parse(sent)).not.toHaveProperty(
      "restartConfirmed",
    );
  });
});

describe("actionAck steer restart reasons", () => {
  it("1.40 reads every reason; 1.39 has no such key", () => {
    expect(
      chatSubscribeV140.serverFrameSchema.parse(rejectedAck),
    ).toMatchObject({ steerRestartReasons: ["settings", "images"] });
    expect(
      chatSubscribeV139.serverFrameSchema.parse(rejectedAck),
    ).not.toHaveProperty("steerRestartReasons");
  });

  it("1.40 still decodes the published slash_command and skills members", () => {
    expect(
      chatSubscribeV140.serverFrameSchema.parse({
        ...rejectedAck,
        steerRestartReasons: ["slash_command", "skills"],
      }),
    ).toMatchObject({ steerRestartReasons: ["slash_command", "skills"] });
  });

  it("1.40 refuses a reason outside the vocabulary", () => {
    expect(
      chatSubscribeV140.serverFrameSchema.safeParse({
        ...rejectedAck,
        steerRestartReasons: ["workspace"],
      }).success,
    ).toBe(false);
  });

  it("the host strips the reasons below 1.40 and keeps the draft-image cause from 1.12", () => {
    const ack = { ...rejectedAck, cause: "too-large" };
    const onV139 = projectChatActionAckForVersion(ack, { major: 1, minor: 39 });
    expect(onV139).not.toHaveProperty("steerRestartReasons");
    expect(onV139).toMatchObject({ cause: "too-large" });
    const onV111 = projectChatActionAckForVersion(ack, { major: 1, minor: 11 });
    expect(onV111).not.toHaveProperty("steerRestartReasons");
    expect(onV111).not.toHaveProperty("cause");
    expect(
      projectChatActionAckForVersion(ack, { major: 1, minor: 40 }),
    ).toMatchObject({ steerRestartReasons: ["settings", "images"] });
  });
});
