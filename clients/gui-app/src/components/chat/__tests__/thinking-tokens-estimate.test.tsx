import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { ReasoningSegment } from "@/components/chat/segments/reasoning-segment";
import { ThinkingTokensEstimate } from "@/components/chat/thinking-tokens-estimate";
import {
  ThinkingTokensSourceContext,
  formatThinkingTokensEstimate,
  type ThinkingTokensSource,
} from "@/components/chat/thinking-tokens-source";
import type { ChatThinkingTokensReading } from "@/stores/chats/chat-thinking-tokens";

interface SourceState {
  activeTurn: ChatActiveTurn | null;
  thinkingTokens: ChatThinkingTokensReading | null;
}

interface FakeSource extends ThinkingTokensSource {
  readonly set: (next: SourceState) => void;
}

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

function withSource(source: FakeSource | null, ui: ReactNode): ReactNode {
  return (
    <ThinkingTokensSourceContext value={source}>
      {ui}
    </ThinkingTokensSourceContext>
  );
}

const LIVE: SourceState = {
  activeTurn: turn("t1", "running"),
  thinkingTokens: { turnId: "t1", estimate: 1234 },
};

describe("formatThinkingTokensEstimate", () => {
  it.each([
    [0, "~0 tokens"],
    [999, "~999 tokens"],
    [1234, "~1.2k tokens"],
    [15_000, "~15.0k tokens"],
    [2_500_000, "~2.5M tokens"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatThinkingTokensEstimate(value)).toBe(expected);
  });
});

describe("<ThinkingTokensEstimate />", () => {
  afterEach(cleanup);

  it("shows the label for the live turn", () => {
    render(withSource(makeSource(LIVE), <ThinkingTokensEstimate />));
    expect(screen.getByTestId("thinking-tokens-estimate").textContent).toBe(
      "~1.2k tokens",
    );
  });

  it("updates when the store changes", () => {
    const source = makeSource(LIVE);
    render(withSource(source, <ThinkingTokensEstimate />));
    act(() => {
      source.set({
        activeTurn: LIVE.activeTurn,
        thinkingTokens: { turnId: "t1", estimate: 2500 },
      });
    });
    expect(screen.getByTestId("thinking-tokens-estimate").textContent).toBe(
      "~2.5k tokens",
    );
  });

  it("draws nothing without a provider", () => {
    render(<ThinkingTokensEstimate />);
    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });

  it("draws nothing for a reading that belongs to another turn", () => {
    const source = makeSource({
      activeTurn: turn("t2", "running"),
      thinkingTokens: { turnId: "t1", estimate: 1234 },
    });
    render(withSource(source, <ThinkingTokensEstimate />));
    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });

  it("disappears after the turn ends", () => {
    const source = makeSource(LIVE);
    render(withSource(source, <ThinkingTokensEstimate />));
    expect(screen.getByTestId("thinking-tokens-estimate")).toBeTruthy();
    act(() => {
      source.set({
        activeTurn: turn("t1", "completed"),
        thinkingTokens: LIVE.thinkingTokens,
      });
    });
    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });
});

describe("<ReasoningSegment /> thinking-token estimate", () => {
  afterEach(cleanup);

  function segment(isStreaming: boolean): ReactNode {
    return (
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={isStreaming}
        durationMs={isStreaming ? null : 12000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />
    );
  }

  it("shows the estimate while streaming", () => {
    render(withSource(makeSource(LIVE), segment(true)), {
      wrapper: WithTestQueryClient,
    });
    expect(screen.getByTestId("thinking-tokens-estimate").textContent).toBe(
      "~1.2k tokens",
    );
  });

  it("does not show it once the block is finished", () => {
    render(withSource(makeSource(LIVE), segment(false)), {
      wrapper: WithTestQueryClient,
    });
    expect(screen.queryByTestId("thinking-tokens-estimate")).toBeNull();
  });
});
