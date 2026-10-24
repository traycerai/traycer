import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BOT_DIRECTIVE_MAX_LENGTH,
  botCreateRequestSchema,
  botUpdateDirectiveRequestSchema,
} from "@traycer/protocol/host/bot/schemas";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";

const FIELDS = {
  environmentId: "env-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-a",
  effort: null,
  profile: null,
  directive: null,
};

describe("host bot.create request key", () => {
  it("accepts a lowercase UUID", () => {
    const requestKey = randomUUID();

    expect(
      botCreateRequestSchema.safeParse({ ...FIELDS, requestKey }).success,
    ).toBe(true);
  });

  it("rejects a create without a key", () => {
    expect(botCreateRequestSchema.safeParse(FIELDS).success).toBe(false);
  });

  it("rejects an uppercase UUID, so each key has one spelling", () => {
    const requestKey = randomUUID().toUpperCase();

    expect(
      botCreateRequestSchema.safeParse({ ...FIELDS, requestKey }).success,
    ).toBe(false);
  });

  it("rejects a key that is not a UUID", () => {
    expect(
      botCreateRequestSchema.safeParse({ ...FIELDS, requestKey: "not-a-uuid" })
        .success,
    ).toBe(false);
  });
});

describe("host bot directive", () => {
  const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const CREATE_FIELDS = { ...FIELDS, requestKey: randomUUID() };

  function acceptedByCreate(directive: string | null): boolean {
    return botCreateRequestSchema.safeParse({ ...CREATE_FIELDS, directive })
      .success;
  }

  function acceptedByUpdate(directive: string | null): boolean {
    return botUpdateDirectiveRequestSchema.safeParse({
      botId: BOT_ID,
      directive,
    }).success;
  }

  const ACCEPTED: ReadonlyArray<readonly [string, string | null]> = [
    ["null", null],
    [
      "a multi-line directive with tabs",
      "Own the release.\n\tCheck CI first.\n",
    ],
    ["the longest directive", "a".repeat(BOT_DIRECTIVE_MAX_LENGTH)],
  ];

  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ["one character past the bound", "a".repeat(BOT_DIRECTIVE_MAX_LENGTH + 1)],
    ["whitespace only", " \n\t "],
    ["a carriage return", "first\r\nsecond"],
    ["a line separator", "first\u2028second"],
    ["a bidirectional override", "first\u202Esecond"],
  ];

  it.each(ACCEPTED)(
    "accepts %s on create and on update",
    (_name, directive) => {
      expect(acceptedByCreate(directive)).toBe(true);
      expect(acceptedByUpdate(directive)).toBe(true);
    },
  );

  it.each(REFUSED)("refuses %s on create and on update", (_name, directive) => {
    expect(acceptedByCreate(directive)).toBe(false);
    expect(acceptedByUpdate(directive)).toBe(false);
  });

  it("rejects a create that omits the directive", () => {
    expect(
      botCreateRequestSchema.safeParse({
        environmentId: FIELDS.environmentId,
        title: FIELDS.title,
        harness: FIELDS.harness,
        model: FIELDS.model,
        effort: FIELDS.effort,
        profile: FIELDS.profile,
        requestKey: randomUUID(),
      }).success,
    ).toBe(false);
  });
});

describe("E_BOT_REQUEST_KEY_REUSED on the wire", () => {
  it("reaches the caller as its own code, not narrowed to RPC_ERROR", () => {
    const error = HostRpcError.fromWireEnvelope(
      { code: "E_BOT_REQUEST_KEY_REUSED", message: "key already used" },
      "request-1",
      "bot.create",
    );

    expect(error.code).toBe("E_BOT_REQUEST_KEY_REUSED");
  });
});
