import "../../../../__tests__/test-browser-apis";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChatFindRows,
  type ChatFindRow,
  chatFindSubagentBodyUnitId,
  chatFindSubagentHeaderUnitId,
  createChatFindAdapter,
  markdownToChatSearchText,
} from "@/components/chat/chat-find";
import {
  type ChatCollapsibleKey,
  derivePromotedSubagentRenderId,
} from "@/components/chat/chat-collapsible-key";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import { makeMessage } from "./chat-message-fixtures";

class TestHighlight {
  readonly ranges: ReadonlyArray<Range>;

  constructor(...ranges: ReadonlyArray<Range>) {
    this.ranges = ranges;
  }
}

interface MockHighlightRegistry {
  readonly values: ReadonlyMap<string, TestHighlight>;
  readonly setCalls: ReadonlyArray<string>;
}

let restoreHighlights: (() => void) | null = null;
let restoreFrames: (() => void) | null = null;
const TILE_INSTANCE_ID = "chat-find-test-tile";

beforeEach(() => {
  restoreFrames = installFrameQueue();
});

afterEach(() => {
  restoreFrames?.();
  restoreFrames = null;
  restoreHighlights?.();
  restoreHighlights = null;
  vi.restoreAllMocks();
});

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

    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-approval",
      revealMatch: vi.fn(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows(
      buildChatFindRows([topLevel, grouped], TILE_INSTANCE_ID),
    );

    // Both rendered headers index the toolName label, so it stays findable at
    // both sites (one match per header, no group-summary noise).
    void adapter.search({ requestId: 1, query: toolName, matchCase: false });
    expect(adapter.getSnapshot().total).toBe(2);

    // The verdict is part of the rendered header too, so it remains findable.
    void adapter.search({ requestId: 2, query: "Denied", matchCase: false });
    expect(adapter.getSnapshot().total).toBeGreaterThanOrEqual(2);

    // The description lives only in the unanchored approval body
    // (bodyFindUnitId=null). Before the fix both projection sites indexed it,
    // counting a phantom match that can never paint; it must now find nothing.
    void adapter.search({
      requestId: 3,
      query: descriptionOnly,
      matchCase: false,
    });
    expect(adapter.getSnapshot().total).toBe(0);
  });
});

