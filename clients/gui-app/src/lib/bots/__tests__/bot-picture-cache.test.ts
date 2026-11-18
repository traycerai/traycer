import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  botPictureLink,
  clearBotPictures,
  keepBotPictures,
  nextWantedBotPicture,
  retryBotPictures,
  settleBotPictureRead,
  subscribeBotPictures,
  wantBotPicture,
  type BotPictureBytes,
} from "@/lib/bots/bot-picture-cache";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const THIRD = "c".repeat(64);
const BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PNG: BotPictureBytes = { mediaType: "image/png", bytesBase64: "AAAA" };

/** The withdrawals of every want a test made, so none outlives it. */
let withdrawals: Array<() => void> = [];

function want(sha256: string, botId: string): () => void {
  const withdraw = wantBotPicture(sha256, botId);
  withdrawals.push(withdraw);
  return withdraw;
}

const SENTINEL = "e".repeat(64);

/** The round the loader is in now, read off a want that is withdrawn again. */
function roundNow(): number {
  const withdraw = wantBotPicture(SENTINEL, BOT);
  const read = nextWantedBotPicture();
  withdraw();
  if (read === null) throw new Error("a wanted picture was not next");
  return read.round;
}

/** A read of `sha256` in the current round settled as `picture`. */
function settle(sha256: string, picture: BotPictureBytes | null): void {
  settleBotPictureRead({ sha256, botId: BOT, round: roundNow() }, picture);
}

/** Holds `sha256` as a read of it would, kept by a listed bot wearing it. */
function holdWorn(...hashes: readonly string[]): void {
  keepBotPictures(new Set(hashes));
  for (const sha256 of hashes) settle(sha256, PNG);
}

let createLink = vi.spyOn(URL, "createObjectURL");
let revokeLink = vi.spyOn(URL, "revokeObjectURL");

