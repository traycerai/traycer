import { z } from "zod";

import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { jsonObjectSchema } from "@traycer/protocol/persistence/chat-sync/json";
import { mcpCallToolResultSchema } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * Host <-> client wire shapes for an MCP App's requests (`chat.mcpApp.*`).
 *
 * An MCP App renders from a tool call's `mcpApp` stamp. When the app asks for
 * something - describe or call a tool, read a resource, update what the model
 * sees - the client forwards it here, and the host serves it through the
 * HARNESS'S OWN MCP connection. Nothing opens a second connection.
 *
 * Every request names the stamped block (`epicId`, `chatId`, `blockId`), and
 * the host runs the same gate before every method: the caller must own the
 * chat and this host must be its binding host; the stamp's `source` must still
 * match the chat's harness, native session and server; the session is woken if
 * it is asleep; and the tool must be visible to the app. A refusal is DATA
 * (`kind: "error"`), so the row keeps showing the stored result.
 *
 * ## Optional capability
 *
 * Registered `degrade: { kind: "unsupported" }` and NOT on the released floor:
 * a host without these methods answers `E_HOST_UNSUPPORTED`, and the app row
 * renders read-only from the stored result.
 */

/** The stamped block an app request comes from. */
const chatMcpAppBlockFields = {
  epicId: lazySchema(() => z.string().min(1)),
  chatId: lazySchema(() => z.string().min(1)),
  blockId: lazySchema(() => z.string().min(1)),
};

/**
 * Why the host refused an app request:
 *
 * - `not-app-block` - the block carries no `mcpApp` stamp.
 * - `not-owner` - the caller does not own the chat (a collaborator).
 * - `harness-unsupported` - the chat's harness has no MCP Apps support.
 * - `session-unavailable` - this host is not the chat's binding host, or the
 *   session could not be woken.
 * - `session-changed` - the chat's harness, native session or server no longer
 *   matches the stamp's `source`.
 * - `hidden-from-app` - the tool's `_meta.ui.visibility` excludes the app.
 * - `content-unsupported` - a model-context update carried a non-text block.
 * - `too-large` - a model-context update is over 16 KiB of UTF-8.
 * - `call-failed` - the harness or the MCP server failed the request.
 */
export const chatMcpAppErrorCodeSchema = lazySchema(() =>
  z.enum([
    "not-app-block",
    "not-owner",
    "harness-unsupported",
    "session-unavailable",
    "session-changed",
    "hidden-from-app",
    "content-unsupported",
    "too-large",
    "call-failed",
  ]),
);
export type ChatMcpAppErrorCode = z.infer<typeof chatMcpAppErrorCodeSchema>;

const chatMcpAppErrorSchema = lazySchema(() =>
  z.object({
    kind: z.literal("error"),
    code: chatMcpAppErrorCodeSchema,
    /** Rendered detail for `call-failed`; `null` for the others. */
    message: z.string().nullable(),
  }),
);

// ─── chat.mcpApp.describeTool ─────────────────────────────────────────────

export const chatMcpAppDescribeToolRequestSchema = lazySchema(() =>
  z.object({
    ...chatMcpAppBlockFields,
    name: z.string().min(1),
  }),
);
export type ChatMcpAppDescribeToolRequest = z.infer<
  typeof chatMcpAppDescribeToolRequestSchema
>;

export const chatMcpAppDescribeToolResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("tool"),
      /** Whether the app may call it (visible to the app). */
      callable: z.boolean(),
      /** The tool's `readOnlyHint`: a read-only call never needs approval. */
      readOnly: z.boolean(),
      title: z.string().nullable(),
      /** The MCP `Tool` definition as the server lists it. */
      tool: jsonObjectSchema,
    }),
    chatMcpAppErrorSchema,
  ]),
);
export type ChatMcpAppDescribeToolResponse = z.infer<
  typeof chatMcpAppDescribeToolResponseSchema
>;

