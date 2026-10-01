import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { deriveActivityGroupRenderId } from "@/components/chat/chat-collapsible-key";
import { ActivityGroupSegment } from "@/components/chat/segments/activity-group-segment";
import type { ActivityGroupModel } from "@/components/chat/chat-activity-groups";
import type {
  CommandSegment,
  ReasoningSegment,
} from "@/stores/composer/chat-store";
import {
  ThinkingTokensSourceContext,
  type ThinkingTokensSource,
} from "@/components/chat/thinking-tokens-source";
import type { ChatThinkingTokensReading } from "@/stores/chats/chat-thinking-tokens";

// This suite only exercises command and reasoning segments - neither reaches
// `FileChangeSegment` at render time - but `ActivityGroupSegment` imports it
// unconditionally, and its module pulls in these two host-bound hooks at
// import time. Mocked the same way `activity-group-segment.test.tsx` mocks
// them, so importing the module under test never needs a host context.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: () => ({
    data: null,
    isPending: false,
  }),
}));

interface SourceState {
  activeTurn: ChatActiveTurn | null;
  thinkingTokens: ChatThinkingTokensReading | null;
}

interface FakeSource extends ThinkingTokensSource {
  readonly set: (next: SourceState) => void;
}

// Copied from `chat/__tests__/thinking-tokens-estimate.test.tsx` verbatim -
// same `ChatActiveTurn` fixture and the same minimal store fake.
function turn(
  turnId: string,
  status: ChatActiveTurn["status"],
): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status,
    harnessId: "codex",
    model: "gpt-5-codex",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 1,
    updatedAt: 1,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function makeSource(initial: SourceState): FakeSource {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

const LIVE: SourceState = {
  activeTurn: turn("t1", "running"),
  thinkingTokens: { turnId: "t1", estimate: 1234 },
};

// Command fixture copied from `activity-group-segment.test.tsx`'s
// `COMMAND_SEGMENT`.
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

// Reasoning fixture copied from `activity-group-segment.test.tsx`'s
// `REASONING_SEGMENT` / `SOLE_REASONING_GROUP`.
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

function renderActivityGroup(
  group: ActivityGroupModel,
  source: FakeSource | null,
) {
  const body: ReactNode = (
    <ChatExpansionTestProviders tileInstanceId="activity-group-thinking-tokens-test-tile">
      <ActivityGroupSegment group={group} />
    </ChatExpansionTestProviders>
  );
  return render(
    <ThinkingTokensSourceContext value={source}>
      {body}
    </ThinkingTokensSourceContext>,
  );
}

describe("<ActivityGroupSegment /> thinking-token estimate", () => {
  afterEach(cleanup);

  it("shows exactly one estimate, in the group header, for a sole streaming reasoning block", () => {
    renderActivityGroup(SOLE_REASONING_GROUP, makeSource(LIVE));

    // `getByTestId` itself asserts there is exactly one match - the group
    // header shows it, and the (visually hidden) sole reasoning block's own
    // header must not add a second.
    const estimate = screen.getByTestId("thinking-tokens-estimate");
    expect(estimate.textContent).toBe("~1.2k tokens");
  });

  it("shows no estimate once the sole reasoning block has finished", () => {
    const completedReasoning: ReasoningSegment = {
      ...REASONING_SEGMENT,
      isStreaming: false,
      durationMs: 2100,
    };
    const finishedGroup: ActivityGroupModel = {
      ...SOLE_REASONING_GROUP,
      segments: [completedReasoning],
      isActive: false,
      isStreaming: false,
      label: "Thought for 2s",
      summary: "Thought for 2s",
    };
    renderActivityGroup(finishedGroup, makeSource(LIVE));

    // Open the group so the (headerless) reasoning body actually mounts -
    // proving the absence with the block on screen, not merely unmounted.
    fireEvent.click(screen.getByRole("button", { name: /Thought for 2s/ }));
    expect(screen.getByText("Weighing the two approaches")).toBeTruthy();

    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });

  it("shows exactly one estimate, from the reasoning block's own header, in a mixed live group", () => {
    renderActivityGroup(
      {
        ...SOLE_REASONING_GROUP,
        segments: [REASONING_SEGMENT, COMMAND_SEGMENT],
        label: "Thinking, ran 1 command",
        summary: "Thinking, ran 1 command",
      },
      makeSource(LIVE),
    );

    // The group is no longer headerless (two segments), so its own header
    // carries no estimate - only the reasoning row's own streaming header
    // does.
    const estimate = screen.getByTestId("thinking-tokens-estimate");
    expect(estimate.textContent).toBe("~1.2k tokens");
  });

  it("shows no estimate without a thinking-tokens source provider", () => {
    renderActivityGroup(SOLE_REASONING_GROUP, null);

    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });
});
