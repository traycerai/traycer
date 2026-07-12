import "../../../../__tests__/test-browser-apis";
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
    useWorkspaceFoldersStore.setState({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("starts an unseeded terminal agent with the populated global workspace", async () => {
    const folder = {
      path: "/repo/global",
      name: "global",
      repoIdentifier: null,
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
});
