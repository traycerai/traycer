import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  useSubagentDockView,
  type SubagentDrillIn,
} from "@/components/chat/segments/subagent-open-as-chat";
import type {
  ChatMessage as ChatMessageModel,
  SubagentSegment,
} from "@/stores/composer/chat-store";

function card(id: string, name: string): SubagentSegment {
  return {
    id,
    kind: "subagent",
    name,
    agentType: null,
    task: `${name} task`,
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
    children: [
      {
        id: `${id}-text`,
        kind: "text",
        markdown: `${id} words`,
        isStreaming: false,
        parentId: id,
      },
    ],
  };
}

function transcript(
  subagent: SubagentSegment,
): ReadonlyArray<ChatMessageModel> {
  return [{ ...makeMessage(1, "assistant"), segments: [subagent] }];
}

function command(taskId: string, blockId: string): BackgroundItem {
  return {
    taskId,
    kind: "command",
    title: `Command ${taskId}`,
    blockId,
    parentTaskId: null,
    scheduledFor: null,
    individualStopUnavailable: null,
  };
}

function drillIn(openId: string | null, close: () => void): SubagentDrillIn {
  return { openId, open: vi.fn(), close };
}

interface HookProps {
  readonly drill: SubagentDrillIn;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly items: ReadonlyArray<BackgroundItem> | undefined;
}

function renderDockView(initial: HookProps) {
  return renderHook(
    (props: HookProps) =>
      useSubagentDockView(props.drill, props.messages, props.items),
    { initialProps: initial },
  );
}

describe("useSubagentDockView", () => {
  it("is null while no subagent conversation is open", () => {
    const close = vi.fn<() => void>();
    const { result } = renderDockView({
      drill: drillIn(null, close),
      messages: transcript(card("mendel", "Mendel")),
      items: [command("task-1", "mendel-text")],
    });

    expect(result.current).toBeNull();
  });

  it("carries the open card's name, owned running count and close", () => {
    const close = vi.fn<() => void>();
    const { result } = renderDockView({
      drill: drillIn("mendel", close),
      messages: transcript(card("mendel", "Mendel")),
      items: [
        command("task-own", "mendel"),
        command("task-owned", "mendel-text"),
        command("task-other", "other-block"),
      ],
    });

    expect(result.current).toEqual({
      name: "Mendel",
      runningCount: 1,
      close,
    });
  });

  it("counts zero while the background items have not loaded", () => {
    const close = vi.fn<() => void>();
    const { result } = renderDockView({
      drill: drillIn("mendel", close),
      messages: transcript(card("mendel", "Mendel")),
      items: undefined,
    });

    expect(result.current).toEqual({ name: "Mendel", runningCount: 0, close });
  });

  it("has no name when the open id is not in the loaded messages", () => {
    const close = vi.fn<() => void>();
    const { result } = renderDockView({
      drill: drillIn("gone", close),
      messages: transcript(card("mendel", "Mendel")),
      items: [command("task-owned", "mendel-text")],
    });

    expect(result.current).toEqual({ name: null, runningCount: 0, close });
  });

  it("keeps the same object across a streamed update that changes nothing it shows", () => {
    const close = vi.fn<() => void>();
    const items = [command("task-owned", "mendel-text")];
    const { result, rerender } = renderDockView({
      drill: drillIn("mendel", close),
      messages: transcript(card("mendel", "Mendel")),
      items,
    });
    const before = result.current;

    // A new messages array holding an equal-valued new card object, new items
    // array with equal contents and a new drill-in wrapper around the same
    // close: what every streamed token produces.
    rerender({
      drill: drillIn("mendel", close),
      messages: transcript(card("mendel", "Mendel")),
      items: [command("task-owned", "mendel-text")],
    });

    expect(before).not.toBeNull();
    expect(result.current).toBe(before);
  });

  it("returns a new object once the running count changes", () => {
    const close = vi.fn<() => void>();
    const messages = transcript(card("mendel", "Mendel"));
    const { result, rerender } = renderDockView({
      drill: drillIn("mendel", close),
      messages,
      items: [],
    });
    const before = result.current;

    rerender({
      drill: drillIn("mendel", close),
      messages,
      items: [command("task-owned", "mendel-text")],
    });

    expect(result.current).not.toBe(before);
    expect(result.current).toEqual({ name: "Mendel", runningCount: 1, close });
  });

  it("returns a new object once the card's name changes", () => {
    const close = vi.fn<() => void>();
    const { result, rerender } = renderDockView({
      drill: drillIn("mendel", close),
      messages: transcript(card("mendel", "Mendel")),
      items: [],
    });
    const before = result.current;

    rerender({
      drill: drillIn("mendel", close),
      messages: transcript(card("mendel", "Mendel the second")),
      items: [],
    });

    expect(result.current).not.toBe(before);
    expect(result.current?.name).toBe("Mendel the second");
  });
});
