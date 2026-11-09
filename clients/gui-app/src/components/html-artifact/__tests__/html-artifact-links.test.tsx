import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchResolveArtifactByPathArgs } from "@/lib/host/resolve-artifact-by-path";
import type { ProjectedSidebarNodeOpenArgs } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { SandboxArtifactLink } from "@/lib/sandbox/bridge-host";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import { HtmlArtifactLinks } from "../html-artifact-links";
import { useHtmlArtifactLinkOpener } from "../html-artifact-link-context";

// Only the host boundary is mocked: the RPCs, the tile-open seam and the
// toast. The resolver that turns a link into an artifact path is the real one.
const mocks = vi.hoisted(() => ({
  tabClient: { request: vi.fn() },
  openTile: vi.fn(),
  toast: vi.fn(),
  resolveArtifactByPath:
    vi.fn<
      (
        args: FetchResolveArtifactByPathArgs,
      ) => Promise<ResolveArtifactByPathResult | null>
    >(),
  fetchWorkspaceFileExists:
    vi.fn<(args: { readonly workspacePath: string }) => Promise<boolean>>(),
  openProjectedSidebarNodeInTabWhenAvailable:
    vi.fn<(args: ProjectedSidebarNodeOpenArgs) => () => void>(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabClient,
}));
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpicForClient: () => ({
    data: { rows: [{ runningDir: "/tab/repo", disabledReason: null }] },
    isError: false,
  }),
}));
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
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => {
  const navigation = { openTile: mocks.openTile };
  return { useEpicTileNavigation: () => navigation };
});
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(() => Promise.resolve()),
  useOpenLinkWithPending: () => ({
    isPending: false,
    openLink: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const PAGE_PATH = "a/b/index.html";
const TRAYCER_PAGE = "traycer-artifact://artifact-a1--m1/a/b/index.html";
const ANDROID_PAGE =
  "https://artifact-a1--m1.traycer-artifact.invalid/a/b/index.html";

/** A link clicked on page a/b/index.html, served at `pageUrl`. */
const linkAt = (href: string, pageUrl: string) => ({
  href,
  pagePath: PAGE_PATH,
  pageUrl,
});
const linkOn = (href: string) => linkAt(href, TRAYCER_PAGE);

const epicSession = {} as React.ContextType<typeof EpicSessionContext>;

/** Renders the provider around a frame stand-in and returns what the frame calls on a click. */
function mountFrame(options: {
  readonly viewTabId: string | null;
  readonly tileHost: string | null;
}): (link: SandboxArtifactLink) => void {
  const opener: { current: ((link: SandboxArtifactLink) => void) | null } = {
    current: null,
  };
  function Frame(): ReactNode {
    opener.current = useHtmlArtifactLinkOpener();
    return null;
  }
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <TabHostContext value={options.tileHost}>
        <EpicSessionContext value={epicSession}>
          <HtmlArtifactLinks epicId="epic-1" viewTabId={options.viewTabId}>
            <Frame />
          </HtmlArtifactLinks>
        </EpicSessionContext>
      </TabHostContext>
    </QueryClientProvider>,
  );
  if (opener.current === null) throw new Error("the frame never rendered");
  return opener.current;
}

beforeEach(() => {
  mocks.openTile.mockReset();
  mocks.toast.mockClear();
  mocks.resolveArtifactByPath.mockReset();
  mocks.resolveArtifactByPath.mockResolvedValue(null);
  mocks.fetchWorkspaceFileExists.mockReset();
  mocks.fetchWorkspaceFileExists.mockResolvedValue(false);
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReset();
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockImplementation(
    (args) => {
      args.openNode({
        id: "artifact-target",
        instanceId: "instance-target",
        type: "html",
        name: "Target",
        hostId: "tab-host",
      });
      return () => undefined;
    },
  );
});

describe("HtmlArtifactLinks", () => {
  const FOUND: ResolveArtifactByPathResult = {
    artifactId: "artifact-target",
    kind: "html",
  };

  it.each([
    ["../sibling/index.html", "epics/epic-1/artifacts/a/sibling/index.md"],
    ["../../top/", "epics/epic-1/artifacts/top/index.md"],
    [
      "../sibling/canvas.json?v=2#part",
      "epics/epic-1/artifacts/a/sibling/index.md",
    ],
  ])(
    "opens the artifact %s names from page a/b/index.html in a tile",
    async (href, resolvedPath) => {
      mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
      const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

      open(linkOn(href));
      await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

      expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "tab-host",
          epicId: "epic-1",
          filePath: resolvedPath,
        }),
      );
      expect(mocks.openTile).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: "tab-1" } }),
        "user",
      );
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it("reads a rooted href from the tree root, not from the page's folder", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("/top/index.html"));
    await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "epics/epic-1/artifacts/top/index.md",
      }),
    );
  });

  const DISK_SIBLING =
    "/Users/u/.traycer/epics/epic-1/artifacts/a/sibling/index.html";

  it("reads an href that is an artifact's path on disk as the tree path it names", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn(DISK_SIBLING));
    await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "epics/epic-1/artifacts/a/sibling/index.md",
      }),
    );
  });

  it("toasts for an artifact's path on disk that the tree lacks, without a disk-file or workspace fallback", async () => {
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn(DISK_SIBLING));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("toasts for another Epic's artifact on disk, without a lookup or probe", async () => {
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("/Users/u/.traycer/epics/epic-2/artifacts/x/index.html"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("toasts when the link names nothing in the tree", async () => {
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("../missing/index.html"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("opens an href written out in full on the page's own origin, read from the tree root", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("traycer-artifact://artifact-a1--m1/a/sibling/index.html"));
    await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "epics/epic-1/artifacts/a/sibling/index.md",
      }),
    );
  });

  it("opens the same on the Android origin", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(
      linkAt(
        "https://artifact-a1--m1.traycer-artifact.invalid/a/sibling/",
        ANDROID_PAGE,
      ),
    );
    await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "epics/epic-1/artifacts/a/sibling/index.md",
      }),
    );
  });

  it("opens a protocol-relative href on the page's own origin", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("//artifact-a1--m1/a/sibling/"));
    await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "epics/epic-1/artifacts/a/sibling/index.md",
      }),
    );
  });

  it.each([
    [
      "another artifact's address",
      "traycer-artifact://artifact-zz--m1/a/sibling/index.html",
      TRAYCER_PAGE,
    ],
    [
      "another artifact's Android address",
      "https://artifact-zz--m1.traycer-artifact.invalid/a/sibling/",
      ANDROID_PAGE,
    ],
    [
      "a full URL that walks above the root",
      "traycer-artifact://artifact-a1--m1/../x/",
      TRAYCER_PAGE,
    ],
  ])(
    "toasts for %s, with no probe, lookup or tile",
    async (_label, href, pageUrl) => {
      mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
      const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

      open(linkAt(href, pageUrl));
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
      );

      expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
      expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
      expect(mocks.openTile).not.toHaveBeenCalled();
    },
  );

  it.each(["../../../x/", "/../x/"])(
    "toasts %s, which walks above the artifacts root, without the resolver or a workspace probe, even where a file of that name exists",
    async (href) => {
      mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
      const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

      open(linkOn(href));
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
      );

      expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
      expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
      expect(mocks.openTile).not.toHaveBeenCalled();
    },
  );

  it("toasts for a plain file the tree lacks, without racing a workspace file of that name", async () => {
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("../sibling/notes.txt"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("opens a plain file that is an artifact of the tree, without probing the workspace", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("../sibling/notes.txt"));
    await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "epics/epic-1/artifacts/a/sibling/notes.txt/index.md",
      }),
    );
    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
  });

  it("toasts for a href that names no file", () => {
    const open = mountFrame({ viewTabId: "tab-1", tileHost: "tab-host" });

    open(linkOn("#"));

    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
  });

  it.each([
    ["no tab to open a tile in", null, "tab-host"],
    ["no tile host", "tab-1", null],
  ])(
    "answers a click with the toast when there is %s",
    (_l, viewTabId, tileHost) => {
      const open = mountFrame({ viewTabId, tileHost });

      open(linkOn("../sibling/index.html"));

      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
      expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
      expect(mocks.openTile).not.toHaveBeenCalled();
    },
  );
});
