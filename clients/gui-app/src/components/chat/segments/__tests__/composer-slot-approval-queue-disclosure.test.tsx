import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import type { AutoModeRuleDraftWorkspace } from "@/lib/auto-mode/auto-mode-rule-copy";
import { JUDGE_CAP_NOTICE } from "@/components/chat/segments/approval-card-disclosure";

function approval(overrides: Partial<ChatApprovalState>): ChatApprovalState {
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

const UNKNOWN_WORKSPACE: AutoModeRuleDraftWorkspace = {
  remote: null,
  branch: null,
};

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
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
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

  // The rungs are INCLUSIVE at 15 and 30 (`judgeWaitDisclosure` uses
  // `elapsedSeconds < RUNG`, not `<=`). The walk above only lands on 14/16/31,
  // which stays green under a `<` -> `<=` slip on either boundary - these two
  // land the component's own clock exactly on the edges so that slip goes red
  // through the component, not just the pure function.
  it("shows the elapsed counter at exactly 15s with no cap notice, and the cap notice at exactly 30s", () => {
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "checking", requestedAt: baseTime })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByTestId("approval-reviewing-elapsed").textContent).toBe(
      "15s",
    );
    expect(screen.queryByTestId("approval-reviewing-cap")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByTestId("approval-reviewing-elapsed").textContent).toBe(
      "30s",
    );
    expect(screen.getByTestId("approval-reviewing-cap").textContent).toBe(
      JUDGE_CAP_NOTICE,
    );
  });

  // FALSIFICATION: this goes red if the elapsed span is moved back inside the
  // stage span's live region, or if `role="status"` is put back on the outer
  // `data-testid="approval-reviewing"` column. `role="status"` is implicitly
  // `aria-atomic`, so either regression re-announces the WHOLE subtree - stage
  // label and elapsed counter together - on every one-second tick, which is
  // exactly the noisy re-announcement the split was meant to stop. Verified
  // by temporarily re-nesting the elapsed span inside the stage span and
  // confirming this test goes red, then restoring the production file.
  it("keeps the elapsed counter outside every live region while the stage and cap notice stay inside their own", () => {
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    render(
      <ComposerSlotApprovalQueue
        approvals={[approval({ reviewing: "checking", requestedAt: baseTime })]}
        canAct
        onDecision={vi.fn()}
        highlightedApprovalId={null}
        ruleDraftWorkspace={UNKNOWN_WORKSPACE}
        onOpenSettings={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    const stage = screen.getByTestId("approval-reviewing-stage");
    const elapsed = screen.getByTestId("approval-reviewing-elapsed");
    const cap = screen.getByTestId("approval-reviewing-cap");

    expect(stage.getAttribute("role")).toBe("status");
    expect(cap.getAttribute("role")).toBe("status");

    // The elapsed counter itself carries no live-region role, and no
    // ancestor of it does either - it must sit OUTSIDE every `role="status"`
    // subtree in the row, not merely lack the role itself.
    expect(elapsed.getAttribute("role")).toBeNull();
    expect(elapsed.closest('[role="status"]')).toBeNull();

    // Still in the a11y tree (not `aria-hidden`) - a screen-reader user can
    // navigate to it and read the seconds on demand, even though it is not
    // announced automatically.
    expect(elapsed.getAttribute("aria-hidden")).toBeNull();
  });
});
