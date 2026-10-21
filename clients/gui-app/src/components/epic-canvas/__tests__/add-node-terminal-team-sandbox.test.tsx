/**
 * The canvas add-node terminal-agent launcher must not launch a harness a
 * team's sandbox does not offer: with the selected TUI harness blocked, Start
 * is disabled, neither a click nor Enter in the args field launches, and the
 * launcher says so. The gate is mocked as a per-test predicate.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UNAVAILABLE_COPY = "Not available on team sandboxes.";

const mocks = vi.hoisted(() => ({
  onAddTerminalAgent: vi.fn(),
}));

const gateState = vi.hoisted(() => ({
  blockedIds: new Set<string>(),
}));

vi.mock("@/hooks/sandboxes/use-team-sandbox-harness-blocked", () => {
  const isBlocked = (harnessId: string): boolean =>
    gateState.blockedIds.has(harnessId);
  return {
    useTeamSandboxHarnessGate: () => isBlocked,
    useTeamSandboxHarnessBlocked: (input: {
      readonly harnessId: string | null;
    }): boolean => input.harnessId !== null && isBlocked(input.harnessId),
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => hostId,
}));

vi.mock("@/hooks/host/use-composer-surface-host-pin", () => {
  const pin = () => ({
    selection: null,
    honoredSelection: null,
    setSelection: () => undefined,
    resolvedHostId: "active-host",
    isPinned: false,
    latchOnFirstUse: () => undefined,
  });
  return {
    useComposerSurfaceHostPin: pin,
    useStartPageComposerHostPin: pin,
    useIsTeamOwnedHost: () => () => false,
    startPageHostPin: <T,>(value: T): T => value,
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  const store = createStore(() => ({
    selection: {
      harnessId: "claude",
      modelSlug: "claude-opus-4-7",
      profileId: null,
    },
    reasoning: "high",
    agentMode: "regular" as const,
    setAgentMode: () => undefined,
    catalog: {
      harnesses: [{ id: "claude", modes: ["gui", "tui"] }],
    },
  }));
  return { useComposerToolbarStore: () => store };
});

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div>Claude Opus</div>,
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => <div>Regular</div>,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: [{ providerId: "claude-code", terminalAgentArgs: "" }] },
  }),
  useProvidersListForClient: () => ({
    data: { providers: [{ providerId: "claude-code", terminalAgentArgs: "" }] },
  }),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: () => <div>Workspace picker</div>,
  }),
);

import { AddNodeDropdown } from "../add-node-dropdown";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { TEAM_SANDBOX_HARNESS_UNAVAILABLE } from "@/lib/sandboxes/team-sandbox-harness";

async function openTerminalAgentLauncher(): Promise<void> {
  render(
    <AddNodeDropdown
      open
      onOpenChange={() => undefined}
      menuPlacement="row"
      menuTestId="add-node-menu"
      itemTestId={(type) => `add-${type}`}
      onAdd={() => undefined}
      epicId="epic-test"
      onAddTerminalAgent={mocks.onAddTerminalAgent}
      terminalAgentWorkspaceSeed={null}
      terminalAgentHostScope={undefined}
      terminalAgentStagingKey={undefined}
      tuiAgentPending={false}
      disabled={false}
      disabledTooltip={null}
      disabledTypes={undefined}
      excludeTypes={undefined}
    >
      <button type="button">Add node</button>
    </AddNodeDropdown>,
  );
  const trigger = await screen.findByTestId("add-node-menu-terminal-agent");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  await screen.findByRole("button", { name: "Start" });
}

function startButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Start" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Start is not a button element");
  }
  return button;
}

describe("<AddNodeDropdown /> terminal-agent launch on a team sandbox", () => {
  beforeEach(() => {
    gateState.blockedIds.clear();
  });

  afterEach(() => {
    mocks.onAddTerminalAgent.mockReset();
    gateState.blockedIds.clear();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("carries the agreed refusal copy", () => {
    expect(TEAM_SANDBOX_HARNESS_UNAVAILABLE).toBe(UNAVAILABLE_COPY);
  });

  it("launches once and shows no notice when the selected harness is not blocked (control)", async () => {
    await openTerminalAgentLauncher();

    expect(
      screen.queryByTestId("add-node-team-sandbox-unavailable"),
    ).toBeNull();
    expect(startButton().disabled).toBe(false);

    fireEvent.click(startButton());

    await waitFor(() => {
      expect(mocks.onAddTerminalAgent).toHaveBeenCalledTimes(1);
    });
  });

  it("disables Start, launches nothing and says why when the selected harness is blocked", async () => {
    gateState.blockedIds.add("claude");
    await openTerminalAgentLauncher();

    const notice = screen.getByTestId("add-node-team-sandbox-unavailable");
    expect(notice.textContent).toBe(UNAVAILABLE_COPY);
    expect(startButton().disabled).toBe(true);

    fireEvent.click(startButton());

    expect(mocks.onAddTerminalAgent).not.toHaveBeenCalled();
  });

  it("does not launch from Enter in the args field when the selected harness is blocked", async () => {
    gateState.blockedIds.add("claude");
    await openTerminalAgentLauncher();

    const argsField = screen.getByLabelText("Terminal interface CLI arguments");
    fireEvent.keyDown(argsField, { key: "Enter" });

    expect(mocks.onAddTerminalAgent).not.toHaveBeenCalled();
  });

  it("launches from Enter in the args field when the selected harness is not blocked (control)", async () => {
    await openTerminalAgentLauncher();

    const argsField = screen.getByLabelText("Terminal interface CLI arguments");
    fireEvent.keyDown(argsField, { key: "Enter" });

    await waitFor(() => {
      expect(mocks.onAddTerminalAgent).toHaveBeenCalledTimes(1);
    });
  });
});
