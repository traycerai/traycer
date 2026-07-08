import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMeasuredItemChangeContext } from "@/components/chat/chat-measured-item-change-context";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { deriveSubagentCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { chatFindSubagentHeaderUnitId } from "@/components/chat/chat-find";
import { SubagentSegment } from "@/components/chat/segments/subagent-segment";
import {
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
  useChatCollapsibleTileInstanceId,
} from "@/stores/chats/chat-find-force-store-context";
import type { SubagentSegment as SubagentSegmentModel } from "@/stores/composer/chat-store";

function clickTriggerFor(text: string): void {
  const button = screen.getByText(text).closest("button");
  if (button === null) {
    throw new Error(`expected a button trigger ancestor for "${text}"`);
  }
  fireEvent.click(button);
}

function nestedAgentFixture(
  overrides: Partial<SubagentSegmentModel>,
): SubagentSegmentModel {
  return {
    id: "nested-agent",
    kind: "subagent",
    name: "nested-agent",
    agentType: null,
    task: "Investigate nested work.",
    progressUpdates: [],
    result: null,
    isStreaming: true,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId: null,
    workflowMeta: null,
    children: [],
    ...overrides,
  };
}

function render(ui: ReactNode) {
  return rtlRender(
    <ChatExpansionTestProviders tileInstanceId="subagent-test-tile">
      {ui}
    </ChatExpansionTestProviders>,
  );
}

interface SubagentPersistenceHarnessProps {
  readonly segmentId: string;
  readonly visible: boolean;
}

function SubagentPersistenceHarness(props: SubagentPersistenceHarnessProps) {
  if (!props.visible) return null;
  return (
    <SubagentSegment
      id={props.segmentId}
      name="reviewer"
      task="Review the implementation"
      progressUpdates={["Step one"]}
      result="Done."
      isStreaming={false}
      endState={null}
      stopped={false}
      startedAt={null}
      durationMs={null}
      agentType={null}
      workflowMeta={null}
      nested={[]}
      variant="promoted"
    />
  );
}

interface ForceSubagentOpenButtonProps {
  readonly label: string;
  readonly renderId: string;
}

function ForceSubagentOpenButton(props: ForceSubagentOpenButtonProps) {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const key = deriveSubagentCollapsibleKey(tileInstanceId, props.renderId);
  return (
    <button type="button" onClick={() => setFindForcedOpen(key, true)}>
      {props.label}
    </button>
  );
}

interface FindForceStatusProps {
  readonly renderId: string;
}

function FindForceStatus(props: FindForceStatusProps) {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const key = deriveSubagentCollapsibleKey(tileInstanceId, props.renderId);
  const forced = useChatFindForcedOpen(key);
  return <span>{forced ? "forced" : "released"}</span>;
}

describe("<SubagentSegment /> promoted feed", () => {
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    expect(screen.getByText("Starting…")).toBeTruthy();
  });

  it("skips ephemeral header chrome from find highlighting but keeps name and type findable", () => {
    render(
      <SubagentSegment
        id="subagent-header-skip"
        name="Scanner"
        task="Scan the repo"
        progressUpdates={["Scanning"]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType="analysis"
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    // Name + agent type are projected/indexed, so they must stay highlightable
    // (no data-find-skip ancestor).
    expect(screen.getByText("Scanner").closest("[data-find-skip]")).toBeNull();
    expect(screen.getByText("analysis").closest("[data-find-skip]")).toBeNull();

    // The latest-progress header mirror duplicates the body's last progress line
    // (see "shows ... in both the header summary and the history list" above).
    // The projection does not index it, so it must be skipped by the highlighter
    // to keep count == highlightable.
    expect(
      screen.getByText("Scanning").closest("[data-find-skip]"),
    ).not.toBeNull();
  });

  it("skips the promoted live elapsed timer and Starting placeholder from highlighting", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      render(
        <SubagentSegment
          id="subagent-header-skip-elapsed"
          name="Probe"
          task="Scan the repo"
          progressUpdates={[]}
          result={null}
          isStreaming
          endState={null}
          stopped={false}
          startedAt={5_000}
          durationMs={null}
          agentType={null}
          workflowMeta={null}
          nested={[]}
          variant="promoted"
        />,
      );

      // Name stays findable; the elapsed timer and the "Starting…" mirror are
      // ephemeral chrome the projection never indexes, so both are skipped.
      const name = screen.getByText("Probe");
      expect(name.closest("[data-find-skip]")).toBeNull();
      expect(name.closest("button")).not.toBeNull();
      expect(screen.getByText("5s").closest("[data-find-skip]")).not.toBeNull();
      expect(
        screen.getByText("Starting…").closest("[data-find-skip]"),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the promoted end-state badge from highlighting", () => {
    render(
      <SubagentSegment
        id="subagent-header-skip-badge"
        name="Probe"
        task="Scan the repo"
        progressUpdates={["Scanning"]}
        result={null}
        isStreaming={false}
        endState="interrupted"
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    const name = screen.getByText("Probe");
    expect(name.closest("[data-find-skip]")).toBeNull();
    expect(name.closest("button")).not.toBeNull();
    expect(
      screen.getByText("stopped").closest("[data-find-skip]"),
    ).not.toBeNull();
  });

  it("skips the compact card header mirror and elapsed timer, keeping the name findable", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      render(
        <SubagentSegment
          id="subagent-card-header-skip"
          name="Probe"
          task="Scan the repo"
          progressUpdates={["Scanning"]}
          result={null}
          isStreaming
          endState={null}
          stopped={false}
          startedAt={5_000}
          durationMs={null}
          agentType="analysis"
          workflowMeta={null}
          nested={[]}
          variant="card"
        />,
      );

      // Name + type stay highlightable; the collapsed summary mirror and elapsed
      // timer in the compact header are skipped, matching the promoted variant.
      const name = screen.getByText("Probe");
      expect(name.closest("[data-find-skip]")).toBeNull();
      expect(name.closest("button")).not.toBeNull();
      expect(
        screen.getByText("analysis").closest("[data-find-skip]"),
      ).toBeNull();
      expect(
        screen.getByText("Scanning").closest("[data-find-skip]"),
      ).not.toBeNull();
      expect(screen.getByText("5s").closest("[data-find-skip]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the compact card end-state badge from highlighting", () => {
    render(
      <SubagentSegment
        id="subagent-card-header-skip-badge"
        name="Probe"
        task="Scan the repo"
        progressUpdates={[]}
        result={null}
        isStreaming={false}
        endState="superseded"
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
        variant="card"
      />,
    );

    const name = screen.getByText("Probe");
    expect(name.closest("[data-find-skip]")).toBeNull();
    expect(name.closest("button")).not.toBeNull();
    expect(
      screen.getByText("superseded").closest("[data-find-skip]"),
    ).not.toBeNull();
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
          stopped={false}
          startedAt={null}
          durationMs={null}
          agentType={null}
          workflowMeta={null}
          nested={[]}
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
          stopped={false}
          startedAt={null}
          durationMs={null}
          agentType={null}
          workflowMeta={null}
          nested={[]}
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        agentType={null}
        workflowMeta={null}
        nested={[]}
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

    const { rerender } = rtlRender(
      <ChatExpansionTestProviders tileInstanceId="subagent-test-tile">
        <SubagentPersistenceHarness segmentId={segmentId} visible />
      </ChatExpansionTestProviders>,
    );

    expect(screen.queryByText("Progress")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("Progress")).toBeTruthy();

    rerender(
      <ChatExpansionTestProviders tileInstanceId="subagent-test-tile">
        <SubagentPersistenceHarness segmentId={segmentId} visible={false} />
      </ChatExpansionTestProviders>,
    );
    rerender(
      <ChatExpansionTestProviders tileInstanceId="subagent-test-tile">
        <SubagentPersistenceHarness segmentId={segmentId} visible />
      </ChatExpansionTestProviders>,
    );

    expect(screen.getByText("Progress")).toBeTruthy();
  });

  it("opens from find-force and releases force on manual collapse", () => {
    const segmentId = "test-segment-find-forced";
    render(
      <>
        <ForceSubagentOpenButton label="Force subagent" renderId={segmentId} />
        <FindForceStatus renderId={segmentId} />
        <SubagentSegment
          id={segmentId}
          name="reviewer"
          task="Find-forced task"
          progressUpdates={["Step one"]}
          result="Done."
          isStreaming={false}
          endState={null}
          stopped={false}
          startedAt={null}
          durationMs={null}
          agentType={null}
          workflowMeta={null}
          nested={[]}
          variant="promoted"
        />
      </>,
    );

    expect(screen.queryByText("Find-forced task")).toBeNull();
    expect(screen.getByText("released")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Force subagent" }));

    expect(screen.getByText("Find-forced task")).toBeTruthy();
    expect(screen.getByText("forced")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.queryByText("Find-forced task")).toBeNull();
    expect(screen.getByText("released")).toBeTruthy();
  });

  it("keeps find-force scoped to the tile provider", () => {
    const segmentId = "shared-subagent-id";
    rtlRender(
      <div>
        <ChatExpansionTestProviders tileInstanceId="tile-a">
          <ForceSubagentOpenButton
            label="Force tile A subagent"
            renderId={segmentId}
          />
          <SubagentSegment
            id={segmentId}
            name="reviewer"
            task="Tile A task"
            progressUpdates={[]}
            result="Tile A result"
            isStreaming={false}
            endState={null}
            stopped={false}
            startedAt={null}
            durationMs={null}
            agentType={null}
            workflowMeta={null}
            nested={[]}
            variant="promoted"
          />
        </ChatExpansionTestProviders>
        <ChatExpansionTestProviders tileInstanceId="tile-b">
          <SubagentSegment
            id={segmentId}
            name="reviewer"
            task="Tile B task"
            progressUpdates={[]}
            result="Tile B result"
            isStreaming={false}
            endState={null}
            stopped={false}
            startedAt={null}
            durationMs={null}
            agentType={null}
            workflowMeta={null}
            nested={[]}
            variant="promoted"
          />
        </ChatExpansionTestProviders>
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Force tile A subagent" }),
    );

    expect(screen.getByText("Tile A task")).toBeTruthy();
    expect(screen.queryByText("Tile B task")).toBeNull();
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
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    // Title reads "Subagent · explorer · Godel · ..." (role CSS-capitalized).
    expect(screen.getByText("explorer")).toBeTruthy();
    expect(screen.getByText("Godel")).toBeTruthy();
  });

  it("anchors the always-visible header (name + type) to the header find unit", () => {
    render(
      <SubagentSegment
        id="test-header-anchor"
        name="Godel"
        agentType="explorer"
        task="Investigate the auth flow"
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    const trigger = screen.getByRole("button", { name: /Subagent/ });
    // The name + agent type render inside the always-visible header trigger, and
    // that trigger carries the header find-unit anchor so the painter can target
    // it without expanding the body.
    expect(trigger.getAttribute("data-chat-find-unit")).toBe(
      chatFindSubagentHeaderUnitId("test-header-anchor"),
    );
    expect(trigger.textContent).toContain("Godel");
    expect(trigger.textContent).toContain("explorer");
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
          stopped={false}
          startedAt={5_000}
          durationMs={null}
          workflowMeta={null}
          nested={[]}
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
        stopped={false}
        startedAt={1_000}
        durationMs={7_000}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={0}
        durationMs={7_600}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={0}
        durationMs={300}
        workflowMeta={null}
        nested={[]}
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
        stopped={false}
        startedAt={1_000}
        durationMs={null}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    // A force-finalized card carries no (turn-end-inflated) duration; the
    // builder passes durationMs=null for non-completed blocks.
    expect(screen.queryByText(/^\d+s$/)).toBeNull();
  });

  it("shows a neutral stopped badge for a subagent whose terminal status is errored but stopped is true", () => {
    // `status: "errored"` with `stopped: true` is how the host reports a
    // subagent that was explicitly stopped (e.g. a deadline-killed run) rather
    // than one that genuinely failed - distinct from `endState`, which only
    // covers `interrupted`/`superseded` statuses.
    render(
      <SubagentSegment
        id="test-subagent-stopped"
        name="reviewer"
        agentType={null}
        task="Review the implementation"
        progressUpdates={["Scanning"]}
        result={null}
        isStreaming={false}
        endState={null}
        stopped
        startedAt={1_000}
        durationMs={4_000}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("renders a nested agent as a row in the Sub-agents section once expanded", () => {
    render(
      <SubagentSegment
        id="test-parent"
        name="planner"
        agentType={null}
        task="Plan the refactor."
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={null}
        nested={[
          nestedAgentFixture({ id: "nested-1", name: "callsite-sweeper" }),
        ]}
        variant="promoted"
      />,
    );

    expect(screen.queryByText("Sub-agents")).toBeNull();
    expect(screen.queryByText("callsite-sweeper")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("Sub-agents")).toBeTruthy();
    expect(screen.getByText("callsite-sweeper")).toBeTruthy();
  });

  it("does not render a Sub-agents section when there are no nested agent children", () => {
    render(
      <SubagentSegment
        id="test-no-children"
        name="planner"
        agentType={null}
        task="Plan the refactor."
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={null}
        nested={[]}
        variant="promoted"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.queryByText("Sub-agents")).toBeNull();
  });

  it("renders a nested provider notice as a compact row once the card is expanded", () => {
    render(
      <SubagentSegment
        id="test-parent-notice"
        name="planner"
        agentType={null}
        task="Plan the refactor."
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={null}
        nested={[
          {
            id: "notice-1",
            kind: "provider_notice",
            status: "completed",
            tone: "warning",
            title: "Model changed",
            message: "Codex switched from gpt-5 to gpt-5-safe.",
            details: [],
            parentId: "test-parent-notice",
          },
        ]}
        variant="promoted"
      />,
    );

    expect(screen.queryByText("Model changed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    expect(screen.getByText("Model changed")).toBeTruthy();
  });

  it("renders a second nesting level once the first-level row is itself expanded", () => {
    render(
      <SubagentSegment
        id="test-root"
        name="root-agent"
        agentType={null}
        task="Root task."
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={null}
        nested={[
          nestedAgentFixture({
            id: "mid-agent",
            name: "mid-agent",
            children: [
              nestedAgentFixture({ id: "leaf-agent", name: "leaf-agent" }),
            ],
          }),
        ]}
        variant="promoted"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));

    // The nested row's own header is visible immediately - one indent level -
    // but its grandchild only appears once THAT row is itself expanded.
    expect(screen.getByText("mid-agent")).toBeTruthy();
    expect(screen.queryByText("leaf-agent")).toBeNull();

    clickTriggerFor("mid-agent");

    // One "Sub-agents" label per expanded level: the root's (holding
    // mid-agent) and mid-agent's own (holding leaf-agent).
    expect(screen.getAllByText("Sub-agents")).toHaveLength(2);
    expect(screen.getByText("leaf-agent")).toBeTruthy();
  });

  it("renders the dedicated workflow card for a subagent segment with workflowMeta", () => {
    render(
      <SubagentSegment
        id="test-workflow"
        name="max-effort-review"
        agentType={null}
        task={null}
        progressUpdates={[]}
        result={null}
        isStreaming
        endState={null}
        stopped={false}
        startedAt={null}
        durationMs={null}
        workflowMeta={{
          name: "max-effort-review",
          intent: "Max-effort review of the refusal-handling changeset",
          activity: [
            { kind: "phase", text: "Phase — Find (16 agents)" },
            { kind: "label", text: "find:host-core" },
          ],
          agentsStarted: 16,
          agentsFinished: 3,
          totalTokens: 412_000,
        }}
        nested={[]}
        variant="promoted"
      />,
    );

    expect(screen.getByText("max-effort-review")).toBeTruthy();
    expect(screen.getByText("Workflow")).toBeTruthy();
    // The collapsed live line composes phase + active label + fleet counts.
    expect(screen.getByText(/Phase — Find \(16 agents\)/)).toBeTruthy();
    expect(screen.getByText(/working on find:host-core/)).toBeTruthy();
    expect(screen.getByText(/3 \/ 16 agents done/)).toBeTruthy();

    clickTriggerFor("max-effort-review");

    expect(
      screen.getByText("Max-effort review of the refusal-handling changeset"),
    ).toBeTruthy();
    expect(screen.getByText("Activity")).toBeTruthy();
    expect(screen.getByText("find:host-core")).toBeTruthy();
  });

  it("omits the Intent section for a workflow card whose intent extraction failed", () => {
    render(
      <SubagentSegment
        id="test-workflow-no-intent"
        name="mystery-workflow"
        agentType={null}
        task={null}
        progressUpdates={[]}
        result={null}
        isStreaming={false}
        endState={null}
        stopped={false}
        startedAt={1_000}
        durationMs={5_000}
        workflowMeta={{
          name: "mystery-workflow",
          intent: null,
          activity: [],
          agentsStarted: null,
          agentsFinished: null,
          totalTokens: null,
        }}
        nested={[]}
        variant="promoted"
      />,
    );

    clickTriggerFor("mystery-workflow");

    expect(screen.queryByText("Intent")).toBeNull();
  });

  it("shows Result totals only once a workflow run has settled", () => {
    render(
      <SubagentSegment
        id="test-workflow-totals"
        name="settled-workflow"
        agentType={null}
        task={null}
        progressUpdates={[]}
        result="All checks passed."
        isStreaming={false}
        endState={null}
        stopped={false}
        startedAt={1_000}
        durationMs={65_000}
        workflowMeta={{
          name: "settled-workflow",
          intent: null,
          activity: [],
          agentsStarted: 5,
          agentsFinished: 5,
          totalTokens: 10_000,
        }}
        nested={[]}
        variant="promoted"
      />,
    );

    clickTriggerFor("settled-workflow");

    // The result renders both as the (always-on, card-style) header summary
    // and inside the expanded Result panel.
    expect(screen.getAllByText("All checks passed.").length).toBeGreaterThan(0);
    expect(
      screen.getByText("5 agents run · 10,000 tokens · 1m 5s"),
    ).toBeTruthy();
  });
});
