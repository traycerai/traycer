import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  deriveActivityGroupCollapsibleKey,
  deriveActivityGroupRenderId,
} from "@/components/chat/chat-collapsible-key";
import { chatFindActivityGroupChildHeaderUnitId } from "@/components/chat/chat-find";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import { LIVE_ACTIVITY_WINDOW_EXIT_MS } from "@/components/chat/segments/live-activity-window-mount";
import type { ActivityGroupModel } from "@/components/chat/chat-activity-groups";
import type {
  CommandSegment,
  ReasoningSegment,
} from "@/stores/composer/chat-store";
import {
  useChatCollapsibleTileInstanceId,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { createActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";

// A file-change body lazy-fetches its before/after by hash and renders a themed
// diff. Stub both so an expanded one renders synchronously, without a
// HostRuntimeProvider or a ThemeProvider - the same pair
// `file-change-group-segment.test.tsx` uses, and the only reason the promote
// assertions below can reach a file-change row at all.
vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: { readonly children: ReactNode }) => (
    <div data-testid="inline-diff-frame">{props.children}</div>
  ),
  DiffContentPrimitive: () => <div data-testid="inline-diff" />,
}));

vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: () => ({
    data: {
      beforeContent: "old();\n",
      afterContent: "const a = 1;\n",
      reason: "snapshot",
    },
    isPending: false,
  }),
}));

