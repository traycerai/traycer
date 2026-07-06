import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatSchema } from "@traycer/protocol/persistence/epic/chat";
import { chatSchemaSurfaceBaseline } from "./__fixtures__/chat-schema-surface";

/**
 * Persisted `chatSchema` surface guard.
 *
 * Every shipped v1.1.x host validates a WHOLE chat with a strict
 * `chatSchema.safeParse` at read time (`readChatSnapshot` in
 * `chat-session-manager.ts`) - one unexpected enum value or discriminated-union
 * variant anywhere in the tree fails the parse and makes the ENTIRE chat
 * unreadable (`CHAT_INVALID`). That is exactly how widening
 * `autonomousResumeTriggerSchema.kind` to include `"wakeup"` broke v1.1.3
 * hosts reading chats written by a v1.1.4 host.
 *
 * `compareRoomVersion` (`packages/common/src/yjs/room-version.ts`) treats any
 * same-major, newer-minor room as forward-compatible and opens it with the
 * shipped schema - there is no version gate a persisted schema change can ride
 * to signal "this needs a newer reader". So within persistence major 2 (the
 * current `schemaVersion`), the ONLY safe change is one a strict, shipped
 * `z.object` parser survives: a NEW key with `.default(...)` / `.nullable()`,
 * silently stripped by an old reader. A new enum value, a new
 * discriminated-union variant, or a new required key is NOT safe.
 *
 * This test freezes the WHOLE surface (both IO modes) against
 * `__fixtures__/chat-schema-surface.ts` and fails on ANY drift - even a safe
 * additive one - because "is this change actually additive" needs a human to
 * look at the diff, not a heuristic. When it fails:
 *   1. Confirm the change is additive (new defaulted/nullable key) or is a
 *      deliberate break gated by a `schemaVersion` bump.
 *   2. Regenerate the baseline and commit the diff as the reviewable record:
 *        bun run protocol/scripts/snapshot-chat-schema-surface.ts > \
 *          protocol/src/persistence/epic/__tests__/__fixtures__/chat-schema-surface.ts
 *
 * Scope: this is a STATIC surface check (what CAN be persisted), independent
 * of the write-funnel regression tests in `chat-message-collections.test.ts`
 * (what the host ACTUALLY persists) - both are needed, since a schema could
 * stay additive while a write path still emits the old shape.
 */
describe("persisted chatSchema surface is frozen (additive-only within major 2)", () => {
  it("storage (io:'input') JSON-Schema matches the baseline", () => {
    const current = z.toJSONSchema(chatSchema, { io: "input" });
    expect(current).toEqual(chatSchemaSurfaceBaseline.storage);
  });

  it("domain (default/output) JSON-Schema matches the baseline", () => {
    const current = z.toJSONSchema(chatSchema);
    expect(current).toEqual(chatSchemaSurfaceBaseline.domain);
  });
});
