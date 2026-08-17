import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
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
import { PaneSurfaceActivityContext } from "@/components/epic-tabs/pane-visibility-context";
import { modLabel } from "@/lib/keybindings/platform";

const dialogMocks = vi.hoisted(() => ({
  create: vi.fn<(input: TerminalForkCreateInput) => Promise<string | null>>(),
  // Keyed by the exact `client` reference `useHostQuery` was called with, so
  // tests can assert the dialog reads `providers.list` from the RIGHT host
  // client (its own `hostClient` prop) and never a decoy/other one.
  providersByClient: new Map<unknown, unknown>(),
  forkProfileSupported: true,
  toast: vi.fn<(message: string) => void>(),
  // Stable identity across re-renders: a fresh `vi.fn()` per hook call would
  // re-trigger the dialog's admission effect forever (mutateAsync is in the
  // effect dep array), hanging any continue-mode test that waits for
  // cross-profile settlement.
  validateMutateAsync: vi.fn().mockResolvedValue({ verdicts: [] }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/agent/use-create-tui-agent")>();
  return {
    ...actual,
    useCreateTuiAgentForClient: () => ({
      create: dialogMocks.create,
      isPending: false,
    }),
  };
});

// Bulk fork-admission preflight is stubbed so continue-mode tests that open
// the dialog don't hit the partially-mocked `use-host-query` module below
// (which only implements `useHostQuery`, not the mutation-lifecycle helper).
vi.mock("@/hooks/agent/use-validate-tui-fork-profile-mutation", () => ({
  useValidateTuiForkProfile: () => ({
    mutateAsync: dialogMocks.validateMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/hooks/agent/use-tui-fork-profile-support", () => ({
  useTuiForkProfileSupported: () => dialogMocks.forkProfileSupported,
}));

vi.mock("sonner", () => ({
  toast: (message: string) => {
    dialogMocks.toast(message);
  },
}));

// The dialog validates its seeded profileId against live `providers.list`
// read from its OWN `hostClient` prop (see resolve-seeded-profile-id.ts /
// use-resolved-seeded-profile-id.ts) via `useHostQuery` directly - not the
// app-wide active host. Every case in this file passes `hostClient={null}`,
// and `dialogMocks.providersByClient` has no entry for `null` unless a test
// seeds one - so `useHostQuery` returns no data by default and every seed
// holds its profileId verbatim (no profiles to judge against).
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

// Stub picker that still exposes the toolbar store so continue-mode title
// tests can flip the selected profile without pulling in the full picker.
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: {
    readonly store: {
      readonly getState: () => {
        readonly selection: {
          readonly harnessId: string;
          readonly modelSlug: string;
          readonly profileId: string | null;
        };
        readonly setSelection: (next: {
          readonly harnessId: string;
          readonly modelSlug: string;
          readonly profileId: string | null;
        }) => void;
      };
    };
  }) => {
    const selection = props.store.getState().selection;
    return (
      <div>
        <button type="button" aria-label="Harness picker">
          Claude Opus
        </button>
        <button
          type="button"
          aria-label="Select Work profile"
          onClick={() =>
            props.store.getState().setSelection({
              harnessId: selection.harnessId,
              modelSlug: selection.modelSlug,
              profileId: "work-profile",
            })
          }
        >
          Select Work
        </button>
        <button
          type="button"
          aria-label="Select ambient profile"
          onClick={() =>
            props.store.getState().setSelection({
              harnessId: selection.harnessId,
              modelSlug: selection.modelSlug,
              profileId: null,
            })
          }
        >
          Select ambient
        </button>
      </div>
    );
  },
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
  useGuiHarnessesQueryForClient: () => ({
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
  useGuiHarnessModelsQueryForClient: () => ({
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

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { TuiForkProfileAdmissionSubcode } from "@traycer/protocol/host/agent/tui/unary-schemas";
import { TuiForkProfileRejectedError } from "@/lib/tui-fork-profile-rejection";
import { TerminalAgentForkDialog } from "../terminal-agent-fork-dialog";

describe("<TerminalAgentForkDialog />", () => {
  afterEach(() => {
    dialogMocks.create.mockReset();
    dialogMocks.providersByClient.clear();
    dialogMocks.forkProfileSupported = true;
    dialogMocks.toast.mockReset();
    dialogMocks.validateMutateAsync.mockReset();
    dialogMocks.validateMutateAsync.mockResolvedValue({ verdicts: [] });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("forks the terminal agent with Cmd+Enter", async () => {
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "fork",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    const forkButton = screen.getByRole("button", { name: "Fork" });
    expect(forkButton.textContent).toContain(modLabel());
    expect(forkButton.textContent).toContain("↵");

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledTimes(1);
    });
  });

  it("submits folderless when the live picker removes the seed's last folder", async () => {
    const folder = {
      path: "/workspace",
      name: "workspace",
      repoIdentifier: null,
      hostId: null,
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
      .setSnapshot(
        pendingForkTerminalAgentStagingKey("host-test", "epic-test"),
        {
          folders: [],
          folderInfoByPath: {},
          primaryPath: null,
        },
      );
    dialogMocks.create.mockResolvedValue("forked-agent");
    render(
      <TerminalAgentForkDialog
        open
        target={{ sourceAgent: sourceAgent(), workspaceSeed, intent: "fork" }}
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
    const stagingKey = pendingForkTerminalAgentStagingKey(
      "host-test",
      "epic-test",
    );
    const onOpenChange = vi.fn();

    const { rerender } = render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: workspaceSeedForFolder(REPO_A),
          intent: "fork",
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
          intent: "fork",
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
          intent: "fork",
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

  it("un-presents a background fork portal without resetting the pending fork lifecycle", async () => {
    const createState: {
      resolve: ((value: string | null) => void) | null;
    } = { resolve: null };
    dialogMocks.create.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          createState.resolve = resolve;
        }),
    );

    function FocusHarness() {
      const [focused, setFocused] = useState(true);
      return (
        <PaneSurfaceActivityContext.Provider value={{ visible: true, focused }}>
          <button type="button" onClick={() => setFocused(false)}>
            Focus partner
          </button>
          <button type="button" onClick={() => setFocused(true)}>
            Focus fork
          </button>
          <TerminalAgentForkDialog
            open
            target={{
              sourceAgent: sourceAgent(),
              workspaceSeed: emptyWorkspaceSeed(),
              intent: "fork",
            }}
            epicId="epic-test"
            tabId="tab-test"
            hostId="host-test"
            hostClient={null}
            onOpenChange={() => undefined}
          />
        </PaneSurfaceActivityContext.Provider>
      );
    }

    render(<FocusHarness />);
    const title = screen.getByRole("textbox", {
      name: "Fork terminal agent title",
    });
    fireEvent.change(title, { target: { value: "Staged sibling fork" } });
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledTimes(1);
    });
    expectButtonDisabled(/^Fork/);

    fireEvent.click(getDocumentButton("Focus partner"));
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();

    fireEvent.click(getDocumentButton("Focus fork"));
    expectTextInputValue("Fork terminal agent title", "Staged sibling fork");
    expectButtonDisabled(/^Fork/);
    fireEvent.click(screen.getByRole("button", { name: /^Fork/ }));
    expect(dialogMocks.create).toHaveBeenCalledTimes(1);

    const completeCreate = createState.resolve;
    if (completeCreate === null) {
      throw new Error("fork dialog did not start creation");
    }
    await act(async () => {
      completeCreate("forked-agent");
      await Promise.resolve();
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
          intent: "fork",
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
          intent: "fork",
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
          intent: "fork",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    const argsInput = screen.getByRole("textbox", {
      name: "Terminal interface CLI arguments",
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

  it("renders continue-mode title, compact field layout, and CTA copy", () => {
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "continue",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Continue under another profile" }),
    ).toBeDefined();
    expect(screen.getByText("Continue under")).toBeDefined();
    expect(
      screen
        .getByTestId("terminal-fork-dialog-fields")
        .classList.contains("md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"),
    ).toBe(true);
    expect(
      screen.queryByText(
        "Choose which profile to continue this session under.",
      ),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
  });

  it.each([
    {
      subcode: "SCOPE_MISMATCH" as const,
      expected:
        "Can't continue this session under the default profile. It doesn't share conversation history with the default profile. Choose a shared profile, or start a new terminal agent.",
    },
    {
      subcode: "TARGET_PROFILE_UNAVAILABLE" as const,
      expected:
        "Can't continue this session under the default profile. That profile isn't available right now - it may be signed out, still finishing setup, or no longer supported. Choose a different profile, or start a new terminal agent.",
    },
    {
      subcode: "FORK_SOURCE_NOT_FOUND" as const,
      expected:
        "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
    },
    {
      subcode: "FORK_SOURCE_AMBIGUOUS" as const,
      expected:
        "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
    },
    {
      subcode: "SOURCE_NOT_READY" as const,
      expected:
        "This session has no conversation yet - send a message before forking.",
    },
  ])(
    "shows an inline rejection alert for preflight subcode $subcode without closing",
    async ({
      subcode,
      expected,
    }: {
      readonly subcode: TuiForkProfileAdmissionSubcode;
      readonly expected: string;
    }) => {
      const onOpenChange = vi.fn();
      dialogMocks.create.mockRejectedValueOnce(
        new TuiForkProfileRejectedError(subcode, `preflight ${subcode}`),
      );
      render(
        <TerminalAgentForkDialog
          open
          target={{
            sourceAgent: sourceAgent(),
            workspaceSeed: emptyWorkspaceSeed(),
            intent: "continue",
          }}
          epicId="epic-test"
          tabId="tab-test"
          hostId="host-test"
          hostClient={null}
          onOpenChange={onOpenChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => {
        const alert = screen.getByRole("alert");
        expect(alert.textContent).toContain(expected);
        expect(alert.classList.contains("grid")).toBe(true);
      });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      // Dialog stays interactive: Cancel and title input remain available.
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
      const titleInput = screen.getByRole("textbox", {
        name: "Continue under another profile title",
      });
      if (!(titleInput instanceof HTMLInputElement)) {
        throw new Error("expected title input");
      }
      expect(titleInput.disabled).toBe(false);
      fireEvent.change(titleInput, { target: { value: "Still editable" } });
      expect(titleInput.value).toBe("Still editable");
    },
  );

  it("shows residueNote from a late prepareLaunch SCOPE_MISMATCH HostRpcError", async () => {
    const onOpenChange = vi.fn();
    dialogMocks.create.mockRejectedValueOnce(
      new HostRpcError({
        code: "E_INVALID_ARGUMENT",
        message:
          "SCOPE_MISMATCH: profiles don't share history. Local worktree residue may remain.",
        requestId: "req-test",
        method: "agent.tui.prepareLaunch",
        fatalDetails: null,
      }),
    );
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "continue",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(
        "Can't continue this session under the default profile.",
      );
      expect(alert.textContent).toContain(
        "profiles don't share history. Local worktree residue may remain.",
      );
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("updates the live default title when the picker profile changes, and freezes after typing", async () => {
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "fork",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    expectTextInputValue("Fork terminal agent title", "Fork - Source terminal");

    fireEvent.click(
      screen.getByRole("button", { name: "Select Work profile" }),
    );

    await waitFor(() => {
      expectTextInputValue(
        "Fork terminal agent title",
        "Continue · Work - Source terminal",
      );
    });

    // User-typed title freezes through further profile switches.
    fireEvent.change(
      screen.getByRole("textbox", { name: "Fork terminal agent title" }),
      { target: { value: "My custom title" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select ambient profile" }),
    );
    expectTextInputValue("Fork terminal agent title", "My custom title");
  });

  it("toasts Claude cross-profile lossiness after a successful fork", async () => {
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    dialogMocks.create.mockResolvedValue("forked-agent");
    const onOpenChange = vi.fn();
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "continue",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={onOpenChange}
      />,
    );

    // The bulk fork-admission preflight is gated to settlement (amend-01 Fix
    // 3), so a cross-profile pick must wait for the mocked mutation's
    // microtask to resolve before the CTA will accept it.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select Work profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "work-profile" }),
      );
    });
    await waitFor(() => {
      expect(dialogMocks.toast).toHaveBeenCalledWith(
        "Continuing under Work - TodoWrite history and rewind state from the original session won't carry over.",
      );
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("locks cross-profile selection through the primary Fork button when the old-host capability is absent (mixed-version regression)", async () => {
    dialogMocks.forkProfileSupported = false;
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "fork",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    // This file's stub picker has no admission awareness of its own (real
    // row-disabling is covered by `profile-dropdown.test.tsx`) - clicking it
    // stands in for "some UI path reached a cross-profile pick", proving the
    // dialog's OWN capability lock refuses the submit regardless.
    fireEvent.click(
      screen.getByRole("button", { name: "Select Work profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(dialogMocks.create).not.toHaveBeenCalled();

    // Same-profile Fork stays fully functional under capability absence.
    fireEvent.click(
      screen.getByRole("button", { name: "Select ambient profile" }),
    );
    dialogMocks.create.mockResolvedValue("forked-agent");
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => {
      expect(dialogMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: null }),
      );
    });
  });

  it("shows the pick-time Claude cross-profile lossiness hint only after a different profile is selected in continue mode", async () => {
    const claudeHint =
      "Heads up: TodoWrite history and rewind state from this session won't carry over to the new profile.";
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: sourceAgent(),
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "continue",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    // Same-profile selection (open defaults to the source ambient profile):
    // the pick-time hint must stay hidden until a different profile is chosen.
    expect(screen.queryByText(claudeHint)).toBeNull();

    // Bulk admission settles before a cross-profile pick is actionable; flush
    // the mocked mutation microtask first (same pattern as the post-fork toast).
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select Work profile" }),
    );

    expect(screen.getByText(claudeHint)).toBeDefined();
  });

  it("does not show the pick-time Claude lossiness hint for a non-Claude harness", async () => {
    const claudeHint =
      "Heads up: TodoWrite history and rewind state from this session won't carry over to the new profile.";
    seedClaudeProviders([
      ambientProfile("Terminal account"),
      managedProfile("work-profile", "Work"),
    ]);
    render(
      <TerminalAgentForkDialog
        open
        target={{
          sourceAgent: { ...sourceAgent(), harnessId: "codex" },
          workspaceSeed: emptyWorkspaceSeed(),
          intent: "continue",
        }}
        epicId="epic-test"
        tabId="tab-test"
        hostId="host-test"
        hostClient={null}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.queryByText(claudeHint)).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select Work profile" }),
    );

    // Cross-profile selected, but harness is not Claude - no pick-time hint.
    expect(screen.queryByText(claudeHint)).toBeNull();
  });
});

interface TerminalForkCreateInput {
  readonly onStatusChange:
    | ((
        status: "preparing-workspace" | "forking-session" | "starting-terminal",
      ) => void)
    | null;
}

function expectButtonDisabled(name: RegExp): void {
  const button = screen.getByRole("button", { name });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected fork button");
  }
  expect(button.disabled).toBe(true);
}

/**
 * Deliberately a raw `document` scan, not `screen.getByRole`. These tests drive
 * buttons while a Radix dialog is open, which marks the background subtree
 * `aria-hidden` - so the buttons are correctly absent from the accessibility
 * tree and a role query cannot reach them. Their un-presented-but-still-mounted
 * state is the behaviour under test, so the query has to bypass the a11y tree.
 */
function getDocumentButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`expected ${label} button`);
  }
  return button;
}

function expectTextInputValue(label: string, value: string): void {
  const input = screen.getByRole("textbox", { name: label });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`expected ${label} input`);
  }
  expect(input.value).toBe(value);
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
    archivedAt: null,
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
  hostId: null,
};
const REPO_A_EXTRA: WorkspaceFolderInfo = {
  path: "/repo-a-extra",
  name: "repo-a-extra",
  repoIdentifier: null,
  hostId: null,
};
const REPO_B: WorkspaceFolderInfo = {
  path: "/repo-b",
  name: "repo-b",
  repoIdentifier: null,
  hostId: null,
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

function ambientProfile(label: string): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function managedProfile(profileId: string, label: string): ProviderProfile {
  return {
    profileId,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function seedClaudeProviders(profiles: ReadonlyArray<ProviderProfile>): void {
  // `useProvidersListForClient(null, …)` keys the providers map under the
  // same `null` client reference every case in this file passes as hostClient.
  dialogMocks.providersByClient.set(null, [
    {
      providerId: "claude-code",
      label: "Claude Code",
      available: true,
      authType: "oauth",
      auth: {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      profiles,
    },
  ]);
}