const COMMAND_SEGMENT: CommandSegment = {
  id: "command-1",
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
      expect(screen.getByRole("button", { name: /echo hi/ })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(LIVE_ACTIVITY_WINDOW_EXIT_MS);
      });

      expect(screen.queryByTestId("activity-live-window")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A group's SOLE reasoning block renders unheaded: the group header's
  // thinking clause IS that block's label, so a nested header repeated the
  // same word one line lower, and kept repeating it ("Thought for 2s" over
  // "Thought for 2s") long after the streaming ended.
  it("renders a group's sole reasoning block with no visible header, so the label appears once", () => {
    renderActivityGroup(SOLE_REASONING_GROUP);

    // Nothing VISIBLE repeats the group's label. The one control in here is
    // `sr-only`: dropping the header outright dropped the block's only button,
    // and its body is a deliberately non-interactive div, so a pointer could
    // still click the trace and a keyboard had nothing to reach at all.
    const scroller = screen.getByTestId("activity-live-window-scroller");
    const controls = scroller.querySelectorAll("button");
    expect(controls).toHaveLength(1);
    expect(controls[0].className).toContain("sr-only");
    // It promotes rather than discloses, so it must not claim otherwise - the
    // same call `PromotingSegmentRow` makes.
    expect(controls[0].getAttribute("aria-expanded")).toBeNull();
    // And because it has no `aria-expanded` AND sits beside the group's own
    // trigger carrying the SAME label, its name has to say what it does. On the
    // bare label a screen reader hears "Thinking, button" twice, identically,
    // with nothing to choose between them.
    expect(controls[0].getAttribute("aria-label")).toBe(
      "Thinking - open in the full activity view",
    );
    // The trace still shows - unheaded must never mean unrendered.
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();

    // No header means no anchor, so the projection must not emit a unit for it
    // either (covered on the projection side in chat-find-projection.test.ts).
    const childUnitId = chatFindActivityGroupChildHeaderUnitId(
      SOLE_REASONING_GROUP.id,
      REASONING_SEGMENT.id,
    );
    expect(
      document.querySelector(`[data-chat-find-unit="${childUnitId}"]`),
    ).toBeNull();
  });

  // The regression that made the narrower rule necessary. Keyed on the
  // reasoning COUNT alone, this shape was headerless too - and its group header
  // reads "Thinking, ran 1 command", which is NOT the block's label, so the
  // trace rendered as a titled-by-nothing paragraph sitting between tool rows.
  it("keeps the reasoning header when the group holds anything else", () => {
    renderActivityGroup({
      ...SOLE_REASONING_GROUP,
      segments: [REASONING_SEGMENT, COMMAND_SEGMENT],
      label: "Thinking, ran 1 command",
      summary: "Thinking, ran 1 command",
    });

    expect(screen.getByRole("button", { name: "Thinking" })).toBeTruthy();
    expect(
      document.querySelector(
        `[data-chat-find-unit="${chatFindActivityGroupChildHeaderUnitId(
          SOLE_REASONING_GROUP.id,
          REASONING_SEGMENT.id,
        )}"]`,
      ),
    ).not.toBeNull();
  });

  // Two blocks mean the group summary carries their SUM, so the rows are the
  // only thing that tells them apart and every header comes back.
  it("keeps a header on every reasoning block once the group holds two", () => {
    const second: ReasoningSegment = {
      ...REASONING_SEGMENT,
      id: "reasoning-2",
      markdown: "Second thought",
      isStreaming: false,
      durationMs: 3000,
    };
    renderActivityGroup({
      ...SOLE_REASONING_GROUP,
      segments: [REASONING_SEGMENT, second],
      label: "Thought for 3s, ran 1 command",
      summary: "Thought for 3s, ran 1 command",
    });

    // The still-streaming block's own header is back; the group summary now
    // reads the accumulated total instead, so the two no longer say the same
    // thing at all.
    expect(screen.getByRole("button", { name: "Thinking" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thought for 3s" })).toBeTruthy();
    for (const segmentId of ["reasoning-1", "reasoning-2"]) {
      const unitId = chatFindActivityGroupChildHeaderUnitId(
        SOLE_REASONING_GROUP.id,
        segmentId,
      );
      expect(
        document.querySelector(`[data-chat-find-unit="${unitId}"]`),
      ).not.toBeNull();
    }
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

  // The headerless flag is derived from the group's SHAPE and flips the moment
  // a second reasoning block joins the run. What that flip must NOT do is leave
  // the trace expanded: a headerless block shows its body because there is
  // nowhere else to put it, not because the reader opened it, and treating that
  // as a disclosure left the first thought of every run permanently unfolded
  // under a header whose chevron claimed it was open.
  it("collapses an unopened reasoning body once a second block gives it a header", () => {
    // COMPLETED, deliberately. The body is also gated on `isStreaming`, so a
    // still-streaming block would keep its body on that alone and hide the
    // behaviour entirely.
    const completedReasoning: ReasoningSegment = {
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

    // One disclosure only: the group. Its sole reasoning block is unheaded, so
    // opening the group is what shows the trace.
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();

    // A SECOND reasoning block joins - the one change that gives this block a
    // header. The group is unchanged in identity and still open.
    rerender(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment
          group={{
            ...soleOpen,
            segments: [
              completedReasoning,
              {
                ...REASONING_SEGMENT,
                id: "reasoning-2",
                markdown: "A later thought",
              },
            ],
            label: "Thought for 2s",
            summary: "Thought for 2s",
          }}
        />
      </ChatExpansionTestProviders>,
    );

    // The header appeared and the trace folded into it - the block now reads
    // exactly like every other completed thought in the group.
    expect(
      document.querySelector(
        `[data-chat-find-unit="${chatFindActivityGroupChildHeaderUnitId(
          SOLE_REASONING_GROUP.id,
          REASONING_SEGMENT.id,
        )}"]`,
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Weighing the two approaches")).toBeNull();
  });

  it("gives every child in an open group its own header and find anchor", () => {
    renderActivityGroup({
      ...SOLE_REASONING_GROUP,
      segments: [REASONING_SEGMENT, COMMAND_SEGMENT],
      isActive: false,
      label: "Thinking, ran 1 command",
      summary: "Thinking, ran 1 command",
    });

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));

    // The command row keeps its own header and the anchor the projection
    // indexes. (The sole reasoning block is unheaded by design and is covered
    // above; every OTHER child kind is unaffected.)
    const childUnitId = chatFindActivityGroupChildHeaderUnitId(
      SOLE_REASONING_GROUP.id,
      COMMAND_SEGMENT.id,
    );
    expect(
      document.querySelector(`[data-chat-find-unit="${childUnitId}"]`),
    ).not.toBeNull();
  });

  // The window is four line-heights tall, so a row expanded in place is clipped
  // to roughly one line and shoves its siblings out of the box. The click
  // leaves the window instead: the group opens and the row comes back in the
  // full-height body, already unfolded.
  it("promotes a live-window row into the open group instead of expanding it in place", () => {
    renderActivityGroup({
      ...GROUP,
      isActive: true,
      isStreaming: true,
      segments: [{ ...COMMAND_SEGMENT, isStreaming: true, exitCode: null }],
    });

    const scroller = screen.getByTestId("activity-live-window-scroller");
    const row = scroller.querySelector<HTMLButtonElement>(
      "[data-testid='activity-row-promote']",
    );
    expect(row).not.toBeNull();
    // Nothing to disclose here - a trigger claiming otherwise would lie about
    // what the click does.
    expect(row?.getAttribute("aria-expanded")).toBeNull();

    fireEvent.click(row as HTMLButtonElement);

    // The group is open and the window is folding away.
    expect(screen.getByTestId("activity-live-window").dataset.shown).toBe(
      "false",
    );

    // And the row came back UNFOLDED. Command, file-change and approval rows
    // keep open state in local `useState` rather than the id-keyed store tool
    // and subagent rows use, so the clicked copy takes its own state with it
    // when the window unmounts - the replacement has to be seeded explicitly or
    // the promote delivers an open group and nothing else.
    //
    // Asserting on the command text does not show this: `echo hi` is in the
    // header, which renders open or closed, so that assertion passed for a row
    // that promoted and stayed shut. The panel label lives in the body only.
    const trigger = screen.getByRole("button", { name: /echo hi/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Command")).toBeTruthy();
  });

  // Every child kind whose open state is LOCAL, not store-backed, needs the
  // same seeding - and each is its own component with its own `useState`, so
  // covering one proves nothing about the others. Reverting the seed on
  // file-change and approval left every suite green until these existed.
  it.each([
    [
      "file change",
      {
        id: "file-1",
        kind: "file_change",
        filePath: "src/app.ts",
        operation: "edit",
        diffSource: "snapshot",
        beforeHash: null,
        afterHash: null,
        additions: 3,
        deletions: 1,
        sourceBlockIds: ["file-1"],
        reason: "snapshot",
        isStreaming: false,
        endState: null,
        parentId: null,
      },
      /src\/app\.ts/,
    ],
    [
      "resolved approval",
      {
        id: "approval-1",
        kind: "approval",
        toolName: "bash",
        description: "Run the test suite",
        inputSummary: "bun test",
        inputDetail: null,
        decision: { approved: true, reason: null },
      },
      /bash/,
    ],
  ] as const)(
    "unfolds a promoted %s row in the open group",
    (_, segment, name) => {
      renderActivityGroup({
        ...GROUP,
        isActive: true,
        isStreaming: true,
        segments: [segment],
      });

      const scroller = screen.getByTestId("activity-live-window-scroller");
      const row = scroller.querySelector<HTMLButtonElement>(
        "[data-testid='activity-row-promote']",
      );
      expect(row).not.toBeNull();

      fireEvent.click(row as HTMLButtonElement);

      expect(
        screen.getByRole("button", { name }).getAttribute("aria-expanded"),
      ).toBe("true");
    },
  );

  // The reveal focuses the row's OWN trigger, marked explicitly. Taking the
  // first button in document order instead lands on whatever the content
  // happens to contain first - for a reasoning trace with a fenced code block
  // that is its "Copy code" button, so the reader is dropped on a control they
  // never asked for, inside the body rather than on the row.
  // A revealed headerless block whose trace contains a fenced code block was
  // where focus went wrong: it rendered no trigger of its own, so the first
  // button inside it was the code block's Copy control. Two things fixed that -
  // the block now KEEPS a hidden control through its own disclosure, so there is
  // a trigger to land on, and the reveal targets that trigger explicitly.
  it("focuses the revealed row's own trigger, not a control inside its body", () => {
    renderActivityGroup({
      ...SOLE_REASONING_GROUP,
      segments: [
        {
          ...REASONING_SEGMENT,
          markdown: "Weighing it up\n\n```ts\nconst a = 1;\n```\n",
        },
      ],
    });

    const scroller = screen.getByTestId("activity-live-window-scroller");
    const row = scroller.querySelector<HTMLButtonElement>(
      "button[data-activity-row-trigger]",
    );
    fireEvent.click(row as HTMLButtonElement);

    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("data-activity-row-trigger")).not.toBeNull();
    // The promote seeded it expanded, so the control's job now is to collapse -
    // and its name has to say so. It read "show the full reasoning" while
    // reporting `aria-expanded="true"`, which described the opposite action.
    expect(focused.getAttribute("aria-label")).toBe(
      "Thinking - collapse to the preview",
    );
  });

  it("moves focus to the revealed row instead of dropping it on the body", () => {
    renderActivityGroup({
      ...GROUP,
      isActive: true,
      isStreaming: true,
      segments: [{ ...COMMAND_SEGMENT, isStreaming: true, exitCode: null }],
    });

    const scroller = screen.getByTestId("activity-live-window-scroller");
    const row = scroller.querySelector<HTMLButtonElement>(
      "[data-testid='activity-row-promote']",
    );
    fireEvent.click(row as HTMLButtonElement);

    // The button that was clicked no longer exists. Leaving focus where it fell
    // returns a keyboard user to the top of the transcript, having just asked
    // to be taken to one specific row.
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: /echo hi/ })).toBe(
      document.activeElement,
    );
  });

  // A run loses a member when a command backgrounds, when a question tool's
  // interview lands, and - upstream of the timeline builder entirely - when
  // `buildAssistantSegments` suppresses a subagent spawn tool. The group id is
  // derived from the first segment, so the list shrinks under an unchanged id on
  // a component that stays mounted. The headerless rule is a pure function of
  // the shape, so it would flip back to true here and, because a headerless body
  // always shows, unfold a completed trace nobody opened: #597 inverted.
  //
  // The header therefore latches on this component's own history. No model flag,
  // because the removals that matter happen in three places and one of them runs
  // before the model is built.
  const COMPLETED_REASONING: ReasoningSegment = {
    ...REASONING_SEGMENT,
    isStreaming: false,
    durationMs: 2100,
  };
  const TWO_CHILD_GROUP: ActivityGroupModel = {
    ...SOLE_REASONING_GROUP,
    segments: [COMPLETED_REASONING, COMMAND_SEGMENT],
    isActive: false,
    isStreaming: false,
    label: "Thought for 2s, ran 1 command",
    summary: "Thought for 2s, ran 1 command",
  };
  const SHRUNK_GROUP: ActivityGroupModel = {
    ...TWO_CHILD_GROUP,
    segments: [COMPLETED_REASONING],
    label: "Thought for 2s",
    summary: "Thought for 2s",
  };

  it("keeps the reasoning header when the group shrinks back to one block", () => {
    const { rerender } = render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={TWO_CHILD_GROUP} />
      </ChatExpansionTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));
    // Headed, so the completed trace is folded away behind its own row.
    expect(screen.queryByText("Weighing the two approaches")).toBeNull();

    // Same group id, one segment fewer - whatever removed it.
    rerender(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={SHRUNK_GROUP} />
      </ChatExpansionTestProviders>,
    );

    // Header still there - two controls now say "Thought for 2s", the group's
    // and the child's - and the trace is still folded. Nothing opened itself.
    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(2);
    expect(screen.queryByText("Weighing the two approaches")).toBeNull();
  });

  // The other half of the latch, and the reason it cannot live on the model. A
  // snapshot flag cannot tell "shrank under the reader" from "arrived this
  // shape", so it kept the duplicate header on any message that merely STARTS
  // with a backgrounded command - reinstating the exact defect the rule removes.
  it("renders unheaded when a one-block group is the first thing it ever sees", () => {
    renderActivityGroup(SHRUNK_GROUP);

    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));

    // Exactly one control: the group's. There was never a child header here for
    // the reader to lose, so there is nothing to preserve.
    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(1);
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();
  });

  // "Was headed" is not "had two segments". A settled, collapsed group renders
  // NO children - the live window is gone and `CollapsibleContent` unmounts its
  // subtree - so a shrink that happens before the reader ever opens it showed
  // them nothing. Latching on shape alone put a second `Thought for 2s` under
  // the first the moment they did open it.
  it("does not latch a header the reader never saw, when the shrink precedes the first open", () => {
    const { rerender } = render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={TWO_CHILD_GROUP} />
      </ChatExpansionTestProviders>,
    );
    // Deliberately NOT opened. Nothing of the two-child shape is on screen.
    expect(screen.queryByText("echo hi")).toBeNull();

    rerender(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={SHRUNK_GROUP} />
      </ChatExpansionTestProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));

    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(1);
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();
  });

  // The gap between "shown" and "on screen". `LiveActivityWindow` keeps its rows
  // in the DOM for the whole 300ms exit, so when a group settles in the SAME
  // update that adds a second segment, `shown` is already false while the newly
  // headed reasoning row is still visible. A latch gated on `shown` records
  // nothing for that window, and the next shrink strips a header the reader saw
  // - the defect the latch exists to prevent, coming back through its one blind
  // spot. Gating on the window's mounted state closes it.
  it("latches a header shown only during the live window's exit animation", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
          <ActivityGroupSegment
            group={{ ...SHRUNK_GROUP, isActive: true, isStreaming: true }}
          />
        </ChatExpansionTestProviders>,
      );

      // Settles and gains a second segment in one update: the window is told to
      // close while its rows - now including the child header - stay mounted.
      rerender(
        <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
          <ActivityGroupSegment group={TWO_CHILD_GROUP} />
        </ChatExpansionTestProviders>,
      );

      // The child header really is on screen during the exit. Without this the
      // test would pass for a window that had already torn its rows down, and
      // prove nothing about the gap.
      expect(screen.getByText("echo hi")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(LIVE_ACTIVITY_WINDOW_EXIT_MS);
      });

      // Now shrink back and open. The header the reader saw mid-exit survives.
      rerender(
        <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
          <ActivityGroupSegment group={SHRUNK_GROUP} />
        </ChatExpansionTestProviders>,
      );
      fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));

      expect(
        screen.queryAllByRole("button", { name: "Thought for 2s" }),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The group's id is derived from its FIRST member, so removing that member
  // RENAMES the group. `[command, reasoning]` whose command is promoted out
  // becomes `[reasoning]` under a different id - and a latch keyed by group id
  // is orphaned by precisely the move it exists to survive, dropping the header
  // and unfolding the trace. Keying by segment id is what makes it hold, because
  // segment ids do not move.
  //
  // Note this is the mirror of the shrink case above, which only ever exercised
  // `[reasoning, X] -> [reasoning]`, where reasoning leads and the id happens
  // not to change.
  it("keeps the reasoning header when the group's FIRST member leaves and renames it", () => {
    const leadingCommandGroup: ActivityGroupModel = {
      ...TWO_CHILD_GROUP,
      id: deriveActivityGroupRenderId(COMMAND_SEGMENT.id),
      segments: [COMMAND_SEGMENT, COMPLETED_REASONING],
    };
    const renamedShrunkGroup: ActivityGroupModel = {
      ...SHRUNK_GROUP,
      id: deriveActivityGroupRenderId(COMPLETED_REASONING.id),
      segments: [COMPLETED_REASONING],
    };
    // The rename is the whole premise; assert it rather than trusting it.
    expect(renamedShrunkGroup.id).not.toBe(leadingCommandGroup.id);

    const { rerender } = render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={leadingCommandGroup} />
      </ChatExpansionTestProviders>,
    );
    // Opened, so the nested reasoning header is genuinely on screen.
    fireEvent.click(
      screen.getByRole("button", { name: /Thought for 2s, ran 1 command/ }),
    );
    expect(screen.getByRole("button", { name: "Thought for 2s" })).toBeTruthy();

    rerender(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={renamedShrunkGroup} />
      </ChatExpansionTestProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));

    // Two controls: the group's own, and the child header the reader saw.
    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(2);
    expect(screen.queryByText("Weighing the two approaches")).toBeNull();
  });

  // A latch that can be evicted is not a latch. Sharing `openIds`' 256-entry
  // FIFO meant the 257th mark erased the oldest, so a long transcript would drop
  // the header on its earliest groups and unfold their traces on the next
  // remount - the same defect, just past a threshold nobody would hit while
  // testing.
  it("keeps a header latched past the open-id cap", () => {
    const store = createActivityGroupOpenStore(null);
    const mount = (group: ActivityGroupModel) => (
      <ChatOpenStoreScopeProvider value="activity-group-cap-tile">
        <ActivityGroupOpenStoreProvider store={store}>
          <ChatFindForceStoreProvider tileInstanceId="activity-group-cap-tile">
            <ActivityGroupSegment group={group} />
          </ChatFindForceStoreProvider>
        </ActivityGroupOpenStoreProvider>
      </ChatOpenStoreScopeProvider>
    );

    const { unmount } = render(mount(TWO_CHILD_GROUP));
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));
    unmount();

    // Well past MAX_ACTIVITY_GROUP_OPEN_IDS (256).
    for (let index = 0; index < 300; index += 1) {
      store.getState().markHeaded([`filler-segment-${index}`]);
    }

    render(mount(SHRUNK_GROUP));
    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(2);
    expect(screen.queryByText("Weighing the two approaches")).toBeNull();
  });

  // "Showed a nested reasoning header" is not "showed children". A group with no
  // reasoning in it never renders one, so marking it is meaningless - and while
  // the set was capped, it was unrelated activity spending a real latch's budget.
  it("does not mark a group that has no reasoning header to show", () => {
    const store = createActivityGroupOpenStore(null);
    render(
      <ChatOpenStoreScopeProvider value="activity-group-mark-tile">
        <ActivityGroupOpenStoreProvider store={store}>
          <ChatFindForceStoreProvider tileInstanceId="activity-group-mark-tile">
            <ActivityGroupSegment
              group={{ ...GROUP, isActive: true, isStreaming: true }}
            />
          </ChatFindForceStoreProvider>
        </ActivityGroupOpenStoreProvider>
      </ChatOpenStoreScopeProvider>,
    );

    // Children ARE on screen - the live window is showing the command row.
    expect(screen.getByText("echo hi")).toBeTruthy();
    expect(store.getState().headedIds.size).toBe(0);
  });

  // The latch outlives the component for the same reason the open state does:
  // chat tiles fully remount on a tab switch, and LegendList unmounts rows that
  // scroll away. Held in component state it died with the mount, so the header
  // vanished and the trace unfolded on the next remount - the same discontinuity
  // one step later. `ChatExpansionTestProviders` keeps the same store instance,
  // which is exactly what a tab remount does.
  it("keeps the preserved header across a remount of the still-open group", () => {
    // The SAME store across both mounts - which is precisely what a tab switch
    // does (the registry hands the tile back its existing store, decision #17).
    // `ChatExpansionTestProviders` passes `store={null}` and would hand out a
    // fresh one, hiding the whole defect.
    const store = createActivityGroupOpenStore(null);
    const mount = (group: ActivityGroupModel) => (
      <ChatOpenStoreScopeProvider value="activity-group-remount-tile">
        <ActivityGroupOpenStoreProvider store={store}>
          <ChatFindForceStoreProvider tileInstanceId="activity-group-remount-tile">
            <ActivityGroupSegment group={group} />
          </ChatFindForceStoreProvider>
        </ActivityGroupOpenStoreProvider>
      </ChatOpenStoreScopeProvider>
    );

    const { unmount } = render(mount(TWO_CHILD_GROUP));
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));
    expect(screen.getByText("echo hi")).toBeTruthy();

    unmount();
    render(mount(SHRUNK_GROUP));

    // Same id, so the group comes back open - and the header has to come back
    // with it, folded, rather than the trace unfolding itself.
    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(2);
    expect(screen.queryByText("Weighing the two approaches")).toBeNull();
  });

  // The latched header is deliberately NOT a find anchor: the projection is
  // rebuilt from the model and sees only the shape, so it emits no unit here.
  // Anchors follow the projection, the visible header follows the latch - which
  // leaves an un-indexed header, never an unpaintable match.
  it("does not anchor find on a header the projection no longer indexes", () => {
    const { rerender } = render(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={TWO_CHILD_GROUP} />
      </ChatExpansionTestProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));

    const childUnit = `[data-chat-find-unit="${chatFindActivityGroupChildHeaderUnitId(
      SOLE_REASONING_GROUP.id,
      REASONING_SEGMENT.id,
    )}"]`;
    expect(document.querySelector(childUnit)).not.toBeNull();

    rerender(
      <ChatExpansionTestProviders tileInstanceId="activity-group-test-tile">
        <ActivityGroupSegment group={SHRUNK_GROUP} />
      </ChatExpansionTestProviders>,
    );

    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(2);
    expect(document.querySelector(childUnit)).toBeNull();
  });

  it("renders no headerless control once there is nothing left to disclose", () => {
    renderActivityGroup({
      ...SOLE_REASONING_GROUP,
      segments: [
        { ...REASONING_SEGMENT, isStreaming: false, durationMs: 2100 },
      ],
      isActive: false,
      isStreaming: false,
      label: "Thought for 2s",
      summary: "Thought for 2s",
    });

    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));

    // The whole trace is already on screen. A focusable element that toggles
    // nothing is worse than none - it is a tab stop that leads nowhere.
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();
    expect(
      screen.queryAllByRole("button", { name: "Thought for 2s" }),
    ).toHaveLength(1);
  });
});
