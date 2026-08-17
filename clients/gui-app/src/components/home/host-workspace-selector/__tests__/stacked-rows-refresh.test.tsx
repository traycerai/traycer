/**
 * The stacked rows arm's intent edge (traycerai/traycer#711).
 *
 * `ActiveHostWorkspaceControls layout="stacked"` is what the fork-chat dialog,
 * the terminal-agent fork dialog and the add-node launcher render. All three
 * mount it inside a Radix `Dialog`/`DropdownMenu` with no `forceMount`, so it
 * unmounts on close and mounts fresh on every open - which makes MOUNT its
 * intent edge, the counterpart of the picker popover's `onOpenChange`.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummaryV15 } from "@traycer/protocol/host/worktree-schemas";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActiveHostWorkspaceControls } from "../host-workspace-selector";

const WORKSPACE_PATH = "/workspace/app";

interface MockHostClient {
  getActiveHost(): {
    readonly hostId: string;
    readonly label: string;
    readonly kind: "local";
    readonly websocketUrl: string;
    readonly version: string;
    readonly transportDialability: "dialable";
  };
  getActiveHostId(): string;
  getRequestContextUserId(): string;
  request(method: string, payload: unknown): Promise<unknown>;
  onChange(): () => void;
}

const mocks = vi.hoisted(() => {
  const request =
    vi.fn<(method: string, payload: unknown) => Promise<unknown>>();
  const resolvedWorkspace: {
    current: { readonly folders: readonly ResolvedFolder[] };
  } = { current: { folders: [] } };
  // The bound host, movable. `HostClient.bind()` rebinds IN PLACE, so a swap
  // moves what the client reports without moving the client - which is exactly
  // the shape the rows arm has to notice.
  const activeHostId = { current: "host-home" };
  return {
    request,
    resolvedWorkspace,
    activeHostId,
    selectHost: vi.fn(),
    pickAndPrepareFolders: vi.fn(() => Promise.resolve(null)),
  };
});

const RESOLVED_FOLDER: ResolvedFolder = {
  kind: "resolved",
  path: WORKSPACE_PATH,
  name: "app",
  repoIdentifier: { owner: "acme", repo: "app" },
};

function folderAt(path: string): ResolvedFolder {
  return { ...RESOLVED_FOLDER, path, name: path };
}

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

// ONE object for the lifetime of the suite, as in production: `bind()` mutates
// the client rather than replacing it, so its identity is not a host signal.
const hostClient: MockHostClient = {
  getActiveHost: () => ({
    hostId: mocks.activeHostId.current,
    label: "Home Mac",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    transportDialability: "dialable",
  }),
  getActiveHostId: () => mocks.activeHostId.current,
  getRequestContextUserId: () => "user-home",
  request: mocks.request,
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
  useReactiveActiveHostId: () => mocks.activeHostId.current,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-home",
        label: "Home Mac",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:4917/rpc",
        version: "0.0.0-test",
        transportDialability: "dialable",
      },
    ],
  }),
}));

// This suite is about the refresh-on-mount latch, not the host list, so it
// mocks `useHostOptions` at the boundary (the same pattern panel suites use
// for `useHostScope`) rather than standing up the six hooks it composes.
// Reads `mocks.activeHostId.current` live so the "host swapped underneath
// the same mount" case stays exercised.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: mocks.activeHostId.current })],
        activeHostId: mocks.activeHostId.current,
      }),
  };
});

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

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue({ workspaces: [SUMMARY] });
  mocks.resolvedWorkspace.current = { folders: [RESOLVED_FOLDER] };
  mocks.activeHostId.current = "host-home";
});

afterEach(cleanup);

describe("stacked rows refresh-on-mount", () => {
  it("forces one re-derive when the fork / add-node surface mounts", async () => {
    renderControls("stacked");

    // Without this edge these surfaces render `forceRefresh: false` branch
    // metadata with no recovery at all when the host's watcher cannot see the
    // checkout - no network mount, no container, no evicted repo. They carry no
    // Refresh button of their own: close-and-reopen is the recovery, and only
    // this makes reopening a real re-derive instead of another cache-only read.
    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(1);
    });
    expect(forcedRefreshCalls()[0]).toMatchObject({
      workspacePaths: [WORKSPACE_PATH],
      forceRefresh: true,
    });
  });

  it("tells two folder scopes apart even when a space-join would not", async () => {
    // These two scopes are DIFFERENT - one folder versus two - but a
    // space-joined key flattens both to "/repos/a /b". A trailing space is a
    // legal path component on Unix, so this is a real collision rather than a
    // theoretical one, and under it the second scope reads as "same target" and
    // never gets its re-derive.
    mocks.resolvedWorkspace.current = { folders: [folderAt("/repos/a /b")] };
    const { rerenderFresh } = renderControls("stacked");
    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(1);
    });

    mocks.resolvedWorkspace.current = {
      folders: [folderAt("/repos/a"), folderAt("/b")],
    };
    rerenderFresh();

    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(2);
    });
  });

  it("forces again for a host swapped underneath the same mount", async () => {
    // A swap the surface never unmounts for: the user picks a different host
    // while the launcher stays open. `bind()` rebinds in place, so neither the
    // client object nor the folder list moves - the ONLY thing that moves is
    // the bound host id. A latch keyed off the client would still be holding
    // the previous host's key here and skip the new host entirely, leaving
    // these rows rendering the old machine's branch labels with no Refresh
    // button to correct them.
    const { rerenderFresh } = renderControls("stacked");
    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(1);
    });

    mocks.activeHostId.current = "host-work";
    rerenderFresh();

    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(2);
    });
  });

  it("forces again on the next mount, which is how close-and-reopen recovers", async () => {
    // The latch has to be per MOUNT. These surfaces live in dialogs with no
    // `forceMount`, so closing one unmounts it and reopening mounts it fresh -
    // that reopen IS the recovery this arm exists to provide. A module-level
    // "force only once ever" latch would satisfy every other case in this file
    // and silently take that recovery away after the first open.
    const first = renderControls("stacked");
    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(1);
    });
    first.unmount();

    renderControls("stacked");

    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(2);
    });
  });

  it("forces it exactly once per mount, even when the folder list is rebuilt", async () => {
    const { rerenderFresh } = renderControls("stacked");

    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(1);
    });

    // A NEW array with the same contents - which is what
    // `useResolvedWorkspaceFolders` hands back on any store touch. That changes
    // `queryableFolderPaths`, and with it the `refresh` callback's identity, so
    // an unlatched effect re-runs here. Re-deriving git on every incidental
    // rebuild is the idle-host burn the retired freshness sweep was removed
    // for; mount is the intent edge, not "the folder list object moved".
    mocks.resolvedWorkspace.current = {
      folders: [...mocks.resolvedWorkspace.current.folders],
    };
    rerenderFresh();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(forcedRefreshCalls().length).toBe(1);
  });

  it("does not burn its one attempt when the host was not reachable", async () => {
    // `canRefresh` only asserts a non-null client and a non-empty path list,
    // and the active scope's client is always present - so this fires even when
    // the bound host is unreachable, and fails. Latching on the ATTEMPT would
    // spend the surface's only chance before any recovery was possible.
    mocks.request.mockRejectedValue(new Error("host unreachable"));
    const { rerenderFresh } = renderControls("stacked");

    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(1);
    });

    // Same target, fresh folder-list identity - the effect re-runs, and a latch
    // released on failure lets it try again.
    mocks.request.mockResolvedValue({ workspaces: [SUMMARY] });
    mocks.resolvedWorkspace.current = {
      folders: [...mocks.resolvedWorkspace.current.folders],
    };
    rerenderFresh();

    await waitFor(() => {
      expect(forcedRefreshCalls().length).toBe(2);
    });
  });

  it("leaves the inline summary arm to its own popover-open edge", async () => {
    renderControls("inline");

    // The summary arm forces on `onOpenChange`, where the user has actually
    // asked to look. Firing here too would pay a re-derive for every landing
    // composer render, where the chip is incidental.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(forcedRefreshCalls()).toEqual([]);
  });
});

function forcedRefreshCalls(): Array<Record<string, unknown>> {
  return mocks.request.mock.calls.flatMap(([method, payload]) => {
    if (method !== "worktree.listByWorkspacePaths") return [];
    if (typeof payload !== "object" || payload === null) return [];
    const record: Record<string, unknown> = { ...payload };
    return record.forceRefresh === true ? [record] : [];
  });
}

function renderControls(layout: "inline" | "stacked"): {
  /** Re-renders from a FRESH element - React bails out on an identical one. */
  readonly rerenderFresh: () => void;
  /** Explicit, because `cleanup` only runs in `afterEach`. */
  readonly unmount: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const buildTree = (): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ActiveHostWorkspaceControls
          disabled={false}
          stagingKey={{
            surface: "landing",
            hostId: mocks.activeHostId.current,
            draftId: null,
          }}
          workspaceSeed={null}
          seedIntent={null}
          seedIntentOverride={null}
          layout={layout}
          hostScope={{ kind: "active" }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(buildTree());
  return {
    unmount,
    rerenderFresh: () => {
      rerender(buildTree());
    },
  };
}
