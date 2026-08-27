import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { TeardownForceDeleteDialog } from "@/components/worktree/teardown-force-delete-dialog";

const HOLDERS: readonly WorktreeBusyHolder[] = [
  {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "terminal-agent",
      ownerId: "tui-1",
    },
    holdKind: "terminal-agent-pty",
    activity: "working",
    label: "Claude Code agent polite-ocelot is working",
  },
  {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "terminal-agent",
      ownerId: "tui-1",
    },
    holdKind: "supervised-shell",
    activity: "idle",
    label: "bun run dev",
  },
];

describe("TeardownForceDeleteDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders delete-flavored copy through the shared disclosure, not a fork", () => {
    render(
      <TeardownForceDeleteDialog
        open
        worktreeLabel="tidy-seal"
        holders={HOLDERS}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    screen.getByRole("dialog", { name: "Delete worktree tidy-seal?" });
    screen.getByText(
      "It's still held by the following. Deleting will stop them first.",
    );
    expect(
      screen.getByTestId("teardown-disclosure-working").textContent,
    ).toContain("Claude Code agent polite-ocelot is working");
    expect(
      screen.getByTestId("teardown-disclosure-idle").textContent,
    ).toContain("bun run dev");
    expect(screen.queryByText(/busy/i)).toBeNull();
    screen.getByRole("button", { name: "Stop all & delete" });
  });

  it("renders nothing in the shared disclosure for an empty holder list", () => {
    render(
      <TeardownForceDeleteDialog
        open
        worktreeLabel="tidy-seal"
        holders={[]}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();
    screen.getByRole("dialog", { name: "Delete worktree tidy-seal?" });
  });

  it("confirms and dismisses without forking the holder list", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <TeardownForceDeleteDialog
        open
        worktreeLabel="tidy-seal"
        holders={HOLDERS}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop all & delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
