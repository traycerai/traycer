import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRunItem } from "@/components/home/host-workspace-selector/workspace-run-item";
import { FirstTaskWorkspaceSetup } from "@/components/onboarding/first-task-workspace-setup";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

interface CoachmarkTestProps {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly selector: string;
  readonly title: string;
  readonly content: string;
  readonly progress: { readonly step: number; readonly total: number } | null;
}

vi.mock("@/components/onboarding/onboarding-coachmark", () => ({
  OnboardingCoachmark: (props: CoachmarkTestProps) => (
    <div
      data-testid="coachmark"
      data-selector={props.selector}
      data-title={props.title}
      data-content={props.content}
      data-progress-step={props.progress?.step}
      data-progress-total={props.progress?.total}
    />
  ),
}));

function workspaceItem(overrides: Partial<WorkspaceRunItem>): WorkspaceRunItem {
  return {
    key: "folder-1",
    displayName: "Workspace",
    displayPath: "/workspace",
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "main",
    summary: null,
    currentIntent: null,
    defaultNewBranchName: "task",
    branchPrefixWarning: null,
    repoIdentifier: { owner: "traycer", repo: "workspace" },
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
    onSelectMode: vi.fn(),
    onEmit: vi.fn(),
    onLocate: null,
    onMakePrimary: vi.fn(),
    onRemove: null,
    ...overrides,
  };
}

function WorkspaceHarness(props: {
  readonly items: readonly WorkspaceRunItem[];
  readonly onContinue: () => void;
  readonly onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const workspaceReviewed = useFirstTaskGuideStore(
    (state) => state.workspaceReviewed,
  );
  return (
    <div ref={rootRef}>
      <button
        type="button"
        data-testid="folder-location-trigger"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Folder location
      </button>
      {open ? <div data-testid="folder-location-menu">Menu</div> : null}
      {workspaceReviewed ? null : (
        <FirstTaskWorkspaceSetup
          items={props.items}
          rootRef={rootRef}
          onContinue={props.onContinue}
          onClose={props.onClose}
        />
      )}
    </div>
  );
}

describe("FirstTaskWorkspaceSetup", () => {
  beforeEach(() => {
    useFirstTaskGuideStore.setState({
      status: "active",
      workspaceReviewed: false,
    });
  });

  afterEach(() => {
    cleanup();
    useFirstTaskGuideStore.getState().prepare();
  });

  it("keeps the original folder controls connected while showing the coachmark", () => {
    render(
      <WorkspaceHarness
        items={[workspaceItem({})]}
        onContinue={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("folder-location-trigger")).toBeTruthy();
    const coachmark = screen.getByTestId("coachmark");
    expect(coachmark.getAttribute("data-selector")).toBe(
      '[data-testid="folder-location-trigger"]',
    );
    expect(coachmark.getAttribute("data-progress-step")).toBe("2");
    expect(coachmark.getAttribute("data-progress-total")).toBe("3");
    expect(coachmark.getAttribute("data-title")).toBe(
      "Work here or in a fresh worktree",
    );
    expect(coachmark.getAttribute("data-content")).toBe(
      "A worktree keeps your main branch clean.",
    );
  });

  it("points a non-git folder at the chip and says the task runs there", () => {
    render(
      <WorkspaceHarness
        items={[workspaceItem({ isGitRepo: false })]}
        onContinue={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const coachmark = screen.getByTestId("coachmark");
    expect(coachmark.getAttribute("data-selector")).toBe(
      '[data-testid="folder-chip"]',
    );
    expect(coachmark.getAttribute("data-progress-step")).toBe("2");
    expect(coachmark.getAttribute("data-progress-total")).toBe("3");
    expect(coachmark.getAttribute("data-title")).toBe("This folder is ready");
    expect(coachmark.getAttribute("data-content")).toBe(
      "Your task will run right here.",
    );
  });

  it("retires the coachmark when the real folder menu opens", () => {
    const onContinue = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceHarness
        items={[workspaceItem({})]}
        onContinue={onContinue}
        onClose={onClose}
      />,
    );

    const trigger = screen.getByTestId("folder-location-trigger");
    fireEvent.click(trigger);

    return waitFor(() => {
      const menu = screen.getByTestId("folder-location-menu");
      expect(screen.getByTestId("folder-location-trigger")).toBe(trigger);
      expect(trigger.isConnected).toBe(true);
      expect(menu.isConnected).toBe(true);
      expect(screen.queryByTestId("coachmark")).toBeNull();
      expect(useFirstTaskGuideStore.getState().workspaceReviewed).toBe(true);
      expect(onContinue).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it("does not show the coachmark while workspace metadata is pending", () => {
    render(
      <WorkspaceHarness
        items={[workspaceItem({ metadataPending: true })]}
        onContinue={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("folder-location-trigger")).toBeTruthy();
    expect(screen.queryByTestId("coachmark")).toBeNull();
  });
});
