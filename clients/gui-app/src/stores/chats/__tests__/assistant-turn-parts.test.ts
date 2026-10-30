import { describe, expect, it } from "vitest";
import type {
  MessageSegment,
  SubagentChildSegment,
} from "@/stores/composer/chat-store";
import {
  assistantTurnPartCuts,
  assistantTurnPartIndexOfSegment,
} from "@/stores/chats/assistant-turn-parts";

function textSegment(id: string): Extract<MessageSegment, { kind: "text" }> {
  return { id, kind: "text", markdown: `body of ${id}`, isStreaming: false };
}

function reasoningSegment(
  id: string,
): Extract<MessageSegment, { kind: "reasoning" }> {
  return {
    id,
    kind: "reasoning",
    markdown: "Thinking",
    isStreaming: false,
    durationMs: null,
  };
}

function toolSegment(
  id: string,
  toolName: string,
): Extract<MessageSegment, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    toolName,
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    agentMessageDelivery: null,
    botSendReceipt: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    imageResults: [],
    artifact: null,
    mcpApp: null,
    startedAt: 0,
    durationMs: null,
    parentId: null,
  };
}

function subagentSegment(
  id: string,
  children: ReadonlyArray<SubagentChildSegment>,
): Extract<MessageSegment, { kind: "subagent" }> {
  return {
    id,
    kind: "subagent",
    name: "reviewer",
    agentType: null,
    task: "Review the implementation",
    progressUpdates: [],
    result: "Found the issue.",
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId: null,
    workflowMeta: null,
    toolImageResults: [],
    children,
  };
}

describe("assistantTurnPartCuts", () => {
  it("stays unsplit for a turn with a single text block", () => {
    expect(assistantTurnPartCuts([textSegment("t0")])).toEqual([]);
  });

  it("cuts before a later text block, not before the first", () => {
    const segments = [
      textSegment("t0"),
      toolSegment("tool-0", "traycer-browser/repl"),
      textSegment("t1"),
    ];
    expect(assistantTurnPartCuts(segments)).toEqual(["t1"]);
  });

  it("cuts before text that follows activity even at the very start of the turn", () => {
    // The tool precedes t0, so t0 is not "nothing precedes it" - part 0 is
    // the tool alone and part 1 opens at the first text block.
    const segments = [
      toolSegment("tool-0", "traycer-browser/repl"),
      textSegment("t0"),
    ];
    expect(assistantTurnPartCuts(segments)).toEqual(["t0"]);
  });

  it("produces one cut per later text block, in order", () => {
    const segments = [
      textSegment("t0"),
      toolSegment("tool-0", "traycer-browser/repl"),
      textSegment("t1"),
      toolSegment("tool-1", "traycer-browser/repl"),
      textSegment("t2"),
    ];
    expect(assistantTurnPartCuts(segments)).toEqual(["t1", "t2"]);
  });

  it("is conservative: a leading run that draws nothing takes no cut before the first text", () => {
    // Reasoning alone draws no group (Layout > Chat > Thinking can hide it),
    // so the module must not assume anything preceded the first text.
    const segments = [reasoningSegment("r0"), textSegment("t0")];
    expect(assistantTurnPartCuts(segments)).toEqual([]);
  });

  it("is conservative about a hideable tool: an interview display tool alone before text takes no cut", () => {
    // isKnownInterviewDisplayToolName tools are dropped when the turn also
    // carries their interview - so, like reasoning, they cannot be assumed to
    // draw anything on their own.
    const segments = [
      toolSegment("tool-0", "AskUserQuestion"),
      textSegment("t0"),
    ];
    expect(assistantTurnPartCuts(segments)).toEqual([]);
  });

  it("never produces a part with zero segments, across a sweep of leading runs", () => {
    const leadingRuns: ReadonlyArray<ReadonlyArray<MessageSegment>> = [
      [],
      [reasoningSegment("r0")],
      [toolSegment("tool-0", "AskUserQuestion")],
      [reasoningSegment("r0"), toolSegment("tool-0", "AskUserQuestion")],
      [toolSegment("tool-0", "traycer-browser/repl")],
      [
        toolSegment("tool-0", "traycer-browser/repl"),
        subagentSegment("sub-0", []),
      ],
    ];
    for (const leading of leadingRuns) {
      const segments = [
        ...leading,
        textSegment("t0"),
        toolSegment("tool-mid", "traycer-browser/repl"),
        textSegment("t1"),
      ];
      const cuts = assistantTurnPartCuts(segments);
      const ranges: Array<{ from: number; to: number }> = [];
      let from = 0;
      for (const cutId of cuts) {
        const to = segments.findIndex((segment) => segment.id === cutId);
        ranges.push({ from, to });
        from = to;
      }
      ranges.push({ from, to: segments.length });
      for (const range of ranges) {
        expect(range.to).toBeGreaterThan(range.from);
      }
    }
  });

  it("is append-only while a turn streams: growing a turn's segments never changes an earlier cut", () => {
    const base = [
      textSegment("t0"),
      toolSegment("tool-0", "traycer-browser/repl"),
      textSegment("t1"),
    ];
    const baseCuts = assistantTurnPartCuts(base);

    const grown = [
      ...base,
      toolSegment("tool-1", "traycer-browser/repl"),
      textSegment("t2"),
    ];
    const grownCuts = assistantTurnPartCuts(grown);

    expect(grownCuts.slice(0, baseCuts.length)).toEqual(baseCuts);
    expect(grownCuts).toEqual([...baseCuts, "t2"]);
  });
});

describe("assistantTurnPartIndexOfSegment", () => {
  const segments = [
    textSegment("t0"),
    toolSegment("tool-0", "traycer-browser/repl"),
    textSegment("t1"),
    toolSegment("tool-1", "traycer-browser/repl"),
    textSegment("t2"),
  ];

  it("falls back to part 0 for a turn that never split", () => {
    expect(assistantTurnPartIndexOfSegment([textSegment("t0")], "t0")).toBe(0);
  });

  it("resolves a top-level id to the part that holds it", () => {
    expect(assistantTurnPartIndexOfSegment(segments, "t0")).toBe(0);
    expect(assistantTurnPartIndexOfSegment(segments, "tool-0")).toBe(0);
    expect(assistantTurnPartIndexOfSegment(segments, "t1")).toBe(1);
    expect(assistantTurnPartIndexOfSegment(segments, "tool-1")).toBe(1);
    expect(assistantTurnPartIndexOfSegment(segments, "t2")).toBe(2);
  });

  it("falls back to part 0 for an id the turn does not carry", () => {
    expect(assistantTurnPartIndexOfSegment(segments, "missing")).toBe(0);
  });

  it("resolves a block id nested inside a subagent's children to the part holding the subagent", () => {
    const nested = [
      textSegment("t0"),
      subagentSegment("sub-0", [
        toolSegment("child-tool", "traycer-browser/repl"),
      ]),
      textSegment("t1"),
    ];
    expect(assistantTurnPartIndexOfSegment(nested, "child-tool")).toBe(0);
    expect(assistantTurnPartIndexOfSegment(nested, "sub-0")).toBe(0);
  });

  it("resolves a nested id to a LATER part when its owning segment starts one", () => {
    const nested = [
      textSegment("t0"),
      toolSegment("tool-0", "traycer-browser/repl"),
      textSegment("t1"),
      subagentSegment("sub-1", [
        toolSegment("child-tool", "traycer-browser/repl"),
      ]),
    ];
    expect(assistantTurnPartIndexOfSegment(nested, "child-tool")).toBe(1);
  });
});