describe("chat find adapter", () => {
  it("counts projection matches and reports pending when the row is not mounted", () => {
    const revealMatch = vi.fn();
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-a",
      revealMatch,
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows([
      testRow("row-1", "unit-1", "alpha beta alpha"),
      testRow("row-2", "unit-2", "gamma"),
    ]);

    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });

    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 1,
      status: "ready",
      current: 1,
      total: 2,
      activeUnitId: "unit-1",
      exactHighlight: "pending",
    });
    expect(revealMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "unit-1",
      }),
    );
  });

  it("scrolls to an offscreen match and paints after the row mounts", () => {
    const registry = installMockHighlights();
    const mountedRows = new Map<string, HTMLElement>();
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-b",
      revealMatch: vi.fn(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: (messageId) => mountedRows.get(messageId) ?? null,
      getMountedUnitRoot: (messageId, unitId) =>
        mountedRows
          .get(messageId)
          ?.querySelector<HTMLElement>(`[data-unit-id="${unitId}"]`) ?? null,
    });
    adapter.updateRows([
      testRow("visible-row", "visible-unit", "ordinary text"),
      testRow("offscreen-row", "offscreen-unit", "needle text"),
    ]);

    void adapter.search({ requestId: 2, query: "needle", matchCase: false });
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    const row = document.createElement("div");
    row.dataset.messageId = "offscreen-row";
    const unit = document.createElement("div");
    unit.dataset.unitId = "offscreen-unit";
    unit.textContent = "needle text";
    row.append(unit);
    mountedRows.set("offscreen-row", row);
    adapter.syncMountedHighlight();
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    expect(activeEntry).not.toBeUndefined();
    const activeRange = activeEntry?.[1].ranges[0];
    expect(activeRange?.startContainer.parentElement).toBe(unit);
  });

  it("paints visible content-bearing header text inside buttons", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.dataset.findInclude = "true";
    const label = document.createElement("span");
    label.textContent = "Ran 1 command";
    trigger.append(label);
    const control = document.createElement("button");
    control.textContent = "Copy reply";
    row.append(trigger);
    row.append(control);
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-header",
      revealMatch: (target) => target.paint(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => trigger,
    });
    adapter.updateRows([testRow("row-1", "header-unit", "Ran 1 command")]);

    void adapter.search({ requestId: 3, query: "Ran", matchCase: false });
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    expect(activeEntry).not.toBeUndefined();
    const activeRange = activeEntry?.[1].ranges[0];
    expect(activeRange?.startContainer.parentElement).toBe(label);

    adapter.updateRows([
      testRow("row-1", "header-unit", "Ran 1 command Copy reply"),
    ]);
    void adapter.search({
      requestId: 4,
      query: "Copy reply",
      matchCase: false,
    });
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
  });

  it("scrolls the active match element into view on reveal but not on passive repaint", () => {
    installMockHighlights();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const row = document.createElement("div");
    // Mirrors a subagent/A2A body: the unit anchor wraps a height-capped inner
    // scroll container, and the match sits below its fold.
    const unit = document.createElement("div");
    const matchLine = document.createElement("p");
    matchLine.textContent = "needle below the fold";
    unit.append(matchLine);
    row.append(unit);
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-inner-scroll",
      revealMatch: (target) => target.paint(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => unit,
    });
    adapter.updateRows([testRow("row-1", "unit-1", "needle below the fold")]);

    void adapter.search({ requestId: 7, query: "needle", matchCase: false });
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    // Reveal scrolls the match's own element, walking every scroll ancestor
    // (the card's inner overflow-auto container included).
    expect(scrollIntoView.mock.instances).toContain(matchLine);

    // A passive re-sync (streaming/rendered-data change) repaints without
    // yanking the scroll position.
    scrollIntoView.mockClear();
    adapter.syncMountedHighlight();
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a missing exact DOM occurrence pending instead of clamping to another range", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    const unit = document.createElement("div");
    unit.textContent = "needle";
    row.append(unit);
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-exact-occurrence",
      revealMatch: (target) => target.paint(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => unit,
    });
    adapter.updateRows([testRow("row-1", "unit-1", "needle needle")]);

    void adapter.search({ requestId: 5, query: "needle", matchCase: false });
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");

    void adapter.next();

    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    expect(activeEntry).toBeUndefined();
  });

  it("can degrade a missing unit anchor to message-root paint when reveal falls back", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    row.textContent = "fallback needle";
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-anchor-fallback",
      revealMatch: (target) => target.paintFallback(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows([testRow("row-1", "missing-unit", "fallback needle")]);

    void adapter.search({
      requestId: 6,
      query: "needle",
      matchCase: false,
    });

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
    const activeRange = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    )?.[1].ranges[0];
    expect(activeRange?.startContainer.parentElement).toBe(row);
  });

  it("paints the message-scoped occurrence when reveal degrades to message root", () => {
    const registry = installMockHighlights();
    const row = document.createElement("div");
    const earlier = document.createElement("p");
    earlier.textContent = "needle one";
    const target = document.createElement("p");
    target.textContent = "needle two";
    row.append(earlier);
    row.append(target);
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-message-fallback",
      // The unit anchor never mounts, so every reveal degrades to the
      // message-root paint that walks BOTH units.
      revealMatch: (target_) => target_.paintFallback(),
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows([
      {
        messageId: "row-1",
        units: [
          { unitId: "earlier-unit", text: "needle one", owningChain: [] },
          { unitId: "target-unit", text: "needle two", owningChain: [] },
        ],
      },
    ]);

    // First match: earlier unit, message occurrence 0 -> the first DOM range.
    void adapter.search({ requestId: 10, query: "needle", matchCase: false });
    expect(activeHighlightParent(registry)).toBe(earlier);

    // Second match: the target unit. Its per-unit ordinal is 0, but its
    // message-wide ordinal is 1 - the fallback must paint the SECOND DOM
    // occurrence, not re-highlight the earlier matching unit.
    void adapter.next();
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "target-unit",
    });
    expect(activeHighlightParent(registry)).toBe(target);
  });

  it("prevents stale highlight work from overwriting a newer query", () => {
    installMockHighlights();
    const row = document.createElement("div");
    row.textContent = "old newer";
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-c",
      revealMatch: (target) => {
        window.requestAnimationFrame(() => target.paint());
      },
      reconcileMatch: vi.fn(),
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => row,
      getMountedUnitRoot: () => row,
    });
    adapter.updateRows([testRow("row-1", "unit-1", "old newer")]);

    void adapter.search({ requestId: 1, query: "old", matchCase: false });
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    void adapter.search({ requestId: 2, query: "missing", matchCase: false });
    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 2,
      query: "missing",
      total: 0,
      exactHighlight: "none",
    });
    flushFrames();

    expect(adapter.getSnapshot()).toMatchObject({
      requestId: 2,
      query: "missing",
      total: 0,
      exactHighlight: "none",
    });
  });

  it("preserves the active streaming match by unit occurrence as totals grow", () => {
    const revealMatch = vi.fn();
    const reconcileMatch = vi.fn();
    const chain = [testCollapsibleKey("subagent", "streaming-subagent")];
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-streaming-identity",
      revealMatch,
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows([
      testRowWithChain(
        "row-1",
        "streaming-unit",
        "prefix needle before needle active",
        chain,
      ),
    ]);
    void adapter.search({ requestId: 7, query: "needle", matchCase: false });
    void adapter.next();

    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "streaming-unit",
    });

    reconcileMatch.mockClear();
    adapter.updateRows([
      testRowWithChain(
        "row-1",
        "streaming-unit",
        "prefix needle before inserted streaming text needle active needle tail",
        chain,
      ),
    ]);

    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 3,
      activeUnitId: "streaming-unit",
    });
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "streaming-unit",
        matchKey: "row-1:streaming-unit:1",
      }),
    );
    expect(revealMatch).toHaveBeenCalledTimes(2);
  });

  it("keeps the active match when a streamed query insert lands before it in a concatenated unit", () => {
    const revealMatch = vi.fn();
    const reconcileMatch = vi.fn();
    const chain = [testCollapsibleKey("subagent", "streaming-body")];
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-streaming-insert",
      revealMatch,
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    // One concatenated body unit (task + progress + result). The only match is
    // the occurrence in the trailing "result" text.
    adapter.updateRows([
      testRowWithChain(
        "row-1",
        "body-unit",
        "task line result needle here",
        chain,
      ),
    ]);
    void adapter.search({ requestId: 11, query: "needle", matchCase: false });
    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: "body-unit",
    });

    reconcileMatch.mockClear();
    // A streamed progress line containing the query streams in BEFORE the active
    // occurrence. Its per-unit ordinal shifts 0 -> 1, so the old exact-ordinal
    // identity would have yanked the active match onto the inserted occurrence.
    adapter.updateRows([
      testRowWithChain(
        "row-1",
        "body-unit",
        "task line needle progress result needle here",
        chain,
      ),
    ]);

    // The active match stays on the original (now second) occurrence.
    expect(adapter.getSnapshot()).toMatchObject({
      current: 2,
      total: 2,
      activeUnitId: "body-unit",
    });
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "body-unit",
        matchKey: "row-1:body-unit:1",
      }),
    );
    // Streaming rescans reconcile in place; no second navigation occurs.
    expect(revealMatch).toHaveBeenCalledTimes(1);
  });

  it("reconciles an active chain change on rescan without navigating", () => {
    const revealMatch = vi.fn();
    const reconcileMatch = vi.fn();
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-rescan-chain",
      revealMatch,
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    const firstChain = [testCollapsibleKey("activity-group", "activity:old")];
    const nextChain = [testCollapsibleKey("subagent", "promoted:subagent")];
    adapter.updateRows([
      testRowWithChain("row-1", "unit-1", "needle", firstChain),
    ]);
    void adapter.search({ requestId: 8, query: "needle", matchCase: false });

    revealMatch.mockClear();
    adapter.updateRows([
      testRowWithChain("row-1", "unit-1", "needle", nextChain),
    ]);

    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: "unit-1",
    });
    expect(revealMatch).not.toHaveBeenCalled();
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-1",
        unitId: "unit-1",
        owningChain: nextChain,
      }),
    );
  });

  it("reconciles to the fallback active match when the previous unit disappears", () => {
    const reconcileMatch = vi.fn();
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-rescan-release",
      revealMatch: vi.fn(),
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows([
      testRowWithChain("row-1", "removed-unit", "needle", [
        testCollapsibleKey("subagent", "removed-subagent"),
      ]),
      testRow("row-2", "visible-unit", "needle"),
    ]);
    void adapter.search({ requestId: 9, query: "needle", matchCase: false });

    reconcileMatch.mockClear();
    adapter.updateRows([
      testRowWithChain("row-1", "removed-unit", "no remaining target", [
        testCollapsibleKey("subagent", "removed-subagent"),
      ]),
      testRow("row-2", "visible-unit", "needle"),
    ]);

    expect(adapter.getSnapshot()).toMatchObject({
      current: 1,
      total: 1,
      activeUnitId: "visible-unit",
    });
    expect(reconcileMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "row-2",
        unitId: "visible-unit",
        owningChain: [],
      }),
    );
  });

  it("ends scanning after clear so post-close streaming does no projection work", () => {
    const reconcileMatch = vi.fn();
    const adapter = createChatFindAdapter({
      tileInstanceId: "chat-tile-clear",
      revealMatch: vi.fn(),
      reconcileMatch,
      clearReveal: vi.fn(),
      getMountedMessageRoot: () => null,
      getMountedUnitRoot: () => null,
    });
    adapter.updateRows([testRow("row-1", "unit-1", "alpha beta alpha")]);
    void adapter.search({ requestId: 1, query: "alpha", matchCase: false });
    expect(adapter.getSnapshot().total).toBe(2);

    adapter.clear();
    expect(adapter.getSnapshot()).toMatchObject({
      query: "",
      total: 0,
      status: "idle",
    });

    reconcileMatch.mockClear();
    // Simulate streaming tokens after the bar closed: updateRows runs from a
    // layout effect on every messages change. With scanning ended it must not
    // re-run findMatches, so matches stay empty and nothing is reconciled.
    adapter.updateRows([
      testRow("row-1", "unit-1", "alpha alpha alpha"),
      testRow("row-2", "unit-2", "alpha"),
    ]);
    expect(adapter.getSnapshot().total).toBe(0);
    expect(adapter.getSnapshot().query).toBe("");
    expect(reconcileMatch).not.toHaveBeenCalled();

    // Reopening still works: a fresh search scans the current rows again.
    void adapter.search({ requestId: 2, query: "alpha", matchCase: false });
    expect(adapter.getSnapshot().total).toBe(4);
  });
});

