import { describe, expect, it } from "vitest";
import type {
  BotReadCursorReadResponse,
  BotReadPosition,
} from "@traycer/protocol/host/bot/schemas";
import {
  advanceTarget,
  channelBold,
  threadHasNewReplies,
} from "../bot-read-cursor";

const CHANNEL = "channel-1";
const THREAD = "thread-1";

function position(seq: number): BotReadPosition {
  return { messageId: `m-${String(seq)}`, seq };
}

function read(
  latest: Record<string, BotReadPosition>,
  cursors: Record<string, BotReadPosition>,
): BotReadCursorReadResponse {
  return { cursors, latest };
}

describe("channelBold", () => {
  it("is bold when the channel's newest row is past the cursor", () => {
    expect(
      channelBold(
        read({ [CHANNEL]: position(2_000) }, { [CHANNEL]: position(1_000) }),
        CHANNEL,
        undefined,
      ),
    ).toBe(true);
  });

  it("is bold when the channel has a row and the person has no cursor", () => {
    expect(
      channelBold(read({ [CHANNEL]: position(2_000) }, {}), CHANNEL, undefined),
    ).toBe(true);
  });

  it("is not bold at an equal seq, or when the cursor is ahead", () => {
    expect(
      channelBold(
        read({ [CHANNEL]: position(2_000) }, { [CHANNEL]: position(2_000) }),
        CHANNEL,
        undefined,
      ),
    ).toBe(false);
    expect(
      channelBold(
        read({ [CHANNEL]: position(2_000) }, { [CHANNEL]: position(3_000) }),
        CHANNEL,
        undefined,
      ),
    ).toBe(false);
  });

  it("is not bold for a channel with no row", () => {
    expect(channelBold(read({}, {}), CHANNEL, undefined)).toBe(false);
  });

  it("is never bold at the off level, however new the row", () => {
    expect(
      channelBold(read({ [CHANNEL]: position(2_000) }, {}), CHANNEL, {
        [CHANNEL]: "off",
      }),
    ).toBe(false);
  });

  it("stays bold at the mentions level, which only trims the count", () => {
    expect(
      channelBold(read({ [CHANNEL]: position(2_000) }, {}), CHANNEL, {
        [CHANNEL]: "mentions",
      }),
    ).toBe(true);
  });
});

describe("threadHasNewReplies", () => {
  const behind = read(
    { [THREAD]: position(3_000) },
    { [THREAD]: position(2_000) },
  );

  it("is true for a followed thread whose newest reply is past the cursor", () => {
    expect(threadHasNewReplies(behind, THREAD, null, true)).toBe(true);
  });

  it("is false for a thread the person does not follow", () => {
    expect(threadHasNewReplies(behind, THREAD, 9_000, false)).toBe(false);
  });

  it("is false until the read has answered", () => {
    expect(threadHasNewReplies(undefined, THREAD, 9_000, true)).toBe(false);
  });

  it("takes the later of the host's row and the list's lastReplyAt", () => {
    const caughtUp = read(
      { [THREAD]: position(2_000) },
      { [THREAD]: position(2_000) },
    );
    expect(threadHasNewReplies(caughtUp, THREAD, 2_500, true)).toBe(true);
    expect(threadHasNewReplies(caughtUp, THREAD, 1_500, true)).toBe(false);
  });

  it("falls back to lastReplyAt when the host has no row for the thread", () => {
    expect(threadHasNewReplies(read({}, {}), THREAD, 500, true)).toBe(true);
    expect(threadHasNewReplies(read({}, {}), THREAD, null, true)).toBe(false);
  });

  it("is false when the cursor sits on the newest reply", () => {
    expect(
      threadHasNewReplies(
        read({ [THREAD]: position(3_000) }, { [THREAD]: position(3_000) }),
        THREAD,
        3_000,
        true,
      ),
    ).toBe(false);
  });
});

describe("advanceTarget", () => {
  it("is the newest row when the cursor is behind it or absent", () => {
    expect(
      advanceTarget(
        read({ [CHANNEL]: position(2_000) }, { [CHANNEL]: position(1_000) }),
        CHANNEL,
      ),
    ).toEqual(position(2_000));
    expect(
      advanceTarget(read({ [CHANNEL]: position(2_000) }, {}), CHANNEL),
    ).toEqual(position(2_000));
  });

  it("is null when the cursor is at or past the newest row, or the conversation has no row", () => {
    expect(
      advanceTarget(
        read({ [CHANNEL]: position(2_000) }, { [CHANNEL]: position(2_000) }),
        CHANNEL,
      ),
    ).toBeNull();
    expect(
      advanceTarget(read({}, { [CHANNEL]: position(1) }), CHANNEL),
    ).toBeNull();
  });
});
