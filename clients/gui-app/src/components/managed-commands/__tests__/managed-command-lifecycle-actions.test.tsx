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

// The host's negotiated method set, as the relaunch switch reads it. A
// primitive slot rather than a nullable one so the tests below can flip it
// without a cast (`let x = false` narrows to `false` under this repo's rules).
const hostMethods = { configure: true };
const supportsMethodSpy = vi.fn(
  (_hostId: string | null, method: string) =>
    method === "managedCommand.configure" && hostMethods.configure,
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) =>
    supportsMethodSpy(hostId, method),
}));

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
  supportsMethodSpy.mockClear();
  hostMethods.configure = true;
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
    // And the gate was asked about THIS command's host, not the app-wide one.
    expect(supportsMethodSpy).toHaveBeenCalledWith(
      "host-1",
      "managedCommand.configure",
    );
  });

  it("hides the relaunch switch on a host that did not negotiate managedCommand.configure", () => {
    // The method is off the released floor, so an older host negotiates it
    // away; a switch against it could only fail. The rest of the row stays -
    // asserted positively, since "switch absent" is also true of a row that
    // failed to render at all.
    hostMethods.configure = false;
    renderActions({ ...RUNNING, relaunchOnHostRestart: true });

    expect(
      screen.queryByRole("button", { name: "Relaunches after a host restart" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Stays down after a host restart" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
    expect(configureMutate).not.toHaveBeenCalled();
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
