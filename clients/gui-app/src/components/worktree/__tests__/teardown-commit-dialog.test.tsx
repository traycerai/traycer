import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { TeardownCommitDialog } from "@/components/worktree/teardown-commit-dialog";

const HOLDER: WorktreeBusyHolder = {
  ownerRef: {
    epicId: "epic-1",
    ownerKind: "chat",
    ownerId: "chat-1",
  },
  holdKind: "chat-turn",
  activity: "working",
  label: "Planner is working",
};

describe("TeardownCommitDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers stop-now and apply-later on the commit gesture", () => {
    const onImmediate = vi.fn();
    const onDefer = vi.fn();
    render(
      <TeardownCommitDialog
        open
        choice="commit"
        holders={[HOLDER]}
        onImmediate={onImmediate}
        onDefer={onDefer}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
    expect(onImmediate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("teardown-commit-defer"));
    expect(onDefer).toHaveBeenCalledTimes(1);
  });

  it("pivots a blocked envelope into apply-on-next-message only", () => {
    render(
      <TeardownCommitDialog
        open
        choice="blocked"
        holders={[]}
        onImmediate={vi.fn()}
        onDefer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("teardown-commit-defer")).toBeTruthy();
    expect(screen.queryByTestId("teardown-commit-immediate")).toBeNull();
  });
});
