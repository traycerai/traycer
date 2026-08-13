/**
 * Regression: landing composer's first submittable keystroke mints a draft id
 * and flips the workspace picker's staging key from `landing:` to
 * `landing:<uuid>`. If the Environment dialog is open mid-edit at that moment,
 * the staged worktree intent must migrate with the key (and the dialog must not
 * remount / drop the in-progress branch-prefix edit + "Use new prefix" offer).
 *
 * Production trigger mirrored here (landing-composer.tsx handleDocumentChange):
 * createDraftWithId → migrateKey(null → minted id) → React re-render with the
 * new draftId. Mocks only the host-RPC boundary.
 */
import { useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummaryV15 } from "@traycer/protocol/host/worktree-schemas";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";

const WORKSPACE_PATH = "/workspace/app";
const MINTED_DRAFT_ID = "draft-1111-2222";

interface MockHostClient {
  getActiveHost(): {
    readonly hostId: string;
    readonly label: string;
    readonly kind: "local";
    readonly websocketUrl: string;
    readonly version: string;
    readonly status: "available";
  };
  getActiveHostId(): string;
  getRequestContextUserId(): string;
  request(method: string, payload: unknown): Promise<unknown>;
  onChange(): () => void;
}

const mocks = vi.hoisted(() => ({
  resolvedWorkspace: {
    current: { folders: [] as readonly ResolvedFolder[] },
  },
  selectHost: vi.fn(),
  pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
  setRepoBranchPrefixMutate:
    vi.fn<(variables: unknown, options: unknown) => void>(),
}));

const RESOLVED_FOLDER: ResolvedFolder = {
  kind: "resolved",
  path: WORKSPACE_PATH,
  name: "app",
  repoIdentifier: { owner: "acme", repo: "app" },
};

const SUMMARY: WorktreeWorkspaceSummaryV15 = {
  workspacePath: WORKSPACE_PATH,
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: WORKSPACE_PATH,
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
  ],
  scripts: null,
  repoBranchPrefix: { status: "absent" },
  resolvedAt: 1,
  presence: "present",
};

const hostClient: MockHostClient = {
  getActiveHost: () => ({
    hostId: "host-test",
    label: "Test host",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "0.0.0-test",
    status: "available",
  }),
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  request: () => Promise.reject(new Error("unexpected direct request()")),
  onChange: () => () => undefined,
};

vi.mock("@/components/ui/select", () => ({
  Select: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectTrigger: (props: { readonly children: ReactNode }) => (
    <button type="button">{props.children}</button>
  ),
  SelectValue: () => <span />,
  SelectContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SelectItem: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({ directory: { selectById: mocks.selectHost } }),
  useHostClient: () => hostClient,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-test",
        label: "Test host",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:0",
        version: "0.0.0-test",
        status: "available",
      },
    ],
  }),
}));

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => mocks.resolvedWorkspace.current,
}));

vi.mock("@/hooks/worktree/use-worktree-list-by-workspace-paths-query", () => ({
  useWorktreeListByWorkspacePaths: () => ({
    data: { workspaces: [SUMMARY] },
    isFetching: false,
  }),
  useWorktreeListByWorkspacePathsForClient: () => ({
    data: { workspaces: [SUMMARY] },
    isFetching: false,
    isPending: false,
    isLoading: false,
  }),
  worktreeListByWorkspacePathsParams: (workspacePaths: readonly string[]) => ({
    workspacePaths: [...workspacePaths],
    scriptRefs: [],
    forceRefresh: false,
  }),
}));

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: () => [],
}));

