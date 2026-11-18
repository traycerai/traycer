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

/**
 * `useFallbackModelLabels` alone - see `fallback-grace-card.test.tsx`'s
 * identical double for the full rationale and `fallback-model-labels.test.tsx`
 * for the resolver's own rules. This row never renders a model at all (see
 * `fallback-retry-row.tsx`: "Retrying on {providerLabel} · {profileLabel}",
 * no `identity.model`), so there is nothing here for the override to prove -
 * this double exists only so the real `useFallbackModelLabels` doesn't reach
 * for a `QueryClientProvider` this file has no reason to stand up.
 */
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (_harnessId: string, model: string) =>
        model,
    };
  },
);

function retryingPending() {
  return retryingPendingAt(2);
}

function retryingPendingAt(attempt: number) {
  return pendingFallback({
    state: "retrying",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: null,
    attempt,
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
    // The live region is the persistent sr-only node, not the visual row.
    expect(row.getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
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
      expect(screen.getByTestId("fallback-retry-status").textContent).toBe("");
      unmount();
    }
    render(<FallbackRetryRow pending={undefined} client={null} />);
    expect(screen.queryByTestId("fallback-retry-row")).toBeNull();
    expect(screen.getByTestId("fallback-retry-status").textContent).toBe("");
  });

  it("keeps one retry live region mounted across the whole traversal", () => {
    const { rerender } = render(
      <FallbackRetryRow pending={undefined} client={null} />,
    );
    const region = screen.getByTestId("fallback-retry-status");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");

    rerender(<FallbackRetryRow pending={retryingPending()} client={null} />);
    expect(screen.getByTestId("fallback-retry-status")).toBe(region);
    expect(region.textContent).toContain("Retrying on Claude Code · failed01");
    expect(region.textContent).toContain("attempt 2 of 4");
    const row = screen.getByTestId("fallback-retry-row");
    expect(row.getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<FallbackRetryRow pending={retryingPendingAt(3)} client={null} />);
    expect(screen.getByTestId("fallback-retry-status")).toBe(region);
    expect(region.textContent).toContain("attempt 3 of 4");

    rerender(<FallbackRetryRow pending={undefined} client={null} />);
    expect(screen.getByTestId("fallback-retry-status")).toBe(region);
    expect(region.textContent).toBe("");
    expect(screen.queryByTestId("fallback-retry-row")).toBeNull();
  });
});
