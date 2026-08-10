import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  WorktreeBinding,
  WorktreeEntryScripts,
  WorktreeIntent,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

// Isolate the dialog's prefill + save-target logic: mock the set-repo-scripts
// mutation and the listAllForHost query so no QueryClient/host client is
// needed, and exercise the real staging store + the real shared modal.
const mocks = vi.hoisted(() => ({
  setRepoScriptsMutate: vi.fn<(variables: unknown, options: unknown) => void>(),
  setRepoBranchPrefixMutate:
    vi.fn<(variables: unknown, options: unknown) => void>(),
  // Flips a test's `mutateAsync` to reject, exercising the dialog's failed-save
  // path (must NOT show "Saved").
  rejectSave: { current: false },
  // Host method gate for the repo-prefix section Save button.
  supportsSetRepoBranchPrefix: { current: true },
  // The mutation's simulated RPC response - `false` reproduces the host's
  // non-git / vanished-checkout no-op (`{ updated: false }`).
  repoBranchPrefixUpdated: { current: true },
  listAllForHost: vi.fn<
    () => {
      readonly data:
        | {
            readonly worktrees: ReadonlyArray<{
              readonly worktreePath: string;
              readonly scripts: WorktreeEntryScripts | null;
            }>;
          }
        | undefined;
      readonly isSuccess: boolean;
    }
  >(() => ({ data: undefined, isSuccess: false })),
  // The source-branch scripts read. Defaults to "settled, no committed scripts"
  // so most tests fall through to summary.scripts exactly as the create path does.
  // The dialog now fetches this via `worktree.listByWorkspacePaths` v1.1; the
  // useHostQuery mock below adapts this single-ref fixture into that shape.
  readScriptsAtRef: vi.fn<
    () => {
      readonly data:
        { readonly scripts: WorktreeEntryScripts | null } | undefined;
      readonly isSuccess: boolean;
      readonly isError: boolean;
    }
  >(() => ({ data: { scripts: null }, isSuccess: true, isError: false })),
  // Captures the git ref the dialog requests in its `scriptRefs` point-read, so
  // tests can pin that the SOURCE branch (new) / checkout branch is read - not
  // just that the query fired.
  lastReadScriptsRef: { current: "" },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.supportsSetRepoBranchPrefix.current,
}));

