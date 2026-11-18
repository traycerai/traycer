import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  botPictureGeneration,
  botPictureLink,
  clearBotPictures,
  holdBotPicture,
  keepBotPictures,
  nextWantedBotPicture,
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
const NOTHING_SKIPPED = (): boolean => false;

/** The withdrawals of every want a test made, so none outlives it. */
let withdrawals: Array<() => void> = [];

function want(sha256: string, botId: string): () => void {
  const withdraw = wantBotPicture(sha256, botId);
  withdrawals.push(withdraw);
  return withdraw;
}

function hold(sha256: string): boolean {
  return holdBotPicture(sha256, PNG, botPictureGeneration());
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
    expect(nextWantedBotPicture(NOTHING_SKIPPED)).toBeNull();

    want(HASH, BOT);
    want(OTHER, OTHER_BOT);

    expect(nextWantedBotPicture(NOTHING_SKIPPED)).toEqual({
      sha256: HASH,
      botId: BOT,
    });
  });

  it("reads a hash several drawn pictures want through the bot that wanted it first", () => {
    want(HASH, BOT);
    want(HASH, OTHER_BOT);

    expect(nextWantedBotPicture(NOTHING_SKIPPED)).toEqual({
      sha256: HASH,
      botId: BOT,
    });
  });

  it("keeps a hash wanted until every picture that wanted it has withdrawn", () => {
    const first = want(HASH, BOT);
    const second = want(HASH, OTHER_BOT);

    first();
    expect(nextWantedBotPicture(NOTHING_SKIPPED)?.sha256).toBe(HASH);
    second();

    expect(nextWantedBotPicture(NOTHING_SKIPPED)).toBeNull();
  });

  it("skips a hash that is held and one the caller refuses, naming the next", () => {
    want(HASH, BOT);
    want(OTHER, BOT);
    want(THIRD, OTHER_BOT);
    hold(HASH);

    expect(nextWantedBotPicture((sha256) => sha256 === OTHER)).toEqual({
      sha256: THIRD,
      botId: OTHER_BOT,
    });
    expect(
      nextWantedBotPicture((sha256) => sha256 === OTHER || sha256 === THIRD),
    ).toBeNull();
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

describe("holding what a read answered", () => {
  it("holds the picture as a link, tells subscribers, and names no link for another hash", () => {
    const listener = vi.fn();
    subscribeBotPictures(listener);

    expect(hold(HASH)).toBe(true);

    expect(botPictureLink(HASH)).toBe("blob:picture-1");
    expect(botPictureLink(OTHER)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
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
  ])("refuses an answer with %s, holding no link", (_name, answer) => {
    expect(holdBotPicture(HASH, answer, botPictureGeneration())).toBe(false);

    expect(botPictureLink(HASH)).toBeNull();
    expect(createLink).not.toHaveBeenCalled();
  });

  it("refuses an answer read before the pictures were cleared, and takes one read after", () => {
    const readIn = botPictureGeneration();
    clearBotPictures();

    expect(holdBotPicture(HASH, PNG, readIn)).toBe(false);
    expect(botPictureLink(HASH)).toBeNull();
    expect(createLink).not.toHaveBeenCalled();
    expect(holdBotPicture(HASH, PNG, botPictureGeneration())).toBe(true);
  });
});

describe("keeping only the pictures still in use", () => {
  it("revokes and drops a picture no listed bot wears and nothing drawn wants, and tells subscribers", () => {
    hold(HASH);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set());

    expect(botPictureLink(HASH)).toBeNull();
    expect(revokeLink).toHaveBeenCalledWith("blob:picture-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a picture a listed bot wears, and one a drawn picture still wants", () => {
    hold(HASH);
    hold(OTHER);
    hold(THIRD);
    want(OTHER, BOT);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set([HASH]));

    expect(botPictureLink(HASH)).not.toBeNull();
    expect(botPictureLink(OTHER)).not.toBeNull();
    expect(botPictureLink(THIRD)).toBeNull();
    expect(revokeLink).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops a wanted picture once its last want is withdrawn and no listed bot wears it", () => {
    hold(HASH);
    const withdraw = want(HASH, BOT);
    keepBotPictures(new Set());
    expect(botPictureLink(HASH)).not.toBeNull();

    withdraw();
    keepBotPictures(new Set());

    expect(botPictureLink(HASH)).toBeNull();
  });

  it("tells no subscriber when nothing was dropped", () => {
    hold(HASH);
    const listener = vi.fn();
    subscribeBotPictures(listener);

    keepBotPictures(new Set([HASH]));

    expect(listener).not.toHaveBeenCalled();
    expect(revokeLink).not.toHaveBeenCalled();
  });
});

describe("clearing the pictures", () => {
  it("revokes every link, drops them, and tells subscribers", () => {
    hold(HASH);
    hold(OTHER);
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

  it("leaves what is wanted wanted, for the next read", () => {
    want(HASH, BOT);

    clearBotPictures();

    expect(nextWantedBotPicture(NOTHING_SKIPPED)?.sha256).toBe(HASH);
  });
});
