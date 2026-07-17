import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLinkLifecycle } from "@/components/chat/build-chat-link-policy";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import { useArtifactLinkOpener } from "../use-artifact-link-opener";

interface ExternalMutationOptions {
  readonly onSettled: () => void;
}

const mocks = vi.hoisted(() => {
  const runPolicy = vi.fn<
    (link: MarkdownFileLink, lifecycle: ChatLinkLifecycle) => boolean
  >(() => true);
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
vi.mock("@/components/chat/build-chat-link-policy", () => ({
  buildChatLinkPolicy: mocks.buildPolicy,
}));
vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({
    mutate: mocks.openExternal,
    isPending: mocks.runnerPending,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTilePreviewInTab: vi.fn() }),
}));
vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({ store: {} }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

function QueryWrapper(props: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
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
});

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
    const link = {
      kind: "file" as const,
      path: "src/index.ts",
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

  it("rewrites a bare sibling href against this artifact's own folder chain", () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
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

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "epics/epic-1/artifacts/ticket-breakdown/01-something/01-sub-ticket/index.md",
      }),
      expect.anything(),
    );
  });

  it("resolves a ../ href against the parent artifact's folder", () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
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
      path: "../02-other/index.md",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "epics/epic-1/artifacts/ticket-breakdown/02-other/index.md",
      }),
      expect.anything(),
    );
  });

  it("resolves a bare index.md href back to this artifact's own directory", () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
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

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "epics/epic-1/artifacts/ticket-breakdown/01-something/index.md",
      }),
      expect.anything(),
    );
  });

  it("does not rewrite an absolute href", () => {
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
      path: "/artifact/index.md",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/artifact/index.md" }),
      expect.anything(),
    );
  });

  it("canonicalizes a directory-shaped absolute artifact href to its index.md, the same way a relative one already is", () => {
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
      path: "/Users/me/.traycer/epics/epic-1/artifacts/some-spec/",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/Users/me/.traycer/epics/epic-1/artifacts/some-spec/index.md",
      }),
      expect.anything(),
    );
  });

  it("does not mangle an absolute directory href that isn't artifact-shaped", () => {
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
      path: "/repo/src/",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/repo/src/" }),
      expect.anything(),
    );
  });

  it("passes a relative href with a non-index.md file extension through unchanged, instead of coercing it into an artifact folder", () => {
    mocks.folderChain.mockReturnValue(["ticket-breakdown", "01-something"]);
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

    // Not rewritten into "…/src/main.ts/index.md" - left as the ORIGINAL
    // relative href so the shared policy's relative-workspace-file branch
    // resolves it as a normal file, not an artifact-folder reference.
    expect(mocks.runPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ path: "../src/main.ts" }),
      expect.anything(),
    );
  });

  it("toasts without opening when the folder chain can't be resolved", () => {
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
      path: "./index.md",
      line: null,
      col: null,
    });

    expect(mocks.runPolicy).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
  });

  it("toasts without opening when a relative href walks above the epic root", () => {
    mocks.folderChain.mockReturnValue(["only-artifact"]);
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

    expect(mocks.runPolicy).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
  });
});
