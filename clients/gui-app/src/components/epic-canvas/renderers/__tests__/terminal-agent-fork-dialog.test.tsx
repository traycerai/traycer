import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import {
  pendingForkTerminalAgentStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  readSeededWorkspaceSnapshot,
  useSeededWorkspaceSnapshotStore,
} from "@/stores/worktree/seeded-workspace-snapshot-store";

const dialogMocks = vi.hoisted(() => ({
  create: vi.fn<(input: TerminalForkCreateInput) => Promise<string | null>>(),
  // Keyed by the exact `client` reference `useHostQuery` was called with, so
  // tests can assert the dialog reads `providers.list` from the RIGHT host
  // client (its own `hostClient` prop) and never a decoy/other one.
  providersByClient: new Map<unknown, unknown>(),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    create: dialogMocks.create,
    isPending: false,
  }),
}));

// The dialog validates its seeded profileId against live `providers.list`
// read from its OWN `hostClient` prop (see resolve-seeded-profile-id.ts /
// use-resolved-seeded-profile-id.ts) via `useHostQuery` directly - not the
// app-wide active host. Every case in this file passes `hostClient={null}`,
// and `dialogMocks.providersByClient` has no entry for `null`, so
// `useHostQuery` returns no data here and every seed holds its profileId
// verbatim (no profiles to judge against) - exactly this file's existing
// expectation for every case.
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly client: unknown;
    readonly options: { readonly enabled: boolean } | null;
  }) => {
    if (!(args.options?.enabled ?? false)) return { data: undefined };
    const providers = dialogMocks.providersByClient.get(args.client);
    return { data: providers === undefined ? undefined : { providers } };
  },
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => (
    <button type="button" aria-label="Harness picker">
      Claude Opus
    </button>
  ),
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => (
    <button type="button" aria-label="Agent mode">
      Regular
    </button>
  ),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQuery: () => ({
    data: {
      models: [
        {
          harnessId: "claude",
          slug: "claude-opus-4-7",
          label: "Claude Opus",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    },
    isPending: false,
  }),
}));

import { TerminalAgentForkDialog } from "../terminal-agent-fork-dialog";

describe("<TerminalAgentForkDialog />", () => {
  afterEach(() => {
    dialogMocks.create.mockReset();
    dialogMocks.providersByClient.clear();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("submits folderless when the live picker removes the seed's last folder", async () => {
    const folder = {
      path: "/workspace",
      name: "workspace",
      repoIdentifier: null,
    };
    const workspaceSeed: ForkWorkspaceSeed = {
      workspace: {
        folders: [folder.path],
        folderInfoByPath: { [folder.path]: folder },
        primaryPath: folder.path,
      },
      intent: {
        entries: [
          {
            kind: "local",
            workspacePath: folder.path,
            repoIdentifier: null,
            isPrimary: true,
          },
        ],
      },
    };
    useSeededWorkspaceSnapshotStore
      .getState()
      .setSnapshot(pendingForkTerminalAgentStagingKey("epic-test"), {
        folders: [],
        folderInfoByPath: {},
        primaryPath: null,
      });
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{ sourceAgent: sourceAgent(), workspaceSeed }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceMode: "folderless",
          worktreeIntent: null,
        }),
      );
    });
  });

  it("does not bleed a CANCELLED fork's workspace into the next fork in the same epic", async () => {
    // `pendingForkTerminalAgentStagingKey` is per-epic, so both forks below
    // share one staging slot - and `readSeededLaunchWorkspace` prefers the
    // live snapshot over the new target's own `workspaceSeed`. Cancelling
    // must therefore drop this fork's scratch workspace, or fork B silently
    // launches into fork A's folders and primary.
    const stagingKey = pendingForkTerminalAgentStagingKey("epic-test");
    const onOpenChange = vi.fn();

    const { rerender } = render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: workspaceSeedForFolder(REPO_A),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={onOpenChange}
      />,
    );

    // The picker is mocked out in this file, so stand in for it: the user adds
    // a second folder and promotes it to primary, which the real picker
    // mirrors into exactly these two slots.
    act(() => {
      useSeededWorkspaceSnapshotStore.getState().setSnapshot(stagingKey, {
        folders: [REPO_A.path, REPO_A_EXTRA.path],
        folderInfoByPath: {
          [REPO_A.path]: REPO_A,
          [REPO_A_EXTRA.path]: REPO_A_EXTRA,
        },
        primaryPath: REPO_A_EXTRA.path,
      });
      useWorktreeIntentStagingStore.getState().setIntent(stagingKey, {
        entries: [
          localIntentEntry(REPO_A.path, false),
          localIntentEntry(REPO_A_EXTRA.path, true),
        ],
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(readSeededWorkspaceSnapshot(stagingKey)).toBeNull();
    expect(readStagedWorktreeIntent(stagingKey)).toBeNull();

    // The parent closes the dialog, then reopens it for a DIFFERENT source
    // agent - the same per-epic staging slot, a fresh seed.
    rerender(
      <TerminalAgentForkDialog
        open={false}
        target={null}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={onOpenChange}
      />,
    );
    dialogMocks.create.mockResolvedValue("forked-agent");
    rerender(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: { ...sourceAgent(), id: "other-source-agent" },
          workspaceSeed: workspaceSeedForFolder(REPO_B),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledTimes(1);
    });
    // Fork B launches into its OWN single folder. Without the cancel-time
    // clear it would inherit fork A's two folders and A's `/repo-a-extra`
    // primary out of the shared slot.
    expect(dialogMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceMode: "inherit",
        worktreeIntent: {
          entries: [localIntentEntry(REPO_B.path, true)],
        },
      }),
    );
  });

  it("submits an edited sibling title and reports fork progress", async () => {
    const createState: {
      input: TerminalForkCreateInput | null;
      resolve: ((value: string | null) => void) | null;
    } = { input: null, resolve: null };
    const onOpenChange = vi.fn();
    dialogMocks.create.mockImplementation((input) => {
      createState.input = input;
      return new Promise<string | null>((resolve) => {
        createState.resolve = resolve;
      });
    });
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={onOpenChange}
      />,
    );

    const titleInput = screen.getByRole("textbox", {
      name: "Fork terminal agent title",
    });
    expect((titleInput as HTMLInputElement).value).toBe(
      "Fork - Source terminal",
    );
    fireEvent.change(titleInput, { target: { value: "Sibling fork" } });
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledTimes(1);
    });
    expect(dialogMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: "source-parent",
        title: "Sibling fork",
        forkSourceHarnessSessionId: "source-session",
      }),
    );
    // The `onStatusChange` callback is captured + exercised below.
    expect(screen.getByRole("status").textContent).toBe(
      "Forking terminal agent",
    );

    const capturedInput = createState.input;
    const handleStatusChange = capturedInput?.onStatusChange ?? null;
    if (handleStatusChange === null) {
      throw new Error("fork dialog did not pass a status callback");
    }
    act(() => {
      handleStatusChange("starting-terminal");
    });
    expect(screen.getByRole("status").textContent).toBe("Starting terminal");

    const completeCreate = createState.resolve;
    if (completeCreate === null) {
      throw new Error("fork dialog did not start creation");
    }
    await act(async () => {
      completeCreate("forked-agent");
      // Flush the create promise's resolution chain inside act.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("seeds the fork from the source agent's profile", async () => {
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgentWithProfile("work-profile"),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "work-profile" }),
      );
    });
  });

  it("seeds an ambient source agent's fork with a null profileId", async () => {
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: null }),
      );
    });
  });

  it("prefills and forwards the source terminal-agent additional args", async () => {
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgentWithTerminalArgs("--from-source"),
          workspaceSeed: emptyWorkspaceSeed(),
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    const argsInput = screen.getByRole("textbox", {
      name: "Terminal agent additional arguments",
    });
    expect((argsInput as HTMLInputElement).value).toBe("--from-source");
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalAgentArgs: "--from-source",
        }),
      );
    });
  });
});

