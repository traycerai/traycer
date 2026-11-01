import { describe, expect, it } from "vitest";
import {
  chatDisplayTitle,
  displayTitle,
  epicDisplayTitle,
  isAgentFallbackName,
  UNTITLED_EPIC_TITLE,
} from "@/lib/display-title";

describe("displayTitle", () => {
  it("returns the raw title when non-empty", () => {
    expect(displayTitle("My epic", "epic")).toBe("My epic");
  });

  it("falls back to the per-kind label when empty", () => {
    expect(displayTitle("", "epic")).toBe("Untitled task");
  });

  it("names an untitled Agent 'New agent' under every Agent kind", () => {
    expect(displayTitle("", "agent")).toBe("New agent");
    expect(displayTitle("", "chat")).toBe("New agent");
    expect(displayTitle("", "terminal-agent")).toBe("New agent");
  });

  it("reads the baked 'Untitled agent' as no title under the agent kind only", () => {
    expect(displayTitle("Untitled agent", "agent")).toBe("New agent");
    expect(displayTitle("Untitled agent", "chat")).toBe("Untitled agent");
  });

  it("keeps a historical 'Untitled chat' title as data", () => {
    expect(displayTitle("Untitled chat", "agent")).toBe("Untitled chat");
  });

  it("exposes the single-sourced empty-epic literal", () => {
    expect(UNTITLED_EPIC_TITLE).toBe("Untitled task");
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

  it("falls back to 'Untitled task' when title and prompt are empty", () => {
    expect(epicDisplayTitle({ title: "", initialUserPrompt: "" })).toBe(
      "Untitled task",
    );
  });

  it("falls back to 'Untitled task' when the prompt is whitespace-only", () => {
    expect(epicDisplayTitle({ title: "", initialUserPrompt: "   \n\t " })).toBe(
      "Untitled task",
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

  it("falls back to 'New agent' when no first message is available", () => {
    expect(chatDisplayTitle({ title: "", firstUserMessage: null })).toBe(
      "New agent",
    );
    expect(chatDisplayTitle({ title: "", firstUserMessage: "" })).toBe(
      "New agent",
    );
  });
});

describe("isAgentFallbackName", () => {
  it.each([
    "New agent",
    "Untitled agent",
    "Untitled chat",
    "Untitled terminal agent",
  ])("recognises %s", (name) => {
    expect(isAgentFallbackName(name)).toBe(true);
  });

  it("does not recognise a real title", () => {
    expect(isAgentFallbackName("Planner")).toBe(false);
  });
});
