import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { SubagentConversation } from "@/components/chat/segments/subagent-conversation";
import type { ReasoningSegment } from "@/stores/composer/chat-store";
import {
  ThinkingTokensSourceContext,
  type ThinkingTokensSource,
} from "@/components/chat/thinking-tokens-source";
import type { ChatThinkingTokensReading } from "@/stores/chats/chat-thinking-tokens";

// Same host-bound hooks `activity-group-thinking-tokens.test.tsx` mocks:
// `SubagentConversation` renders through `ActivityGroupSegment`, whose module
// pulls these in at import time regardless of which segment kind is on
// screen.
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

function makeSource(initial: SourceState): ThinkingTokensSource {
  return {
    getState: () => initial,
    subscribe: () => () => undefined,
  };
}

// Copied from `chat/__tests__/thinking-tokens-estimate.test.tsx` /
// `activity-group-thinking-tokens.test.tsx` - same minimal fixture.
const PARENT_TURN: ChatActiveTurn = {
  agentMode: "regular",
  sameTurnSteeringSupported: false,
  turnId: "parent-turn-1",
  status: "running",
  harnessId: "codex",
  model: "gpt-5-codex",
  profileId: null,
  userMessageId: "message-1",
  startedAt: 1,
  updatedAt: 1,
  reasoningEffort: null,
  serviceTier: null,
};

// The PARENT turn's live reading - what `chat-tile.tsx` provides ambiently
// through `ThinkingTokensSourceContext` for the whole tile, subagent
// conversations included.
const PARENT_LIVE: SourceState = {
  activeTurn: PARENT_TURN,
  thinkingTokens: { turnId: "parent-turn-1", estimate: 1234 },
};

const STREAMING_REASONING: ReasoningSegment = {
  id: "subagent-reasoning-1",
  kind: "reasoning",
  markdown: "Weighing the two approaches",
  isStreaming: true,
  durationMs: null,
  parentId: "subagent-1",
};

describe("<SubagentConversation /> thinking-token estimate", () => {
  afterEach(cleanup);

  it("never draws the parent turn's estimate for its own streaming reasoning", () => {
    render(
      <ThinkingTokensSourceContext value={makeSource(PARENT_LIVE)}>
        <ChatExpansionTestProviders tileInstanceId="subagent-conversation-thinking-tokens-tile">
          <SubagentConversation entries={[STREAMING_REASONING]} isStreaming />
        </ChatExpansionTestProviders>
      </ThinkingTokensSourceContext>,
    );

    // The estimate belongs to the PARENT turn, not this subagent's own
    // reasoning - a subagent has no thinking-tokens source of its own, so it
    // must draw nothing rather than borrow the ambient (parent) number.
    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });
});
