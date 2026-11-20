/**
 * How long the GUI waits for an `epic.readChatFile` response frame.
 *
 * A file attachment is up to 16 MiB, about 22 MB once base64 has inflated it,
 * and the whole of it is ONE response: there is no partial frame to reset a
 * timer with. The transport's default 30 s unary budget is sized for KB of
 * JSON; on a slow phone link the body alone can take most of it. Two minutes
 * matches `drafts.putBlob`, which carries the same body the other way.
 *
 * MUST equal the `joinResponseTimeoutMs` declared for `epic.readChatFile` in
 * `host-method-policy-table.ts`; the host client refuses any other value. A
 * leaf module so the table and the caller share one literal without a cycle.
 */
export const CHAT_FILE_READ_RESPONSE_TIMEOUT_MS = 120_000;
