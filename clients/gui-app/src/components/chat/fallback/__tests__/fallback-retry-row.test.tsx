import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingFallbackStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackRetryRow } from "@/components/chat/fallback/fallback-retry-row";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
} from "./fallback-fixtures";

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

function retryingPending() {
  return pendingFallback({
    state: "retrying",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: null,
    attempt: 2,
    maxAttempts: 4,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-retry",
    revision: 7,
  });
}

describe("FallbackRetryRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders for retrying with the failed tuple and attempt counts", () => {
    render(<FallbackRetryRow pending={retryingPending()} client={null} />);
    const row = screen.getByTestId("fallback-retry-row");
    expect(row.getAttribute("role")).toBe("status");
    expect(row.textContent).toMatch(/Retrying on Claude Code · failed01/);
    expect(row.textContent).toMatch(/attempt 2 of 4/);
    // Falsification: read pending.targetTuple in fallback-retry-row.tsx and THIS assertion must go red.
    expect(row.textContent).not.toMatch(/Codex/);
    expect(row.textContent).not.toMatch(/target01/);
    expect(row.textContent).not.toMatch(BANNED_VOCABULARY);
  });

  it("returns null for every other pendingFallbackStateSchema option and for undefined", () => {
    for (const state of pendingFallbackStateSchema.options) {
      if (state === "retrying") continue;
      const { unmount } = render(
        <FallbackRetryRow
          pending={pendingFallback({
            state,
            reason: "rate_limit",
            failedTuple: FAILED_CLAUDE_TUPLE,
            targetTuple: TARGET_CODEX_TUPLE,
            impendingAction: null,
            deadline: 1_700_000_000_000,
            attempt: 1,
            maxAttempts: 3,
            queuedItemsMoving: 0,
            siblingSwitching: 0,
            traversalId: "traversal-retry",
            revision: 1,
          })}
          client={null}
        />,
      );
      expect(screen.queryByTestId("fallback-retry-row")).toBeNull();
      unmount();
    }
    render(<FallbackRetryRow pending={undefined} client={null} />);
    expect(screen.queryByTestId("fallback-retry-row")).toBeNull();
  });
});
