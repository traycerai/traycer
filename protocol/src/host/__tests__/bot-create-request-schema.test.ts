import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { botCreateRequestSchema } from "@traycer/protocol/host/bot/schemas";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";

const FIELDS = {
  environmentId: "env-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-a",
  effort: null,
  profile: null,
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
