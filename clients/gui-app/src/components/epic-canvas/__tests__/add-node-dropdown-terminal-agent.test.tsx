import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onAddTerminalAgent: vi.fn(),
}));

// Records the `hostId` each call was made with, so tests can assert the
// terminal-agent launcher resolves its picker's target host through THIS
// primitive - keyed on the launch host scope - rather than the app-wide
// default. The returned "client" is just the hostId echoed back: neither the
// mocked `useComposerToolbarStore` nor `useProvidersListForClient` below read
// it for content, only `add-node-dropdown.tsx` itself threads it through.
const hostClientForHostIdMock = vi.hoisted(() => ({
  calls: [] as Array<string | null>,
}));

// Records the host-scoped props each render passed to the picker, so tests
// can assert `createProfileHostId` / `runTargetHostId` follow the launch host
// scope without needing the real (heavy) picker to mount.
const harnessModelPickerMock = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly createProfileHostId: string | null;
    readonly runTargetHostId: string | null;
  }>,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    hostClientForHostIdMock.calls.push(hostId);
    return hostId;
  },
}));

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
  HarnessModelPicker: (props: {
    readonly createProfileHostId: string | null;
    readonly runTargetHostId: string | null;
  }) => {
    harnessModelPickerMock.calls.push({
      createProfileHostId: props.createProfileHostId,
      runTargetHostId: props.runTargetHostId,
    });
    return <div>Claude Opus</div>;
  },
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => <div>Regular</div>,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: {
      providers: [
        {
          providerId: "claude-code",
          terminalAgentArgs: "",
        },
      ],
    },
  }),
  // `TerminalAgentSubMenuContent` now reads through this (its fixed-scope
  // launch host client) rather than the app-wide `useProvidersList` - same
  // canned data, since this suite doesn't vary it by host.
  useProvidersListForClient: () => ({
    data: {
      providers: [
        {
          providerId: "claude-code",
          terminalAgentArgs: "",
        },
      ],
    },
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
import {
  pendingTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";

describe("<AddNodeDropdown /> terminal-agent launch", () => {
  afterEach(() => {
    mocks.onAddTerminalAgent.mockReset();
    hostClientForHostIdMock.calls.length = 0;
    harnessModelPickerMock.calls.length = 0;
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("opens a header add menu on the configured right side", async () => {
    render(
      <AddNodeDropdown
        open
        onOpenChange={() => undefined}
        menuPlacement="header"
        menuTestId="header-add-node-menu"
        itemTestId={(type) => `header-add-${type}`}
        onAdd={() => undefined}
        epicId="epic-test"
        onAddTerminalAgent={undefined}
        terminalAgentWorkspaceSeed={null}
        terminalAgentHostScope={undefined}
        terminalAgentStagingKey={undefined}
        tuiAgentPending={false}
        disabled={false}
        disabledTooltip={null}
        disabledTypes={undefined}
        excludeTypes={undefined}
      >
        <button type="button">Add artifact</button>
      </AddNodeDropdown>,
    );

    expect((await screen.findByRole("menu")).getAttribute("data-side")).toBe(
      "right",
    );
  });

  it("starts an unseeded terminal agent with the populated global workspace", async () => {
    const folder = {
      path: "/repo/global",
      name: "global",
      repoIdentifier: null,
      hostId: null,
    };
    const entry = {
      kind: "worktree" as const,
      scripts: null,
      workspacePath: folder.path,
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new" as const,
        name: "traycer/global-launch",
        source: "main",
        carryUncommittedChanges: false,
      },
    };
    useWorkspaceFoldersStore.setState({
      folders: [folder.path],
      folderInfoByPath: { [folder.path]: folder },
      primaryPath: folder.path,
    });
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(pendingTerminalAgentStagingKey("epic-test"), {
        entries: [entry],
      });

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

    const terminalAgentTrigger = await screen.findByTestId(
      "add-node-menu-terminal-agent",
    );
    terminalAgentTrigger.focus();
    fireEvent.keyDown(terminalAgentTrigger, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(mocks.onAddTerminalAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeIntent: { entries: [entry] },
          workspaceMode: "inherit",
        }),
      );
    });
  });

  it("resolves the picker's target host through useHostClientForHostId, keyed on the launch host scope", async () => {
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
        terminalAgentHostScope={{
          kind: "fixed",
          hostId: "host-b",
          hostClient: null,
        }}
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

    const terminalAgentTrigger = await screen.findByTestId(
      "add-node-menu-terminal-agent",
    );
    terminalAgentTrigger.focus();
    fireEvent.keyDown(terminalAgentTrigger, { key: "ArrowRight" });
    await screen.findByRole("button", { name: "Start" });

    expect(hostClientForHostIdMock.calls.at(-1)).toBe("host-b");
    expect(harnessModelPickerMock.calls.at(-1)).toEqual({
      createProfileHostId: "host-b",
      runTargetHostId: "host-b",
    });

    cleanup();
    hostClientForHostIdMock.calls.length = 0;
    harnessModelPickerMock.calls.length = 0;

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

    const undefinedScopeTrigger = await screen.findByTestId(
      "add-node-menu-terminal-agent",
    );
    undefinedScopeTrigger.focus();
    fireEvent.keyDown(undefinedScopeTrigger, { key: "ArrowRight" });
    await screen.findByRole("button", { name: "Start" });

    expect(hostClientForHostIdMock.calls.at(-1)).toBeNull();
    expect(harnessModelPickerMock.calls.at(-1)).toEqual({
      createProfileHostId: null,
      runTargetHostId: null,
    });
  });
});