vi.mock("@/hooks/worktree/use-worktree-set-repo-scripts-mutation", () => ({
  useWorktreeSetRepoScriptsFor: () => ({
    mutate: mocks.setRepoScriptsMutate,
    // The dialog now drives its success state off `mutateAsync`'s promise; route
    // it through the same spy so the per-target call assertions still hold.
    mutateAsync: (variables: unknown) => {
      mocks.setRepoScriptsMutate(variables, undefined);
      return mocks.rejectSave.current
        ? Promise.reject(new Error("save failed"))
        : Promise.resolve();
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
    // `scriptRefs` is required: the v1.1 request always carries it (empty when
    // there is no source ref). Reading it without optional chaining below makes a
    // regression where the dialog stops sending the field fail loudly instead of
    // silently degrading to an empty request.
    readonly params: {
      readonly workspacePaths: ReadonlyArray<string>;
      readonly scriptRefs: ReadonlyArray<{
        readonly workspacePath: string;
        readonly ref: string;
      }>;
    };
  }) => {
    // The source-branch preview rides `worktree.listByWorkspacePaths` v1.1 as a
    // point-read (`scriptRefs: [{ workspacePath, ref }]` -> `scriptsAtRefs`).
    // Adapt the single-ref `readScriptsAtRef` fixture into that response shape so
    // the existing per-test fixtures keep working unchanged.
    if (opts.method === "worktree.listByWorkspacePaths") {
      // The preview is a pure point-read: it must list NO workspaces (empty
      // `workspacePaths`) and carry the scripts read on `scriptRefs`. Fail loudly
      // if the dialog ever regresses to a workspace-summary list.
      if (opts.params.workspacePaths.length > 0) {
        throw new Error(
          `worktree.listByWorkspacePaths preview must send workspacePaths: [], got ${JSON.stringify(
            opts.params.workspacePaths,
          )}`,
        );
      }
      // `.at(0)` (not `[0]`) so an empty `scriptRefs` yields `undefined` while a
      // missing `scriptRefs` field still throws - the required-field assertion.
      const entry = opts.params.scriptRefs.at(0);
      mocks.lastReadScriptsRef.current = entry?.ref ?? "";
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

interface Shell {
  readonly children: ReactNode;
}
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean } & Shell) =>
    open ? <div data-testid="scripts-dialog">{children}</div> : null,
  DialogContent: ({ children }: Shell) => <div>{children}</div>,
  DialogHeader: ({ children }: Shell) => <div>{children}</div>,
  DialogFooter: ({ children }: Shell) => <div>{children}</div>,
  DialogTitle: ({ children }: Shell) => <h2>{children}</h2>,
  DialogDescription: ({ children }: Shell) => <p>{children}</p>,
}));

import {
  WorktreeScriptsDialog,
  type WorktreeScriptsContext,
} from "@/components/home/worktree/worktree-scripts-dialog";

const WORKSPACE = "/tmp/a";
const STAGING_KEY: WorktreeStagingKey = { surface: "landing", draftId: null };
const KEY_STRING = worktreeStagingKeyString(STAGING_KEY);

function osScript(value: string): WorktreeEntryScripts["setup"] {
  return { default: value, macos: null, windows: null, linux: null };
}

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

function stagedLocalIntent(): WorktreeIntent {
  return {
    entries: [
      {
        kind: "local",
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  };
}

function stagedCheckoutIntent(): WorktreeIntent {
  return {
    entries: [
      {
        kind: "worktree",
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: true,
        branch: { type: "existing", name: "release/2.0" },
        scripts: null,
      },
    ],
  };
}

function liveWorktreeBinding(): WorktreeBinding {
  return {
    entries: [
      {
        workspacePath: WORKSPACE,
        mode: "worktree",
        repoIdentifier: null,
        worktreePath: "/wt/a",
        branch: "feat/login",
        isPrimary: true,
        isImported: false,
        setupState: "failed",
        setupTerminalSessionId: null,
        setupExitCode: 1,
        setupFailedAt: 0,
        createdAt: 0,
        ownedSubmodules: [],
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
  regenerateBranchNameForWorkspace: () => null,
};

const IN_EPIC_CONTEXT: WorktreeScriptsContext = {
  epicId: "epic-1",
  ownerId: "chat-1",
  ownerKind: "chat",
  binding: liveWorktreeBinding(),
  stagingKey: STAGING_KEY,
  hostClient: null,
  regenerateBranchNameForWorkspace: () => null,
};

function renderDialog(
  context: WorktreeScriptsContext,
  summary: WorktreeWorkspaceSummaryV14,
) {
  const onOpenChange = vi.fn();
  render(
    <TooltipProvider>
      <WorktreeScriptsDialog
        open
        onOpenChange={onOpenChange}
        target={{ workspacePath: WORKSPACE, summary }}
        context={context}
      />
    </TooltipProvider>,
  );
  return { onOpenChange };
}

function applyRepoPrefixOverride(): void {
  fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
}

function enableCustomPrefixAndType(value: string): void {
  // Layered Branch naming UI: choose "Override for this repository", then type.
  fireEvent.click(screen.getByTestId("repo-branch-prefix-choice-override"));
  fireEvent.change(screen.getByLabelText("Prefix"), {
    target: { value },
  });
}

function setupDefaultField(): HTMLTextAreaElement {
  const field = screen.getByLabelText("Setup script (Default)");
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error("expected the setup default textarea");
  }
  return field;
}

function saveScriptsButton(): HTMLElement {
  // Footer action is "Save scripts" (independent of Branch naming's Apply).
  return screen.getByRole("button", { name: "Save scripts" });
}

describe("<WorktreeScriptsDialog />", () => {
  beforeEach(() => {
    useWorktreeIntentStagingStore.setState({ intentByKey: {} });
    mocks.setRepoScriptsMutate.mockReset();
    mocks.setRepoBranchPrefixMutate.mockReset();
    mocks.rejectSave.current = false;
    mocks.supportsSetRepoBranchPrefix.current = true;
    mocks.repoBranchPrefixUpdated.current = true;
    mocks.listAllForHost.mockReset();
    mocks.listAllForHost.mockReturnValue({
      data: undefined,
      isSuccess: false,
    });
    mocks.readScriptsAtRef.mockReset();
    mocks.readScriptsAtRef.mockReturnValue({
      data: { scripts: null },
      isSuccess: true,
      isError: false,
    });
    mocks.lastReadScriptsRef.current = "";
  });
  afterEach(() => {
    cleanup();
  });

  it("stages onto the worktree intent (no setRepoScripts) for a staged new worktree", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));

    // A new worktree reads scripts at its fork SOURCE, not the new branch name.
    expect(mocks.lastReadScriptsRef.current).toBe("main");

    fireEvent.change(setupDefaultField(), { target: { value: "bun install" } });
    fireEvent.click(saveScriptsButton());

    const staged =
      useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
    const entry = staged?.entries[0];
    expect(entry?.kind).toBe("worktree");
    expect(
      entry?.kind === "worktree" ? entry.scripts?.setup.default : null,
    ).toBe("bun install");
    // A staged new-worktree edit rides the intent - it must never write a file.
    expect(mocks.setRepoScriptsMutate).not.toHaveBeenCalled();
  });

  it("shows the 'Existing branch' header and stages a checked-out branch (no setRepoScripts)", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedCheckoutIntent());

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));

    // A checked-out existing branch is distinct from a new branch and has no
    // path yet, so it reads "Existing branch · <branch>", not a worktree path.
    expect(screen.getByText("Existing branch")).toBeTruthy();
    expect(screen.getByText("release/2.0")).toBeTruthy();
    // A checked-out branch reads scripts at that branch's committed ref.
    expect(mocks.lastReadScriptsRef.current).toBe("release/2.0");

    fireEvent.change(setupDefaultField(), { target: { value: "echo co" } });
    fireEvent.click(saveScriptsButton());

    const staged =
      useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
    const entry = staged?.entries[0];
    expect(entry?.kind).toBe("worktree");
    expect(
      entry?.kind === "worktree" ? entry.scripts?.setup.default : null,
    ).toBe("echo co");
    // Like a new branch, it rides the intent - it must never write a file.
    expect(mocks.setRepoScriptsMutate).not.toHaveBeenCalled();
  });

  it("writes an existing in-epic worktree's own env via setRepoScripts(worktreePath)", () => {
    renderDialog(IN_EPIC_CONTEXT, summaryWith(null));

    fireEvent.change(setupDefaultField(), { target: { value: "make build" } });
    fireEvent.click(saveScriptsButton());

    expect(mocks.setRepoScriptsMutate).toHaveBeenCalledTimes(1);
    const [variables] = mocks.setRepoScriptsMutate.mock.calls[0];
    expect(variables).toMatchObject({
      epicId: "epic-1",
      // The live worktree's own toplevel, never the source checkout.
      workspacePath: "/wt/a",
      setup: { default: "make build" },
    });
  });

  it("writes the source repo's env via setRepoScripts(source) in Local mode", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedLocalIntent());

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));

    fireEvent.change(setupDefaultField(), { target: { value: "echo local" } });
    fireEvent.click(saveScriptsButton());

    expect(mocks.setRepoScriptsMutate).toHaveBeenCalledTimes(1);
    const [variables] = mocks.setRepoScriptsMutate.mock.calls[0];
    expect(variables).toMatchObject({
      epicId: "",
      // Local runs in the checkout, so the repo's own toplevel - committable.
      workspacePath: WORKSPACE,
      setup: { default: "echo local" },
    });
  });

  it("does not show 'Saved' (and keeps the dialog open) when the write fails", async () => {
    // Regression: the dialog used to animate to "Saved" + close on a fixed timer
    // regardless of the mutation outcome, so a failed setRepoScripts read as a
    // false success. It must stay on "Save scripts" when the write rejects.
    mocks.rejectSave.current = true;
    renderDialog(IN_EPIC_CONTEXT, summaryWith(null));

    fireEvent.change(setupDefaultField(), { target: { value: "make build" } });
    fireEvent.click(saveScriptsButton());
    expect(mocks.setRepoScriptsMutate).toHaveBeenCalledTimes(1);

    // Let the rejected save promise settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Saved" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save scripts" })).toBeTruthy();
  });

  it("prefills from the staged override for a new worktree", () => {
    useWorktreeIntentStagingStore.getState().setIntent(
      STAGING_KEY,
      stagedWorktreeIntent({
        setup: osScript("echo staged"),
        teardown: osScript(""),
      }),
    );

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));

    expect(setupDefaultField().value).toBe("echo staged");
  });

  it("prefills from the SOURCE branch's committed scripts for a new worktree (not the primary checkout)", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    mocks.readScriptsAtRef.mockReturnValue({
      data: {
        scripts: { setup: osScript("echo branch"), teardown: osScript("") },
      },
      isSuccess: true,
      isError: false,
    });

    // summary.scripts is the primary checkout's value - it must NOT win over the
    // source branch's committed scripts.
    renderDialog(
      PRE_CREATE_CONTEXT,
      summaryWith({
        setup: osScript("echo primary"),
        teardown: osScript(""),
        updatedAt: 0,
      }),
    );

    expect(setupDefaultField().value).toBe("echo branch");
    expect(mocks.lastReadScriptsRef.current).toBe("main");
  });

  it("shows a spinner (no fields) until the source branch read settles", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    mocks.readScriptsAtRef.mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: false,
    });

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));

    // No flash of the primary checkout: the editable field is withheld behind a
    // spinner until the source-branch read resolves.
    expect(screen.queryByLabelText("Setup script (Default)")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("on a failed source-branch read, starts blank with an error note (never the primary checkout)", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    mocks.readScriptsAtRef.mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
    });

    // summary.scripts is the stale primary-checkout value — it must NOT be
    // seeded when the source-branch read fails.
    renderDialog(
      PRE_CREATE_CONTEXT,
      summaryWith({
        setup: osScript("echo primary"),
        teardown: osScript(""),
        updatedAt: 0,
      }),
    );

    expect(setupDefaultField().value).toBe("");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("prefills from the worktree's own env for an existing worktree", () => {
    mocks.listAllForHost.mockReturnValue({
      data: {
        worktrees: [
          {
            worktreePath: "/wt/a",
            scripts: { setup: osScript("echo wt-own"), teardown: osScript("") },
          },
        ],
      },
      isSuccess: true,
    });

    renderDialog(IN_EPIC_CONTEXT, summaryWith(null));

    expect(setupDefaultField().value).toBe("echo wt-own");
  });

  it("renders setup scripts first, Branch naming last, and titles the dialog Worktree environment", () => {
    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));
    expect(
      screen.getByRole("heading", { name: "Worktree environment" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Configure lifecycle scripts and branch prefix for a/),
    ).toBeTruthy();
    expect(screen.getByTestId("repo-branch-prefix-section")).toBeTruthy();
    expect(screen.getByText("Branch prefix")).toBeTruthy();
    // Scripts section eyebrow only when Branch naming is present.
    expect(screen.getByText("Setup & teardown scripts")).toBeTruthy();
    // Information hierarchy: setup/teardown before branch naming.
    const scriptsEyebrow = screen.getByText("Setup & teardown scripts");
    const branchNaming = screen.getByText("Branch prefix");
    expect(
      scriptsEyebrow.compareDocumentPosition(branchNaming) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save scripts" })).toBeTruthy();
    // New-branch worktree: no disconnected top-level branch path block.
    expect(screen.queryByText("New worktree branch")).toBeNull();
  });

  it("never renders Branch naming (or the scripts eyebrow) for a non-Git folder", () => {
    renderDialog(PRE_CREATE_CONTEXT, {
      ...summaryWith(null),
      isGitRepo: false,
    });
    expect(screen.queryByTestId("repo-branch-prefix-section")).toBeNull();
    expect(screen.queryByText("Branch prefix")).toBeNull();
    // Without a Branch naming slot, the scripts section has no divider eyebrow
    // (single unlabeled section - same as before the redesign).
    expect(screen.queryByText("Setup & teardown scripts")).toBeNull();
    expect(screen.getByText(/Configure lifecycle scripts for a/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save scripts" })).toBeTruthy();
  });

  it("keeps Branch naming Apply and scripts Save as independent actions", () => {
    // Existing worktree: scripts hit setRepoScripts; branch naming hits setRepoBranchPrefix.
    renderDialog(IN_EPIC_CONTEXT, summaryWith(null));

    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();
    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setRepoScriptsMutate).not.toHaveBeenCalled();

    fireEvent.change(setupDefaultField(), { target: { value: "bun install" } });
    fireEvent.click(saveScriptsButton());
    expect(mocks.setRepoScriptsMutate).toHaveBeenCalledTimes(1);
    // Scripts save must not re-fire the branch-prefix mutation.
    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setRepoScriptsMutate.mock.calls[0][0]).toMatchObject({
      epicId: "epic-1",
      workspacePath: "/wt/a",
      setup: { default: "bun install" },
    });
  });

  it("does not offer regenerate when the mutation resolves with updated: false", () => {
    // A non-git no-op, or a checkout that vanished between render and click -
    // either way the RPC call resolved, but nothing was actually persisted,
    // so the offer (and any "saved" state) must not appear.
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    mocks.repoBranchPrefixUpdated.current = false;
    const regenerate = vi.fn(
      (
        _path: string,
        prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) =>
        prefixState.status === "present" &&
        typeof prefixState.value === "string"
          ? `${prefixState.value}${suffix}`
          : `traycer/${suffix}`,
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      summaryWith(null),
    );

    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();

    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
    // Composition may run for the live preview, but onSaved must not fire so
    // the offer stays hidden.
  });

  it("does not show the regenerate offer until a repo-prefix save succeeds", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));

    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
  });

  it("offers regenerate only for a staged type:new branch after a successful prefix save", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    const regenerate = vi.fn(
      (
        _path: string,
        prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) =>
        prefixState.status === "present" &&
        typeof prefixState.value === "string"
          ? `${prefixState.value}${suffix}`
          : `traycer/${suffix}`,
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      summaryWith(null),
    );

    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();

    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeTruthy();
    // Composition runs for the live preview + Apply capture; the offer itself
    // is still pure UI until the user opts in (staging happens on click).
    expect(regenerate).toHaveBeenCalled();
  });

  it("does not offer regenerate for a staged existing-branch checkout", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedCheckoutIntent());

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));
    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();

    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
  });

  it("does not offer regenerate for a local-mode staged folder", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedLocalIntent());

    renderDialog(PRE_CREATE_CONTEXT, summaryWith(null));
    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();

    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
  });

  it("does not offer regenerate for an already-created in-epic worktree", () => {
    renderDialog(IN_EPIC_CONTEXT, summaryWith(null));
    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();

    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
  });

  it("Keep current dismisses the offer without staging a new branch name", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    const regenerate = vi.fn(
      (
        _path: string,
        prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) =>
        prefixState.status === "present" &&
        typeof prefixState.value === "string"
          ? `${prefixState.value}${suffix}`
          : `traycer/${suffix}`,
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      summaryWith(null),
    );
    enableCustomPrefixAndType("team/");
    applyRepoPrefixOverride();

    fireEvent.click(screen.getByRole("button", { name: "Keep current" }));

    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
    const staged =
      useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
    const entry = staged?.entries[0];
    expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
      "feat/login",
    );
  });

  it("Use new prefix stages the exact captured candidate (no second random pick)", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    // Track whether "Use new prefix" ever asked for a NEW composition with a
    // different suffix than the one already captured at Apply time. Preview
    // re-renders may still call regenerate with the same stable suffix - that
    // is fine; the regression is staging a freshly-picked different name.
    const suffixesSeen = new Set<string>();
    const regenerate = vi.fn(
      (
        _path: string,
        prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) => {
        suffixesSeen.add(suffix);
        return prefixState.status === "present" &&
          typeof prefixState.value === "string"
          ? `${prefixState.value}${suffix}`
          : `traycer/${suffix}`;
      },
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      summaryWith(null),
    );
    enableCustomPrefixAndType("team/");
    // Capture the live Effective branch shown during editing - the same
    // composition inputs Apply will freeze into regenerateCandidate.
    const shownWhileEditing = readEffectiveBranchValue();
    applyRepoPrefixOverride();

    expect(regenerate).toHaveBeenCalled();
    // Apply's capture must have used the present draft + a suffix.
    expect(regenerate).toHaveBeenCalledWith(
      WORKSPACE,
      { status: "present", value: "team/" },
      expect.any(String),
    );
    const suffixesAtApply = new Set(suffixesSeen);

    fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));

    // Staging uses the frozen candidate string - equal to what editing showed.
    // Even if preview re-renders compose again, they must reuse the same suffix
    // (stable per mount); a second random pick would enlarge suffixesSeen.
    expect(suffixesSeen.size).toBe(suffixesAtApply.size);
    const staged =
      useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
    const entry = staged?.entries[0];
    expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
      shownWhileEditing,
    );
    expect(
      screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
    ).toBeNull();
  });

  it("single-repo: Effective branch during editing equals the staged Use new prefix value", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    const regenerate = vi.fn(
      (
        _path: string,
        prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) =>
        prefixState.status === "present" &&
        typeof prefixState.value === "string"
          ? `${prefixState.value}${suffix}`
          : `traycer/${suffix}`,
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      summaryWith(null),
    );
    enableCustomPrefixAndType("feat/");
    const shown = readEffectiveBranchValue();
    expect(shown.startsWith("feat/")).toBe(true);
    applyRepoPrefixOverride();
    fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));
    const staged =
      useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
    const entry = staged?.entries[0];
    expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(shown);
  });

  it("multi-repo: Effective branch during editing equals the staged Use new prefix value (slug inserted)", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    // Simulates the host wiring when 2+ git workspaces are staged: composition
    // inserts the repository slug between prefix and suffix.
    const regenerate = vi.fn(
      (
        _path: string,
        prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) =>
        prefixState.status === "present" &&
        typeof prefixState.value === "string"
          ? `${prefixState.value}app-${suffix}`
          : `traycer/app-${suffix}`,
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      {
        ...summaryWith(null),
        repoIdentifier: { owner: "acme", repo: "app" },
      },
    );
    enableCustomPrefixAndType("team/");
    const shown = readEffectiveBranchValue();
    expect(shown).toMatch(/^team\/app-/);
    applyRepoPrefixOverride();
    fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));
    const staged =
      useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
    const entry = staged?.entries[0];
    expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(shown);
  });

  it("shows the picker's real staged proposal as Effective branch when one exists", () => {
    // Opening Environment after the picker already staged type:new "feat/login"
    // must show that exact name - not a fresh random composed candidate.
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
    const regenerate = vi.fn(
      (
        _path: string,
        _prefixState: { readonly status: string; readonly value?: string },
        suffix: string,
      ) => `traycer/${suffix}`,
    );
    renderDialog(
      {
        ...PRE_CREATE_CONTEXT,
        regenerateBranchNameForWorkspace: regenerate,
      },
      summaryWith(null),
    );

    expect(readEffectiveBranchValue()).toBe("feat/login");
  });

  // Item 5 (layered-settings review findings): while the post-save
  // regeneration offer is active, Effective branch must show the CAPTURED
  // candidate (not the old staged proposal), the offer must name that old
  // proposal separately, Use new prefix stages exactly the visible candidate,
  // and Keep current resumes ordinary proposal display. Apply and Remove
  // share this shape.
  describe("post-save regeneration offer display identity (item 5)", () => {
    function presentCompose(
      prefixState: { readonly status: string; readonly value?: string },
      suffix: string,
    ): string {
      return prefixState.status === "present" &&
        typeof prefixState.value === "string"
        ? `${prefixState.value}${suffix}`
        : `traycer/${suffix}`;
    }

    it("Apply: offer shows previous proposal; Effective branch is the captured candidate; Use new prefix stages that same visible value", () => {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
      const regenerate = vi.fn(
        (
          _path: string,
          prefixState: { readonly status: string; readonly value?: string },
          suffix: string,
        ) => presentCompose(prefixState, suffix),
      );
      renderDialog(
        {
          ...PRE_CREATE_CONTEXT,
          regenerateBranchNameForWorkspace: regenerate,
        },
        summaryWith(null),
      );

      // Pre-condition: picker already proposed feat/login.
      expect(readEffectiveBranchValue()).toBe("feat/login");

      enableCustomPrefixAndType("team/");
      const shownWhileEditing = readEffectiveBranchValue();
      expect(shownWhileEditing.startsWith("team/")).toBe(true);
      applyRepoPrefixOverride();

      // While the offer is active, Branch naming shows the CAPTURED candidate
      // (not the old staged proposal).
      const offer = screen.getByTestId("repo-branch-prefix-regenerate-offer");
      expect(offer.textContent).toMatch(/This picker already proposed/);
      expect(offer.textContent).toContain("feat/login");
      const visibleDuringOffer = readEffectiveBranchValue();
      expect(visibleDuringOffer).toBe(shownWhileEditing);
      expect(visibleDuringOffer).not.toBe("feat/login");

      // Use new prefix stages exactly what was rendered as Effective branch.
      fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));
      const staged =
        useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
      const entry = staged?.entries[0];
      expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
        visibleDuringOffer,
      );
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
    });

    it("Apply: Keep current dismisses the offer and resumes showing the old staged proposal", () => {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
      const regenerate = vi.fn(
        (
          _path: string,
          prefixState: { readonly status: string; readonly value?: string },
          suffix: string,
        ) => presentCompose(prefixState, suffix),
      );
      renderDialog(
        {
          ...PRE_CREATE_CONTEXT,
          regenerateBranchNameForWorkspace: regenerate,
        },
        summaryWith(null),
      );

      enableCustomPrefixAndType("team/");
      applyRepoPrefixOverride();

      // Offer active: candidate shown, previous named separately.
      expect(readEffectiveBranchValue()).not.toBe("feat/login");
      expect(
        screen.getByTestId("repo-branch-prefix-regenerate-offer").textContent,
      ).toContain("feat/login");

      fireEvent.click(screen.getByRole("button", { name: "Keep current" }));

      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      // Nothing staged - ordinary currentProposedBranchName precedence resumes.
      expect(readEffectiveBranchValue()).toBe("feat/login");
      const staged =
        useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
      const entry = staged?.entries[0];
      expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
        "feat/login",
      );
    });

    it("Remove: offer shows previous proposal; Effective branch is the inherited candidate; Use new prefix stages that same visible value", () => {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
      const regenerate = vi.fn(
        (
          _path: string,
          prefixState: { readonly status: string; readonly value?: string },
          suffix: string,
        ) => presentCompose(prefixState, suffix),
      );
      renderDialog(
        {
          ...PRE_CREATE_CONTEXT,
          regenerateBranchNameForWorkspace: regenerate,
        },
        {
          ...summaryWith(null),
          repoBranchPrefix: { status: "present", value: "team/" },
        },
      );

      // Saved override open: staged proposal still wins before Remove.
      expect(readEffectiveBranchValue()).toBe("feat/login");

      fireEvent.click(screen.getByRole("button", { name: "Remove prefix" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      const offer = screen.getByTestId("repo-branch-prefix-regenerate-offer");
      expect(offer.textContent).toMatch(/This picker already proposed/);
      expect(offer.textContent).toContain("feat/login");

      // After remove, captured candidate uses the inherited (global) prefix.
      const visibleDuringOffer = readEffectiveBranchValue();
      expect(visibleDuringOffer.startsWith("traycer/")).toBe(true);
      expect(visibleDuringOffer).not.toBe("feat/login");

      fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));
      const staged =
        useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
      const entry = staged?.entries[0];
      expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
        visibleDuringOffer,
      );
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
    });

    it("Remove: Keep current dismisses the offer and resumes showing the old staged proposal", () => {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
      const regenerate = vi.fn(
        (
          _path: string,
          prefixState: { readonly status: string; readonly value?: string },
          suffix: string,
        ) => presentCompose(prefixState, suffix),
      );
      renderDialog(
        {
          ...PRE_CREATE_CONTEXT,
          regenerateBranchNameForWorkspace: regenerate,
        },
        {
          ...summaryWith(null),
          repoBranchPrefix: { status: "present", value: "team/" },
        },
      );

      fireEvent.click(screen.getByRole("button", { name: "Remove prefix" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      expect(readEffectiveBranchValue()).not.toBe("feat/login");
      expect(
        screen.getByTestId("repo-branch-prefix-regenerate-offer").textContent,
      ).toContain("feat/login");

      fireEvent.click(screen.getByRole("button", { name: "Keep current" }));

      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      expect(readEffectiveBranchValue()).toBe("feat/login");
      const staged =
        useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
      const entry = staged?.entries[0];
      expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
        "feat/login",
      );
    });
  });

  // Item 6 (layered-settings review findings): starting another repository-
  // prefix edit while a regeneration offer is active must dismiss that stale
  // offer immediately (before any draft typing). Dismissal is silent - not an
  // implicit "Keep current" / stage. A later successful Apply may create a
  // fresh offer; two actionable candidates must never coexist.
  describe("re-entry dismisses stale regeneration offer (item 6)", () => {
    interface StageCall {
      readonly key: WorktreeStagingKey;
      readonly workspacePath: string;
      readonly name: string;
    }

    interface StageCallTracker {
      readonly calls: StageCall[];
      readonly notCalled: () => void;
    }

    let stageTracker: StageCallTracker;
    let originalStageBranchName: (
      key: WorktreeStagingKey,
      workspacePath: string,
      name: string,
    ) => void;

    function presentCompose(
      prefixState: { readonly status: string; readonly value?: string },
      suffix: string,
    ): string {
      return prefixState.status === "present" &&
        typeof prefixState.value === "string"
        ? `${prefixState.value}${suffix}`
        : `traycer/${suffix}`;
    }

    beforeEach(() => {
      const calls: StageCall[] = [];
      originalStageBranchName =
        useWorktreeIntentStagingStore.getState().stageBranchName;
      useWorktreeIntentStagingStore.setState({
        stageBranchName: (key, workspacePath, name) => {
          calls.push({ key, workspacePath, name });
          originalStageBranchName(key, workspacePath, name);
        },
      });
      stageTracker = {
        calls,
        notCalled: () => {
          expect(calls).toHaveLength(0);
        },
      };
    });

    afterEach(() => {
      useWorktreeIntentStagingStore.setState({
        stageBranchName: originalStageBranchName,
      });
    });

    function renderWithRegenerate(): void {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(STAGING_KEY, stagedWorktreeIntent(null));
      const regenerate = vi.fn(
        (
          _path: string,
          prefixState: { readonly status: string; readonly value?: string },
          suffix: string,
        ) => presentCompose(prefixState, suffix),
      );
      renderDialog(
        {
          ...PRE_CREATE_CONTEXT,
          regenerateBranchNameForWorkspace: regenerate,
        },
        summaryWith(null),
      );
    }

    function applyAndShowOffer(prefix: string): string {
      enableCustomPrefixAndType(prefix);
      const candidate = readEffectiveBranchValue();
      applyRepoPrefixOverride();
      expect(
        screen.getByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeTruthy();
      return candidate;
    }

    function prefixInput(): HTMLInputElement {
      const field = screen.getByLabelText("Prefix");
      if (!(field instanceof HTMLInputElement)) {
        throw new Error("expected repository prefix input");
      }
      return field;
    }

    it("re-entry with a changed valid draft dismisses the offer immediately and keeps it gone", () => {
      renderWithRegenerate();
      const firstCandidate = applyAndShowOffer("team/");
      expect(readEffectiveBranchValue()).toBe(firstCandidate);

      // Enter editing BEFORE any typing - offer must already be gone.
      fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      stageTracker.notCalled();

      // Type a different valid prefix - offer stays dismissed.
      fireEvent.change(prefixInput(), { target: { value: "eng/" } });
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      expect(readEffectiveBranchValue().startsWith("eng/")).toBe(true);
      stageTracker.notCalled();
    });

    it("re-entry with an unchanged draft still dismisses the offer (unconditional on entry)", () => {
      renderWithRegenerate();
      applyAndShowOffer("team/");

      fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      // Seeded draft is the just-saved value; leave it alone.
      expect(prefixInput().value).toBe("team/");
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      stageTracker.notCalled();
    });

    it("re-entry with an invalid draft keeps the offer absent and shows Current effective branch fallback", () => {
      renderWithRegenerate();
      applyAndShowOffer("team/");

      fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();

      fireEvent.change(prefixInput(), { target: { value: "has spaces" } });
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      expect(screen.getByText("Current staged")).toBeTruthy();
      // Invalid draft must not surface the bad prefix as a composed candidate;
      // the staged proposal still wins ordinary precedence once the offer is gone.
      expect(readEffectiveBranchValue()).toBe("feat/login");
      expect(screen.queryByText(/has spaces/)).toBeNull();
      stageTracker.notCalled();
    });

    it("subsequent Apply after re-entry yields a single fresh offer with item-5 identity", () => {
      renderWithRegenerate();
      const firstCandidate = applyAndShowOffer("team/");
      expect(
        screen.getByTestId("repo-branch-prefix-regenerate-offer").textContent,
      ).toContain("feat/login");

      fireEvent.click(screen.getByRole("button", { name: "Edit prefix" }));
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
      stageTracker.notCalled();

      fireEvent.change(prefixInput(), { target: { value: "eng/" } });
      const secondCandidate = readEffectiveBranchValue();
      expect(secondCandidate.startsWith("eng/")).toBe(true);
      expect(secondCandidate).not.toBe(firstCandidate);
      applyRepoPrefixOverride();

      // Exactly one offer; previous proposal is what is still staged for THIS
      // save (feat/login), not a ghost of the first-round candidate.
      const offers = screen.getAllByTestId(
        "repo-branch-prefix-regenerate-offer",
      );
      expect(offers).toHaveLength(1);
      expect(offers[0]?.textContent).toContain("feat/login");
      expect(offers[0]?.textContent).toMatch(/This picker already proposed/);
      // Effective branch shows the NEW captured candidate for this save.
      expect(readEffectiveBranchValue()).toBe(secondCandidate);
      expect(readEffectiveBranchValue()).not.toBe(firstCandidate);

      fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));
      expect(stageTracker.calls).toEqual([
        {
          key: STAGING_KEY,
          workspacePath: WORKSPACE,
          name: secondCandidate,
        },
      ]);
      const staged =
        useWorktreeIntentStagingStore.getState().intentByKey[KEY_STRING];
      const entry = staged?.entries[0];
      expect(entry?.kind === "worktree" ? entry.branch.name : null).toBe(
        secondCandidate,
      );
      expect(
        screen.queryByTestId("repo-branch-prefix-regenerate-offer"),
      ).toBeNull();
    });
  });
});

function readEffectiveBranchValue(): string {
  const label = screen.getByText(
    /^(Example|Staged branch|Current example|Current staged)$/,
  );
  const row = label.closest("div");
  if (row === null) {
    throw new Error("expected effective branch row");
  }
  const code = row.querySelector("code");
  if (code === null) {
    throw new Error("expected effective branch code value");
  }
  return code.textContent;
}
