import { describe, expect, it } from "vitest";
import { collectAssistantReplyText } from "@/lib/chat/collect-assistant-reply-text";
import type { MessageSegment } from "@/stores/composer/chat-store";

describe("collectAssistantReplyText browserSession exclusion", () => {
  it("excludes the first-use browser-session row from the copyable reply", () => {
    const segments: MessageSegment[] = [
      {
        id: "seg-1",
        kind: "text",
        markdown: "Here is the answer.",
        isStreaming: false,
      },
      {
        id: "seg-2",
        kind: "text",
        markdown: "Browser · Primary",
        isStreaming: false,
        browserSession: {
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          profile: "primary",
        },
      },
      {
        id: "seg-3",
        kind: "text",
        markdown: "One more line.",
        isStreaming: false,
      },
    ];

    expect(collectAssistantReplyText(segments)).toBe(
      "Here is the answer.\n\nOne more line.",
    );
  });

  it("still joins ordinary text segments when none carry a browserSession", () => {
    const segments: MessageSegment[] = [
      { id: "seg-1", kind: "text", markdown: "First.", isStreaming: false },
      { id: "seg-2", kind: "text", markdown: "Second.", isStreaming: false },
    ];

    expect(collectAssistantReplyText(segments)).toBe("First.\n\nSecond.");
  });
});
