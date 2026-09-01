import { describe, expect, it } from "vitest";
import {
  buildChatFindRows,
  chatFindActivityGroupChildHeaderUnitId,
  chatFindActivityGroupSummaryUnitId,
  chatFindMessageContentUnitId,
  chatFindSegmentUnitId,
  chatFindSubagentBodyUnitId,
  chatFindSubagentHeaderUnitId,
  markdownToChatSearchText,
  type ChatFindRow,
} from "@/components/chat/chat-find";
import {
  deriveActivityGroupRenderId,
  deriveInterviewCollapsibleKey,
  derivePromotedSubagentRenderId,
} from "@/components/chat/chat-collapsible-key";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import { deriveInterviewReviewModel } from "@/components/chat/segments/interview-review-model";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ApprovalSegment,
  ChatMessage as ChatMessageModel,
  InterviewSegment,
  MessageSegment,
} from "@/stores/composer/chat-store";
import { makeMessage } from "./chat-message-fixtures";

const TILE_INSTANCE_ID = "chat-find-test-tile";

describe("chat find projection", () => {
  it("projects completed and errored terminal interviews from review fields", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(2, "assistant"),
      segments: [
        interviewSegment("interview-completed", "completed"),
        interviewSegment("interview-errored", "errored"),
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
    const completedQuestion = row.units.find(
      (unit) =>
        unit.unitId ===
        "interview:interview-completed:question:0:question-text",
    );
    const failedReason = row.units.find(
      (unit) => unit.unitId === "interview:interview-errored:block:reason",
    );

    expect(completedQuestion?.text).toBe("Where should this deploy?");
    expect(completedQuestion?.owningChain).toEqual([
      deriveInterviewCollapsibleKey(TILE_INSTANCE_ID, "interview-completed"),
    ]);
    expect(failedReason?.text).toBe("Provider stopped");
    expect(
      row.units.some((unit) => unit.unitId.includes("answered_questions")),
    ).toBe(false);
  });

  it("keeps multiple question targets distinct and positional", () => {
    const segment: InterviewSegment = {
      ...interviewSegment("interview-multiple", "completed"),
      questions: [
        {
          questionId: "q1",
          question: "Where should this deploy?",
          header: null,
          options: [],
          multiSelect: false,
        },
        {
          questionId: "q2",
          question: "Which region?",
          header: null,
          options: [],
          multiSelect: false,
        },
      ],
      answers: [
        {
          questionId: "q1",
          question: "Where should this deploy?",
          values: ["Staging"],
          notes: null,
          selection: null,
        },
        {
          questionId: "q2",
          question: "Which region?",
          values: ["us-east-1"],
          notes: null,
          selection: null,
        },
      ],
    };

    const row = buildChatFindRows(
      [
        {
          ...makeMessage(3, "assistant"),
          segments: [segment],
        },
      ],
      TILE_INSTANCE_ID,
      new Set(),
    )[0];

    expect(
      row.units
        .filter((unit) => unit.unitId.includes(":question:"))
        .map((unit) => unit.unitId),
    ).toContain("interview:interview-multiple:question:0:question-text");
    expect(
      row.units
        .filter((unit) => unit.unitId.includes(":question:"))
        .map((unit) => unit.unitId),
    ).toContain("interview:interview-multiple:question:1:question-text");
    expect(rowSearchText(row)).toContain("Where should this deploy?");
    expect(rowSearchText(row)).toContain("Which region?");
  });

  it("projects every rendered interview field under the card's owning chain", () => {
    const segment: InterviewSegment = {
      ...interviewSegment("interview-all-fields", "errored"),
      title: "Deployment title",
      description: "Rollout description",
      questions: [
        {
          questionId: "q-options",
          question: "Which environment?",
          header: "Environment",
          options: [
            {
              label: "Staging",
              description: "Shared test environment",
              preview: "No production traffic",
            },
          ],
          multiSelect: false,
        },
        {
          questionId: "q-text",
          question: "What should the release note say?",
          header: null,
          options: [],
          multiSelect: false,
        },
        {
          questionId: "q-draft",
          question: "What should remain a draft?",
          header: null,
          options: [],
          multiSelect: false,
        },
      ],
      answers: [
        {
          questionId: "q-options",
          question: "Which environment?",
          values: ["Custom environment"],
          notes: "Only after approval",
          selection: {
            questionIndex: 0,
            optionIndices: [],
            optionLabels: [],
            customText: "Custom environment",
          },
        },
        {
          questionId: "q-text",
          question: "What should the release note say?",
          values: ["Ship carefully"],
          notes: "Mention the migration",
          selection: null,
        },
        {
          questionId: "missing-question",
          question: "Which unknown question?",
          values: ["Fallback value"],
          notes: "Fallback note",
          selection: null,
        },
      ],
      draftAnswers: [
        {
          questionId: "q-draft",
          question: "What should remain a draft?",
          values: ["Draft response"],
          notes: "Draft note",
          selection: null,
        },
      ],
      outcome: "failed",
      error: "Provider stopped",
      delivery: {
        deliveryId: "delivery-all-fields",
        status: "failed",
        retryable: true,
        generation: 2,
      },
      settlement: { settlementId: "settlement-all-fields", source: "gui" },
    };
    const assistant: ChatMessageModel = {
      ...makeMessage(4, "assistant"),
      segments: [segment],
    };
    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
    const model = deriveInterviewReviewModel({
      blockId: segment.id,
      status: segment.status,
      toolName: segment.toolName,
      title: segment.title,
      description: segment.description,
      questions: segment.questions,
      answers: segment.answers,
      draftAnswers: segment.draftAnswers,
      outcome: segment.outcome,
      settlement: segment.settlement,
      error: segment.error,
      delivery: segment.delivery,
      forkedWithoutAnswer: segment.forkedWithoutAnswer,
    });
    const owningChain = [
      deriveInterviewCollapsibleKey(TILE_INSTANCE_ID, segment.id),
    ];

    expect(row.units.map(({ unitId, text }) => ({ unitId, text }))).toEqual(
      model.searchableFields.map(({ unitId, text }) => ({ unitId, text })),
    );
    expect(row.units).toHaveLength(model.searchableFields.length);
    expect(
      row.units.every(
        (unit) =>
          JSON.stringify(unit.owningChain) === JSON.stringify(owningChain),
      ),
    ).toBe(true);
  });

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

    const rows = buildChatFindRows(
      [user, assistant],
      TILE_INSTANCE_ID,
      new Set(),
    );
    const joined = rows.map((row) => rowSearchText(row)).join("\n");

    expect(joined).toContain("/fix search bar alignment");
    expect(joined).toContain("Visible assistant answer.");
    expect(joined).toContain("Choose one of these next steps.");
    expect(joined).not.toContain("Hidden button prompt");
    expect(joined).not.toContain("Show more");
    expect(joined).not.toContain("Copy reply");
  });

  // Find indexes what the DOM paints. `UserMessageBody` renders a chip through
  // `slashCommandLabelFromAttrs`, so a `$`-written skill reads as `$name` on
  // screen even though it still serializes to `/name` for the provider and the
  // clipboard. Indexing the serialized form instead would make the visible text
  // unsearchable AND count a match the highlighter has no node to paint.
  it("indexes a $-triggered chip by the label it renders, not its canonical form", () => {
    const user: ChatMessageModel = {
      ...makeMessage(1, "user"),
      content: "",
      structuredContent: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "slashCommand",
                attrs: { commandName: "traycer-implement", trigger: "$" },
              },
              { type: "text", text: " the runtime ticket" },
            ],
          },
        ],
      },
    };

    const joined = buildChatFindRows([user], TILE_INSTANCE_ID, new Set())
      .map((row) => rowSearchText(row))
      .join("\n");

    expect(joined).toContain("$traycer-implement the runtime ticket");
    expect(joined).not.toContain("/traycer-implement");
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
        managedCommand: null,
        isStreaming: false,
        endState: null,
        stopped: false,
        progress: null,
        backgroundOutput: null,
        backgroundTask: false,
        imageResults: [],
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

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

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

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

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

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

    expect(rowSearchText(row)).toContain("Thinking");
    expect(rowSearchText(row)).not.toContain(
      "streaming private chain-of-thought",
    );
  });

  // A completed block with no usable duration - persisted history with no
  // `startedAt`, or a same-millisecond completion - used to sum to 0 and let
  // the summary fall through to the generic "Ran activity". Since a lone
  // reasoning block is now a group, and the group summary is what find indexes
  // for it, that erased the word "Thought" from the index entirely: searching
  // for the thinking you can plainly see would return nothing.
  it("indexes a duration-less reasoning group as thought, not as generic activity", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(5, "assistant"),
      segments: [
        {
          id: "reasoning-no-duration",
          kind: "reasoning",
          markdown: "sole block body",
          isStreaming: false,
          durationMs: null,
        },
      ],
    };

    const text = rowSearchText(
      buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0],
    );

    expect(text).toContain("Thought");
    expect(text).not.toContain("Ran activity");
  });

  // A unit id and an owning chain are both derived from the group a segment
  // lands in, and the group id comes from the run's FIRST segment - so a tool
  // promoted out of the run shifts every id behind it. The renderer promotes
  // from the host's live set; if the projection ran on an empty one it would
  // emit `activity:tool-1` ids for rows the DOM renders under `activity:
  // reasoning-1`, counting matches that can never be painted or navigated to.
  it("groups exactly as the renderer does when a tool is promoted by the live set", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(7, "assistant"),
      segments: [
        {
          id: "tool-live-promoted",
          kind: "tool",
          toolName: "run_command",
          inputSummary: "bun test",
          inputDetail: null,
          taskTodoItems: null,
          error: null,
          agentMessageSend: null,
          managedCommand: null,
          isStreaming: false,
          endState: null,
          stopped: false,
          progress: null,
          backgroundOutput: null,
          // No durable marker - promotion is visible ONLY through the live set.
          backgroundTask: false,
          imageResults: [],
          durationMs: null,
          startedAt: 0,
          parentId: null,
        },
        {
          id: "reasoning-after-tool",
          kind: "reasoning",
          markdown: "body",
          isStreaming: false,
          durationMs: 2100,
        },
      ],
    };

    const promoted = new Set(["tool-live-promoted"]);
    const unitIds = buildChatFindRows(
      [assistant],
      TILE_INSTANCE_ID,
      promoted,
    )[0].units.map((unit) => unit.unitId);

    // The run starts at the reasoning block, because the tool stands alone.
    // Probed through the group SUMMARY unit: the group's sole reasoning block
    // renders unheaded, so it contributes no child unit of its own - but the
    // group id is derived the same way and discriminates the same mistake.
    expect(unitIds).toContain(
      chatFindActivityGroupSummaryUnitId(
        deriveActivityGroupRenderId("reasoning-after-tool"),
      ),
    );
    // The id the empty-set projection would have produced must NOT appear.
    expect(unitIds).not.toContain(
      chatFindActivityGroupSummaryUnitId(
        deriveActivityGroupRenderId("tool-live-promoted"),
      ),
    );
  });

  // A group that is NOTHING BUT one reasoning block renders it unheaded - the
  // group summary is its label verbatim - so it must not also be projected as a
  // child unit. A unit with no anchor counts a match the reveal can never
  // paint, and here it would double-count the very same words.
  it("does not index a lone reasoning child, whose header does not render", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(5, "assistant"),
      segments: [
        {
          id: "reasoning-alone",
          kind: "reasoning",
          markdown: "body",
          isStreaming: false,
          durationMs: 2100,
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

    // Exactly once - in the group summary ("Thought for 2s"). The label is
    // still findable; it is just not counted twice.
    expect(countOccurrences(rowSearchText(row), "Thought for 2s")).toBe(1);
    expect(row.units.map((unit) => unit.unitId)).not.toContain(
      chatFindActivityGroupChildHeaderUnitId(
        deriveActivityGroupRenderId("reasoning-alone"),
        "reasoning-alone",
      ),
    );
  });

  // A group that SHRANK back to one reasoning block keeps its VISIBLE header -
  // the renderer latches it so a completed trace does not unfold itself - but
  // the projection is rebuilt from the model and sees only the shape, so it
  // emits no unit. That asymmetry is deliberate and one-directional: a header
  // that is not a find target. The words are still indexed once, on the group
  // summary, which by definition says the same thing. The dangerous direction -
  // a counted match with no anchor to paint - cannot arise, because the
  // renderer drops the anchor whenever the projection drops the unit.
  it("stops indexing the reasoning child once its sibling is backgrounded", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(5, "assistant"),
      segments: [
        {
          id: "reasoning-remnant",
          kind: "reasoning",
          markdown: "body",
          isStreaming: false,
          durationMs: 2100,
        },
        {
          id: "command-backgrounded",
          kind: "command",
          command: "bun test --watch",
          cwd: null,
          exitCode: null,
          isStreaming: true,
          endState: null,
          stopped: false,
          progress: null,
          startedAt: 0,
          backgroundTask: null,
          parentId: null,
        },
      ],
    };

    const row = buildChatFindRows(
      [assistant],
      TILE_INSTANCE_ID,
      new Set(["command-backgrounded"]),
    )[0];

    expect(row.units.map((unit) => unit.unitId)).not.toContain(
      chatFindActivityGroupChildHeaderUnitId(
        deriveActivityGroupRenderId("reasoning-remnant"),
        "reasoning-remnant",
      ),
    );
    // Still findable, exactly once, through the summary of the group it is now
    // the whole of.
    expect(countOccurrences(rowSearchText(row), "Thought for 2s")).toBe(1);
  });

  // The moment the group holds anything else, its summary stops being that
  // block's label ("Thought for 2s, ran 1 command"), the header comes back, and
  // the unit must come back with it - or the row is unfindable and a reveal
  // targeting it has no anchor to paint.
  it("indexes a reasoning child that has a non-reasoning sibling", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(5, "assistant"),
      segments: [
        {
          id: "reasoning-with-sibling",
          kind: "reasoning",
          markdown: "body",
          isStreaming: false,
          durationMs: 2100,
        },
        {
          id: "command-sibling",
          kind: "command",
          command: "echo hi",
          cwd: null,
          exitCode: 0,
          isStreaming: false,
          endState: null,
          stopped: false,
          progress: null,
          startedAt: 0,
          backgroundTask: null,
          parentId: null,
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

    expect(row.units.map((unit) => unit.unitId)).toContain(
      chatFindActivityGroupChildHeaderUnitId(
        deriveActivityGroupRenderId("reasoning-with-sibling"),
        "reasoning-with-sibling",
      ),
    );
  });

  // Two or more blocks DO each keep a header: the group summary carries their
  // SUM, so only the rows tell them apart. Their units must come back.
  it("indexes every reasoning child once a group holds more than one", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(5, "assistant"),
      segments: [
        {
          id: "reasoning-first",
          kind: "reasoning",
          markdown: "body",
          isStreaming: false,
          durationMs: 2100,
        },
        {
          id: "reasoning-second",
          kind: "reasoning",
          markdown: "body",
          isStreaming: false,
          durationMs: 3200,
        },
      ],
    };

    const unitIds = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())
      .flatMap((row) => row.units)
      .map((unit) => unit.unitId);
    const groupId = deriveActivityGroupRenderId("reasoning-first");

    expect(unitIds).toContain(
      chatFindActivityGroupChildHeaderUnitId(groupId, "reasoning-first"),
    );
    expect(unitIds).toContain(
      chatFindActivityGroupChildHeaderUnitId(groupId, "reasoning-second"),
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
          parentId: null,
          workflowMeta: null,
          children: [],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
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

  it("indexes a workflow card's Intent/Activity/Result in the same order the card renders them", () => {
    const subagentId = "workflow-projection";
    const assistant: ChatMessageModel = {
      ...makeMessage(6, "assistant"),
      segments: [
        {
          id: subagentId,
          kind: "subagent",
          name: "review",
          agentType: null,
          // The dual-written base fields must never surface here - only
          // workflowMeta's own intent/activity, in card order.
          task: "must not be indexed",
          progressUpdates: ["must not be indexed"],
          result: "3 findings",
          isStreaming: false,
          endState: null,
          stopped: false,
          startedAt: 1,
          durationMs: 1200,
          spawnToolCallId: null,
          parentId: null,
          workflowMeta: {
            name: "review",
            intent: "Review the diff",
            activity: [{ kind: "phase", text: "Find" }],
            agentsStarted: 1,
            agentsFinished: 1,
            totalTokens: 500,
          },
          children: [],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
    const renderId = derivePromotedSubagentRenderId(subagentId);
    const bodyUnit = row.units.find(
      (unit) => unit.unitId === chatFindSubagentBodyUnitId(renderId),
    );

    expect(bodyUnit?.text).not.toContain("must not be indexed");
    const text = bodyUnit?.text ?? "";
    const intentIndex = text.indexOf("Review the diff");
    const activityIndex = text.indexOf("Find");
    const resultIndex = text.indexOf("3 findings");
    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeGreaterThan(intentIndex);
    expect(resultIndex).toBeGreaterThan(activityIndex);
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
          parentId: null,
          workflowMeta: null,
          children: [],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
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

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

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

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

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

  it("indexes a resolved approval's header label only (verdict + toolName), never the body-only description", () => {
    const toolName = "run_command";
    const descriptionOnly = "delete the production database";
    const approval = (
      id: string,
      decision: ApprovalSegment["decision"],
    ): MessageSegment => ({
      id,
      kind: "approval",
      toolName,
      description: descriptionOnly,
      inputSummary: null,
      inputDetail: null,
      decision,
    });
    // A resolved approval on an assistant turn folds into an activity group and
    // renders one child-header row (activityGroupChildHeaderSearchText). A
    // pending approval is suppressed from the transcript entirely, so this header
    // is the only place an approval's text is findable.
    const grouped: ChatMessageModel = {
      ...makeMessage(21, "assistant"),
      segments: [
        approval("approval-grouped", { approved: false, reason: null }),
      ],
    };

    const joined = buildChatFindRows([grouped], TILE_INSTANCE_ID, new Set())
      .map((row) => rowSearchText(row))
      .join("\n");

    // The rendered header indexes the toolName label exactly once - the activity
    // group summary must not also index it (that would double-count).
    expect(countOccurrences(joined, toolName)).toBe(1);

    // The verdict is part of the rendered header too, so it remains findable.
    expect(joined).toContain("Denied");

    // The description lives only in the unanchored approval body
    // (bodyFindUnitId=null), so indexing it would count a phantom match that can
    // never paint; it must find nothing.
    expect(joined).not.toContain(descriptionOnly);
  });

  it("indexes a top-level provider notice's title/message/detail text, ungated by any activity group", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(22, "assistant"),
      segments: [
        {
          id: "notice-top",
          kind: "provider_notice",
          status: "completed",
          tone: "warning",
          title: "Model changed",
          message: "Codex switched from gpt-5 to gpt-5-safe.",
          details: [{ label: "Reason", value: "highRiskCyberActivity" }],
          parentId: null,
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
    const noticeUnit = row.units.find(
      (unit) => unit.unitId === chatFindSegmentUnitId("notice-top"),
    );

    expect(noticeUnit?.text).toContain("Model changed");
    expect(noticeUnit?.text).toContain(
      "Codex switched from gpt-5 to gpt-5-safe.",
    );
    expect(noticeUnit?.text).toContain("Reason");
    expect(noticeUnit?.text).toContain("highRiskCyberActivity");
    // Not gated behind any collapsible key - it never folds into an activity
    // group's collapse state.
    expect(noticeUnit?.owningChain).toEqual([]);
  });

  it("indexes a nested provider notice inside a sub-agent card, opening the same chain as the sub-agent's own body", () => {
    const subagentId = "subagent-with-notice";
    const assistant: ChatMessageModel = {
      ...makeMessage(23, "assistant"),
      segments: [
        {
          id: subagentId,
          kind: "subagent",
          name: "Researcher",
          agentType: null,
          task: "Investigate the reroute",
          progressUpdates: [],
          result: null,
          isStreaming: false,
          endState: null,
          stopped: false,
          startedAt: 1,
          durationMs: null,
          spawnToolCallId: null,
          parentId: null,
          workflowMeta: null,
          children: [
            {
              id: "notice-nested",
              kind: "provider_notice",
              status: "completed",
              tone: "info",
              title: "Model verification active",
              message: "Trusted access verification enabled.",
              details: [
                { label: "Verifications", value: "trustedAccessForCyber" },
              ],
              parentId: subagentId,
            },
          ],
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];
    const renderId = derivePromotedSubagentRenderId(subagentId);
    const bodyUnit = row.units.find(
      (unit) => unit.unitId === chatFindSubagentBodyUnitId(renderId),
    );
    const noticeUnit = row.units.find(
      (unit) => unit.unitId === chatFindSegmentUnitId("notice-nested"),
    );

    expect(noticeUnit?.text).toContain("Model verification active");
    expect(noticeUnit?.text).toContain("Trusted access verification enabled.");
    expect(noticeUnit?.text).toContain("Verifications");
    expect(noticeUnit?.text).toContain("trustedAccessForCyber");
    // The nested notice opens with the SAME chain as the sub-agent's own
    // body - expanding the card reveals the notice alongside it.
    expect(noticeUnit?.owningChain).toEqual(bodyUnit?.owningChain);
    expect(noticeUnit?.owningChain).toHaveLength(1);
  });

  // A regular user message renders its whole body as ONE anchor
  // (message:{id}:content) via UserMessageBody - it never renders per-segment
  // anchors. Real user messages also carry a `text` segment mirroring their
  // content, so also projecting that segment double-counts every match with a
  // phantom that can never paint (the Cmd+F "N matches shows N+1" bug).
  it("projects a plain-content user message with a mirrored text segment as a single content unit", () => {
    const user: ChatMessageModel = {
      ...makeMessage(30, "user"),
      content: "confirm the app is working",
      segments: [
        {
          id: "user-text-0",
          kind: "text",
          markdown: "confirm the app is working",
          isStreaming: false,
        },
      ],
    };

    const row = buildChatFindRows([user], TILE_INSTANCE_ID, new Set())[0];

    expect(row.units.map((unit) => unit.unitId)).toEqual([
      chatFindMessageContentUnitId(user.id),
    ]);
    // "app" renders once, so the projection must count it exactly once.
    expect(countOccurrences(rowSearchText(row), "app")).toBe(1);
  });

  it("projects a structured-content user message as a single content unit despite mirroring text segments", () => {
    const user: ChatMessageModel = {
      ...makeMessage(31, "user"),
      content: "",
      structuredContent: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "align the search bar" }],
          },
        ],
      },
      segments: [
        {
          id: "user-text-1",
          kind: "text",
          markdown: "align the search bar",
          isStreaming: false,
        },
      ],
    };

    const row = buildChatFindRows([user], TILE_INSTANCE_ID, new Set())[0];

    expect(row.units.map((unit) => unit.unitId)).toEqual([
      chatFindMessageContentUnitId(user.id),
    ]);
    expect(countOccurrences(rowSearchText(row), "search")).toBe(1);
  });

  // Guard the fix's scope: assistant turns render per-segment anchors, so their
  // segments must still each project a unit (both "app" occurrences count).
  it("still projects assistant text segments per-segment (fix is scoped to non-assistant messages)", () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(32, "assistant"),
      segments: [
        {
          id: "assistant-text-0",
          kind: "text",
          markdown: "the app renders the app",
          isStreaming: false,
        },
      ],
    };

    const row = buildChatFindRows([assistant], TILE_INSTANCE_ID, new Set())[0];

    expect(row.units.map((unit) => unit.unitId)).toEqual([
      chatFindSegmentUnitId("assistant-text-0"),
    ]);
    expect(countOccurrences(rowSearchText(row), "app")).toBe(2);
  });

  // Guard the fix's exception: a synthesized single-special-segment row
  // (setup-card / forked-chat-link) renders that segment's OWN anchor and no
  // content block, so the projection must keep emitting the segment unit.
  it("still projects a synthesized single forked-chat-link segment as its own unit", () => {
    const synthesized: ChatMessageModel = {
      ...makeMessage(33, "system"),
      content: "",
      segments: [
        {
          id: "forked-1",
          kind: "forked-chat-link",
          viewTabId: "view-tab-1",
          sourceChatId: "source-chat-1",
          sourceChatTitle: "Legacy Thread",
          sourceHostId: "host-1",
        },
      ],
    };

    const row = buildChatFindRows(
      [synthesized],
      TILE_INSTANCE_ID,
      new Set(),
    )[0];

    expect(row.units.map((unit) => unit.unitId)).toEqual([
      chatFindSegmentUnitId("forked-1"),
    ]);
    expect(rowSearchText(row)).toContain("Forked from Legacy Thread");
  });

  // The marker's anchor paints one line: the provider's DISPLAY name and the
  // import date. Indexing the harness id or the source directory (tooltip-only,
  // and rendered in a portal outside the anchor) would count matches the
  // highlighter has no text to paint.
  it("indexes an imported-chat-marker by the line it renders, not the raw provider id or the source path", () => {
    const synthesized: ChatMessageModel = {
      ...makeMessage(34, "system"),
      content: "",
      segments: [
        {
          id: "imported-1",
          kind: "imported-chat-marker",
          sourceProvider: "claude",
          importedAt: 1700000000000,
          sourceCwd: "/repo/work",
        },
      ],
    };

    const row = buildChatFindRows(
      [synthesized],
      TILE_INSTANCE_ID,
      new Set(),
    )[0];

    expect(row.units.map((unit) => unit.unitId)).toEqual([
      chatFindSegmentUnitId("imported-1"),
    ]);
    const text = rowSearchText(row);
    expect(text).toBe(
      `Imported from Claude Code · ${formatAbsoluteDateTime(1700000000000)}`,
    );
    expect(text).not.toContain("/repo/work");
  });
});

function interviewSegment(
  id: string,
  status: InterviewSegment["status"],
): InterviewSegment {
  return {
    id,
    kind: "interview",
    status,
    toolName: "AskUserQuestion",
    title: null,
    description: null,
    questions: [
      {
        questionId: "q1",
        question: "Where should this deploy?",
        header: null,
        options: [],
        multiSelect: false,
      },
    ],
    answers:
      status === "errored"
        ? []
        : [
            {
              questionId: "q1",
              question: "Where should this deploy?",
              values: ["Staging"],
              notes: null,
              selection: null,
            },
          ],
    draftAnswers: [],
    outcome: status === "errored" ? "failed" : "answered",
    settlement: null,
    error: status === "errored" ? "Provider stopped" : null,
    delivery: null,
    forkedWithoutAnswer: false,
  };
}

function rowSearchText(row: ChatFindRow): string {
  return row.units.map((unit) => unit.text).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