export const chatMcpAppDescribeToolV10 = defineRpcContract({
  method: "chat.mcpApp.describeTool",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatMcpAppDescribeToolRequestSchema,
  responseSchema: chatMcpAppDescribeToolResponseSchema,
});

// ─── chat.mcpApp.callTool ─────────────────────────────────────────────────

export const chatMcpAppCallToolRequestSchema = lazySchema(() =>
  z.object({
    ...chatMcpAppBlockFields,
    name: z.string().min(1),
    arguments: jsonObjectSchema,
    /**
     * The token a `needsApproval` answer handed out, once the user approved;
     * `null` on the first attempt.
     */
    approvalToken: z.string().min(1).nullable(),
  }),
);
export type ChatMcpAppCallToolRequest = z.infer<
  typeof chatMcpAppCallToolRequestSchema
>;

export const chatMcpAppCallToolResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("result"),
      result: mcpCallToolResultSchema,
    }),
    /**
     * The chat's permission mode needs approval for this call. The token is
     * held by the host, single-use, valid for 60 s, and bound to the caller,
     * the chat, the block, the session generation, the tool and the
     * arguments' hash. Only the GUI bridge host sees it, never the frame.
     */
    z.object({
      kind: z.literal("needsApproval"),
      token: z.string().min(1),
      title: z.string(),
      args: jsonObjectSchema,
    }),
    chatMcpAppErrorSchema,
  ]),
);
export type ChatMcpAppCallToolResponse = z.infer<
  typeof chatMcpAppCallToolResponseSchema
>;

export const chatMcpAppCallToolV10 = defineRpcContract({
  method: "chat.mcpApp.callTool",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatMcpAppCallToolRequestSchema,
  responseSchema: chatMcpAppCallToolResponseSchema,
});

// ─── chat.mcpApp.readResource ─────────────────────────────────────────────

/** Only on the app's own server; on Claude, only `ui://` URIs. */
export const chatMcpAppReadResourceRequestSchema = lazySchema(() =>
  z.object({
    ...chatMcpAppBlockFields,
    uri: z.string().min(1),
  }),
);
export type ChatMcpAppReadResourceRequest = z.infer<
  typeof chatMcpAppReadResourceRequestSchema
>;

export const chatMcpAppReadResourceResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("result"),
      /** The MCP `ReadResourceResult` as the server sent it. */
      result: jsonObjectSchema,
    }),
    chatMcpAppErrorSchema,
  ]),
);
export type ChatMcpAppReadResourceResponse = z.infer<
  typeof chatMcpAppReadResourceResponseSchema
>;

export const chatMcpAppReadResourceV10 = defineRpcContract({
  method: "chat.mcpApp.readResource",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatMcpAppReadResourceRequestSchema,
  responseSchema: chatMcpAppReadResourceResponseSchema,
});

// ─── chat.mcpApp.updateModelContext ───────────────────────────────────────

/**
 * The standard `ui/update-model-context` request, normalized on the host:
 * text blocks only, `structuredContent` JSON-encoded, the parts joined with a
 * blank line and trimmed. Blank text clears the context; over 16 KiB of UTF-8
 * is `too-large`, never truncated.
 */
export const chatMcpAppUpdateModelContextRequestSchema = lazySchema(() =>
  z.object({
    ...chatMcpAppBlockFields,
    content: z.array(jsonObjectSchema).nullable(),
    structuredContent: jsonObjectSchema.nullable(),
  }),
);
export type ChatMcpAppUpdateModelContextRequest = z.infer<
  typeof chatMcpAppUpdateModelContextRequestSchema
>;

export const chatMcpAppUpdateModelContextResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("updated") }),
    chatMcpAppErrorSchema,
  ]),
);
export type ChatMcpAppUpdateModelContextResponse = z.infer<
  typeof chatMcpAppUpdateModelContextResponseSchema
>;

export const chatMcpAppUpdateModelContextV10 = defineRpcContract({
  method: "chat.mcpApp.updateModelContext",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatMcpAppUpdateModelContextRequestSchema,
  responseSchema: chatMcpAppUpdateModelContextResponseSchema,
});
