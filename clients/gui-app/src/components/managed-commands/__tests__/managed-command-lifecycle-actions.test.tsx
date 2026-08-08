import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The human capability set (`UI.md` §2): watch plus lifecycle, nothing more.
 * Start only where there is nothing running, stop where there is, and delete
 * behind a confirmation that names what dies with it.
 */

const startMutate = vi.fn();
const stopMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: startMutate, isPending: false }),
    useManagedCommandStop: () => ({ mutate: stopMutate, isPending: false }),
    useManagedCommandDelete: () => ({ mutate: deleteMutate, isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

import { ManagedCommandLifecycleActions } from "../managed-command-lifecycle-actions";

const RUNNING: ManagedCommand = {
  id: "cmd-1",
  notifying: true,
  description: "deploy watcher",
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  createdAtMs: 10,
  updatedAtMs: 10,
};

const EXITED: ManagedCommand = {
  ...RUNNING,
  status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 90 },
};

function renderActions(command: ManagedCommand): void {
  render(
    <TooltipProvider>
      <ManagedCommandLifecycleActions
        command={command}
        epicId="epic-1"
        hostId="host-1"
        className={undefined}
      />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  startMutate.mockClear();
  stopMutate.mockClear();
  deleteMutate.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("managed-command lifecycle actions", () => {
  it("offers stop while the command is running", () => {
    renderActions(RUNNING);

    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(stopMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
  });

  it("offers start once the command is not running", () => {
    renderActions(EXITED);

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(startMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
  });

  it("names the output history before deleting, and only deletes on confirm", () => {
    renderActions(EXITED);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteMutate).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toContain("output history");

    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(deleteMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
  });

  it("leaves the command alone when the confirmation is dismissed", () => {
    renderActions(EXITED);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(deleteMutate).not.toHaveBeenCalled();
  });
});
