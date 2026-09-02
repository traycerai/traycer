import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The human capability set (`UI.md` §2): watch plus lifecycle, plus the one
 * setting a person edits - relaunch after a host restart. Start only where
 * there is nothing running, stop where there is, and delete behind a
 * confirmation that names what dies with it.
 */

const startMutate = vi.fn();
const stopMutate = vi.fn();
const deleteMutate = vi.fn();
const configureMutate = vi.fn();

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: startMutate, isPending: false }),
    useManagedCommandStop: () => ({ mutate: stopMutate, isPending: false }),
    useManagedCommandDelete: () => ({ mutate: deleteMutate, isPending: false }),
    useManagedCommandConfigure: () => ({
      mutate: configureMutate,
      isPending: false,
    }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

import { ManagedCommandLifecycleActions } from "../managed-command-lifecycle-actions";

const RUNNING: ManagedCommand = {
  id: "cmd-1",
  monitoring: true,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  relaunchOnHostRestart: false,
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
  configureMutate.mockClear();
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

  it("offers the relaunch switch in both states, sending the opposite of what the row shows", () => {
    // Off is the default and the common case: the switch reads as off and a
    // press asks the host to turn it on.
    renderActions(RUNNING);
    const off = screen.getByRole("button", {
      name: "Stays down after a host restart",
    });
    expect(off.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(off);
    expect(configureMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
      relaunchOnHostRestart: true,
    });
    cleanup();

    // On reads as pressed, and a press turns it off - the case the switch
    // exists for: a shell the host keeps relaunching that nobody wants back.
    configureMutate.mockClear();
    renderActions({ ...EXITED, relaunchOnHostRestart: true });
    const on = screen.getByRole("button", {
      name: "Relaunches after a host restart",
    });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(on);
    expect(configureMutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
      relaunchOnHostRestart: false,
    });
    // A toggle, not a lifecycle act: nothing was started or stopped by it.
    expect(startMutate).not.toHaveBeenCalled();
    expect(stopMutate).not.toHaveBeenCalled();
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
