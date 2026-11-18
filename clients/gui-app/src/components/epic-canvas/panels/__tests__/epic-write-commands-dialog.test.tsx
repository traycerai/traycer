import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import { EpicWriteCommandsDialog } from "@/components/epic-canvas/panels/epic-write-commands-dialog";
import { presentEpicWriteCommand } from "@/lib/epic-write-command-copy";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";

const mocks = vi.hoisted(() => ({
  retryWriteCommand: vi.fn<(commandId: string) => void>(),
  discardWriteCommand: vi.fn<(commandId: string) => void>(),
  commands: [] as CommandRecord<EpicWriteCommandIntent>[],
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicWriteCommands: () => mocks.commands,
}));

/**
 * The dialog reads `retryWriteCommand` / `discardWriteCommand` off the epic
 * store as selector functions - this mock is the selector's whole state
 * object, not a store, so any selector the dialog passes resolves against it.
 */
interface MockedOpenEpicState {
  readonly retryWriteCommand: (commandId: string) => void;
  readonly discardWriteCommand: (commandId: string) => void;
}

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: <T,>(selector: (state: MockedOpenEpicState) => T): T =>
    selector({
      retryWriteCommand: mocks.retryWriteCommand,
      discardWriteCommand: mocks.discardWriteCommand,
    }),
}));

afterEach(() => {
  cleanup();
  mocks.retryWriteCommand.mockReset();
  mocks.discardWriteCommand.mockReset();
  mocks.commands = [];
});

function queuedCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: {
      kind: "rename-artifact",
      artifactId: "a1",
      title: "Queued rename",
    },
    state: "pending",
    delivery: "queued",
    issuedAtMs: 1000,
    attempts: 0,
    expectedEntityVersion: null,
    resolution: null,
  };
}

function sendingCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: {
      kind: "rename-artifact",
      artifactId: "a2",
      title: "Sending rename",
    },
    state: "pending",
    delivery: "sending",
    issuedAtMs: 1000,
    attempts: 1,
    expectedEntityVersion: null,
    resolution: null,
  };
}

function unknownOutcomeCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: { kind: "delete-artifact", artifactId: "a3" },
    state: "pending",
    delivery: "unknown-outcome",
    issuedAtMs: 1000,
    attempts: 1,
    expectedEntityVersion: null,
    resolution: null,
  };
}

function committedCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: { kind: "reparent-artifact", artifactId: "a4", parentId: null },
    state: "committed",
    delivery: "settled",
    issuedAtMs: 1000,
    attempts: 1,
    expectedEntityVersion: 2,
    resolution: { kind: "committed", hostId: "host-9", entityVersion: 3 },
  };
}

function rejectedCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: {
      kind: "update-artifact-status",
      artifactId: "a5",
      artifactType: "ticket",
      status: 1,
    },
    state: "rejected",
    delivery: "settled",
    issuedAtMs: 1000,
    attempts: 1,
    expectedEntityVersion: 1,
    resolution: {
      kind: "rejected",
      code: "WORKTREE_BUSY",
      reason: "Another agent is using this worktree",
      retryable: true,
    },
  };
}

function readOnlyCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: { kind: "update-epic-title", title: "New title", updatedAt: 1000 },
    state: "rejected",
    delivery: "settled",
    issuedAtMs: 1000,
    attempts: 1,
    expectedEntityVersion: null,
    resolution: {
      kind: "rejected",
      code: "E_EPIC_READ_ONLY",
      reason: "This epic cannot be written to right now",
      retryable: false,
    },
  };
}

function supersededCommand(
  commandId: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: {
      kind: "rename-artifact",
      artifactId: "a6",
      title: "Replaced rename",
    },
    state: "superseded",
    delivery: "settled",
    issuedAtMs: 1000,
    attempts: 1,
    expectedEntityVersion: 1,
    resolution: { kind: "superseded", observedAtMs: 2000, via: "record-lane" },
  };
}

function renderDialog(commands: CommandRecord<EpicWriteCommandIntent>[]): void {
  mocks.commands = commands;
  render(<EpicWriteCommandsDialog open onOpenChange={vi.fn()} />);
}

function rowFor(commandId: string): HTMLElement {
  return screen.getByTestId(`epic-write-command-${commandId}`);
}

