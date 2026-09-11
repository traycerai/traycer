import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import { JUDGE_CAP_NOTICE } from "@/components/chat/segments/approval-card-disclosure";

function approval(
  overrides: Partial<ChatApprovalState> = {},
): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "approval-1",
    toolName: "bash",
    description: "Run a shell command",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
    reason: null,
    reviewing: null,
    ...overrides,
  });
}

describe("<ComposerSlotApprovalQueue /> disclosure ladder", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows nothing at 14s, the elapsed counter at 16s, and the cap notice at 31s", () => {
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    render(
      <ComposerSlotApprovalQueue
        approvals={[
          approval({ reviewing: "checking", requestedAt: baseTime - 14_000 }),
        ]}
        canAct
        onDecision={vi.fn()}
      />,
    );

    // 14s elapsed: below the first rung, neither field renders.
    expect(screen.queryByTestId("approval-reviewing-elapsed")).toBeNull();
    expect(screen.queryByTestId("approval-reviewing-cap")).toBeNull();

    // Advance to 16s elapsed: the counter appears, the cap does not.
    // Synchronous `act`: `advanceTimersByTime` fires the interval and its
    // `setState` synchronously, so there is nothing to await and an async
    // callback with no await in it is what `require-await` is for.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("approval-reviewing-elapsed").textContent).toBe(
      "16s",
    );
    expect(screen.queryByTestId("approval-reviewing-cap")).toBeNull();

    // Advance to 31s elapsed: the cap notice joins it.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByTestId("approval-reviewing-elapsed").textContent).toBe(
      "31s",
    );
    expect(screen.getByTestId("approval-reviewing-cap").textContent).toBe(
      JUDGE_CAP_NOTICE,
    );
  });
});
