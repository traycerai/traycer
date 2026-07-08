import "../../../../../__tests__/test-browser-apis";
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
  WorktreeWorkspaceSummary,
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
  // Flips a test's `mutateAsync` to reject, exercising the dialog's failed-save
  // path (must NOT show "Saved").
  rejectSave: { current: false },
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
  scripts: WorktreeWorkspaceSummary["scripts"],
): WorktreeWorkspaceSummary {
  return {
    workspacePath: WORKSPACE,
    isGitRepo: true,
    repoIdentifier: null,
    mainBranch: "main",
    worktrees: [],
    scripts,
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
};

const IN_EPIC_CONTEXT: WorktreeScriptsContext = {
  epicId: "epic-1",
  ownerId: "chat-1",
  ownerKind: "chat",
  binding: liveWorktreeBinding(),
  stagingKey: STAGING_KEY,
  hostClient: null,
};

function renderDialog(
  context: WorktreeScriptsContext,
  summary: WorktreeWorkspaceSummary,
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

function setupDefaultField(): HTMLTextAreaElement {
  const field = screen.getByLabelText("Setup script (Default)");
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error("expected the setup default textarea");
  }
  return field;
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Save" });
}

describe("<WorktreeScriptsDialog />", () => {
  beforeEach(() => {
    useWorktreeIntentStagingStore.setState({ intentByKey: {} });
    mocks.setRepoScriptsMutate.mockReset();
    mocks.rejectSave.current = false;
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
    fireEvent.click(saveButton());

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
    fireEvent.click(saveButton());

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
    fireEvent.click(saveButton());

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
    fireEvent.click(saveButton());

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
    // false success. It must stay on "Save" when the write rejects.
    mocks.rejectSave.current = true;
    renderDialog(IN_EPIC_CONTEXT, summaryWith(null));

    fireEvent.change(setupDefaultField(), { target: { value: "make build" } });
    fireEvent.click(saveButton());
    expect(mocks.setRepoScriptsMutate).toHaveBeenCalledTimes(1);

    // Let the rejected save promise settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Saved" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
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
});
