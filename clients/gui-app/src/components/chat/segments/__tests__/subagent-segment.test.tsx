import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMeasuredItemChangeContext } from "@/components/chat/chat-measured-item-change-context";
import { SubagentSegment } from "@/components/chat/segments/subagent-segment";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";

describe("<SubagentSegment /> promoted feed", () => {
  beforeEach(() => {
    useSubagentOpenStore.setState({ openIds: new Set() });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows only the latest progress line collapsed, full history expanded", () => {
    render(
      <SubagentSegment
        id="test-segment-1"
        name="reviewer"
        task="Review the implementation"
        progressUpdates={["one", "two", "three", "four", "five", "six"]}
        result={null}
        isStreaming
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    // Collapsed: only the most recent line, nothing else.
    expect(screen.getByText("six")).toBeTruthy();
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.queryByText("five")).toBeNull();
    // Task is never shown collapsed.
    expect(screen.queryByText("Review the implementation")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    for (const line of ["one", "two", "three", "four", "five"]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    // The latest line shows in both the header summary and the history list.
    expect(screen.getAllByText("six").length).toBe(2);
  });

  it("shows a starting state before progress arrives", () => {
    render(
      <SubagentSegment
        id="test-segment-2"
        name="reviewer"
        task="Review the implementation"
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    expect(screen.getByText("Starting…")).toBeTruthy();
  });

  it("requests measured item-change when promoted card toggles", () => {
    const requestMeasuredItemChange = vi.fn();
    render(
      <ChatMeasuredItemChangeContext.Provider value={requestMeasuredItemChange}>
        <SubagentSegment
          id="test-segment-measured-change"
          name="reviewer"
          task="Review the implementation"
          progressUpdates={["one", "two"]}
          result={null}
          isStreaming
          endState={null}
          startedAt={null}
          durationMs={null}
          agentType={null}
          variant="promoted"
        />
      </ChatMeasuredItemChangeContext.Provider>,
    );

    const trigger = screen.getByRole("button", { name: /Subagent/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(requestMeasuredItemChange).toHaveBeenCalledTimes(2);
  });

  it("requests measured item-change through the shared card shell", () => {
    const requestMeasuredItemChange = vi.fn();
    render(
      <ChatMeasuredItemChangeContext.Provider value={requestMeasuredItemChange}>
        <SubagentSegment
          id="test-segment-card-measured-change"
          name="reviewer"
          task="Review the implementation"
          progressUpdates={["one", "two"]}
          result={null}
          isStreaming
          endState={null}
          startedAt={null}
          durationMs={null}
          agentType={null}
          variant="card"
        />
      </ChatMeasuredItemChangeContext.Provider>,
    );

    const trigger = screen.getByRole("button", { name: /reviewer/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(requestMeasuredItemChange).toHaveBeenCalledTimes(2);
  });

  it("shows the cleaned task only when expanded, never as the collapsed line", () => {
    render(
      <SubagentSegment
        id="test-segment-task-notification"
        name="codex-cli"
        task={[
          "<task-notification>",
          "<task-id>bd0xoyyo6</task-id>",
          "<summary>Monitor event: What's this project about?</summary>",
          "</task-notification>",
        ].join("\n")}
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    // Collapsed line is the live status, not the task.
    expect(screen.queryByText("What's this project about?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("What's this project about?")).toBeTruthy();
    expect(screen.queryByText(/task-id/)).toBeNull();
    expect(screen.queryByText(/Monitor event/)).toBeNull();
  });

  it("does not expose raw task-notification markup when the wrapper has attributes", () => {
    render(
      <SubagentSegment
        id="test-segment-task-notification-attrs"
        name="codex-cli"
        task={[
          '<task-notification kind="monitor">',
          "<task-id>bd0xoyyo6</task-id>",
          "<message>Monitor event: Inspect the failing suite</message>",
          "</task-notification>",
        ].join("\n")}
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("Inspect the failing suite")).toBeTruthy();
    expect(screen.queryByText(/task-notification/)).toBeNull();
    expect(screen.queryByText(/Monitor event/)).toBeNull();
  });

  it("collapses adjacent duplicate progress lines in the expanded history", () => {
    render(
      <SubagentSegment
        id="test-segment-3"
        name="reviewer"
        task="Review the implementation"
        progressUpdates={["Scanning", "Scanning", "Reading", "Scanning"]}
        result={null}
        isStreaming
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    // History keeps the two non-adjacent "Scanning" blocks (adjacent pair
    // collapsed); the header summary mirrors the latest line, so three total.
    expect(screen.getAllByText("Scanning")).toHaveLength(3);
    expect(screen.getByText("Reading")).toBeTruthy();
  });

  it("shows the result collapsed and full progress history when expanded", () => {
    render(
      <SubagentSegment
        id="test-segment-4"
        name="reviewer"
        task="Review the implementation"
        progressUpdates={["Step one", "Step two"]}
        result="Completed the review."
        isStreaming={false}
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    expect(screen.queryByText("Completed the review.")).toBeNull();
    expect(screen.queryByText("Step one")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("Progress")).toBeTruthy();
    expect(screen.getByText("Step one")).toBeTruthy();
    expect(screen.getByText("Step two")).toBeTruthy();
    expect(screen.getByText("Completed the review.")).toBeTruthy();
  });

  it("preserves open state across unmount and remount with same segment id", () => {
    const segmentId = "test-segment-persistent";

    const { unmount } = render(
      <SubagentSegment
        id={segmentId}
        name="reviewer"
        task="Review the implementation"
        progressUpdates={["Step one"]}
        result="Done."
        isStreaming={false}
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    expect(screen.queryByText("Progress")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("Progress")).toBeTruthy();

    unmount();

    render(
      <SubagentSegment
        id={segmentId}
        name="reviewer"
        task="Review the implementation"
        progressUpdates={["Step one"]}
        result="Done."
        isStreaming={false}
        endState={null}
        startedAt={null}
        durationMs={null}
        agentType={null}
        variant="promoted"
      />,
    );

    expect(screen.getByText("Progress")).toBeTruthy();
  });

  it("renders the agent type as a distinct title segment alongside the name", () => {
    render(
      <SubagentSegment
        id="test-agent-type"
        name="Godel"
        agentType="explorer"
        task="Investigate the auth flow"
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        startedAt={null}
        durationMs={null}
        variant="promoted"
      />,
    );

    // Title reads "Subagent · explorer · Godel · ..." (role CSS-capitalized).
    expect(screen.getByText("explorer")).toBeTruthy();
    expect(screen.getByText("Godel")).toBeTruthy();
  });

  it("shows a live elapsed timer while streaming", () => {
    // Fake the clock so the floored delta is exact (10s now - 5s start = 5s).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      render(
        <SubagentSegment
          id="test-elapsed-live"
          name="reviewer"
          agentType={null}
          task="Review the implementation"
          progressUpdates={["Scanning"]}
          result={null}
          isStreaming
          endState={null}
          startedAt={5_000}
          durationMs={null}
          variant="promoted"
        />,
      );

      expect(screen.getByText("5s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the total run duration once finished", () => {
    render(
      <SubagentSegment
        id="test-elapsed-total"
        name="reviewer"
        agentType={null}
        task="Review the implementation"
        progressUpdates={["Scanning"]}
        result="Done."
        isStreaming={false}
        endState={null}
        startedAt={1_000}
        durationMs={7_000}
        variant="promoted"
      />,
    );

    expect(screen.getByText("7s")).toBeTruthy();
  });

  it("floors the finished total to match the live tick (no +1 jump)", () => {
    render(
      <SubagentSegment
        id="test-elapsed-floor"
        name="reviewer"
        agentType={null}
        task="Review the implementation"
        progressUpdates={["Scanning"]}
        result="Done."
        isStreaming={false}
        endState={null}
        startedAt={0}
        durationMs={7_600}
        variant="promoted"
      />,
    );

    // 7.6s floors to "7s" (the last live value), not round-up "8s".
    expect(screen.getByText("7s")).toBeTruthy();
    expect(screen.queryByText("8s")).toBeNull();
  });

  it("clamps a sub-second finished run to 1s instead of showing 0s", () => {
    render(
      <SubagentSegment
        id="test-elapsed-subsecond"
        name="reviewer"
        agentType={null}
        task="Review the implementation"
        progressUpdates={["Scanning"]}
        result="Done."
        isStreaming={false}
        endState={null}
        startedAt={0}
        durationMs={300}
        variant="promoted"
      />,
    );

    expect(screen.getByText("1s")).toBeTruthy();
    expect(screen.queryByText("0s")).toBeNull();
  });

  it("shows no duration for an interrupted run, only the end-state badge", () => {
    render(
      <SubagentSegment
        id="test-elapsed-interrupted"
        name="reviewer"
        agentType={null}
        task="Review the implementation"
        progressUpdates={["Scanning"]}
        result={null}
        isStreaming={false}
        endState="interrupted"
        startedAt={1_000}
        durationMs={null}
        variant="promoted"
      />,
    );

    // A force-finalized card carries no (turn-end-inflated) duration; the
    // builder passes durationMs=null for non-completed blocks.
    expect(screen.queryByText(/^\d+s$/)).toBeNull();
  });
});
