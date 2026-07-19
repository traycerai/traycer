import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  buildChatLinkPolicy,
  firstEagerlyTrueIndex,
} from "@/components/chat/build-chat-link-policy";
import type {
  ChatLinkLifecycle,
  ChatLinkPolicyDeps,
} from "@/components/chat/build-chat-link-policy";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import type { FetchResolveArtifactByPathArgs } from "@/lib/host/resolve-artifact-by-path";
import type { ProjectedSidebarNodeOpenArgs } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import type { FetchWorkspaceFileExistsArgs } from "@/lib/host/probe-workspace-file-exists";

const OPEN_EPIC_ID = "epic-open";
const ACTIVE_HOST_ID = "host-active";
const CHAT_HOST_ID = "host-chat";
const TAB_ID = "tab-1";

const SAME_EPIC_ARTIFACT_PATH = `/Users/me/.traycer/epics/${OPEN_EPIC_ID}/artifacts/some-spec/index.md`;
const CROSS_EPIC_ARTIFACT_PATH =
  "/Users/them/.traycer/epics/epic-other/artifacts/parent/child-ticket/index.md";

const mocks = vi.hoisted(() => ({
  resolveArtifactByPath:
    vi.fn<
      (
        args: FetchResolveArtifactByPathArgs,
      ) => Promise<ResolveArtifactByPathResult | null>
    >(),
  openProjectedSidebarNodeInTabWhenAvailable:
    vi.fn<(args: ProjectedSidebarNodeOpenArgs) => () => void>(),
  navigateToTabIntent: vi.fn(),
  openOrFocusEpicIntent: vi.fn((input: { epicId: string; focus: unknown }) => ({
    kind: "epic" as const,
    ...input,
  })),
  setWorkspaceFileRevealTarget: vi.fn(),
  workspaceFileRefFromLinkPath:
    vi.fn<
      (
        hostId: string,
        roots: ReadonlyArray<string>,
        path: string,
      ) => { id: string } | null
    >(),
  workspaceFileRefFromAbsoluteFilePath:
    vi.fn<(hostId: string, path: string) => { id: string } | null>(),
  candidateWorkspaceFileRefsForRelativeLinkPath: vi.fn<
    (
      hostId: string,
      roots: ReadonlyArray<string>,
      path: string,
    ) => ReadonlyArray<{
      readonly id: string;
      readonly workspacePath: string;
      readonly filePath: string;
    }> | null
  >(),
  candidateWorkspaceFileRefsForAbsoluteLinkPath: vi.fn<
    (
      hostId: string,
      roots: ReadonlyArray<string>,
      path: string,
    ) => ReadonlyArray<{
      readonly id: string;
      readonly workspacePath: string;
      readonly filePath: string;
    }> | null
  >(),
  fetchWorkspaceFileExists:
    vi.fn<(args: FetchWorkspaceFileExistsArgs) => Promise<boolean>>(),
}));

vi.mock("@/lib/host/resolve-artifact-by-path", () => ({
  fetchResolveArtifactByPath: (args: FetchResolveArtifactByPathArgs) =>
    mocks.resolveArtifactByPath(args),
}));

vi.mock("@/components/epic-canvas/sidebar/open-projected-sidebar-node", () => ({
  openProjectedSidebarNodeInTabWhenAvailable: (
    args: ProjectedSidebarNodeOpenArgs,
  ) => mocks.openProjectedSidebarNodeInTabWhenAvailable(args),
}));

vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (navigate: unknown, intent: unknown) => {
    mocks.navigateToTabIntent(navigate, intent);
  },
  openOrFocusEpicIntent: (input: { epicId: string; focus: unknown }) =>
    mocks.openOrFocusEpicIntent(input),
}));

