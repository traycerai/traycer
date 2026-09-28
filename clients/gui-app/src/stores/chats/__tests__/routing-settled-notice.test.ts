import { describe, expect, it } from "vitest";
import { routingSettledNoticeSegmentId } from "@/stores/chats/routing-settled-notice";
import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * `routingSettledNoticeSegmentId` already keys on `receipt !== null` for any
 * `provider_notice`, so a cancellation notice (`receipt: null` per the
 * contract) never becomes the settled card - the same rule that already
 * excludes every superseded settlement notice.
 */
describe("routingSettledNoticeSegmentId", () => {
  it("returns null for a cancellation notice whose receipt is null", () => {
    const segments: ReadonlyArray<MessageSegment> = [
      {
        id: "fallback-settled:t1",
        kind: "provider_notice",
        status: "completed",
        noticeKind: "fallback_settled",
        tone: "info",
        title:
          "Fallback ended - no further providers will be tried for this turn",
        message: "What was tried is recorded below.",
        details: [
          { label: "Code", value: "FALLBACK_CANCELLED" },
          { label: "Cause", value: "You chose not to switch" },
        ],
        receipt: null,
        parentId: null,
      },
    ];

    expect(routingSettledNoticeSegmentId(segments)).toBeNull();
  });
});
