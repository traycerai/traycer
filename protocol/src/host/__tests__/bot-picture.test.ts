import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  botAppearanceSchema,
  botUpdateAppearanceRequestSchema,
} from "@traycer/protocol/host/bot/schemas";
import {
  BOT_PICTURE_MAX_BYTES,
  BOT_PICTURE_SIDE,
  botPictureIsAnimated,
  botPictureRefusalOf,
} from "@traycer/protocol/host/bot/pictures";
import {
  botListV12,
  botReadPictureV10,
  botUploadPictureV10,
} from "@traycer/protocol/host/bot/contracts";

const BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HASH = "a".repeat(64);

const BOT_ROW = {
  botId: BOT,
  environmentId: "env-1",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-a",
  effort: null,
  profile: null,
  directive: null,
  appConversationChatId: null,
  replyMode: "direct" as const,
  trunkChatId: "chat-1",
  boundHostId: "host-1",
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
};

describe("a picture mark on a request", () => {
  const request = botUpdateAppearanceRequestSchema;

  it("accepts a picture named by its hash, and still a mascot", () => {
    expect(
      request.parse({ botId: BOT, mark: { kind: "picture", sha256: HASH } }),
    ).toEqual({ botId: BOT, mark: { kind: "picture", sha256: HASH } });
    expect(
      request.parse({ botId: BOT, mark: { kind: "mascot", shape: "cat" } })
        .mark,
    ).toEqual({ kind: "mascot", shape: "cat" });
  });

  it.each([
    ["a short hash", "a".repeat(63)],
    ["a long hash", "a".repeat(65)],
    ["an uppercase hash", "A".repeat(64)],
    ["a non-hex hash", "g".repeat(64)],
  ])("refuses a picture with %s", (_name, sha256) => {
    expect(
      request.safeParse({ botId: BOT, mark: { kind: "picture", sha256 } })
        .success,
    ).toBe(false);
  });

  it("refuses a picture that names no hash, and one that carries the kept shape, which only a read does", () => {
    expect(
      request.safeParse({ botId: BOT, mark: { kind: "picture" } }).success,
    ).toBe(false);
    expect(
      request.parse({
        botId: BOT,
        mark: { kind: "picture", sha256: HASH, mascotShape: "cat" },
      }).mark,
    ).toEqual({ kind: "picture", sha256: HASH });
  });
});

describe("a picture mark as it is read", () => {
  const read = (mark: unknown) =>
    botAppearanceSchema.parse({ mark, color: null }).mark;

  it.each(["cat", null])(
    "keeps a picture's hash and the mascot shape kept beside it, %j",
    (mascotShape) => {
      expect(read({ kind: "picture", sha256: HASH, mascotShape })).toEqual({
        kind: "picture",
        sha256: HASH,
        mascotShape,
      });
    },
  );

  it.each([
    ["a picture with no kept shape field", { kind: "picture", sha256: HASH }],
    [
      "a picture with a bad hash",
      { kind: "picture", sha256: "xyz", mascotShape: null },
    ],
    ["a kind a newer writer added", { kind: "video", sha256: HASH }],
  ])("reads %s as a mark it cannot read", (_name, mark) => {
    expect(read(mark)).toEqual({ kind: "unrecognised" });
  });

  it("does not fail a bot.list row for a mark it cannot read, and keeps the rest of the row", () => {
    const [row] = botListV12.responseSchema.parse({
      bots: [
        {
          ...BOT_ROW,
          appearance: { mark: { kind: "video", sha256: HASH }, color: null },
        },
      ],
      mainBotIds: null,
    }).bots;

    expect(row?.appearance?.mark).toEqual({ kind: "unrecognised" });
    expect(row?.botId).toBe(BOT);
  });
});

describe("bot.uploadPicture and bot.readPicture", () => {
  it("are registered at 1.0, found through the registry, with the requests and answers they take", () => {
    const upload = hostRpcRegistry["bot.uploadPicture"][1];
    const readPicture = hostRpcRegistry["bot.readPicture"][1];

    expect(upload.latestMinor).toBe(0);
    expect(upload.versions[0].contract).toBe(botUploadPictureV10);
    expect(readPicture.latestMinor).toBe(0);
    expect(readPicture.versions[0].contract).toBe(botReadPictureV10);
    expect(
      botUploadPictureV10.requestSchema.safeParse({
        botId: BOT,
        bytesBase64: "AAAA",
      }).success,
    ).toBe(true);
    expect(botUploadPictureV10.responseSchema.parse({ sha256: HASH })).toEqual({
      sha256: HASH,
    });
    expect(
      botReadPictureV10.requestSchema.safeParse({ botId: BOT, sha256: HASH })
        .success,
    ).toBe(true);
  });

  it.each([
    [
      "an empty upload",
      botUploadPictureV10.requestSchema,
      { botId: BOT, bytesBase64: "" },
    ],
    [
      "a read for a short hash",
      botReadPictureV10.requestSchema,
      { botId: BOT, sha256: "ab" },
    ],
    [
      "an answer that is the bare bytes with no picture key",
      botReadPictureV10.responseSchema,
      { mediaType: "image/png", bytesBase64: "AAAA" },
    ],
    [
      "an answer of another media type",
      botReadPictureV10.responseSchema,
      { picture: { mediaType: "image/gif", bytesBase64: "AAAA" } },
    ],
    [
      "an answer with no bytes",
      botReadPictureV10.responseSchema,
      { picture: { mediaType: "image/png", bytesBase64: "" } },
    ],
    [
      "an answer with no picture and no null",
      botReadPictureV10.responseSchema,
      {},
    ],
    [
      "an upload answer with a bad hash",
      botUploadPictureV10.responseSchema,
      { sha256: "ab" },
    ],
  ])("refuses %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("answers a webp and a png, or none for a picture the bot no longer wears", () => {
    for (const mediaType of ["image/webp", "image/png"]) {
      expect(
        botReadPictureV10.responseSchema.parse({
          picture: { mediaType, bytesBase64: "AAAA" },
        }),
      ).toEqual({ picture: { mediaType, bytesBase64: "AAAA" } });
    }
    expect(botReadPictureV10.responseSchema.parse({ picture: null })).toEqual({
      picture: null,
    });
  });
});

