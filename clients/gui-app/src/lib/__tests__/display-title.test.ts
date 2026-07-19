import { describe, expect, it } from "vitest";
import {
  chatDisplayTitle,
  displayTitle,
  epicDisplayTitle,
  tuiAgentDisplayTitle,
  UNTITLED_EPIC_TITLE,
} from "@/lib/display-title";

describe("displayTitle", () => {
  it("returns the raw title when non-empty", () => {
    expect(displayTitle("My epic", "epic")).toBe("My epic");
  });

  it("falls back to the per-kind label when empty", () => {
    expect(displayTitle("", "epic")).toBe("Untitled epic");
    expect(displayTitle("", "chat")).toBe("Untitled chat");
    expect(displayTitle("", "terminal-agent")).toBe("Untitled terminal agent");
  });

  it("exposes the single-sourced empty-epic literal", () => {
    expect(UNTITLED_EPIC_TITLE).toBe("Untitled epic");
  });
});

describe("epicDisplayTitle", () => {
  it("returns the raw title when non-empty (prompt ignored)", () => {
    expect(
      epicDisplayTitle({
        title: "Stored title",
        initialUserPrompt: "a prompt",
      }),
    ).toBe("Stored title");
  });

  it("derives a prompt slice when the title is empty and a prompt exists", () => {
    expect(
      epicDisplayTitle({
        title: "",
        initialUserPrompt: "Add a derived display fallback",
      }),
    ).toBe("Add a derived display fallback");
  });

  it("collapses and truncates a long multi-line prompt", () => {
    const prompt = `${"word ".repeat(40)}\n more`;
    const derived = epicDisplayTitle({ title: "", initialUserPrompt: prompt });
    expect(derived.endsWith("...")).toBe(true);
    expect(derived.length).toBe(72);
    expect(derived).not.toContain("\n");
  });

  it("falls back to 'Untitled epic' when title and prompt are empty", () => {
    expect(epicDisplayTitle({ title: "", initialUserPrompt: "" })).toBe(
      "Untitled epic",
    );
  });

  it("falls back to 'Untitled epic' when the prompt is whitespace-only", () => {
    expect(epicDisplayTitle({ title: "", initialUserPrompt: "   \n\t " })).toBe(
      "Untitled epic",
    );
  });
});

describe("tuiAgentDisplayTitle", () => {
  it("returns the raw title when non-empty (harness ignored)", () => {
    expect(
      tuiAgentDisplayTitle({ title: "Renamed agent", harnessId: "claude" }),
    ).toBe("Renamed agent");
  });

  it("derives the harness label when the title is empty", () => {
    expect(tuiAgentDisplayTitle({ title: "", harnessId: "claude" })).toBe(
      "Claude Code",
    );
    expect(tuiAgentDisplayTitle({ title: "", harnessId: "codex" })).toBe(
      "Codex",
    );
    expect(tuiAgentDisplayTitle({ title: "", harnessId: "opencode" })).toBe(
      "OpenCode",
    );
  });
});

describe("chatDisplayTitle", () => {
  it("returns the raw title when non-empty (first message ignored)", () => {
    expect(
      chatDisplayTitle({ title: "Stored chat", firstUserMessage: "hello" }),
    ).toBe("Stored chat");
  });

  it("derives the first user message when the title is empty", () => {
    expect(
      chatDisplayTitle({ title: "", firstUserMessage: "How do I do X?" }),
    ).toBe("How do I do X?");
  });

  it("falls back to 'Untitled chat' when no first message is available", () => {
    expect(chatDisplayTitle({ title: "", firstUserMessage: null })).toBe(
      "Untitled chat",
    );
    expect(chatDisplayTitle({ title: "", firstUserMessage: "" })).toBe(
      "Untitled chat",
    );
  });
});
