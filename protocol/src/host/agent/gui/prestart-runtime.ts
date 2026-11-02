import { z } from "zod";
import { accountContextSchema } from "@traycer/protocol/common/schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { defineRpcContract } from "@traycer/protocol/framework/versioned-rpc";
import { chatRunSettingsSchemaPreUltracode } from "@traycer/protocol/persistence/epic/schemas";

/** Typing may warm an already-open chat; this request never sends a message. */
export const chatPrestartRuntimeRequestSchema = lazySchema(() =>
  z.strictObject({
    epicId: z.string(),
    chatId: z.string(),
    settings: chatRunSettingsSchemaPreUltracode,
    accountContext: accountContextSchema,
  }),
);
export type ChatPrestartRuntimeRequest = z.infer<
  typeof chatPrestartRuntimeRequestSchema
>;

/** Bounded reasons are diagnostic codes, never provider-authored messages. */
export const chatPrestartRuntimeResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("started"),
      reason: z.enum(["spawned", "replaced"]),
    }),
    z.object({
      outcome: z.literal("reused"),
      reason: z.literal("warm"),
    }),
    z.object({
      outcome: z.literal("skipped"),
      reason: z.enum([
        "turn_active",
        "queue_nonempty",
        "no_live_session",
        "no_provider_session",
        "harness_unsupported",
        "sandbox_host",
        "session_closing",
        "catalog_unavailable",
        "runtime_busy",
      ]),
    }),
  ]),
);
export type ChatPrestartRuntimeResponse = z.infer<
  typeof chatPrestartRuntimeResponseSchema
>;

export const chatPrestartRuntimeV10 = defineRpcContract({
  method: "chat.prestartRuntime",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatPrestartRuntimeRequestSchema,
  responseSchema: chatPrestartRuntimeResponseSchema,
});
