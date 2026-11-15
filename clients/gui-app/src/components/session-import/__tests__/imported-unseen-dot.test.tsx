import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImportedUnseenDot } from "@/components/session-import/imported-unseen-dot";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";

function resetStore(): void {
  act(() => {
    for (const epicId of ["epic-1", "epic-2", "epic-native"]) {
      useImportedUnseenStore.getState().markSeen(epicId);
    }
  });
}

function DotRenderProbe(props: { readonly epicId: string }) {
  return <ImportedUnseenDot epicId={props.epicId} />;
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

  it("a second provider landing on the same task goes neutral - the dot names neither provider, in the tooltip or the aria-label", () => {
    act(() => {
      const store = useImportedUnseenStore.getState();
      store.markImported("epic-1", "claude");
      store.markImported("epic-1", "codex");
    });
    render(
      <TooltipProvider>
        <ImportedUnseenDot epicId="epic-1" />
      </TooltipProvider>,
    );

    const dot = screen.getByRole("img", { name: "Imported, not opened yet" });
    expect(dot).toBeTruthy();

    fireEvent.focus(dot);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Imported, not opened yet",
    );
  });

  it("a single provider still names it - not neutral by default", () => {
    act(() => {
      useImportedUnseenStore.getState().markImported("epic-1", "claude");
    });
    render(
      <TooltipProvider>
        <ImportedUnseenDot epicId="epic-1" />
      </TooltipProvider>,
    );

    const dot = screen.getByRole("img", {
      name: "Imported from Claude Code, not opened yet",
    });
    expect(dot).toBeTruthy();

    fireEvent.focus(dot);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Imported from Claude Code - not opened yet",
    );
  });

  it("updates the marked dot in the same act without rendering another epic's dot", () => {
    let firstRenders = 0;
    let secondRenders = 0;
    render(
      <>
        <Profiler id="first-dot" onRender={() => (firstRenders += 1)}>
          <DotRenderProbe epicId="epic-1" />
        </Profiler>
        <Profiler id="second-dot" onRender={() => (secondRenders += 1)}>
          <DotRenderProbe epicId="epic-2" />
        </Profiler>
      </>,
    );
    const secondBaseline = secondRenders;

    act(() => {
      useImportedUnseenStore.getState().markImported("epic-1", "claude");
    });

    expect(screen.getByTestId("imported-unseen-dot")).toBeTruthy();
    expect(secondRenders).toBe(secondBaseline);
    const firstAfterImport = firstRenders;

    act(() => {
      useImportedUnseenStore.getState().markSeen("epic-1");
    });

    expect(screen.queryByTestId("imported-unseen-dot")).toBeNull();
    expect(firstRenders).toBeGreaterThan(firstAfterImport);
    expect(secondRenders).toBe(secondBaseline);
  });

  it("stays neutral when a THIRD provider lands - neutral is sticky, not just 'exactly two'", () => {
    act(() => {
      const store = useImportedUnseenStore.getState();
      store.markImported("epic-1", "claude");
      store.markImported("epic-1", "codex");
      store.markImported("epic-1", "opencode");
    });
    render(<ImportedUnseenDot epicId="epic-1" />);
    expect(
      screen.getByRole("img", { name: "Imported, not opened yet" }),
    ).toBeTruthy();
  });
});
