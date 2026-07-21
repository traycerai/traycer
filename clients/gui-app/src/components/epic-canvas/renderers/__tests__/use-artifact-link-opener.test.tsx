import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLinkLifecycle } from "@/components/chat/build-chat-link-policy";
import type { FetchResolveArtifactByPathArgs } from "@/lib/host/resolve-artifact-by-path";
import type { ProjectedSidebarNodeOpenArgs } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import { useArtifactLinkOpener } from "../use-artifact-link-opener";

interface ExternalMutationOptions {
  readonly onSettled: () => void;
}

const mocks = vi.hoisted(() => {
  const runPolicy = vi.fn<
    (link: MarkdownFileLink, lifecycle: ChatLinkLifecycle) => boolean
  >(() => true);
  const previewTileInTab = vi.fn();
  const worktreeQuery: {
    data:
      | {
          rows: Array<{ runningDir: string; disabledReason: string | null }>;
        }
      | undefined;
    isError: boolean;
  } = {
    data: { rows: [{ runningDir: "/tab/repo", disabledReason: null }] },
    isError: false,
  };
  return {
    tabClient: { request: vi.fn() },
    defaultClient: { request: vi.fn() },
    worktreeQuery,
    listBindingsForClient: vi.fn(() => worktreeQuery),
    runPolicy,
    buildPolicy: vi.fn(() => runPolicy),
    openExternal:
      vi.fn<(url: string, options: ExternalMutationOptions) => void>(),
    runnerPending: false,
    toast: vi.fn(),
    folderChain: vi.fn<(artifactId: string) => readonly string[] | null>(() => [
      "root-artifact",
    ]),
    navigate: vi.fn(),
    previewTileInTab,
    epicHandle: { store: {} },
    // A STABLE object reference returned on every call, matching how the
    // real hook (context/Zustand-backed) behaves - a fresh literal per call
    // would destabilize every memo/callback downstream of it for reasons
    // that don't exist in production.
    tileNavigation: { openTilePreviewInTab: previewTileInTab },
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
    fetchWorkspaceFileExists:
      vi.fn<(args: { readonly workspacePath: string }) => Promise<boolean>>(),
    resolveArtifactByPath:
      vi.fn<
        (
          args: FetchResolveArtifactByPathArgs,
        ) => Promise<ResolveArtifactByPathResult | null>
      >(),
    openProjectedSidebarNodeInTabWhenAvailable:
      vi.fn<(args: ProjectedSidebarNodeOpenArgs) => () => void>(),
    navigateToTabIntent: vi.fn(),
    openOrFocusEpicIntent: vi.fn(
      (input: { epicId: string; focus: unknown }) => ({
        kind: "epic" as const,
        ...input,
      }),
    ),
    setWorkspaceFileRevealTarget: vi.fn(),
  };
});

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "tab-host",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabClient,
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "default-host",
}));
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpicForClient: mocks.listBindingsForClient,
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.defaultClient,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useArtifactFolderChain: (artifactId: string) => mocks.folderChain(artifactId),
}));
// `buildChatLinkPolicy` (used for the ABSOLUTE-href branch, and internally
// for the shared workspace-file/artifact-open primitives the RELATIVE-href
// race reuses) is mocked ONLY at its `buildChatLinkPolicy` export;
// `firstEagerlyTrueIndex`/`openResolvedArtifact`/`openResolvedWorkspaceTarget`
// stay REAL - they're independently covered in build-chat-link-policy.test.ts,
// and the race logic under test here depends on their actual behavior, not a
// stand-in.
vi.mock("@/components/chat/build-chat-link-policy", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/chat/build-chat-link-policy")
    >();
  return { ...actual, buildChatLinkPolicy: mocks.buildPolicy };
});
vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-link-ref",
  () => ({
    candidateWorkspaceFileRefsForRelativeLinkPath: (
      hostId: string,
      roots: ReadonlyArray<string>,
      path: string,
    ) =>
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath(hostId, roots, path),
  }),
);
vi.mock("@/lib/host/probe-workspace-file-exists", () => ({
  fetchWorkspaceFileExists: (args: { readonly workspacePath: string }) =>
    mocks.fetchWorkspaceFileExists(args),
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
vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({
    mutate: mocks.openExternal,
    isPending: mocks.runnerPending,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => mocks.tileNavigation,
}));
vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => mocks.epicHandle,
}));
vi.mock("@tanstack/react-router", () => ({
  // A STABLE reference across renders, matching the real `useNavigate`'s
  // behavior (it doesn't change identity when the router context doesn't) -
  // an unstable mock here would destabilize every memo/callback downstream
  // of `navigate` for reasons that don't exist in production.
  useNavigate: () => mocks.navigate,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

function QueryWrapper(props: { readonly children: ReactNode }) {
  // A STABLE client across rerenders - constructing `new QueryClient()`
  // inline in the render body would hand `useQueryClient()` a different
  // instance on every rerender, destabilizing anything memoized on it.
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.worktreeQuery.data = {
    rows: [{ runningDir: "/tab/repo", disabledReason: null }],
  };
  mocks.worktreeQuery.isError = false;
  mocks.listBindingsForClient.mockClear();
  mocks.buildPolicy.mockClear();
  mocks.runPolicy.mockReset();
  mocks.runPolicy.mockReturnValue(true);
  mocks.openExternal.mockClear();
  mocks.runnerPending = false;
  mocks.toast.mockClear();
  mocks.folderChain.mockReset();
  mocks.folderChain.mockReturnValue(["root-artifact"]);
  mocks.navigate.mockClear();
  mocks.previewTileInTab.mockReset();
  mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReset();
  mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue(null);
  mocks.fetchWorkspaceFileExists.mockReset();
  mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
  mocks.resolveArtifactByPath.mockReset();
  mocks.resolveArtifactByPath.mockResolvedValue(null);
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReset();
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReturnValue(
    () => undefined,
  );
  mocks.navigateToTabIntent.mockReset();
  mocks.openOrFocusEpicIntent.mockClear();
  mocks.setWorkspaceFileRevealTarget.mockReset();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useArtifactLinkOpener", () => {
  it("queries roots with the tab client while resolving artifacts with the default client", () => {
    renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    expect(mocks.listBindingsForClient).toHaveBeenCalledWith({
      client: mocks.tabClient,
      epicId: "epic-1",
      enabled: true,
    });
    expect(mocks.buildPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        client: mocks.defaultClient,
        workspaceClient: mocks.tabClient,
        hostId: "tab-host",
        activeHostId: "default-host",
        workspaceRoots: ["/tab/repo"],
      }),
    );
  });

  it("gates file routing until workspace roots have loaded", () => {
    mocks.worktreeQuery.data = undefined;
    const { result, rerender } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );
    // Absolute, so the gate is exercised in isolation from the relative-href
    // race (which never even reaches `openFile`/`runPolicy`).
    const link = {
      kind: "file" as const,
      path: "/artifact/index.md",
      line: null,
      col: null,
    };

    result.current.openLink(link);

    expect(mocks.runPolicy).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Workspace links are still loading",
    );

    mocks.worktreeQuery.data = {
      rows: [{ runningDir: "/tab/repo", disabledReason: null }],
    };
    rerender();
    result.current.openLink(link);

    expect(mocks.runPolicy).toHaveBeenCalledTimes(1);
  });

  it("supersedes an earlier async file click when a newer click hits the readiness gate", () => {
    const cancel = vi.fn();
    const state: { firstLifecycle: ChatLinkLifecycle | null } = {
      firstLifecycle: null,
    };
    mocks.runPolicy.mockImplementationOnce((_link, lifecycle) => {
      state.firstLifecycle = lifecycle;
      lifecycle.beginClick();
      lifecycle.setPendingProjectedOpenCancel(cancel);
      return true;
    });
    const { result, rerender } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );
    const link = {
      kind: "file" as const,
      path: "/artifact/index.md",
      line: null,
      col: null,
    };

    result.current.openLink(link);
    mocks.worktreeQuery.data = undefined;
    rerender();
    result.current.openLink(link);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.firstLifecycle?.isCurrent(1)).toBe(false);
  });

  it("reports a workspace-root loading failure without routing", () => {
    mocks.worktreeQuery.data = undefined;
    mocks.worktreeQuery.isError = true;
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "src/index.ts",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
  });

  it("routes external links through the runner mutation", () => {
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "external",
      url: "https://example.com",
    });

    expect(mocks.openExternal.mock.calls[0]?.[0]).toBe("https://example.com");
  });

  it("keeps the opener stable when the mutation result object is recreated", () => {
    const { result, rerender } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );
    const firstOpenLink = result.current.openLink;

    rerender();

    expect(result.current.openLink).toBe(firstOpenLink);
  });

  it("supersedes an in-flight artifact open before routing an external link", () => {
    const cancel = vi.fn();
    mocks.runPolicy.mockImplementationOnce((_link, lifecycle) => {
      lifecycle.beginClick();
      lifecycle.setPendingProjectedOpenCancel(cancel);
      return true;
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "/artifact/index.md",
      line: null,
      col: null,
    });
    result.current.openLink({
      kind: "external",
      url: "https://example.com",
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal.mock.calls[0]?.[0]).toBe("https://example.com");
  });

  it("atomically rejects a same-turn second external open until settlement", () => {
    let settle: () => void = () => undefined;
    mocks.openExternal.mockImplementation((_url, options) => {
      settle = options.onSettled;
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    const link = { kind: "external" as const, url: "https://example.com" };
    result.current.openLink(link);
    result.current.openLink(link);

    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    settle();
    result.current.openLink(link);
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it("exposes runner pending state", () => {
    mocks.runnerPending = true;
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    expect(result.current.isExternalPending).toBe(true);
  });

  it("toasts when the async artifact outcome reports that nothing opened", () => {
    mocks.runPolicy.mockImplementationOnce((_link, lifecycle) => {
      lifecycle.onAsyncFailure();
      return true;
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "/artifact/index.md",
      line: null,
      col: null,
    });

    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
  });

  it("passes an absolute href through unchanged to the shared policy (A, C1 now live in build-chat-link-policy)", () => {
    mocks.folderChain.mockReturnValue(null);
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "/Users/me/.traycer/epics/epic-1/artifacts/some-spec/README.md",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/Users/me/.traycer/epics/epic-1/artifacts/some-spec/README.md",
      }),
      expect.anything(),
    );
  });

  it("passes a rootless artifact-shaped href through unchanged to the shared policy", () => {
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "epics/epic-2/artifacts/spec/index.md",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "epics/epic-2/artifacts/spec/index.md",
      }),
      expect.anything(),
    );
    expect(
      mocks.candidateWorkspaceFileRefsForRelativeLinkPath,
    ).not.toHaveBeenCalled();
  });

  it("opens the artifact-folder candidate when it resolves, racing against the plain-file candidates (E)", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      {
        id: "file-candidate",
        workspacePath: "/tab/repo",
        filePath: "01-sub-ticket/index.md",
      },
    ]);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-sub",
      kind: "ticket",
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "01-sub-ticket/",
      line: null,
      col: null,
    });
    await flush();

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "default-host",
        epicId: "epic-1",
        filePath:
          "epics/epic-1/artifacts/ticket-breakdown/01-something/01-sub-ticket/index.md",
      }),
    );
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: "tab-1",
        nodeId: "artifact-sub",
        fallbackHostId: "default-host",
      }),
    );
    expect(mocks.previewTileInTab).not.toHaveBeenCalled();
    expect(mocks.runPolicy).not.toHaveBeenCalled();
  });

  it("opens the own-directory artifact candidate over a same-named workspace file when both exist (#1)", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      {
        id: "same-named-file",
        workspacePath: "/tab/repo",
        filePath: "01-child/index.md",
      },
    ]);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-own-dir",
      kind: "ticket",
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "./01-child/",
      line: null,
      col: null,
    });
    await flush();

    // The own-directory artifact wins even though a same-named workspace file
    // also exists - own-directory resolution is the corpus's majority case,
    // so it must not be shadowed by a coincidentally-matching file elsewhere
    // in the chat's bound roots.
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "artifact-own-dir" }),
    );
    expect(mocks.previewTileInTab).not.toHaveBeenCalled();
  });

  it("opens the own-directory artifact candidate as soon as it resolves, without waiting on a slower file probe (#1)", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      {
        id: "slow-file",
        workspacePath: "/tab/repo",
        filePath: "01-child/index.md",
      },
    ]);
    // Never settles within the test - proves the artifact candidate winning
    // doesn't wait on it.
    mocks.fetchWorkspaceFileExists.mockReturnValue(
      new Promise(() => undefined),
    );
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-fast",
      kind: "ticket",
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "./01-child/",
      line: null,
      col: null,
    });
    await flush();

    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "artifact-fast" }),
    );
  });

  it("toasts instead of hanging when the folder RPC rejects and no plain-file candidate exists (#2)", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue(null);
    mocks.resolveArtifactByPath.mockRejectedValue(new Error("transport error"));
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "index.md",
      line: null,
      col: null,
    });
    await flush();

    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
  });

  it("drops a rejected folder-RPC settlement from a superseded click instead of surfacing a stale toast (#2)", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue(null);
    let rejectFirst: (error: Error) => void = () => undefined;
    mocks.resolveArtifactByPath
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        artifactId: "artifact-second-click",
        kind: "spec",
      });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "index.md",
      line: null,
      col: null,
    });
    result.current.openLink({
      kind: "file",
      path: "index.md",
      line: null,
      col: null,
    });
    rejectFirst(new Error("transport error"));
    await flush();

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "artifact-second-click" }),
    );
  });

  it("opens the winning plain-file candidate for a relative href with a non-index.md extension, without ever attempting the folder RPC race to win (E)", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    const fileRef = {
      id: "main-ts",
      workspacePath: "/tab/repo",
      filePath: "src/main.ts",
    };
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue([
      fileRef,
    ]);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    mocks.resolveArtifactByPath.mockResolvedValue(null);
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "../src/main.ts",
      line: null,
      col: null,
    });
    await flush();

    // Not rewritten into an artifact-folder reference: the real file wins the
    // race, so it opens as a plain workspace-file preview.
    expect(mocks.previewTileInTab).toHaveBeenCalledWith("tab-1", fileRef);
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
  });

  it("resolves a bare index.md href back to this artifact's own directory via the folder RPC candidate", async () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue(null);
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-self",
      kind: "spec",
    });
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "index.md",
      line: null,
      col: null,
    });
    await flush();

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath:
          "epics/epic-1/artifacts/ticket-breakdown/01-something/index.md",
      }),
    );
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "artifact-self" }),
    );
  });

  it("toasts without opening when the folder chain can't be resolved and no plain-file candidate exists", async () => {
    mocks.folderChain.mockReturnValue(null);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue(null);
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "./index.md",
      line: null,
      col: null,
    });
    await flush();

    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
  });

  it("toasts without opening (not a parent/artifacts-root fallback guess) when a relative href walks above the epic root and no plain-file candidate exists", async () => {
    mocks.folderChain.mockReturnValue(["only-artifact"]);
    mocks.candidateWorkspaceFileRefsForRelativeLinkPath.mockReturnValue(null);
    const { result } = renderHook(
      () =>
        useArtifactLinkOpener({
          epicId: "epic-1",
          artifactId: "artifact-1",
          viewTabId: "tab-1",
        }),
      { wrapper: QueryWrapper },
    );

    result.current.openLink({
      kind: "file",
      path: "../../escaped/index.md",
      line: null,
      col: null,
    });
    await flush();

    // resolveArtifactRelativeLinkPath (real) returns null for this walk, so
    // the folder candidate is never even attempted via the RPC.
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
  });
});
