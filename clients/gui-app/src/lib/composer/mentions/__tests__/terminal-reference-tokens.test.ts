import { describe, expect, it } from "vitest";

import {
  ContextType,
  formatMentionForDisplayQuery,
} from "@traycer/protocol/common/json-content-serializer";
import { createLegacyMentionAttachment } from "../legacy";
import { mentionAttachmentFromSuggestion } from "../attachments";
import { splitPromptIntoComposerSegments } from "@/lib/composer/segments";
import {
  mentionAttachmentFromAttrs,
  mentionAttrsFromAttachment,
} from "@/lib/composer/tiptap-json-content";
import type { EpicTerminalMentionEntry } from "@/lib/composer/types";

const TERMINAL_ENTRY: EpicTerminalMentionEntry = {
  kind: "epic-terminal",
  id: "terminal:epic-1:term-9",
  token: "terminal:epic-1/term-9",
  epicId: "epic-1",
  terminalId: "term-9",
  label: "repo · zsh",
  description: "/repo",
  cwd: "/repo",
  updatedAt: 10,
};

/**
 * The `terminal:` reference names the shell itself, not an Agent reached
 * through one. It is deliberately a sibling of `terminal-agent:` rather than a
 * variant of it: a coding agent can READ a terminal and can never talk to one,
 * so the two must not collapse anywhere along this path.
 */
describe("terminal reference tokens", () => {
  it("builds a pointer-only mention from a picker row", () => {
    expect(mentionAttachmentFromSuggestion(TERMINAL_ENTRY)).toEqual({
      kind: "mention",
      contextType: "terminal",
      path: "terminal:epic-1/term-9",
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: "repo · zsh",
      description: "/repo",
      epicId: "epic-1",
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: null,
      terminalId: "term-9",
      status: null,
    });
  });

  it("round-trips a terminal mention through editor attrs", () => {
    const attachment = mentionAttachmentFromSuggestion(TERMINAL_ENTRY);
    if (attachment === null) throw new Error("expected a terminal attachment");

    expect(
      mentionAttachmentFromAttrs(mentionAttrsFromAttachment(attachment)),
    ).toEqual(attachment);
  });

  it("carries the terminal id through the attrs the node stores", () => {
    const attachment = mentionAttachmentFromSuggestion(TERMINAL_ENTRY);
    if (attachment === null) throw new Error("expected a terminal attachment");
    const attrs = mentionAttrsFromAttachment(attachment);

    expect(attrs).toMatchObject({
      contextType: "terminal",
      id: "term-9",
      terminalId: "term-9",
      epicId: "epic-1",
      label: "repo · zsh",
    });
  });

  it("parses a persisted terminal reference back out of prompt text", () => {
    expect(
      createLegacyMentionAttachment("terminal:epic-1/term-9"),
    ).toMatchObject({
      contextType: "terminal",
      path: "terminal:epic-1/term-9",
      epicId: "epic-1",
      terminalId: "term-9",
      terminalAgentId: null,
      chatId: null,
    });
    expect(
      splitPromptIntoComposerSegments("look at @terminal:epic-1/term-9"),
    ).toEqual([
      { type: "text", text: "look at " },
      { type: "mention", path: "terminal:epic-1/term-9" },
    ]);
  });

  it("keeps `terminal-agent:` parsing as an Agent, not a terminal", () => {
    // The two tokens share a prefix; the longer one must win or every Terminal
    // Agent reference would silently degrade into a read-only terminal pointer.
    expect(
      createLegacyMentionAttachment("terminal-agent:epic-1/tui-9"),
    ).toMatchObject({
      contextType: "terminal-agent",
      terminalAgentId: "tui-9",
      terminalId: null,
    });
  });

  it("reconstructs a terminal path from bare attrs with no stored path", () => {
    expect(
      mentionAttachmentFromAttrs({
        contextType: "terminal",
        epicId: "epic-1",
        id: "term-9",
      }),
    ).toMatchObject({
      contextType: "terminal",
      path: "terminal:epic-1/term-9",
      terminalId: "term-9",
    });
  });

  it("emits attrs the protocol serializer renders as a terminal reference", () => {
    // The GUI's contextType string and the protocol enum are declared
    // independently. Pin the seam from both ends: an attachment that drifted
    // off `ContextType.Terminal` would fall through the serializer's switch to
    // `default:` and reach the coding agent as a bare label with no terminal id.
    const attachment = mentionAttachmentFromSuggestion(TERMINAL_ENTRY);
    if (attachment === null) throw new Error("expected a terminal attachment");
    const attrs = mentionAttrsFromAttachment(attachment);

    expect(attachment.contextType).toBe(ContextType.Terminal);
    expect(attrs.contextType).toBe(ContextType.Terminal);
    expect(
      formatMentionForDisplayQuery({
        contextType: String(attrs.contextType),
        label: String(attrs.label),
        terminalId: String(attrs.terminalId),
      }),
    ).toBe("terminal:repo · zsh");
  });
});
