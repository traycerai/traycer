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
    ).toContain(
      "Terminal agent “Claude Code agent polite-ocelot” is working — will be stopped",
    );
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

  it("keeps a long unbroken holder token wrapping inside the dialog with a wrapping footer", () => {
    const unbrokenToken = "x".repeat(200);
    render(
      <TeardownForceDeleteDialog
        open
        worktreeLabel="tidy-seal"
        holders={[
          {
            ...HOLDERS[0],
            label: unbrokenToken,
          },
        ]}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const dialog = screen.getByTestId("teardown-force-delete-dialog");
    const label = screen.getByTestId("teardown-holder-label");
    const footer = screen.getByTestId("teardown-force-delete-footer");
    const confirm = screen.getByTestId("teardown-force-delete-confirm");
    expect(label.textContent).toContain(unbrokenToken);
    expect(dialog.contains(label)).toBe(true);
    expect(dialog.contains(confirm)).toBe(true);
    expect(label.className).toContain("wrap-anywhere");
    expect(label.className).toContain("min-w-0");
    expect(footer.className).toContain("flex-wrap");
    expect(footer.className).toContain("min-w-0");
    expect(footer.contains(confirm)).toBe(true);
  });
});
