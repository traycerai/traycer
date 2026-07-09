import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChatLinkPolicy } from "@/components/chat/build-chat-link-policy";
import type {
  ChatLinkLifecycle,
  ChatLinkPolicyDeps,
} from "@/components/chat/build-chat-link-policy";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import type { FetchResolveArtifactByPathArgs } from "@/lib/host/resolve-artifact-by-path";
import type { ProjectedSidebarNodeOpenArgs } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";

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
  }),
);

let pendingCancel: (() => void) | null = null;
let disposed = false;
let clickToken = 0;
const previewTileInTab = vi.fn();

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
    client: {} as never,
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("buildChatLinkPolicy", () => {
  it("ignores directory links without calling the RPC", () => {
    const run = buildChatLinkPolicy(makeDeps({}));
    expect(run(fileLink({ isDirectory: true }), lifecycle)).toBe(false);
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(previewTileInTab).not.toHaveBeenCalled();
  });

  it("opens a non-artifact path as a workspace-file preview without the RPC", () => {
    const run = buildChatLinkPolicy(makeDeps({}));
    expect(run(fileLink({ path: "src/app.ts" }), lifecycle)).toBe(true);
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(mocks.workspaceFileRefFromLinkPath).toHaveBeenCalledWith(
      CHAT_HOST_ID,
      ["/repo"],
      "src/app.ts",
    );
    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "content-1",
    });
  });

  it("records a reveal target before opening when the link carries a line", () => {
    const run = buildChatLinkPolicy(makeDeps({}));
    run(fileLink({ path: "src/app.ts", line: 42, col: 7 }), lifecycle);
    expect(mocks.setWorkspaceFileRevealTarget).toHaveBeenCalledWith(
      TAB_ID,
      "content-1",
      42,
      7,
    );
    expect(previewTileInTab).toHaveBeenCalledTimes(1);
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

  it("treats an artifact path as a plain file when there is no active host", () => {
    const run = buildChatLinkPolicy(makeDeps({ activeHostId: null }));
    expect(run(fileLink({ path: SAME_EPIC_ARTIFACT_PATH }), lifecycle)).toBe(
      true,
    );
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
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
    expect(previewTileInTab).toHaveBeenCalledTimes(1);
    expect(previewTileInTab).toHaveBeenLastCalledWith(TAB_ID, {
      id: "content-1",
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

  it("opens a non-artifact out-of-root absolute path via a synthesized workspace ref", () => {
    // In-root resolution misses (out-of-root); the absolute-file fallback
    // supplies the synthesized ref so the file still opens (D1/D2).
    mocks.workspaceFileRefFromLinkPath.mockReturnValue(null);
    mocks.workspaceFileRefFromAbsoluteFilePath.mockReturnValue({
      id: "abs-content",
    });
    const skillPath =
      "/Users/me/.traycer/.codex/skills/traycer-review/SKILL.md";
    const run = buildChatLinkPolicy(makeDeps({}));

    expect(run(fileLink({ path: skillPath }), lifecycle)).toBe(true);
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(mocks.workspaceFileRefFromAbsoluteFilePath).toHaveBeenCalledWith(
      CHAT_HOST_ID,
      skillPath,
    );
    expect(previewTileInTab).toHaveBeenCalledWith(TAB_ID, {
      id: "abs-content",
    });
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
  });
});