beforeEach(() => {
  withdrawals = [];
  let made = 0;
  createLink = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:picture-${String((made += 1))}`);
  revokeLink = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  for (const withdraw of withdrawals) withdraw();
  clearBotPictures();
  vi.restoreAllMocks();
});

describe("which pictures are wanted", () => {
  it("names the first wanted picture with the bot it is read through, and nothing when none is wanted", () => {
    expect(nextWantedBotPicture()).toBeNull();

    want(HASH, BOT);
    want(OTHER, OTHER_BOT);

    expect(nextWantedBotPicture()).toMatchObject({ sha256: HASH, botId: BOT });
  });

  it("reads a hash several drawn pictures want through the bot that wanted it first", () => {
    want(HASH, BOT);
    want(HASH, OTHER_BOT);

    expect(nextWantedBotPicture()).toMatchObject({ sha256: HASH, botId: BOT });
  });

  it("keeps a hash wanted until every picture that wanted it has withdrawn", () => {
    const first = want(HASH, BOT);
    const second = want(HASH, OTHER_BOT);

    first();
    expect(nextWantedBotPicture()?.sha256).toBe(HASH);
    second();

    expect(nextWantedBotPicture()).toBeNull();
  });

  it("answers the same object until its answer changes, so it can be subscribed to", () => {
    want(HASH, BOT);
    want(OTHER, OTHER_BOT);
    const first = nextWantedBotPicture();

    expect(nextWantedBotPicture()).toBe(first);
    want(THIRD, BOT);
    expect(nextWantedBotPicture()).toBe(first);

    settle(HASH, null);
    const second = nextWantedBotPicture();
    expect(second).toMatchObject({ sha256: OTHER, botId: OTHER_BOT });
    expect(second).not.toBe(first);
    expect(nextWantedBotPicture()).toBe(second);
  });

  it("skips a hash that is held, naming the next", () => {
    want(HASH, BOT);
    want(OTHER, BOT);
    holdWorn(HASH);

    expect(nextWantedBotPicture()?.sha256).toBe(OTHER);
  });

  it("tells a subscriber when a hash is first wanted, and not when a second picture wants it", () => {
    const listener = vi.fn();
    const stop = subscribeBotPictures(listener);

    want(HASH, BOT);
    want(HASH, OTHER_BOT);
    stop();
    want(OTHER, BOT);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("settling a read", () => {
  it("holds the picture a wanted read answered as a link, tells subscribers, and names no link for another hash", () => {
    want(HASH, BOT);
    const read = nextWantedBotPicture();
    if (read === null) throw new Error("nothing was next");
    const listener = vi.fn();
    subscribeBotPictures(listener);

    settleBotPictureRead(read, PNG);

    expect(botPictureLink(HASH)).toBe("blob:picture-1");
    expect(botPictureLink(OTHER)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(nextWantedBotPicture()).toBeNull();
  });

  it("marks a hash tried for a picture, for none, and for bytes it cannot read, so it is not read again", () => {
    want(HASH, BOT);
    want(OTHER, BOT);
    want(THIRD, BOT);

    settle(HASH, PNG);
    expect(nextWantedBotPicture()?.sha256).toBe(OTHER);
    settle(OTHER, null);
    expect(nextWantedBotPicture()?.sha256).toBe(THIRD);
    settle(THIRD, {
      mediaType: "image/gif",
      bytesBase64: "AAAA",
    });

    expect(nextWantedBotPicture()).toBeNull();
  });

  it.each([
    ["another media type", { mediaType: "image/gif", bytesBase64: "AAAA" }],
    ["no media type", { mediaType: undefined, bytesBase64: "AAAA" }],
    [
      "a media type that is not a string",
      { mediaType: 7, bytesBase64: "AAAA" },
    ],
    ["bytes that are not a string", { mediaType: "image/png", bytesBase64: 7 }],
    ["no bytes", { mediaType: "image/png", bytesBase64: undefined }],
    [
      "bytes that are not base64",
      { mediaType: "image/png", bytesBase64: "!!!" },
    ],
  ])(
    "holds no link for an answer with %s, and marks it tried",
    (_name, answer) => {
      want(HASH, BOT);

      settle(HASH, answer);

      expect(botPictureLink(HASH)).toBeNull();
      expect(createLink).not.toHaveBeenCalled();
      expect(nextWantedBotPicture()).toBeNull();
    },
  );

  it("holds nothing, and revokes the link it made, for a picture that is neither wanted nor worn", () => {
    settle(HASH, PNG);

    expect(botPictureLink(HASH)).toBeNull();
    expect(createLink).toHaveBeenCalledTimes(1);
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
  });

  it("holds a picture only a listed bot wears", () => {
    keepBotPictures(new Set([HASH]));

    settle(HASH, PNG);

    expect(botPictureLink(HASH)).toBe("blob:picture-1");
    expect(revokeLink).not.toHaveBeenCalled();
  });

  it("revokes the link a newer answer replaces", () => {
    want(HASH, BOT);
    settle(HASH, PNG);

    settle(HASH, PNG);

    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
    expect(botPictureLink(HASH)).toBe("blob:picture-2");
  });
});

describe("retrying the pictures", () => {
  it("makes a tried hash that is not held next again, and tells subscribers", () => {
    want(HASH, BOT);
    settle(HASH, null);
    expect(nextWantedBotPicture()).toBeNull();
    const listener = vi.fn();
    subscribeBotPictures(listener);

    retryBotPictures();

    expect(nextWantedBotPicture()?.sha256).toBe(HASH);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("leaves a held picture held and not next", () => {
    want(HASH, BOT);
    want(OTHER, BOT);
    settle(HASH, PNG);
    settle(OTHER, null);

    retryBotPictures();

    expect(botPictureLink(HASH)).not.toBeNull();
    expect(nextWantedBotPicture()?.sha256).toBe(OTHER);
  });

  it("starts a new round and tells subscribers even when nothing was tried", () => {
    want(HASH, BOT);
    const before = nextWantedBotPicture();
    const listener = vi.fn();
    subscribeBotPictures(listener);

    retryBotPictures();

    expect(listener).toHaveBeenCalledTimes(1);
    const after = nextWantedBotPicture();
    expect(after).toEqual({ ...before, round: (before?.round ?? 0) + 1 });
    expect(after).not.toBe(before);
  });

  it("names the same hash as a different read in each round, and the same object within one", () => {
    want(HASH, BOT);
    const first = nextWantedBotPicture();
    retryBotPictures();
    const second = nextWantedBotPicture();
    retryBotPictures();

    const third = nextWantedBotPicture();

    expect(new Set([first, second, third]).size).toBe(3);
    expect(nextWantedBotPicture()).toBe(third);
  });

  it("drops the answer to a read of an earlier round: nothing tried, no link, no revoke of a current link", () => {
    want(HASH, BOT);
    want(OTHER, BOT);
    const stale = nextWantedBotPicture();
    if (stale === null) throw new Error("nothing was next");
    keepBotPictures(new Set([OTHER]));
    retryBotPictures();
    settle(OTHER, PNG);
    createLink.mockClear();

    settleBotPictureRead(stale, PNG);
    settleBotPictureRead({ ...stale, sha256: OTHER }, null);

    expect(botPictureLink(HASH)).toBeNull();
    expect(createLink).not.toHaveBeenCalled();
    expect(botPictureLink(OTHER)).not.toBeNull();
    expect(revokeLink).not.toHaveBeenCalled();
    expect(nextWantedBotPicture()?.sha256).toBe(HASH);
  });
});

describe("withdrawing a want", () => {
  it("drops an unworn link only at the last withdrawal of every bot drawing it, and tells subscribers", () => {
    const first = want(HASH, BOT);
    const second = want(HASH, OTHER_BOT);
    settle(HASH, PNG);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    second();
    expect(botPictureLink(HASH)).not.toBeNull();
    expect(revokeLink).not.toHaveBeenCalled();
    listener.mockClear();
    first();

    expect(botPictureLink(HASH)).toBeNull();
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the link of a picture a listed bot wears", () => {
    const withdraw = want(HASH, BOT);
    keepBotPictures(new Set([HASH]));
    settle(HASH, PNG);

    withdraw();

    expect(botPictureLink(HASH)).not.toBeNull();
    expect(revokeLink).not.toHaveBeenCalled();
  });
});

describe("wanting a picture again in the same round", () => {
  it("offers a picture that was held and pruned when its last want left, since it was read and not refused", () => {
    const withdraw = want(HASH, BOT);
    settle(HASH, PNG);
    expect(nextWantedBotPicture()).toBeNull();
    withdraw();
    expect(botPictureLink(HASH)).toBeNull();

    want(HASH, BOT);

    expect(nextWantedBotPicture()).toMatchObject({ sha256: HASH, botId: BOT });
  });

  it("does not offer a picture that settled as none or unreadable, which has no link to prune", () => {
    const withdraw = want(HASH, BOT);
    settle(HASH, null);
    withdraw();

    want(HASH, BOT);

    expect(nextWantedBotPicture()).toBeNull();
  });
});

describe("bots drawing the same picture", () => {
  it("reads it through the bot that still draws it once the first has withdrawn before any read, as a new read", () => {
    const withdrawA = want(HASH, BOT);
    want(HASH, OTHER_BOT);
    const before = nextWantedBotPicture();
    expect(before).toMatchObject({ sha256: HASH, botId: BOT });

    withdrawA();

    const after = nextWantedBotPicture();
    expect(after).toMatchObject({ sha256: HASH, botId: OTHER_BOT });
    expect(after).not.toBe(before);
  });

  it("offers it again through the bot that stays when the read through the bot that left settled as none", () => {
    const withdrawA = want(HASH, BOT);
    want(HASH, OTHER_BOT);
    settle(HASH, null);
    expect(nextWantedBotPicture()).toBeNull();
    const listener = vi.fn();
    subscribeBotPictures(listener);

    withdrawA();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(nextWantedBotPicture()).toMatchObject({
      sha256: HASH,
      botId: OTHER_BOT,
    });
  });

  it("does not offer it again when the bot that withdrew was not the one it was read through", () => {
    want(HASH, BOT);
    const withdrawB = want(HASH, OTHER_BOT);
    settle(HASH, null);

    withdrawB();

    expect(nextWantedBotPicture()).toBeNull();
  });

  it("counts drawers per bot: one of two drawers of the same bot leaving changes nothing", () => {
    const first = want(HASH, BOT);
    want(HASH, BOT);
    want(HASH, OTHER_BOT);
    settle(HASH, null);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    first();

    expect(listener).not.toHaveBeenCalled();
    expect(nextWantedBotPicture()).toBeNull();
  });

  it("keeps reading it through the first bot until that bot's last drawer has left", () => {
    const first = want(HASH, BOT);
    const second = want(HASH, BOT);
    want(HASH, OTHER_BOT);

    first();
    expect(nextWantedBotPicture()).toMatchObject({ botId: BOT });
    second();

    expect(nextWantedBotPicture()).toMatchObject({ botId: OTHER_BOT });
  });
});

describe("keeping only the pictures still in use", () => {
  it("revokes and drops a picture no listed bot wears and nothing drawn wants, and tells subscribers", () => {
    holdWorn(HASH);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set());

    expect(botPictureLink(HASH)).toBeNull();
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a picture a listed bot wears, and one a drawn picture still wants", () => {
    want(OTHER, BOT);
    holdWorn(HASH, THIRD);
    settle(OTHER, PNG);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set([HASH]));

    expect(botPictureLink(HASH)).not.toBeNull();
    expect(botPictureLink(OTHER)).not.toBeNull();
    expect(botPictureLink(THIRD)).toBeNull();
    expect(revokeLink).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells no subscriber when nothing was dropped", () => {
    holdWorn(HASH);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set([HASH]));

    expect(listener).not.toHaveBeenCalled();
    expect(revokeLink).not.toHaveBeenCalled();
  });
});

describe("a hash that becomes worn again", () => {
  it("is offered again in the same round when a read found none, the listing moved to another picture, and a later listing names it again", () => {
    want(HASH, BOT);
    keepBotPictures(new Set([HASH]));
    settle(HASH, null);
    expect(nextWantedBotPicture()).toBeNull();
    keepBotPictures(new Set([OTHER]));
    expect(nextWantedBotPicture()).toBeNull();
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set([HASH]));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(nextWantedBotPicture()).toMatchObject({ sha256: HASH });
  });

  it("is not offered again when it never left the worn set", () => {
    want(HASH, BOT);
    keepBotPictures(new Set([HASH]));
    settle(HASH, null);

    keepBotPictures(new Set([HASH, OTHER]));
    keepBotPictures(new Set([HASH]));

    expect(nextWantedBotPicture()).toBeNull();
  });
});

describe("clearing the pictures", () => {
  it("revokes every link, drops them, and tells subscribers", () => {
    holdWorn(HASH, OTHER);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    clearBotPictures();

    expect(revokeLink).toHaveBeenCalledTimes(2);
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-2");
    expect(botPictureLink(HASH)).toBeNull();
    expect(botPictureLink(OTHER)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("leaves what is wanted wanted, and makes a tried hash next again", () => {
    want(HASH, BOT);
    settle(HASH, null);
    expect(nextWantedBotPicture()).toBeNull();

    clearBotPictures();

    expect(nextWantedBotPicture()?.sha256).toBe(HASH);
  });

  it("forgets which pictures listed bots wear, so a later settle of one holds nothing", () => {
    keepBotPictures(new Set([HASH]));
    clearBotPictures();

    settle(HASH, PNG);

    expect(botPictureLink(HASH)).toBeNull();
  });

  it("starts a new round, so a read begun before it holds no link when it settles and the hash is offered again", () => {
    want(HASH, BOT);
    const before = nextWantedBotPicture();
    if (before === null) throw new Error("nothing was next");

    clearBotPictures();
    settleBotPictureRead(before, PNG);

    expect(botPictureLink(HASH)).toBeNull();
    expect(createLink).not.toHaveBeenCalled();
    expect(nextWantedBotPicture()).toMatchObject({
      sha256: HASH,
      round: before.round + 1,
    });
  });
});
