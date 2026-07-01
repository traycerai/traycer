import "../../../../__tests__/test-browser-apis";

import { describe, expect, it } from "vitest";
import {
  buildChatFindRows,
  chatFindSubagentBodyUnitId,
  chatFindSubagentHeaderUnitId,
  markdownToChatSearchText,
  type ChatFindRow,
} from "@/components/chat/chat-find";
import { derivePromotedSubagentRenderId } from "@/components/chat/chat-collapsible-key";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import { makeMessage } from "./chat-message-fixtures";

const TILE_INSTANCE_ID = "chat-find-test-tile";

describe("chat find projection", () => {
  it("projects markdown links and code as rendered text, not markdown syntax", () => {
    const text = markdownToChatSearchText(
      [
        "Read [Traycer docs](https://example.test/docs) and `inlineCode`.",
        "",
        "```ts",
        "const answer = 42;",
        "```",
      ].join("\n"),
    );

    expect(text).toContain("Traycer docs");
    expect(text).toContain("inlineCode");
    expect(text).toContain("const answer = 42;");
    expect(text).not.toContain("https://example.test/docs");
    expect(text).not.toContain("```");
    expect(text).not.toContain("[Traycer docs]");
  });

  it("indexes user structured text, assistant prose, and excludes next-step controls", () => {
    const structuredContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "fix" } },
            { type: "text", text: " search bar alignment" },
          ],
        },
      ],
    };
    const user: ChatMessageModel = {
      ...makeMessage(1, "user"),
      content: "",
      structuredContent,
    };
    const assistant: ChatMessageModel = {
      ...makeMessage(2, "assistant"),
      segments: [
        {
          id: "assistant-text",
          kind: "text",
          markdown: [
            "Visible assistant answer.",
            "",
            "<TRAYCER_NEXT_STEPS>",
            "Choose one of these next steps.",
            "",
            "- [] : Hidden button prompt",
            "</TRAYCER_NEXT_STEPS>",
          ].join("\n"),
          isStreaming: false,
        },
      ],
    };

    const rows = buildChatFindRows([user, assistant], TILE_INSTANCE_ID);
    const joined = rows.map((row) => rowSearchText(row)).join("\n");

    expect(joined).toContain("/fix search bar alignment");
    expect(joined).toContain("Visible assistant answer.");
    expect(joined).toContain("Choose one of these next steps.");
    expect(joined).not.toContain("Hidden button prompt");
    expect(joined).not.toContain("Show more");
    expect(joined).not.toContain("Copy reply");
  });

  it("indexes collapsed activity group summaries and child headers only", () => {
    const segments: ReadonlyArray<MessageSegment> = [
      {
        id: "tool-1",
        kind: "tool",
        toolName: "read_file",
        inputSummary: "src/components/search-bar.tsx",
        inputDetail: null,
        taskTodoItems: null,
        error: null,
        agentMessageSend: null,
        isStreaming: false,
        endState: null,
        stopped: false,
        progress: null,
        backgroundOutput: null,
        backgroundTask: false,
        durationMs: null,
        startedAt: 0,
        parentId: null,
      },
      {
        id: "file-1",
        kind: "file_change",
        filePath: "src/components/chat/chat-find.ts",
        operation: "create",
        diffSource: "snapshot",
        beforeHash: null,
        afterHash: "after",
        additions: 12,
        deletions: 0,
        sourceBlockIds: ["file-1"],
        reason: "snapshot",
        isStreaming: false,
        endState: null,
        parentId: null,
      },
    ];
    const assistant: ChatMessageModel = {
      ...makeMessage(3, "assistant"),
      segments,
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];

    expect(rowSearchText(row)).toContain("Read 1 file, edited 1 file");
    expect(rowSearchText(row)).toContain("src/components/search-bar.tsx");
    expect(rowSearchText(row)).toContain("src/components/chat/chat-find.ts");
    expect(rowSearchText(row)).not.toContain("No diff available");
  });

  it("does not index completed reasoning body text hidden behind the collapsed summary", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(4, "assistant"),
      segments: [
        {
          id: "reasoning-1",
          kind: "reasoning",
          markdown: "private chain of thought details",
          isStreaming: false,
          durationMs: 2100,
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];

    expect(rowSearchText(row)).toContain("Thought for 2s");
    expect(rowSearchText(row)).not.toContain("private chain of thought");
  });

  it("indexes only the Thinking label for streaming reasoning, not the live tail", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(5, "assistant"),
      segments: [
        {
          id: "reasoning-streaming",
          kind: "reasoning",
          markdown: "streaming private chain-of-thought tail",
          isStreaming: true,
          durationMs: null,
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];

    expect(rowSearchText(row)).toContain("Thinking");
    expect(rowSearchText(row)).not.toContain(
      "streaming private chain-of-thought",
    );
  });

  it("indexes the always-visible subagent header (name + type) and dedupes progress", () => {
    const subagentId = "subagent-projection";
    const assistant: ChatMessageModel = {
      ...makeMessage(6, "assistant"),
      segments: [
        {
          id: subagentId,
          kind: "subagent",
          name: "Researcher",
          agentType: "analysis",
          task: "Investigate the flake",
          progressUpdates: ["Scanning", "Scanning", "Reading", "Scanning"],
          result: "All clear.",
          isStreaming: false,
          endState: null,
          stopped: false,
          startedAt: 1,
          durationMs: 1200,
          spawnToolCallId: null,
          children: [],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];
    const renderId = derivePromotedSubagentRenderId(subagentId);
    const headerUnit = row.units.find(
      (unit) => unit.unitId === chatFindSubagentHeaderUnitId(renderId),
    );
    const bodyUnit = row.units.find(
      (unit) => unit.unitId === chatFindSubagentBodyUnitId(renderId),
    );

    // The header indexes the always-visible name + agent type, reachable without
    // opening the subagent body (empty owning chain).
    expect(headerUnit?.text).toBe("Researcher analysis");
    expect(headerUnit?.owningChain).toEqual([]);
    // The body is gated behind the subagent's own collapsible key.
    expect(bodyUnit?.owningChain).toHaveLength(1);
    // Adjacent duplicate progress collapses, matching the rendered list (two
    // "Scanning" survive: the adjacent pair becomes one, the later one stays).
    expect(bodyUnit?.text.match(/Scanning/g)).toHaveLength(2);
    expect(bodyUnit?.text).toContain("Reading");
    expect(bodyUnit?.text).toContain("Investigate the flake");
    expect(bodyUnit?.text).toContain("All clear.");
  });

  it("falls back to the rendered Subagent placeholder when the name is null", () => {
    const subagentId = "subagent-unnamed";
    const assistant: ChatMessageModel = {
      ...makeMessage(7, "assistant"),
      segments: [
        {
          id: subagentId,
          kind: "subagent",
          name: null,
          agentType: null,
          task: "Quietly observe",
          progressUpdates: [],
          result: null,
          isStreaming: false,
          endState: null,
          stopped: false,
          startedAt: null,
          durationMs: null,
          spawnToolCallId: null,
          children: [],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];
    const headerUnit = row.units.find(
      (unit) =>
        unit.unitId ===
        chatFindSubagentHeaderUnitId(
          derivePromotedSubagentRenderId(subagentId),
        ),
    );
    expect(headerUnit?.text).toBe("Subagent");
  });

  it("indexes the todo header count and item labels, not status or priority words", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(8, "assistant"),
      segments: [
        {
          id: "todo-projection",
          kind: "todo",
          items: [
            {
              id: "t1",
              status: "completed",
              text: "Wire the adapter",
              priority: "high",
              activeForm: "Wiring the adapter",
            },
            {
              id: "t2",
              status: "in_progress",
              text: "Index the header",
              priority: "medium",
              activeForm: "Indexing the header",
            },
            {
              id: "t3",
              status: "pending",
              text: "Cover with tests",
              priority: "low",
              activeForm: null,
            },
          ],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];

    expect(rowSearchText(row)).toContain("1 of 3 Done");
    // Completed item renders its plain text, never its active form.
    expect(rowSearchText(row)).toContain("Wire the adapter");
    expect(rowSearchText(row)).not.toContain("Wiring the adapter");
    // In-progress item renders its active form.
    expect(rowSearchText(row)).toContain("Indexing the header");
    expect(rowSearchText(row)).toContain("Cover with tests");
    // Status / priority words are not rendered, so they must not be findable.
    expect(rowSearchText(row)).not.toContain("pending");
    expect(rowSearchText(row)).not.toContain("in_progress");
    expect(rowSearchText(row)).not.toContain("high");
    expect(rowSearchText(row)).not.toContain("medium");
  });

  it("indexes only the rendered plan card text, not dialog-only preview or extra steps", () => {
    const steps = Array.from({ length: 6 }, (_unused, index) => ({
      id: `step-${index}`,
      text: `Plan step ${index}`,
      status: "pending" as const,
      activeForm: null,
    }));
    const assistant: ChatMessageModel = {
      ...makeMessage(9, "assistant"),
      segments: [
        {
          id: "plan-projection",
          kind: "plan",
          planId: "plan-1",
          planStatus: "approved",
          harnessId: "codex",
          source: {
            harnessId: "codex",
            sessionId: null,
            turnId: null,
            kind: "structured",
          },
          title: "Refactor the search index",
          summary: "Split projection from rendering",
          markdownPreview: "## Hidden heading\n\nSecret dialog-only paragraph.",
          fullContentRef: null,
          steps,
          actions: [],
          approvalId: null,
          supersededByPlanId: null,
          isStreaming: false,
          contentIdentity: "identity-1",
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID)[0];

    expect(rowSearchText(row)).toContain("Refactor the search index");
    // The status badge LABEL is indexed, not the raw enum value.
    expect(rowSearchText(row)).toContain("Approved");
    expect(rowSearchText(row)).toContain("Split projection from rendering");
    // The first four steps render on the card.
    expect(rowSearchText(row)).toContain("Plan step 0");
    expect(rowSearchText(row)).toContain("Plan step 3");
    // Steps beyond the preview limit live behind the unopened dialog.
    expect(rowSearchText(row)).not.toContain("Plan step 4");
    expect(rowSearchText(row)).not.toContain("Plan step 5");
    // The full markdown preview is dialog-only, never shown on the card.
    expect(rowSearchText(row)).not.toContain("Secret dialog-only paragraph");
    expect(rowSearchText(row)).not.toContain("Hidden heading");
  });

  it("indexes the approval header label only (verdict + toolName), never the body-only description, at both projection sites", () => {
    const toolName = "run_command";
    const descriptionOnly = "delete the production database";
    const approval = (id: string): MessageSegment => ({
      id,
      kind: "approval",
      toolName,
      description: descriptionOnly,
      inputSummary: null,
      inputDetail: null,
      decision: { approved: false, reason: null },
    });
    // Top-level approval projection (segmentSearchText): a non-assistant message
    // routes its segments straight through segmentSearchUnits.
    const topLevel: ChatMessageModel = {
      ...makeMessage(20, "user"),
      content: "",
      segments: [approval("approval-top")],
    };
    // Activity-group-child approval projection
    // (activityGroupChildHeaderSearchText): a resolved approval on an assistant
    // turn folds into an activity group.
    const grouped: ChatMessageModel = {
      ...makeMessage(21, "assistant"),
      segments: [approval("approval-grouped")],
    };

    const joined = buildChatFindRows([topLevel, grouped], TILE_INSTANCE_ID)
      .map((row) => rowSearchText(row))
      .join("\n");

    // Both rendered headers index the toolName label, so it stays findable at
    // both sites (one match per header, no group-summary noise).
    expect(countOccurrences(joined, toolName)).toBe(2);

    // The verdict is part of the rendered header too, so it remains findable.
    expect(countOccurrences(joined, "Denied")).toBeGreaterThanOrEqual(2);

    // The description lives only in the unanchored approval body
    // (bodyFindUnitId=null). Before the fix both projection sites indexed it,
    // counting a phantom match that can never paint; it must now find nothing.
    expect(joined).not.toContain(descriptionOnly);
  });
});

function rowSearchText(row: ChatFindRow): string {
  return row.units.map((unit) => unit.text).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
