import { describe, expect, it } from "vitest";
import { rankSlashCommands } from "../slash-command-ranking";
import type { SlashCommand } from "../types";

function command(fields: {
  name: string;
  description?: string;
  argumentHint?: string;
  kind?: SlashCommand["kind"];
}): SlashCommand {
  return {
    harnessId: "claude",
    name: fields.name,
    description: fields.description ?? "",
    argumentHint: fields.argumentHint ?? null,
    kind: fields.kind ?? "slash-command",
    metadata: {},
    source: "provider",
    preview: {
      kind: "text",
      primary: fields.description ?? "",
      secondary: null,
      mono: false,
    },
  };
}

function rankedNames(
  commands: ReadonlyArray<SlashCommand>,
  query: string,
): string[] {
  return rankSlashCommands(commands, query).map((item) => item.name);
}

describe("rankSlashCommands", () => {
  it("returns the catalog unchanged for an empty query", () => {
    const commands = [
      command({ name: "review" }),
      command({ name: "compact" }),
    ];
    expect(rankedNames(commands, "  ")).toEqual(["review", "compact"]);
  });

  it("ranks a name match above a description-only match", () => {
    const commands = [
      command({
        name: "compact",
        description: "Summarize and plan the conversation",
      }),
      command({ name: "plan", description: "Enter plan mode" }),
    ];
    expect(rankedNames(commands, "plan")[0]).toBe("plan");
  });

  it("matches a fuzzy query the old substring filter would have dropped", () => {
    const commands = [
      command({ name: "frontend-design", description: "Build polished UI" }),
      command({ name: "review", description: "Review current changes" }),
    ];
    expect(rankedNames(commands, "frntend")).toEqual(["frontend-design"]);
  });

  it("drops rows that do not match the query", () => {
    const commands = [
      command({ name: "review", description: "Review current changes" }),
      command({ name: "compact", description: "Summarize the conversation" }),
    ];
    expect(rankedNames(commands, "review")).toEqual(["review"]);
  });

  it("still narrows by kind so a skills query lists only skills", () => {
    const commands = [
      command({ name: "review", description: "Review current changes" }),
      command({
        name: "frontend-design",
        description: "Build polished UI",
        kind: "skill",
      }),
    ];
    expect(rankedNames(commands, "skill")).toEqual(["frontend-design"]);
  });

  it("keeps equal-quality matches in input (alphabetical) order", () => {
    const commands = [
      command({ name: "agent-review", description: "" }),
      command({ name: "review-agent", description: "" }),
    ];
    expect(rankedNames(commands, "agent")).toEqual([
      "agent-review",
      "review-agent",
    ]);
  });
});