function activeHighlightParent(
  registry: MockHighlightRegistry,
): Element | null {
  const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
    name.includes("active"),
  );
  return activeEntry?.[1].ranges[0]?.startContainer.parentElement ?? null;
}

function rowSearchText(row: ChatFindRow): string {
  return row.units.map((unit) => unit.text).join("\n");
}

function testRow(messageId: string, unitId: string, text: string): ChatFindRow {
  return testRowWithChain(messageId, unitId, text, []);
}

function testRowWithChain(
  messageId: string,
  unitId: string,
  text: string,
  owningChain: ReadonlyArray<ChatCollapsibleKey>,
): ChatFindRow {
  return {
    messageId,
    units: [
      {
        unitId,
        text,
        owningChain,
      },
    ],
  };
}

function testCollapsibleKey(
  kind: ChatCollapsibleKey["kind"],
  id: string,
): ChatCollapsibleKey {
  return {
    tileInstanceId: TILE_INSTANCE_ID,
    kind,
    id,
  };
}

function installMockHighlights(): MockHighlightRegistry {
  const globalWithHighlights: {
    readonly CSS?: typeof CSS;
    readonly Highlight?: typeof Highlight;
  } = globalThis;
  const previousCss = globalWithHighlights.CSS;
  const previousHighlight = globalWithHighlights.Highlight;
  const values = new Map<string, TestHighlight>();
  const setCalls: string[] = [];
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: TestHighlight,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      highlights: {
        set: (name: string, highlight: TestHighlight) => {
          setCalls.push(name);
          values.set(name, highlight);
        },
        delete: (name: string) => {
          values.delete(name);
        },
      },
    },
  });
  restoreHighlights = () => {
    if (previousCss === undefined) Reflect.deleteProperty(globalThis, "CSS");
    else {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        writable: true,
        value: previousCss,
      });
    }
    if (previousHighlight === undefined) {
      Reflect.deleteProperty(globalThis, "Highlight");
    } else {
      Object.defineProperty(globalThis, "Highlight", {
        configurable: true,
        writable: true,
        value: previousHighlight,
      });
    }
  };
  return { values, setCalls };
}

function installFrameQueue(): () => void {
  const frames: FrameRequestCallback[] = [];
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      const index = id - 1;
      frames[index] = () => undefined;
    });
  flushFrames = () => {
    const pending = frames.splice(0, frames.length);
    pending.forEach((callback) => callback(performance.now()));
  };
  return () => {
    request.mockRestore();
    cancel.mockRestore();
    flushFrames = () => undefined;
  };
}

let flushFrames: () => void = () => undefined;
