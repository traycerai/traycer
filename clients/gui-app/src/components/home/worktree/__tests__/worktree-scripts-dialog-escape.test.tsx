/**
 * Integration: Escape while Branch naming is editing must cancel only the
 * editor at the Radix Dialog dismiss boundary - not close Worktree environment
 * or discard unsaved scripts. Uses the REAL Dialog/DialogContent primitives
 * (no dialog mock) so capture-phase Escape ordering matches production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  WorktreeEntryScripts,
  WorktreeIntent,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

const mocks = vi.hoisted(() => ({
  setRepoScriptsMutate: vi.fn<(variables: unknown, options: unknown) => void>(),
  setRepoBranchPrefixMutate:
    vi.fn<(variables: unknown, options: unknown) => void>(),
  supportsSetRepoBranchPrefix: { current: true },
  repoBranchPrefixUpdated: { current: true },
  listAllForHost: vi.fn(() => ({
    data: undefined as
      | {
          readonly worktrees: ReadonlyArray<{
            readonly worktreePath: string;
            readonly scripts: WorktreeEntryScripts | null;
          }>;
        }
      | undefined,
    isSuccess: false,
  })),
  readScriptsAtRef: vi.fn(
    (): {
      readonly data:
        { readonly scripts: WorktreeEntryScripts | null } | undefined;
      readonly isSuccess: boolean;
      readonly isError: boolean;
    } => ({
      data: { scripts: null },
      isSuccess: true,
      isError: false,
    }),
  ),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.supportsSetRepoBranchPrefix.current,
}));

vi.mock("@/hooks/worktree/use-worktree-set-repo-scripts-mutation", () => ({
  useWorktreeSetRepoScriptsFor: () => ({
    mutate: mocks.setRepoScriptsMutate,
    mutateAsync: (variables: unknown) => {
      mocks.setRepoScriptsMutate(variables, undefined);
      return Promise.resolve();
    },
    isPending: false,
  }),
}));

vi.mock(
  "@/hooks/worktree/use-worktree-set-repo-branch-prefix-mutation",
  () => ({
    useWorktreeSetRepoBranchPrefixFor: () => ({
      mutate: (
        variables: unknown,
        options: { readonly onSuccess: (data: { updated: boolean }) => void },
      ) => {
        mocks.setRepoBranchPrefixMutate(variables, options);
        options.onSuccess({ updated: mocks.repoBranchPrefixUpdated.current });
      },
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (opts: {
    readonly method: string;
    readonly params: {
      readonly workspacePaths: ReadonlyArray<string>;
      readonly scriptRefs: ReadonlyArray<{
        readonly workspacePath: string;
        readonly ref: string;
      }>;
    };
  }) => {
    if (opts.method === "worktree.listByWorkspacePaths") {
      const entry = opts.params.scriptRefs.at(0);
      const result = mocks.readScriptsAtRef();
      if (result.data === undefined) {
        return {
          data: undefined,
          isSuccess: result.isSuccess,
          isError: result.isError,
        };
      }
      const scriptsAtRefs =
        entry === undefined
          ? []
          : [
              {
                workspacePath: entry.workspacePath,
                ref: entry.ref,
                scripts: result.data.scripts,
              },
            ];
      return {
        data: { workspaces: [], scriptsAtRefs },
        isSuccess: result.isSuccess,
        isError: result.isError,
      };
    }
    return mocks.listAllForHost();
  },
}));

// Intentionally NOT mocking `@/components/ui/dialog` - this suite needs the
// real Radix dismissable-layer capture-phase Escape listener.

import {
  WorktreeScriptsDialog,
  type WorktreeScriptsContext,
} from "@/components/home/worktree/worktree-scripts-dialog";

const WORKSPACE = "/tmp/a";
const STAGING_KEY: WorktreeStagingKey = {
  surface: "landing",
  hostId: "host-a",
  draftId: null,
};

function summaryWith(
  scripts: WorktreeWorkspaceSummaryV14["scripts"],
): WorktreeWorkspaceSummaryV14 {
  return {
    workspacePath: WORKSPACE,
    isGitRepo: true,
    repoIdentifier: null,
    mainBranch: "main",
    worktrees: [],
    scripts,
    repoBranchPrefix: { status: "absent" },
    resolvedAt: 1,
  };
}

function stagedWorktreeIntent(
  scripts: WorktreeEntryScripts | null,
): WorktreeIntent {
  return {
    entries: [
      {
        kind: "worktree",
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: "feat/login",
          source: "main",
          carryUncommittedChanges: false,
        },
        scripts,
      },
    ],
  };
}

const PRE_CREATE_CONTEXT: WorktreeScriptsContext = {
  epicId: "",
  ownerId: null,
  ownerKind: null,
  binding: null,
  stagingKey: STAGING_KEY,
  hostClient: null,
  regenerateBranchNameForWorkspace: (
    _path: string,
    prefixState: { readonly status: string; readonly value?: string },
    suffix: string,
  ) =>
    prefixState.status === "present" && typeof prefixState.value === "string"
      ? `${prefixState.value}${suffix}`
      : `traycer/${suffix}`,
};

function renderDialog() {
  const onOpenChange = vi.fn();
  useWorktreeIntentStagingStore
    .getState()
    .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
  render(
    <TooltipProvider>
      <WorktreeScriptsDialog
        open
        onOpenChange={onOpenChange}
        target={{ workspacePath: WORKSPACE, summary: summaryWith(null) }}
        context={PRE_CREATE_CONTEXT}
      />
    </TooltipProvider>,
  );
  return { onOpenChange };
}

function setupDefaultField(): HTMLTextAreaElement {
  const field = screen.getByLabelText("Setup script (Default)");
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error("expected the setup default textarea");
  }
  return field;
}

describe("<WorktreeScriptsDialog /> Escape at Radix dismiss boundary", () => {
  beforeEach(() => {
    useWorktreeIntentStagingStore.setState({ intentByKey: {} });
    mocks.setRepoScriptsMutate.mockReset();
    mocks.setRepoBranchPrefixMutate.mockReset();
    mocks.supportsSetRepoBranchPrefix.current = true;
    mocks.repoBranchPrefixUpdated.current = true;
    mocks.listAllForHost.mockReturnValue({
      data: undefined,
      isSuccess: false,
    });
    mocks.readScriptsAtRef.mockReturnValue({
      data: { scripts: null },
      isSuccess: true,
      isError: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("Escape while editing Branch naming cancels the edit, keeps the dialog open, and preserves dirty scripts", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Dirty an unrelated scripts field first.
    fireEvent.change(setupDefaultField(), {
      target: { value: "echo unsaved-scripts" },
    });
    expect(setupDefaultField().value).toBe("echo unsaved-scripts");

    // Enter Branch naming editing (fresh override).
    fireEvent.click(screen.getByTestId("repo-branch-prefix-choice-override"));
    expect(screen.getByLabelText("Prefix")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prefix"), {
      target: { value: "team/" },
    });

    // Fire Escape at the document/dialog level - Radix listens in capture phase
    // on document, so this is the regression that a mock Dialog cannot catch.
    await user.keyboard("{Escape}");

    // (a) dialog still open
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // (b) Branch naming back in non-editing (inherited) view
    expect(screen.queryByLabelText("Prefix")).toBeNull();
    expect(screen.getByTestId("repo-branch-prefix-choice-global")).toBeTruthy();

    // (c) scripts field still has the unsaved edit
    expect(setupDefaultField().value).toBe("echo unsaved-scripts");

    // Second Escape (not editing) closes the dialog normally.
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Escape while editing an existing saved override also cancels only the editor", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    render(
      <TooltipProvider>
        <WorktreeScriptsDialog
          open
          onOpenChange={onOpenChange}
          target={{
            workspacePath: WORKSPACE,
            summary: {
              ...summaryWith(null),
              repoBranchPrefix: { status: "present", value: "team/" },
            },
          }}
          context={PRE_CREATE_CONTEXT}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    fireEvent.change(setupDefaultField(), {
      target: { value: "make install" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));
    expect(screen.getByLabelText("Prefix")).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByLabelText("Prefix")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit prefix" })).toBeTruthy();
    expect(setupDefaultField().value).toBe("make install");
  });
});
