import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSummaryTrigger } from "@/components/home/host-workspace-selector/workspace-summary-trigger";
import type { WorkspaceRunItem } from "@/components/home/host-workspace-selector/workspace-run-item";

const NOOP = (): void => undefined;
const SOURCE_PATH = "/Users/me/Work/infra";
const RUN_PATH = "/Users/me/worktrees/infra-feat-login";

/**
 * An ADOPTED worktree, which is the case that makes the two paths differ: the
 * chat runs in the worktree, while the row's own label names the source folder.
 * A local folder would let a test pass while reading either one.
 */
function adoptedWorktree(): WorkspaceRunItem {
  return {
    key: SOURCE_PATH,
    displayName: "infra",
    displayPath: SOURCE_PATH,
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "feat/login",
    summary: null,
    currentIntent: {
      kind: "import",
      workspacePath: SOURCE_PATH,
      repoIdentifier: null,
      isPrimary: true,
      worktreePath: RUN_PATH,
    },
    defaultNewBranchName: "traycer/swift-otter",
    branchPrefixWarning: null,
    repoIdentifier: null,
    isPrimary: true,
    canChangePrimary: true,
    makePrimaryDisabled: false,
    makePrimaryDisabledReason: null,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: NOOP,
    onEmit: NOOP,
    onLocate: null,
    onMakePrimary: NOOP,
    onRemove: null,
  };
}

function renderTrigger(): void {
  // The click-open picker renders folder rows that ask the host for worktree
  // facts, so the tap path needs a query client even though the sheet does not.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceSummaryTrigger
        items={[adoptedWorktree()]}
        readOnly
        bindingResolved
      />
    </QueryClientProvider>,
  );
}

function press(pointerType: "touch" | "mouse"): HTMLElement {
  const trigger = screen.getByTestId("workspace-summary-trigger");
  fireEvent.pointerDown(trigger, {
    clientX: 10,
    clientY: 10,
    pointerId: 1,
    pointerType,
    isPrimary: true,
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  return trigger;
}

describe("workspace summary preview on touch", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("brings the hover preview's own facts within reach of a press", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTrigger();

    // Radix opens a HoverCard on hover with touch pointers excluded, so before
    // this the run path had no touch route at all - the collapsed chip shows
    // the folder name and branch, and the click-open picker shows neither path.
    expect(screen.queryByText(RUN_PATH)).toBeNull();

    press("touch");

    const sheet = screen.getByRole("dialog");
    expect(sheet.textContent).toContain("Linked folders");
    // The run path specifically: where the chat ACTUALLY runs, which for an
    // adopted worktree is not the folder the row is named after. A reveal that
    // surfaced `displayPath` would look identical on a local folder and answer
    // the wrong question here.
    expect(sheet.textContent).toContain(RUN_PATH);
    expect(sheet.textContent).toContain("feat/login");
  });

  it("does not also open the folder picker the tap opens", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTrigger();

    const trigger = press("touch");
    // The browser still delivers a click after the hold, and this trigger's
    // click opens the picker - which would land on top of the sheet that just
    // answered the gesture.
    fireEvent.click(trigger);

    expect(
      screen.queryByTestId("workspace-readonly-folders-popover"),
    ).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain(RUN_PATH);
  });

  it("still opens the picker on an ordinary tap", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTrigger();
    const trigger = screen.getByTestId("workspace-summary-trigger");

    fireEvent.pointerDown(trigger, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    fireEvent.pointerUp(trigger, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(trigger);

    // The guard is armed by a press that FIRED, not by every press. Without
    // this the reveal would cost the control its primary action.
    expect(
      screen.getByTestId("workspace-readonly-folders-popover"),
    ).toBeTruthy();
  });

  it("swallows exactly one click, so a keyboard can still open the picker", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTrigger();

    const trigger = press("touch");
    // The click the browser delivers after the hold. This one is consumed.
    fireEvent.click(trigger);
    expect(
      screen.queryByTestId("workspace-readonly-folders-popover"),
    ).toBeNull();

    // Now activate from the keyboard. Enter on a focused button produces a
    // click with NO pointerdown before it, so nothing re-arms the recognizer -
    // a flag that reported without clearing would still be set here and would
    // eat this activation too, leaving the control dead to the keyboard until
    // someone touched it again.
    fireEvent.click(trigger);
    expect(
      screen.getByTestId("workspace-readonly-folders-popover"),
    ).toBeTruthy();
  });

  it("leaves a mouse press alone, where hover already answers", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTrigger();

    press("mouse");

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