vi.mock("@/hooks/workspace/use-workspace-folder-actions", () => ({
  preparedWorkspaceFolderToWorkspaceFolderInfo: (folder: {
    readonly workspacePath: string;
    readonly workspaceName: string;
    readonly repoIdentifier: unknown;
  }) => ({
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: folder.repoIdentifier,
  }),
  useWorkspaceFolderActions: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
  useWorkspaceFolderActionsForClient: () => ({
    pickAndPrepareFolders: mocks.pickAndPrepareFolders,
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({
    data: undefined,
    isSuccess: true,
    isError: false,
    isFetching: false,
  }),
  useHostMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: () => Promise.resolve({ workspaces: [] }),
    isPending: false,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-set-repo-scripts-mutation", () => ({
  useWorktreeSetRepoScriptsFor: () => ({
    mutate: vi.fn(),
    mutateAsync: () => Promise.resolve(),
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
        options.onSuccess({ updated: true });
      },
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: (props: { readonly open: boolean; readonly children: ReactNode }) =>
    props.open ? (
      <div data-testid="scripts-dialog">{props.children}</div>
    ) : null,
  DialogContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DialogHeader: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DialogFooter: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DialogTitle: (props: { readonly children: ReactNode }) => (
    <h2>{props.children}</h2>
  ),
  DialogDescription: (props: { readonly children: ReactNode }) => (
    <p>{props.children}</p>
  ),
}));

/**
 * Mirrors HomeSurface's stagingKey memo
 * (`{ surface: "landing", draftId }` from host-workspace-selector.tsx).
 */
function LandingLikeHarness(props: {
  readonly draftId: string | null;
}): ReactNode {
  const stagingKey = useMemo(
    () => ({ surface: "landing" as const, draftId: props.draftId }),
    [props.draftId],
  );
  return (
    <ActiveHostWorkspaceControls
      disabled={false}
      stagingKey={stagingKey}
      workspaceSeed={null}
      seedIntent={null}
      seedIntentOverride={null}
      layout="inline"
      hostScope={{ kind: "active" }}
    />
  );
}

function renderLandingLikeHarness(draftId: string | null): {
  readonly rerenderWithDraftId: (nextDraftId: string | null) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const buildTree = (id: string | null): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LandingLikeHarness draftId={id} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(buildTree(draftId));
  return {
    rerenderWithDraftId: (nextDraftId) => rerender(buildTree(nextDraftId)),
  };
}

async function openEnvironmentDialog(): Promise<void> {
  fireEvent.click(screen.getByTestId("workspace-summary-trigger"));
  await screen.findByTestId("home-workspace-rows-popover");
  fireEvent.click(
    screen.getByRole("button", { name: "Edit setup and teardown scripts" }),
  );
  await screen.findByTestId("scripts-dialog");
}

function readEffectiveBranchValue(): string {
  const label = screen.getByText(
    /^(Example|Staged branch|Current example|Current staged)$/,
  );
  const row = label.closest("div");
  if (row === null) throw new Error("expected effective branch row");
  const code = row.querySelector("code");
  if (code === null) throw new Error("expected effective branch code value");
  return code.textContent;
}

function outerBranchLabelText(): string {
  return screen.getByTestId("workspace-summary-trigger").textContent;
}

function stagedBranchName(draftId: string | null): string | null {
  const intent = readStagedWorktreeIntent({ surface: "landing", draftId });
  const entry = intent?.entries.find((e) => e.workspacePath === WORKSPACE_PATH);
  if (entry === undefined || entry.kind !== "worktree") return null;
  if (entry.branch.type !== "new") return null;
  return entry.branch.name;
}

/**
 * Mirrors landing-composer.tsx handleDocumentChange after createDraftWithId:
 * migrate the null-draft staging slot onto the minted id, then re-render the
 * picker under the new draftId (as HomeSurface does once activeDraftId flips).
 */
function mintLandingDraftMidSetup(
  rerenderWithDraftId: (nextDraftId: string | null) => void,
  mintedDraftId: string,
): void {
  useWorktreeIntentStagingStore
    .getState()
    .migrateKey(
      { surface: "landing", draftId: null },
      { surface: "landing", draftId: mintedDraftId },
    );
  rerenderWithDraftId(mintedDraftId);
}

beforeEach(() => {
  mocks.resolvedWorkspace.current = { folders: [RESOLVED_FOLDER] };
  mocks.setRepoBranchPrefixMutate.mockReset();
  useWorktreeIntentStagingStore.getState().resetForTests();
  useWorktreeIntentMemoryStore.getState().resetForTests();
  useSettingsStore.setState({ worktreeBranchPrefix: "traycer/" });
});

afterEach(cleanup);

describe("landing draftId flip preserves Environment branch-prefix edit", () => {
  it("keeps an in-progress prefix edit and confirmed branch across null → uuid", async () => {
    const { rerenderWithDraftId } = renderLandingLikeHarness(null);

    await waitFor(() => {
      expect(stagedBranchName(null)).not.toBeNull();
    });
    const initialStaged = stagedBranchName(null);
    if (initialStaged === null) {
      throw new Error(
        "expected a seeded staged branch name under draftId=null",
      );
    }
    await waitFor(() => {
      expect(outerBranchLabelText()).toContain(initialStaged);
    });

    await openEnvironmentDialog();
    expect(readEffectiveBranchValue()).toBe(initialStaged);

    // Mid-edit under the null-draft staging key.
    fireEvent.click(screen.getByTestId("repo-branch-prefix-choice-override"));
    fireEvent.change(screen.getByLabelText("Prefix"), {
      target: { value: "team/" },
    });
    expect(screen.getByRole("button", { name: "Save prefix" })).toBeTruthy();

    // Production path: composer mints a draft id while Environment is open.
    mintLandingDraftMidSetup(rerenderWithDraftId, MINTED_DRAFT_ID);

    // Intent must already live under the new key (migrateKey, not a reseed).
    expect(stagedBranchName(null)).toBeNull();
    expect(stagedBranchName(MINTED_DRAFT_ID)).toBe(initialStaged);
    // Outer picker still reflects the migrated staged name - not a reseed.
    expect(outerBranchLabelText()).toContain(initialStaged);
    // Editing chrome must survive (not remounted to a fresh "local" seed).
    expect(screen.getByRole("button", { name: "Save prefix" })).toBeTruthy();
    const prefixField = screen.getByLabelText<HTMLInputElement>("Prefix");
    expect(prefixField.value).toBe("team/");

    fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));
    expect(mocks.setRepoBranchPrefixMutate).toHaveBeenCalledTimes(1);

    const offer = screen.getByTestId("repo-branch-prefix-regenerate-offer");
    expect(offer).toBeTruthy();
    const candidateShown = readEffectiveBranchValue();
    expect(candidateShown).not.toBe(initialStaged);
    expect(candidateShown.startsWith("team/")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Use new prefix" }));
    expect(stagedBranchName(MINTED_DRAFT_ID)).toBe(candidateShown);
    // Still only the confirmed candidate under the minted key - no second
    // reseed under a different random name.
    expect(stagedBranchName(null)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("scripts-dialog")).toBeNull();
    });

    const outerAfterClose = outerBranchLabelText();
    expect(outerAfterClose).toContain(candidateShown);
    expect(outerAfterClose).not.toContain(initialStaged);
  });
});
