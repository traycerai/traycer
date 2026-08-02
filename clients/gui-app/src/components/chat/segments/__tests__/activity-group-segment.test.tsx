import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  deriveActivityGroupCollapsibleKey,
  deriveActivityGroupRenderId,
} from "@/components/chat/chat-collapsible-key";
import { chatFindActivityGroupChildHeaderUnitId } from "@/components/chat/chat-find";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import { LIVE_ACTIVITY_WINDOW_EXIT_MS } from "@/components/chat/segments/live-activity-window";
import type { ActivityGroupModel } from "@/components/chat/chat-activity-groups";
import type {
  CommandSegment,
  ReasoningSegment,
} from "@/stores/composer/chat-store";
import {
  useChatCollapsibleTileInstanceId,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";

const COMMAND_SEGMENT: CommandSegment = {
  id: "command-1",
  kind: "command",
  command: "echo hi",
  cwd: null,
  exitCode: 0,
  isStreaming: false,
  endState: null,
  progress: null,
  startedAt: 0,
  parentId: null,
};

const GROUP_ID = deriveActivityGroupRenderId(COMMAND_SEGMENT.id);

const GROUP: ActivityGroupModel = {
  id: GROUP_ID,
  segments: [COMMAND_SEGMENT],
  isActive: false,
  isStreaming: false,
  label: "Ran 1 command",
  summary: "Ran 1 command",
  activeStartedAt: null,
};

interface ForceActivityGroupButtonProps {
  readonly label: string;
  readonly groupId: string;
}

function ForceActivityGroupButton(props: ForceActivityGroupButtonProps) {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const key = deriveActivityGroupCollapsibleKey(tileInstanceId, props.groupId);
  return (
    <button type="button" onClick={() => setFindForcedOpen(key, true)}>
      {props.label}
    </button>
  );
}

function renderActivityGroup(group: ActivityGroupModel) {
  return render(
    <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
      <ActivityGroupSegment group={group} />
    </ChatExpansionTestProviders>,
  );
}

describe("<ActivityGroupSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps user open and close behavior unchanged", () => {
    renderActivityGroup(GROUP);

    expect(screen.queryByText("echo hi")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.getByText("echo hi")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.queryByText("echo hi")).toBeNull();
  });

  it("opens through find-force and releases on manual collapse", () => {
    render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ForceActivityGroupButton
          label="Force activity group"
          groupId={GROUP_ID}
        />
        <ActivityGroupSegment group={GROUP} />
      </ChatExpansionTestProviders>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Force activity group" }),
    );

    expect(screen.getByText("echo hi")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.queryByText("echo hi")).toBeNull();
  });

  it("skips the active-group live elapsed timer from highlighting, keeping the label findable", () => {
    vi.useFakeTimers();
    try {
      // 10s now - 5s start = a stable floored "5s" elapsed label.
      vi.setSystemTime(10_000);
      renderActivityGroup({
        ...GROUP,
        label: "Ran 5 commands",
        summary: "Ran 5 commands",
        isActive: true,
        isStreaming: true,
        activeStartedAt: 5_000,
      });

      // The label is the only text the summary unit indexes, so it must stay
      // highlightable inside the find-anchor button (no data-find-skip ancestor).
      const label = screen.getByText("Ran 5 commands");
      expect(label.closest("[data-find-skip]")).toBeNull();
      expect(label.closest("button")).not.toBeNull();

      // The live elapsed timer is ephemeral chrome the summary projection never
      // indexes. Without the data-find-skip wrapper, a query on the elapsed
      // digits would paint inside the anchor (count 1, paint 2); the skip keeps
      // paint == count.
      expect(screen.getByText("5s").closest("[data-find-skip]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

const REASONING_SEGMENT: ReasoningSegment = {
  id: "reasoning-1",
  kind: "reasoning",
  markdown: "Weighing the two approaches",
  isStreaming: true,
  durationMs: null,
};

const SOLE_REASONING_GROUP: ActivityGroupModel = {
  id: deriveActivityGroupRenderId(REASONING_SEGMENT.id),
  segments: [REASONING_SEGMENT],
  isActive: true,
  isStreaming: true,
  label: "Thinking",
  summary: "Thinking",
  activeStartedAt: null,
};

describe("<ActivityGroupSegment /> live window", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the live window while active and collapsed, so streaming rows are visible without expanding", () => {
    renderActivityGroup({ ...GROUP, isActive: true, isStreaming: true });

    const window = screen.getByTestId("activity-live-window");
    expect(window.dataset.shown).toBe("true");
    // The row is visible WITHOUT the group being open - that is the whole
    // point. Before this, a collapsed active group rendered nothing at all.
    expect(screen.getByText("echo hi")).toBeTruthy();
  });

  it("does not render the window for a settled group", () => {
    renderActivityGroup(GROUP);

    expect(screen.queryByTestId("activity-live-window")).toBeNull();
    expect(screen.queryByText("echo hi")).toBeNull();
  });

  it("withholds children from the window while the group is open, so no find unit renders twice", () => {
    renderActivityGroup({ ...GROUP, isActive: true, isStreaming: true });

    expect(screen.getAllByText("echo hi")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    // Still exactly one: the window is exiting (and empty) while
    // CollapsibleContent now owns the row. Two copies would double-count in
    // find and paint a highlight the projection never counted.
    expect(screen.getAllByText("echo hi")).toHaveLength(1);
  });

  it("keeps the window mounted through its exit so the fold-away can animate, then unmounts", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
          <ActivityGroupSegment
            group={{ ...GROUP, isActive: true, isStreaming: true }}
          />
        </ChatExpansionTestProviders>,
      );
      expect(screen.getByTestId("activity-live-window")).toBeTruthy();

      // The turn ends.
      rerender(
        <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
          <ActivityGroupSegment group={GROUP} />
        </ChatExpansionTestProviders>,
      );

      // Still in the DOM, but marked closed - the grid row is transitioning to
      // 0fr. Unmounting here instead would snap the height and reproduce the
      // exact jump this design removes.
      const exiting = screen.getByTestId("activity-live-window");
      expect(exiting.dataset.shown).toBe("false");
      expect(screen.getByText("echo hi")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(LIVE_ACTIVITY_WINDOW_EXIT_MS);
      });

      expect(screen.queryByTestId("activity-live-window")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The window is a VIEWPORT onto the rows the expanded group shows, not a
  // different rendering of them. A reasoning block keeps its nested header and
  // its find anchor in here; the only thing the window takes over is the height
  // cap, so the block drops its own inner scroller and nothing else.
  it("keeps the reasoning child's nested header and anchor inside the window", () => {
    renderActivityGroup(SOLE_REASONING_GROUP);

    // Twice: the group's own summary line, and the block's nested header.
    expect(screen.getAllByText("Thinking")).toHaveLength(2);
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();

    const childUnitId = chatFindActivityGroupChildHeaderUnitId(
      SOLE_REASONING_GROUP.id,
      REASONING_SEGMENT.id,
    );
    expect(
      document.querySelector(`[data-chat-find-unit="${childUnitId}"]`),
    ).not.toBeNull();
  });

  // The window caps the height and follows the tail itself. A `ReasoningTail`
  // in here would be a second `overflow-y-auto` inside the first: two scroll
  // positions, two tail pins, two stacked top masks over the same lines.
  it("drops the reasoning child's own scroller inside the window, and keeps it outside", () => {
    renderActivityGroup({
      ...SOLE_REASONING_GROUP,
      segments: [REASONING_SEGMENT, COMMAND_SEGMENT],
      label: "Thinking, ran 1 command",
      summary: "Thinking, ran 1 command",
    });

    const scroller = screen.getByTestId("activity-live-window-scroller");
    expect(scroller.querySelector("[data-testid='reasoning-tail']")).toBeNull();

    // Expanding hands the rows to a container that caps nothing, so the block
    // has to bound itself again.
    fireEvent.click(screen.getByRole("button", { name: /ran 1 command/ }));
    expect(screen.getByTestId("reasoning-tail")).toBeTruthy();
  });

  // `headerless` is a property of the CONTAINER, not of the group's shape. It
  // was briefly derived from "this group holds one lone reasoning block", which
  // flips the instant a tool call joins the run - and because `ReasoningSegment`
  // owns an `expanded` state defaulting to false, a completed child that flipped
  // to headed rendered NO body at all. The reader lost the trace they were
  // mid-way through, in one frame, with no animation possible because the group
  // was open. That is the exact discontinuity this whole design removes.
  it("keeps an open group's reasoning body visible when a tool call joins the run", () => {
    // COMPLETED, deliberately. `ReasoningSegment` gates its body on
    // `isStreaming || expanded`, so a still-streaming block keeps its body
    // through the flip on the strength of `isStreaming` alone and would hide
    // the defect entirely.
    const completedReasoning = {
      ...REASONING_SEGMENT,
      isStreaming: false,
      durationMs: 2100,
    };
    const soleOpen: ActivityGroupModel = {
      ...SOLE_REASONING_GROUP,
      segments: [completedReasoning],
      isActive: false,
      isStreaming: false,
      label: "Thought for 2s",
      summary: "Thought for 2s",
    };
    const { rerender } = render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={soleOpen} />
      </ChatExpansionTestProviders>,
    );

    // Two disclosures, deliberately: the group, then the reasoning child inside
    // it. Under the shape-derived flag the child had no header to click at all
    // (it rendered headerless, body always showing), so this second click is
    // what the reader never got to make - and their body vanished the moment a
    // sibling arrived. `getAllByRole` order is DOM order: trigger, then child.
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));
    const childHeader = screen.getAllByRole("button", {
      name: /Thought for 2s/,
    })[1];
    expect(childHeader).toBeTruthy();
    fireEvent.click(childHeader);
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();

    // A command joins the run. The group is unchanged in identity and still
    // open; only its segment list grew.
    rerender(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment
          group={{
            ...soleOpen,
            segments: [completedReasoning, COMMAND_SEGMENT],
            label: "Thought for 2s, ran 1 command",
            summary: "Thought for 2s, ran 1 command",
          }}
        />
      </ChatExpansionTestProviders>,
    );

    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();
  });

  it("gives every child in an open group its own header and find anchor", () => {
    renderActivityGroup({ ...SOLE_REASONING_GROUP, isActive: false });

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));

    // The open body has no height cap and no tail pin, so the child keeps its
    // own header, its own bounded tail, and the anchor the projection indexes
    // unconditionally.
    const childUnitId = chatFindActivityGroupChildHeaderUnitId(
      SOLE_REASONING_GROUP.id,
      REASONING_SEGMENT.id,
    );
    expect(
      document.querySelector(`[data-chat-find-unit="${childUnitId}"]`),
    ).not.toBeNull();
  });
});