/** A WebP with an extended header of the given flags, `side` pixels square. */
function webpX(flags: number, side: number, total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  const text = (from: number, value: string): void => {
    [...value].forEach((char, i) => {
      bytes[from + i] = char.charCodeAt(0);
    });
  };
  text(0, "RIFF");
  text(8, "WEBP");
  text(12, "VP8X");
  bytes[16] = 10;
  bytes[20] = flags;
  [24, 27].forEach((from) => {
    bytes[from] = (side - 1) % 256;
    bytes[from + 1] = Math.floor((side - 1) / 256);
  });
  return bytes;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** One PNG chunk: a length, a type, `length` data bytes and a check. */
function pngChunk(type: string, length: number): number[] {
  return [
    Math.floor(length / 0x1000000) % 256,
    Math.floor(length / 0x10000) % 256,
    Math.floor(length / 0x100) % 256,
    length % 256,
    ...[...type].map((char) => char.charCodeAt(0)),
    ...new Array<number>(length).fill(0),
    0,
    0,
    0,
    0,
  ];
}

/** A PNG `side` pixels square whose chunks after the header are `types`. */
function png(side: number, types: readonly string[]): Uint8Array {
  const header = pngChunk("IHDR", 13);
  [16, 20].forEach((from) => {
    header[from - 8 + 2] = Math.floor(side / 256);
    header[from - 8 + 3] = side % 256;
  });
  return Uint8Array.from([
    ...PNG_MAGIC,
    ...header,
    ...types.flatMap((type) => pngChunk(type, type === "acTL" ? 8 : 4)),
  ]);
}

const ANIMATION_FLAG = 0b10;
const ICC_FLAG = 0b100000;

describe("an animated picture", () => {
  it("is refused as animated when a WebP extended header sets the animation flag, and passes when it does not", () => {
    expect(
      botPictureRefusalOf(webpX(ANIMATION_FLAG, BOT_PICTURE_SIDE, 40)),
    ).toBe("animated");
    expect(
      botPictureRefusalOf(
        webpX(ANIMATION_FLAG | ICC_FLAG, BOT_PICTURE_SIDE, 40),
      ),
    ).toBe("animated");
    expect(botPictureRefusalOf(webpX(0, BOT_PICTURE_SIDE, 40))).toBeNull();
    expect(
      botPictureRefusalOf(webpX(ICC_FLAG, BOT_PICTURE_SIDE, 40)),
    ).toBeNull();
  });

  it("is refused as animated when a PNG carries an animation control chunk before its image data, and passes without one", () => {
    expect(
      botPictureRefusalOf(png(BOT_PICTURE_SIDE, ["acTL", "IDAT", "IEND"])),
    ).toBe("animated");
    expect(
      botPictureRefusalOf(
        png(BOT_PICTURE_SIDE, ["gAMA", "acTL", "IDAT", "IEND"]),
      ),
    ).toBe("animated");
    expect(
      botPictureRefusalOf(png(BOT_PICTURE_SIDE, ["gAMA", "IDAT", "IEND"])),
    ).toBeNull();
  });

  it("reads a PNG whose animation control chunk comes after its image data as still", () => {
    expect(
      botPictureIsAnimated(png(BOT_PICTURE_SIDE, ["IDAT", "acTL", "IEND"])),
    ).toBe(false);
  });

  it("ends the walk of a PNG whose last chunk is cut short or claims more bytes than the file has", () => {
    const whole = png(BOT_PICTURE_SIDE, ["gAMA", "IDAT"]);
    expect(botPictureIsAnimated(whole.subarray(0, whole.length - 6))).toBe(
      false,
    );
    const lying = Uint8Array.from([
      ...png(BOT_PICTURE_SIDE, []),
      0xff,
      0xff,
      0xff,
      0xff,
      ...[..."gAMA"].map((char) => char.charCodeAt(0)),
    ]);
    expect(botPictureIsAnimated(lying)).toBe(false);
    expect(botPictureRefusalOf(lying)).toBeNull();
  });

  it("is judged on its size first, then its type, then its dimensions, then its animation", () => {
    expect(
      botPictureRefusalOf(
        webpX(ANIMATION_FLAG, BOT_PICTURE_SIDE, BOT_PICTURE_MAX_BYTES + 1),
      ),
    ).toBe("size");
    expect(botPictureRefusalOf(webpX(ANIMATION_FLAG, 128, 40))).toBe(
      "dimensions",
    );
    expect(botPictureRefusalOf(new Uint8Array(40))).toBe("type");
  });
});