vi.mock("@/stores/epics/canvas/workspace-file-reveal-store", () => ({
  setWorkspaceFileRevealTarget: (
    tabId: string,
    contentId: string,
    line: number,
    col: number | null,
  ) => {
    mocks.setWorkspaceFileRevealTarget(tabId, contentId, line, col);
  },
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-link-ref",
  () => ({
    workspaceFileRefFromLinkPath: (
      hostId: string,
      roots: ReadonlyArray<string>,
      path: string,
    ) => mocks.workspaceFileRefFromLinkPath(hostId, roots, path),
    workspaceFileRefFromAbsoluteFilePath: (hostId: string, path: string) =>
      mocks.workspaceFileRefFromAbsoluteFilePath(hostId, path),
    candidateWorkspaceFileRefsForRelativeLinkPath: (
      hostId: string,
      roots: ReadonlyArray<string>,
      path: string,
    ) =>
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath(hostId, roots, path),
    candidateWorkspaceFileRefsForAbsoluteLinkPath: (
      hostId: string,
      roots: ReadonlyArray<string>,
      path: string,
    ) =>
      mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath(hostId, roots, path),
  }),
);

vi.mock("@/lib/host/probe-workspace-file-exists", () => ({
  fetchWorkspaceFileExists: (args: FetchWorkspaceFileExistsArgs) =>
    mocks.fetchWorkspaceFileExists(args),
}));

let pendingCancel: (() => void) | null = null;
let disposed = false;
let clickToken = 0;
const previewTileInTab = vi.fn();
const onAsyncFailure = vi.fn();

function createHostClient(requestId: string): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => requestId,
      handlers: {},
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client;
}

// Distinct client identities so a test
// can assert WHICH client a call actually received - `client` (bound to the
// active/default host) and `workspaceClient` (bound to the chat tab's own
// host) must never be interchangeable.
const DEFAULT_CLIENT = createHostClient("default-client");
const WORKSPACE_CLIENT = createHostClient("workspace-client");

function makeDeps(overrides: Partial<ChatLinkPolicyDeps>): ChatLinkPolicyDeps {
  return {
    tabId: TAB_ID,
    hostId: CHAT_HOST_ID,
    workspaceRoots: ["/repo"],
    activeHostId: ACTIVE_HOST_ID,
    openEpicId: OPEN_EPIC_ID,
    // The builder only forwards these opaquely; the mocked modules ignore them.
    epicHandle: { store: { getState: vi.fn(), subscribe: vi.fn() } } as never,
    queryClient: {} as never,
    client: DEFAULT_CLIENT,
    workspaceClient: WORKSPACE_CLIENT,
    navigate: (() => undefined) as never,
    previewTileInTab,
    ...overrides,
  };
}

// Lifecycle is threaded in at call time (event context), mirroring how the
// component supplies the refs from inside its click handler.
const lifecycle: ChatLinkLifecycle = {
  isDisposed: () => disposed,
  getPendingProjectedOpenCancel: () => pendingCancel,
  setPendingProjectedOpenCancel: (cancel) => {
    pendingCancel = cancel;
  },
  beginClick: () => {
    clickToken += 1;
    return clickToken;
  },
  isCurrent: (token) => token === clickToken,
  onAsyncFailure,
};

function fileLink(overrides: Partial<MarkdownFileLink>): MarkdownFileLink {
  return {
    path: "src/app.ts",
    line: null,
    col: null,
    isDirectory: false,
    ...overrides,
  };
}

beforeEach(() => {
  pendingCancel = null;
  disposed = false;
  clickToken = 0;
  previewTileInTab.mockReset();
  onAsyncFailure.mockReset();
  mocks.resolveArtifactByPath.mockReset();
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReset();
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReturnValue(
    () => undefined,
  );
  mocks.navigateToTabIntent.mockReset();
  mocks.openOrFocusEpicIntent.mockClear();
  mocks.setWorkspaceFileRevealTarget.mockReset();
  mocks.workspaceFileRefFromLinkPath.mockReset();
  mocks.workspaceFileRefFromLinkPath.mockReturnValue({ id: "content-1" });
  mocks.workspaceFileRefFromAbsoluteFilePath.mockReset();
  mocks.workspaceFileRefFromAbsoluteFilePath.mockReturnValue(null);
  mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReset();
  mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
    { id: "content-1", workspacePath: "/repo", filePath: "src/app.ts" },
  ]);
  // `null` (no structural candidates) is the default so EXISTING absolute-path
  // tests, written against the old deterministic longest-prefix match, keep
  // exercising that same `openChatWorkspaceFilePreview` fallback (via
  // `workspaceFileRefFromLinkPath`/`workspaceFileRefFromAbsoluteFilePath`)
  // rather than the new probe-race; tests exercising the race set their own
  // candidates explicitly.
  mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReset();
  mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReturnValue(null);
  mocks.fetchWorkspaceFileExists.mockReset();
  mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("firstEagerlyTrueIndex", () => {
  it("treats a rejected higher-priority probe as false rather than hanging forever (#2)", async () => {
    const winningIndex = await firstEagerlyTrueIndex([
      Promise.reject(new Error("transport error")),
      Promise.resolve(true),
    ]);
    expect(winningIndex).toBe(1);
  });

  it("resolves -1 (not hanging) when every probe rejects", async () => {
    const winningIndex = await firstEagerlyTrueIndex([
      Promise.reject(new Error("a")),
      Promise.reject(new Error("b")),
    ]);
    expect(winningIndex).toBe(-1);
  });
});

describe("buildChatLinkPolicy", () => {
  it("ignores directory links without calling the RPC", () => {
    const run = buildChatLinkPolicy(makeDeps({}));
    expect(run(fileLink({ isDirectory: true }), lifecycle)).toBe(false);
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("opens a relative non-artifact path as a workspace-file preview after probing the root for existence", async () => {
    const run = buildChatLinkPolicy(makeDeps({}));
    expect(run(fileLink({ path: "src/app.ts" }), lifecycle)).toBe(true);
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    await flush();

    expect(
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath,
    ).toHaveBeenCalledWith(CHAT_HOST_ID, ["/repo"], "src/app.ts");
    expect(mocks.fetchWorkspaceFileExists).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: CHAT_HOST_ID,
        workspacePath: "/repo",
        filePath: "src/app.ts",
        // Bound to the CHAT TAB's own host, not the app-wide default client -
        // a tab pinned to a different host than the active one must probe ITS
        // OWN filesystem, not whatever host `client` happens to be connected to.
        client: WORKSPACE_CLIENT,
      }),
    );
    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "content-1",
      workspacePath: "/repo",
      filePath: "src/app.ts",
    });
  });

  it("probes the tab-scoped workspace client even when it differs from the app-wide default host client", async () => {
    // A chat tab bound to a DIFFERENT host than the app's active one: the
    // existence probe must still go through `workspaceClient`, never `client`
    // (which is bound to `activeHostId`, a different physical host here).
    const run = buildChatLinkPolicy(
      makeDeps({ hostId: CHAT_HOST_ID, activeHostId: ACTIVE_HOST_ID }),
    );
    run(fileLink({ path: "src/app.ts" }), lifecycle);
    await flush();

    const [args] = mocks.fetchWorkspaceFileExists.mock.calls.at(-1) ?? [];
    expect(args?.client).toBe(WORKSPACE_CLIENT);
    expect(args?.client).not.toBe(DEFAULT_CLIENT);
  });

  it("reports a click failure for a relative link without probing when the tab-scoped workspace client hasn't resolved yet", async () => {
    const run = buildChatLinkPolicy(makeDeps({ workspaceClient: null }));

    expect(run(fileLink({ path: "src/app.ts" }), lifecycle)).toBe(true);
    await flush();

    expect(
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath,
    ).not.toHaveBeenCalled();
    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(previewTileInTab).not.toHaveBeenCalled();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
  });

  it("records a reveal target before opening when the link carries a line", async () => {
    const run = buildChatLinkPolicy(makeDeps({}));
    run(fileLink({ path: "src/app.ts", line: 42, col: 7 }), lifecycle);
    await flush();

    expect(mocks.setWorkspaceFileRevealTarget).toHaveBeenCalledWith(
      TAB_ID,
      "content-1",
      42,
      7,
    );
    expect(previewTileInTab).toHaveBeenCalledTimes(1);
  });

  it("probes every bound root and opens the first one that has the file", async () => {
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      { id: "root-a-content", workspacePath: "/repo-a", filePath: "app.ts" },
      { id: "root-b-content", workspacePath: "/repo-b", filePath: "app.ts" },
    ]);
    mocks.fetchWorkspaceFileExists.mockImplementation(
      (args: { readonly workspacePath: string }) =>
        Promise.resolve(args.workspacePath === "/repo-b"),
    );
    const run = buildChatLinkPolicy(
      makeDeps({ workspaceRoots: ["/repo-a", "/repo-b"] }),
    );

    expect(run(fileLink({ path: "app.ts" }), lifecycle)).toBe(true);
    await flush();

    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "root-b-content",
      workspacePath: "/repo-b",
      filePath: "app.ts",
    });
  });

  it("prefers the first root by order even when a later root's probe settles first", async () => {
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      { id: "root-a-content", workspacePath: "/repo-a", filePath: "app.ts" },
      { id: "root-b-content", workspacePath: "/repo-b", filePath: "app.ts" },
    ]);
    let resolveRootA: (exists: boolean) => void = () => undefined;
    mocks.fetchWorkspaceFileExists.mockImplementation(
      (args: { readonly workspacePath: string }) =>
        args.workspacePath === "/repo-a"
          ? new Promise<boolean>((resolve) => {
              resolveRootA = resolve;
            })
          : Promise.resolve(true),
    );
    const run = buildChatLinkPolicy(
      makeDeps({ workspaceRoots: ["/repo-a", "/repo-b"] }),
    );

    run(fileLink({ path: "app.ts" }), lifecycle);
    await flush();
    expect(previewTileInTab).not.toHaveBeenCalled();

    resolveRootA(true);
    await flush();

    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "root-a-content",
      workspacePath: "/repo-a",
      filePath: "app.ts",
    });
  });

  it("opens the first root's hit immediately, without waiting on a still-pending lower-priority root", async () => {
    // Root 0 settles true right away; root 1 never settles within this test.
    // No later root can ever outrank root 0, so the open must not wait for it.
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      { id: "root-a-content", workspacePath: "/repo-a", filePath: "app.ts" },
      { id: "root-b-content", workspacePath: "/repo-b", filePath: "app.ts" },
    ]);
    mocks.fetchWorkspaceFileExists.mockImplementation(
      (args: { readonly workspacePath: string }) =>
        args.workspacePath === "/repo-a"
          ? Promise.resolve(true)
          : new Promise<boolean>(() => undefined),
    );
    const run = buildChatLinkPolicy(
      makeDeps({ workspaceRoots: ["/repo-a", "/repo-b"] }),
    );

    run(fileLink({ path: "app.ts" }), lifecycle);
    await flush();

    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "root-a-content",
      workspacePath: "/repo-a",
      filePath: "app.ts",
    });
  });

  it("reports a click failure when no bound root has the relative file", async () => {
    mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: "missing.ts" }), lifecycle);
    await flush();

    expect(previewTileInTab).not.toHaveBeenCalled();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
  });

  it("opens a directory-shaped relative href by probing its canonical index.md candidate", async () => {
    // A trailing-separator href resolves to the directory's `index.md`, not a
    // rejection - `candidateWorkspaceFileRefsForRelativeLinkPath` builds that
    // candidate itself (see workspace-file-link-ref.test.ts); this level only
    // verifies the policy probes and opens whatever candidate it returns.
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      {
        id: "dir-index-content",
        workspacePath: "/repo",
        filePath: "sub-dir/index.md",
      },
    ]);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: "sub-dir/" }), lifecycle);
    await flush();

    expect(
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath,
    ).toHaveBeenCalledWith(CHAT_HOST_ID, ["/repo"], "sub-dir/");
    expect(mocks.fetchWorkspaceFileExists).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        filePath: "sub-dir/index.md",
      }),
    );
    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "dir-index-content",
      workspacePath: "/repo",
      filePath: "sub-dir/index.md",
    });
  });

  it("reports a click failure for a relative link without probing when there is no bound host", async () => {
    const run = buildChatLinkPolicy(makeDeps({ hostId: null }));

    expect(run(fileLink({ path: "src/app.ts" }), lifecycle)).toBe(true);
    await flush();

    expect(
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath,
    ).not.toHaveBeenCalled();
    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(previewTileInTab).not.toHaveBeenCalled();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
  });

  it("resolves a same-epic artifact link and opens it via the projection waiter", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-same",
      kind: "spec",
    });
    const run = buildChatLinkPolicy(makeDeps({}));

    expect(run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle)).toBe(
      true,
    );
    await flush();

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: ACTIVE_HOST_ID,
        epicId: OPEN_EPIC_ID,
        filePath: SAME_EPIC_ARTIFACT_PATH,
      }),
    );
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: TAB_ID,
        nodeId: "artifact-same",
        fallbackHostId: ACTIVE_HOST_ID,
        openTileInTab: previewTileInTab,
      }),
    );
    // The cancel handle is retained so an unmount can tear the wait down.
    expect(pendingCancel).not.toBeNull();
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("navigates a cross-epic artifact link with a fresh focusedAt", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-cross",
      kind: "ticket",
    });
    const before = Date.now();
    const run = buildChatLinkPolicy(makeDeps({}));

    expect(run(fileLink({ path: CROSS_EPIC_ARTIFACT_PATH }), lifecycle)).toBe(
      true,
    );
    await flush();

    expect(mocks.openOrFocusEpicIntent).toHaveBeenCalledTimes(1);
    const input = mocks.openOrFocusEpicIntent.mock.calls[0][0];
    expect(input.epicId).toBe("epic-other");
    expect(input.focus).toEqual(
      expect.objectContaining({
        focusArtifactId: "artifact-cross",
        focusThreadId: undefined,
        migrationSource: undefined,
      }),
    );
    expect(
      (input.focus as { focusedAt: number }).focusedAt,
    ).toBeGreaterThanOrEqual(before);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
  });

  it("falls back to a file preview when the artifact resolves to null", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(null);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle);
    await flush();

    expect(mocks.workspaceFileRefFromLinkPath).toHaveBeenCalledWith(
      CHAT_HOST_ID,
      ["/repo"],
      SAME_EPIC_ARTIFACT_PATH,
    );
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
  });

  it("falls back to a file preview when the resolve rejects", async () => {
    mocks.resolveArtifactByPath.mockRejectedValue(new Error("transport"));
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle);
    await flush();

    expect(previewTileInTab).toHaveBeenCalledTimes(1);
  });

  it("drops the rejected artifact fallback when a newer click has superseded it", async () => {
    // First click's resolve is held open so a newer click can supersede it
    // before it rejects; the second resolves to an artifact (opening via the
    // projection waiter, not previewTileInTab).
    let rejectFirstClick: (reason: Error) => void = () => undefined;
    const firstResolve = new Promise<ResolveArtifactByPathResult>(
      (_resolve, reject) => {
        rejectFirstClick = reject;
      },
    );
    mocks.resolveArtifactByPath
      .mockReturnValueOnce(firstResolve)
      .mockResolvedValueOnce({ artifactId: "artifact-newer", kind: "spec" });
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle); // token 1
    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle); // token 2 supersedes
    await flush();

    // The slow first click now rejects: its catch must NOT open a fallback
    // preview over the newer click (latest-click-wins).
    rejectFirstClick(new Error("transport"));
    await flush();

    expect(previewTileInTab).not.toHaveBeenCalled();
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "artifact-newer" }),
    );
  });

  it("drops the deferred open when the tab is disposed mid-resolve", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-same",
      kind: "spec",
    });
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle);
    disposed = true;
    await flush();

    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("treats an artifact path as a plain file when there is no active host", async () => {
    const run = buildChatLinkPolicy(makeDeps({ activeHostId: null }));
    expect(run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle)).toBe(
      true,
    );
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    await flush();

    expect(previewTileInTab).toHaveBeenCalledTimes(1);
  });

  it("cancels a prior same-epic projection wait on a superseding plain-file click, without re-opening the prior link", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-same",
      kind: "spec",
    });
    const cancelPriorWait = vi.fn();
    mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReturnValue(
      cancelPriorWait,
    );
    const run = buildChatLinkPolicy(makeDeps({}));

    // First click installs a same-epic projection wait (its cancel handle is
    // retained on the lifecycle).
    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle);
    await flush();
    expect(pendingCancel).toBe(cancelPriorWait);
    expect(cancelPriorWait).not.toHaveBeenCalled();

    // A newer plain-file click supersedes it: the prior wait is cancelled
    // (silently — the mock cancel fires no fallback) and the pending handle is
    // cleared, so the prior artifact never opens over the new file.
    expect(run(fileLink({ path: "src/app.ts" }), lifecycle)).toBe(true);
    expect(cancelPriorWait).toHaveBeenCalledTimes(1);
    expect(pendingCancel).toBeNull();
    await flush();
    expect(previewTileInTab).toHaveBeenCalledTimes(1);
    expect(previewTileInTab).toHaveBeenLastCalledWith(TAB_ID, {
      id: "content-1",
      workspacePath: "/repo",
      filePath: "src/app.ts",
    });
  });

  it("lets the newest click win when an earlier same-epic resolve settles out of order", async () => {
    let settleFirstClick: (value: ResolveArtifactByPathResult) => void = () =>
      undefined;
    let settleSecondClick: (value: ResolveArtifactByPathResult) => void = () =>
      undefined;
    const firstResolve = new Promise<ResolveArtifactByPathResult>((resolve) => {
      settleFirstClick = resolve;
    });
    const secondResolve = new Promise<ResolveArtifactByPathResult>(
      (resolve) => {
        settleSecondClick = resolve;
      },
    );
    mocks.resolveArtifactByPath
      .mockReturnValueOnce(firstResolve)
      .mockReturnValueOnce(secondResolve);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle); // token 1
    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle); // token 2

    // The newer click resolves first and installs its wait...
    settleSecondClick({ artifactId: "artifact-newer", kind: "spec" });
    await flush();
    // ...then the slow earlier click settles last and must be dropped.
    settleFirstClick({ artifactId: "artifact-older", kind: "spec" });
    await flush();

    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "artifact-newer" }),
    );
  });

  it("opens a non-artifact out-of-root absolute path via a synthesized workspace ref", async () => {
    // No structural candidate (default mock): falls to the deterministic
    // fallback, where in-root resolution misses (out-of-root) and the
    // absolute-file fallback supplies the synthesized ref so the file still
    // opens (D1/D2).
    mocks.workspaceFileRefFromLinkPath.mockReturnValue(null);
    mocks.workspaceFileRefFromAbsoluteFilePath.mockReturnValue({
      id: "abs-content",
    });
    const skillPath =
      "/Users/me/.traycer/.codex/skills/traycer-review/SKILL.md";
    const run = buildChatLinkPolicy(makeDeps({}));

    expect(run(fileLink({ path: skillPath }), lifecycle)).toBe(true);
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    await flush();

    expect(mocks.workspaceFileRefFromAbsoluteFilePath).toHaveBeenCalledWith(
      CHAT_HOST_ID,
      skillPath,
    );
    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "abs-content",
    });
  });

  it("opens the direct absolute candidate when it exists, instead of coercing it into a directory reference (A)", async () => {
    const directRef = {
      id: "readme-content",
      workspacePath: "/repo/epics/e1/artifacts/spec",
      filePath: "README.md",
    };
    const dirIndexRef = {
      id: "readme-index-content",
      workspacePath: "/repo/epics/e1/artifacts/spec/README.md",
      filePath: "index.md",
    };
    mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReturnValue([
      directRef,
      dirIndexRef,
    ]);
    mocks.fetchWorkspaceFileExists.mockImplementation(
      (args: { readonly workspacePath: string }) =>
        Promise.resolve(args.workspacePath === directRef.workspacePath),
    );
    const run = buildChatLinkPolicy(makeDeps({}));

    run(
      fileLink({ path: "/repo/epics/e1/artifacts/spec/README.md" }),
      lifecycle,
    );
    await flush();

    // README.md is a real file - not the `index.md` fallback, even though
    // BOTH candidates were probed.
    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, directRef);
  });

  it("falls back to the index.md candidate when the direct absolute target doesn't exist (A, C1)", async () => {
    const directRef = {
      id: "sub-ticket-content",
      workspacePath: "/repo/epics/e1/artifacts",
      filePath: "01-sub-ticket",
    };
    const dirIndexRef = {
      id: "sub-ticket-index-content",
      workspacePath: "/repo/epics/e1/artifacts/01-sub-ticket",
      filePath: "index.md",
    };
    mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReturnValue([
      directRef,
      dirIndexRef,
    ]);
    mocks.fetchWorkspaceFileExists.mockImplementation(
      (args: { readonly workspacePath: string }) =>
        Promise.resolve(args.workspacePath === dirIndexRef.workspacePath),
    );
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-sub-ticket",
      kind: "ticket",
    });
    const run = buildChatLinkPolicy(makeDeps({}));

    run(
      fileLink({ path: "/repo/epics/e1/artifacts/01-sub-ticket" }),
      lifecycle,
    );
    await flush();

    // The winning candidate is index.md-shaped, so it routes through the
    // artifact resolver (B) rather than opening a raw file preview.
    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "e1",
        filePath: "/repo/epics/e1/artifacts/01-sub-ticket/index.md",
      }),
    );
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("opens the direct absolute candidate when NEITHER candidate is confirmed to exist, preserving the open-any-file capability", async () => {
    const directRef = {
      id: "unsynced-content",
      workspacePath: "/repo",
      filePath: "just-written.ts",
    };
    const dirIndexRef = {
      id: "unsynced-index-content",
      workspacePath: "/repo/just-written.ts",
      filePath: "index.md",
    };
    mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReturnValue([
      directRef,
      dirIndexRef,
    ]);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
    // The fallback re-derives the direct ref via `openChatWorkspaceFilePreview`
    // (the same pre-existing synchronous path the no-candidates/no-client
    // branches already use) rather than reusing the race's own candidate
    // object, so this must resolve to the SAME ref the mocked candidate list
    // above used for its direct (non-index.md) entry.
    mocks.workspaceFileRefFromLinkPath.mockReturnValue(directRef);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: "/repo/just-written.ts" }), lifecycle);
    await flush();

    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, directRef);
    expect(onAsyncFailure).not.toHaveBeenCalled();
    // A non-artifact-shaped miss never attempts the RPC at all.
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
  });

  it("tries a structurally artifact-shaped candidate through the resolver before defaulting to the direct candidate when neither local probe hits (#4)", async () => {
    const directRef = {
      id: "foreign-direct",
      workspacePath: "/Users/them/.traycer/epics/foreign-epic/artifacts",
      filePath: "some-dir",
    };
    const dirIndexRef = {
      id: "foreign-index",
      workspacePath:
        "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir",
      filePath: "index.md",
    };
    mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReturnValue([
      directRef,
      dirIndexRef,
    ]);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-foreign",
      kind: "spec",
    });
    const run = buildChatLinkPolicy(makeDeps({}));

    run(
      fileLink({
        path: "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir",
      }),
      lifecycle,
    );
    await flush();

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "foreign-epic",
        filePath:
          "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir/index.md",
      }),
    );
    // Cross-epic (differs from OPEN_EPIC_ID): navigate, not a same-epic preview.
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("falls back to the direct candidate when the artifact-shaped fallback also misses (#4)", async () => {
    const directRef = {
      id: "foreign-direct-miss",
      workspacePath: "/Users/them/.traycer/epics/foreign-epic/artifacts",
      filePath: "some-dir",
    };
    const dirIndexRef = {
      id: "foreign-index-miss",
      workspacePath:
        "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir",
      filePath: "index.md",
    };
    mocks.candidateWorkspaceFileRefsForAbsoluteLinkPath.mockReturnValue([
      directRef,
      dirIndexRef,
    ]);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
    mocks.resolveArtifactByPath.mockResolvedValue(null);
    mocks.workspaceFileRefFromLinkPath.mockReturnValue(directRef);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(
      fileLink({
        path: "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir",
      }),
      lifecycle,
    );
    await flush();

    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, directRef);
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("tries a structurally artifact-shaped candidate through the resolver even when the chat's own workspace client hasn't resolved yet (#4)", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-foreign-no-client",
      kind: "spec",
    });
    const run = buildChatLinkPolicy(makeDeps({ workspaceClient: null }));

    run(
      fileLink({
        path: "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir",
      }),
      lifecycle,
    );
    await flush();

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "foreign-epic",
        filePath:
          "/Users/them/.traycer/epics/foreign-epic/artifacts/some-dir/index.md",
      }),
    );
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("routes a resolved RELATIVE workspace-file winner through the artifact resolver when it lands on an index.md (B)", async () => {
    const winner = {
      id: "cross-artifact-content",
      workspacePath: "/repo",
      filePath: "epics/other-epic/artifacts/spec/index.md",
    };
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      winner,
    ]);
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-cross",
      kind: "spec",
    });
    const run = buildChatLinkPolicy(makeDeps({}));

    run(
      fileLink({ path: "../../.traycer/epics/other-epic/artifacts/spec" }),
      lifecycle,
    );
    await flush();

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "other-epic",
        filePath: "/repo/epics/other-epic/artifacts/spec/index.md",
      }),
    );
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("falls back to opening the winning file when its index.md-shaped path doesn't resolve to a real artifact (B)", async () => {
    const winner = {
      id: "coincidental-content",
      workspacePath: "/repo",
      filePath: "epics/other-epic/artifacts/spec/index.md",
    };
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      winner,
    ]);
    mocks.resolveArtifactByPath.mockResolvedValue(null);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(
      fileLink({ path: "../../.traycer/epics/other-epic/artifacts/spec" }),
      lifecycle,
    );
    await flush();

    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, winner);
  });

  it("keeps the artifact-null fallback a no-op with out-of-root synthesis disabled (D5)", async () => {
    // The artifact resolves to null and its out-of-root `index.md` misses the
    // in-root resolver; with synthesis gated off on the artifact fallback, the
    // absolute helper must NOT be consulted and nothing opens (CL-1 no-op).
    mocks.resolveArtifactByPath.mockResolvedValue(null);
    mocks.workspaceFileRefFromLinkPath.mockReturnValue(null);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle);
    await flush();

    expect(mocks.workspaceFileRefFromAbsoluteFilePath).not.toHaveBeenCalled();
    expect(previewTileInTab).not.toHaveBeenCalled();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected artifact resolution when its safe fallback cannot open", async () => {
    mocks.resolveArtifactByPath.mockRejectedValue(new Error("transport"));
    mocks.workspaceFileRefFromLinkPath.mockReturnValue(null);
    const run = buildChatLinkPolicy(makeDeps({}));

    run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle);
    await flush();

    expect(previewTileInTab).not.toHaveBeenCalled();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
  });
});
