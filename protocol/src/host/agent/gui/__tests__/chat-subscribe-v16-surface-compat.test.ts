import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatSubscribeV16 } from "@traycer/protocol/host/agent/gui/subscribe";
import { chatSubscribeV16SurfaceBaseline } from "./__fixtures__/chat-subscribe-v16-surface";

/**
 * Exact frozen surface of `chat.subscribe@1.6`.
 *
 * `released-baseline-compat.test.ts` guards drift against the newest tagged
 * release, but the committed `released-baseline-surface.json` fixture still
 * ends `chat.subscribe` at minor 5 - it predates the 1.6 tag, so it cannot
 * catch drift in the hand-copied 1.6 freeze (`chatSchemaPreImage` /
 * `runtimeEventSchemaPreImage`, see `subscribe.ts`). The freeze-regression
 * loop in `chat-subscribe.test.ts` only proves the four image fields are
 * absent; it would still pass if some OTHER 1.6 field, default, optionality,
 * or ordering drifted.
 *
 * This test closes that gap directly: the baseline fixture was captured from
 * the commit immediately before the pre-image freeze (before `chatSubscribeV16`
 * was rebound off the live schemas), so any future edit to `chatSchemaPreImage`
 * / `runtimeEventSchemaPreImage` / their transitive dependencies that changes
 * `chatSubscribeV16`'s wire shape in ANY way - not just image fields - fails
 * here first.
 *
 * Regenerate ONLY if a genuine investigation concludes the frozen line itself
 * needs re-pinning (it should not, ever, since `chat.subscribe@1.6` is
 * released):
 *   bun run protocol/scripts/snapshot-chat-subscribe-v16-surface.ts > \
 *     protocol/src/host/agent/gui/__tests__/__fixtures__/chat-subscribe-v16-surface.ts
 */
describe("chat.subscribe@1.6 surface is frozen exactly", () => {
  it("declares the pinned method and schemaVersion", () => {
    expect(chatSubscribeV16.method).toBe(chatSubscribeV16SurfaceBaseline.method);
    expect(chatSubscribeV16.schemaVersion).toEqual(
      chatSubscribeV16SurfaceBaseline.schemaVersion,
    );
  });

  it("openRequest storage/domain JSON Schema matches the baseline", () => {
    expect(
      z.toJSONSchema(chatSubscribeV16.openRequestSchema, { io: "input" }),
    ).toEqual(chatSubscribeV16SurfaceBaseline.openRequest.storage);
    expect(z.toJSONSchema(chatSubscribeV16.openRequestSchema)).toEqual(
      chatSubscribeV16SurfaceBaseline.openRequest.domain,
    );
  });

  it("serverFrame storage/domain JSON Schema matches the baseline", () => {
    expect(
      z.toJSONSchema(chatSubscribeV16.serverFrameSchema, { io: "input" }),
    ).toEqual(chatSubscribeV16SurfaceBaseline.serverFrame.storage);
    expect(z.toJSONSchema(chatSubscribeV16.serverFrameSchema)).toEqual(
      chatSubscribeV16SurfaceBaseline.serverFrame.domain,
    );
  });

  it("clientFrame storage/domain JSON Schema matches the baseline", () => {
    expect(
      z.toJSONSchema(chatSubscribeV16.clientFrameSchema, { io: "input" }),
    ).toEqual(chatSubscribeV16SurfaceBaseline.clientFrame.storage);
    expect(z.toJSONSchema(chatSubscribeV16.clientFrameSchema)).toEqual(
      chatSubscribeV16SurfaceBaseline.clientFrame.domain,
    );
  });
});
