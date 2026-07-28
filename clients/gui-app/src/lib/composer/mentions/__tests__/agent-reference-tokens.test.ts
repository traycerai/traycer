import { describe, expect, it } from "vitest";

import { ContextType } from "@traycer/protocol/common/json-content-serializer";
import { createLegacyMentionAttachment } from "../legacy";
import { splitPromptIntoComposerSegments } from "@/lib/composer/segments";
import {
  mentionAttachmentFromAttrs,
  mentionAttrsFromAttachment,
} from "@/lib/composer/tiptap-json-content";

/**
 * The durable Agent reference syntax. `chat:` names a chat-interface Agent and
 * is the syntax already persisted in shipped messages - it must keep parsing
 * byte-for-byte. `terminal-agent:` is the new sibling for terminal-interface
 * Agents; no stored data is rewritten to adopt it.
 */
describe("Agent reference tokens", () => {
  it("keeps parsing persisted chat-interface references unchanged", () => {
    expect(createLegacyMentionAttachment("chat:epic-1/chat-9")).toMatchObject({
      contextType: "chat",
      path: "chat:epic-1/chat-9",
      epicId: "epic-1",
      chatId: "chat-9",
      terminalAgentId: null,
    });
  });

  it("parses a terminal-interface Agent reference", () => {
    expect(
      createLegacyMentionAttachment("terminal-agent:epic-1/tui-9"),
    ).toMatchObject({
      contextType: "terminal-agent",
      path: "terminal-agent:epic-1/tui-9",
      epicId: "epic-1",
      chatId: null,
      terminalAgentId: "tui-9",
    });
  });

  it("treats both Agent tokens as complete mentions at end of prompt", () => {
    expect(splitPromptIntoComposerSegments("ping @chat:epic-1/chat-9")).toEqual(
      [
        { type: "text", text: "ping " },
        { type: "mention", path: "chat:epic-1/chat-9" },
      ],
    );
    expect(
      splitPromptIntoComposerSegments("ping @terminal-agent:epic-1/tui-9"),
    ).toEqual([
      { type: "text", text: "ping " },
      { type: "mention", path: "terminal-agent:epic-1/tui-9" },
    ]);
  });

  it("round-trips a terminal-interface Agent mention through editor attrs", () => {
    const attachment = createLegacyMentionAttachment(
      "terminal-agent:epic-1/tui-9",
    );
    const restored = mentionAttachmentFromAttrs(
      mentionAttrsFromAttachment(attachment),
    );

    expect(restored).toMatchObject({
      contextType: "terminal-agent",
      path: "terminal-agent:epic-1/tui-9",
      epicId: "epic-1",
      terminalAgentId: "tui-9",
      artifactId: null,
    });
  });

  it("reconstructs a terminal-agent path from bare attrs with no stored path", () => {
    expect(
      mentionAttachmentFromAttrs({
        contextType: "terminal-agent",
        epicId: "epic-1",
        id: "tui-9",
      }),
    ).toMatchObject({
      contextType: "terminal-agent",
      path: "terminal-agent:epic-1/tui-9",
      terminalAgentId: "tui-9",
    });
  });

  it("emits the contextType the protocol serializer switches on", () => {
    // The GUI's string and the protocol enum are declared independently, and
    // this is the exact hop where a Terminal-interface mention used to fall
    // through to `default:` and reach the coding agent as a bare title with no
    // agentId. Pin the seam from both ends.
    const attachment = createLegacyMentionAttachment(
      "terminal-agent:epic-1/tui-9",
    );
    expect(attachment.contextType).toBe(ContextType.TerminalAgent);
    expect(mentionAttrsFromAttachment(attachment).contextType).toBe(
      ContextType.TerminalAgent,
    );

    const chat = createLegacyMentionAttachment("chat:epic-1/chat-9");
    expect(chat.contextType).toBe(ContextType.Chat);
  });
});