interface TerminalForkCreateInput {
  readonly onStatusChange:
    | ((
        status: "preparing-workspace" | "forking-session" | "starting-terminal",
      ) => void)
    | null;
}

function sourceAgent(): TuiAgentProjection {
  return sourceAgentWithTerminalArgs(null);
}

function sourceAgentWithProfile(profileId: string | null): TuiAgentProjection {
  return { ...sourceAgentWithTerminalArgs(null), profileId };
}

function sourceAgentWithTerminalArgs(
  terminalAgentArgs: string | null,
): TuiAgentProjection {
  return {
    id: "source-agent",
    harnessId: "claude",
    title: "Source terminal",
    parentId: "source-parent",
    createdAt: 0,
    updatedAt: 0,
    userId: "user-test",
    hostId: "host-test",
    workspaceFolders: ["/workspace"],
    workspaceMode: undefined,
    model: "claude-opus-4-7",
    reasoningEffort: "high",
    agentMode: "regular",
    profileId: null,
    harnessSessionId: "source-session",
    terminalAgentArgs,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--resume", "source-session"],
  };
}

function emptyWorkspaceSeed(): ForkWorkspaceSeed {
  return {
    workspace: { folders: [], folderInfoByPath: {}, primaryPath: null },
    intent: null,
  };
}

const REPO_A: WorkspaceFolderInfo = {
  path: "/repo-a",
  name: "repo-a",
  repoIdentifier: null,
};
const REPO_A_EXTRA: WorkspaceFolderInfo = {
  path: "/repo-a-extra",
  name: "repo-a-extra",
  repoIdentifier: null,
};
const REPO_B: WorkspaceFolderInfo = {
  path: "/repo-b",
  name: "repo-b",
  repoIdentifier: null,
};

function localIntentEntry(
  workspacePath: string,
  isPrimary: boolean,
): WorktreeFolderIntent {
  return { kind: "local", workspacePath, repoIdentifier: null, isPrimary };
}

function workspaceSeedForFolder(
  folder: WorkspaceFolderInfo,
): ForkWorkspaceSeed {
  return {
    workspace: {
      folders: [folder.path],
      folderInfoByPath: { [folder.path]: folder },
      primaryPath: folder.path,
    },
    intent: { entries: [localIntentEntry(folder.path, true)] },
  };
}
