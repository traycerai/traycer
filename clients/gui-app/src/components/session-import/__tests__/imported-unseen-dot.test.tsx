import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportedUnseenDot } from "@/components/session-import/imported-unseen-dot";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";

function resetStore(): void {
  act(() => {
    const state = useImportedUnseenStore.getState();
    for (const epicId of Object.keys(state.unseen)) state.markSeen(epicId);
  });
}

beforeEach(resetStore);
afterEach(() => {
  cleanup();
  resetStore();
});

describe("<ImportedUnseenDot />", () => {
  it("renders nothing for a task that was never imported", () => {
    render(<ImportedUnseenDot epicId="epic-native" />);
    expect(screen.queryByTestId("imported-unseen-dot")).toBeNull();
  });

  it("shows the dot for an imported task and names its source provider", () => {
    act(() => {
      useImportedUnseenStore.getState().markImported("epic-1", "claude");
    });
    render(<ImportedUnseenDot epicId="epic-1" />);
    expect(
      screen.getByRole("img", {
        name: "Imported from Claude Code, not opened yet",
      }),
    ).toBeTruthy();
  });

  it("retires the dot once the task has been opened", () => {
    act(() => {
      useImportedUnseenStore.getState().markImported("epic-1", "codex");
    });
    render(<ImportedUnseenDot epicId="epic-1" />);
    expect(screen.getByTestId("imported-unseen-dot")).toBeTruthy();

    act(() => {
      useImportedUnseenStore.getState().markSeen("epic-1");
    });
    expect(screen.queryByTestId("imported-unseen-dot")).toBeNull();
  });

  it("marking one task seen leaves another's dot alone", () => {
    act(() => {
      const store = useImportedUnseenStore.getState();
      store.markImported("epic-1", "opencode");
      store.markImported("epic-2", "opencode");
      store.markSeen("epic-1");
    });
    render(<ImportedUnseenDot epicId="epic-2" />);
    expect(screen.getByTestId("imported-unseen-dot")).toBeTruthy();
  });
});
