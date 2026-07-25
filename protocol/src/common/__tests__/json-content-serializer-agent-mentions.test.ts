import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import {
  ContextType,
  jsonContentToMarkdown,
} from "../json-content-serializer";

/**
 * Regression tests for Agent mention serialization across both interfaces.
 *
 * An Agent is the durable referenceable entity; Chat and Terminal are the
 * interfaces used to interact with one. `ContextType.TerminalAgent` was added
 * after `Chat`, and before it existed a Terminal-interface Agent mention fell
 * through the serializer's `default:` arm and reached the coding agent as a
 * bare title - no `@agent:` marker and, critically, no `agentId`, so the
 * runtime had nothing to pass to `traycer_send_message` /
 * `traycer_get_transcript`. Referring to an Agent has to mean the same thing
 * regardless of interface (Core Flows, Flow 3).
 */

function mentionDoc(attrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "ask " },
          { type: "mention", attrs },
          { type: "text", text: " for status" },
        ],
      },
    ],
  };
}

function toLlm(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
}

function toDisplay(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "user",
    platform: "POSIX",
  });
}

describe("Agent mention serialization", () => {
  it("keeps the released chat context serializing unchanged for the LLM", () => {
    const out = toLlm(
      mentionDoc({
        contextType: ContextType.Chat,
        id: "c1",
        label: "Refactor",
      }),
    );
    expect(out).toContain("@agent:Refactor [agentId=c1]");
  });

  it("gives a Terminal-interface Agent the identical LLM reference form", () => {
    const out = toLlm(
      mentionDoc({
        contextType: ContextType.TerminalAgent,
        id: "t1",
        label: "Refactor",
      }),
    );
    // Same marker and the durable id - not a bare title.
    expect(out).toContain("@agent:Refactor [agentId=t1]");
    expect(out).not.toBe("ask Refactor for status");
  });

  it("serializes both interfaces identically for the LLM given the same id and title", () => {
    const chat = toLlm(
      mentionDoc({ contextType: ContextType.Chat, id: "x", label: "Shared" }),
    );
    const terminal = toLlm(
      mentionDoc({
        contextType: ContextType.TerminalAgent,
        id: "x",
        label: "Shared",
      }),
    );
    expect(terminal).toBe(chat);
  });

  it("marks a Terminal-interface Agent whose id is missing rather than dropping the reference", () => {
    const out = toLlm(
      mentionDoc({ contextType: ContextType.TerminalAgent, label: "Refactor" }),
    );
    expect(out).toContain("@agent:Refactor [agentId is unavailable]");
  });

  it("falls back to the untitled marker when a Terminal-interface Agent has no title", () => {
    const out = toLlm(
      mentionDoc({ contextType: ContextType.TerminalAgent, id: "t9" }),
    );
    expect(out).toContain("@agent:untitled [agentId=t9]");
  });

  it("projects both interfaces as the durable Agent for a human reader", () => {
    const chat = toDisplay(
      mentionDoc({ contextType: ContextType.Chat, id: "c1", label: "Plan" }),
    );
    const terminal = toDisplay(
      mentionDoc({
        contextType: ContextType.TerminalAgent,
        id: "t1",
        label: "Plan",
      }),
    );

    expect(chat).toContain("agent:Plan");
    expect(terminal).toContain("agent:Plan");
    // Prefixing by interface would render Chat and Terminal as sibling entity
    // types - the model the Agent rename replaces.
    expect(chat).not.toContain("chat:Plan");
    expect(terminal).not.toContain("terminal-agent:Plan");
  });

  it("serializes both interfaces identically for display given the same id and title", () => {
    const chat = toDisplay(
      mentionDoc({ contextType: ContextType.Chat, id: "x", label: "Shared" }),
    );
    const terminal = toDisplay(
      mentionDoc({
        contextType: ContextType.TerminalAgent,
        id: "x",
        label: "Shared",
      }),
    );
    expect(terminal).toBe(chat);
  });

  it("keeps the released chat context value stable", () => {
    // `chat` is carried by persisted mentions; renaming it would strand them.
    expect(ContextType.Chat).toBe("chat");
    expect(ContextType.TerminalAgent).toBe("terminal-agent");
  });
});
