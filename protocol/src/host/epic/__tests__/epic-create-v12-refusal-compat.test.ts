import { describe, expect, it } from "vitest";
import {
  createChatResponseSchema,
  createChatResponseSchemaV12,
  createEpicResponseSchema,
  epicCreateRefusalKindSchema,
  epicCreateRefusalKindSchemaV12,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Refusal-kind compat, per the tech plan's Verification section: a `@1.1`
 * peer must fail the whole parse on a `@1.2`-only refusal kind (never widen
 * silently), a `@1.1` client parsing a `@1.2` SUCCESS body (no refusal) must
 * stay green, and `epic.createChat`'s `@1.0`/`@1.1` response - which has never
 * had a `refusal` key at all - must strip one rather than choke on it.
 */

describe("epic.create refusal-kind compat", () => {
  it("epicCreateRefusalKindSchema rejects the @1.2-only kind", () => {
    expect(
      epicCreateRefusalKindSchema.safeParse("missing-attachment-bytes").success,
    ).toBe(false);
  });

  it("epicCreateRefusalKindSchemaV12 accepts it", () => {
    expect(
      epicCreateRefusalKindSchemaV12.safeParse("missing-attachment-bytes")
        .success,
    ).toBe(true);
  });

  it("a @1.1 client parsing a @1.2 response carrying no refusal stays green", () => {
    const v12SuccessBody = {
      roomInfo: null,
      task: null,
      initialTurnStarted: false,
    };
    expect(createEpicResponseSchema.safeParse(v12SuccessBody).success).toBe(
      true,
    );
  });

  it("a @1.1 client parsing a @1.2 response WITH the new refusal kind fails the whole parse", () => {
    const v12RefusalBody = {
      roomInfo: null,
      refusal: {
        kind: "missing-attachment-bytes",
        message: "Could not find the uploaded image.",
        remedy: "Re-upload the image and try again.",
      },
    };
    expect(createEpicResponseSchema.safeParse(v12RefusalBody).success).toBe(
      false,
    );
  });
});

describe("epic.createChat refusal-kind compat", () => {
  it("createChatResponseSchema (1.0/1.1, which has never had a refusal key) strips a refusal a @1.2 host sends", () => {
    const v12Body = {
      chatId: "chat-1",
      initialTurnStarted: false,
      refusal: {
        kind: "missing-attachment-bytes",
        message: "Could not find the uploaded image.",
        remedy: "Re-upload the image and try again.",
      },
    };
    const parsed = createChatResponseSchema.parse(v12Body);
    expect(parsed).not.toHaveProperty("refusal");
    expect(parsed).toEqual({ chatId: "chat-1", initialTurnStarted: false });
  });

  it("createChatResponseSchemaV12 parses the refusal", () => {
    const v12Body = {
      chatId: "chat-1",
      refusal: {
        kind: "missing-attachment-bytes",
        message: "Could not find the uploaded image.",
        remedy: "Re-upload the image and try again.",
      },
    };
    const parsed = createChatResponseSchemaV12.parse(v12Body);
    expect(parsed.refusal).toEqual(v12Body.refusal);
  });
});