describe("<EpicWriteCommandsDialog />", () => {
  it("shows queued copy on a queued record", () => {
    const command = queuedCommand("cmd-queued");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("queued");
    expect(
      within(row).getByTestId("epic-write-command-status").textContent,
    ).toBe(presentEpicWriteCommand(command).statusLabel);
  });

  it("shows sending copy on a sending record", () => {
    const command = sendingCommand("cmd-sending");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("sending");
    expect(
      within(row).getByTestId("epic-write-command-status").textContent,
    ).toBe(presentEpicWriteCommand(command).statusLabel);
  });

  it("shows unknown-outcome copy on an unknown-outcome record", () => {
    const command = unknownOutcomeCommand("cmd-unknown");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("unknown-outcome");
    expect(
      within(row).getByTestId("epic-write-command-status").textContent,
    ).toBe(presentEpicWriteCommand(command).statusLabel);
  });

  it("shows committed (host-committed) copy on a committed record", () => {
    const command = committedCommand("cmd-committed");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("committed");
    expect(
      within(row).getByTestId("epic-write-command-status").textContent,
    ).toBe(presentEpicWriteCommand(command).statusLabel);
  });

  it("shows rejected copy on an ordinary rejected record", () => {
    const command = rejectedCommand("cmd-rejected");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("rejected");
    expect(
      within(row).getByTestId("epic-write-command-status").textContent,
    ).toBe(presentEpicWriteCommand(command).statusLabel);
  });

  it("shows read-only copy on an E_EPIC_READ_ONLY record, distinct from an ordinary rejection", () => {
    const command = readOnlyCommand("cmd-read-only");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("read-only");
    const status = within(row).getByTestId("epic-write-command-status");
    expect(status.textContent).toBe(
      presentEpicWriteCommand(command).statusLabel,
    );
    expect(status.textContent).not.toBe(
      presentEpicWriteCommand(rejectedCommand("other")).statusLabel,
    );
  });

  it("shows superseded copy on a superseded record", () => {
    const command = supersededCommand("cmd-superseded");
    renderDialog([command]);
    const row = rowFor(command.commandId);
    expect(row.getAttribute("data-stage")).toBe("superseded");
    expect(
      within(row).getByTestId("epic-write-command-status").textContent,
    ).toBe(presentEpicWriteCommand(command).statusLabel);
  });

  it("renders a rejected record as reachable and discardable, discarding by its own commandId", async () => {
    const user = userEvent.setup();
    const rejected = rejectedCommand("cmd-rejected");
    renderDialog([rejected]);
    const row = rowFor(rejected.commandId);
    const dismissButton = within(row).getByTestId("epic-write-command-discard");

    await user.click(dismissButton);

    expect(mocks.discardWriteCommand).toHaveBeenCalledTimes(1);
    expect(mocks.discardWriteCommand).toHaveBeenCalledWith(rejected.commandId);
  });

  it("offers retry on an unknown-outcome record without ever calling it automatically, then retries by commandId on click", async () => {
    const user = userEvent.setup();
    const unknown = unknownOutcomeCommand("cmd-unknown");
    renderDialog([unknown]);
    const row = rowFor(unknown.commandId);
    const retryButton = within(row).getByTestId("epic-write-command-retry");

    // The negative half is the load-bearing assertion: this state is never
    // auto-retried by the queue, so nothing may have called retry yet.
    expect(mocks.retryWriteCommand).not.toHaveBeenCalled();

    await user.click(retryButton);

    expect(mocks.retryWriteCommand).toHaveBeenCalledTimes(1);
    expect(mocks.retryWriteCommand).toHaveBeenCalledWith(unknown.commandId);
  });

  it("offers no retry control at all on an E_EPIC_READ_ONLY record", () => {
    const readOnly = readOnlyCommand("cmd-read-only");
    renderDialog([readOnly]);
    const row = rowFor(readOnly.commandId);

    expect(within(row).queryByTestId("epic-write-command-retry")).toBeNull();
  });

  it("offers no Dismiss on a pending record, queued or sending", () => {
    const queued = queuedCommand("cmd-queued");
    const sending = sendingCommand("cmd-sending");
    renderDialog([queued, sending]);

    for (const command of [queued, sending]) {
      const row = rowFor(command.commandId);
      expect(
        within(row).queryByTestId("epic-write-command-discard"),
      ).toBeNull();
    }
  });
});
