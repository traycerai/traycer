import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoChangesInWorktree } from "../no-changes-in-worktree";

const UPDATED_AT_MS = 1_700_000_000_000;

function renderEmptyState(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <NoChangesInWorktree lastUpdatedAtMs={UPDATED_AT_MS} />
    </QueryClientProvider>,
  );
}

function makeWrapperQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("<NoChangesInWorktree />", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("uses muted placeholder text", () => {
    renderEmptyState(makeWrapperQueryClient());

    expect(screen.getByText("No changes").getAttribute("class")).toContain(
      "text-muted-foreground/60",
    );
    expect(screen.getByText(/^Last updated/).getAttribute("class")).toContain(
      "text-muted-foreground/50",
    );
  });

  it("spins the refresh icon while git queries are invalidating", () => {
    const queryClient = makeWrapperQueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(() => new Promise<void>(() => undefined));

    renderEmptyState(queryClient);
    fireEvent.click(screen.getByTestId("git-diff-empty-refresh"));

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    const [invalidateOptions] = invalidateQueries.mock.calls[0];
    if (invalidateOptions === undefined) {
      throw new Error("expected invalidateQueries options");
    }
    expect(typeof invalidateOptions.predicate).toBe("function");
    expect(
      screen.getByTestId("git-diff-empty-refresh").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("git-diff-empty-refresh-icon").getAttribute("class"),
    ).toContain("animate-spin");
  });

  it("keeps center refresh feedback visible when invalidation finishes immediately", async () => {
    vi.useFakeTimers();
    const queryClient = makeWrapperQueryClient();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    renderEmptyState(queryClient);
    fireEvent.click(screen.getByTestId("git-diff-empty-refresh"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.getByTestId("git-diff-empty-refresh").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("git-diff-empty-refresh-icon").getAttribute("class"),
    ).toContain("animate-spin");

    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(
      screen.getByTestId("git-diff-empty-refresh").hasAttribute("disabled"),
    ).toBe(false);
  });
});
