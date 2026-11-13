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
  worktrees: vi.fn<() => WorktreeList>(),
}));

interface WorktreeList {
  readonly data:
    | {
        readonly rows: readonly {
          readonly runningDir: string;
          readonly disabledReason: null;
        }[];
      }
    | undefined;
  readonly isError: boolean;
}

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabClient,
}));
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpicForClient: () => mocks.worktrees(),
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
// The desktop's site is shared by the artifact's mounts; the page's mount is
// in the path, ahead of the tree path.
const DESKTOP_PAGE = "traycer-sandbox://artifact-a1/m/m1/a/b/index.html";

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
  /** Whether the Epic session the tree is read through is around the frame. */
  readonly epicSession: boolean;
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
        <EpicSessionContext value={options.epicSession ? epicSession : null}>
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

/** A frame in an Epic's tab, with a tile host and the Epic session around it. */
const IN_EPIC_TAB = {
  viewTabId: "tab-1",
  tileHost: "tab-host",
  epicSession: true,
} as const;

beforeEach(() => {
  mocks.worktrees.mockReset();
  mocks.worktrees.mockReturnValue({
    data: { rows: [{ runningDir: "/tab/repo", disabledReason: null }] },
    isError: false,
  });
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
    ["../sibling/?v=2", "epics/epic-1/artifacts/a/sibling/index.md"],
    ["../sibling/#intro", "epics/epic-1/artifacts/a/sibling/index.md"],
    ["/research/top/", "epics/epic-1/artifacts/research/top/index.md"],
    ["my doc/", "epics/epic-1/artifacts/a/b/my doc/index.md"],
    ["my%20doc/", "epics/epic-1/artifacts/a/b/my doc/index.md"],
  ])(
    "opens the artifact %s names from page a/b/index.html in a tile",
    async (href, resolvedPath) => {
      mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
      const open = mountFrame(IN_EPIC_TAB);

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

  it.each([
    ["still loading", false],
    ["failing", true],
  ])(
    "opens a link while the Epic's worktree list is %s, which the tree lookup never reads",
    async (_label, isError) => {
      mocks.worktrees.mockReturnValue({ data: undefined, isError });
      mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
      const open = mountFrame(IN_EPIC_TAB);

      open(linkOn("../sibling/index.html"));
      await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it("toasts when the link names nothing in the tree", async () => {
    const open = mountFrame(IN_EPIC_TAB);

    open(linkOn("../missing/index.html"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("opens an href written out in full on the page's own origin, read from the tree root", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame(IN_EPIC_TAB);

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
    const open = mountFrame(IN_EPIC_TAB);

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

  it.each([
    ["a relative href", "../sibling/index.html"],
    ["a rooted href", "/a/sibling/"],
    [
      "an href written out in full through the page's mount",
      "traycer-sandbox://artifact-a1/m/m1/a/sibling/index.html",
    ],
    [
      "an href written out in full from the site's root",
      "traycer-sandbox://artifact-a1/a/sibling/",
    ],
  ])(
    "opens %s on the desktop's site, where the mount comes before the tree path",
    async (_label, href) => {
      mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
      const open = mountFrame(IN_EPIC_TAB);

      open(linkAt(href, DESKTOP_PAGE));
      await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

      expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: "epics/epic-1/artifacts/a/sibling/index.md",
        }),
      );
    },
  );

  it("opens a protocol-relative href on the page's own origin", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue(FOUND);
    const open = mountFrame(IN_EPIC_TAB);

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
      "another artifact's desktop address",
      "traycer-sandbox://artifact-zz/m/m1/a/sibling/",
      DESKTOP_PAGE,
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
      const open = mountFrame(IN_EPIC_TAB);

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
      const open = mountFrame(IN_EPIC_TAB);

      open(linkOn(href));
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
      );

      expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
      expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
      expect(mocks.openTile).not.toHaveBeenCalled();
    },
  );

  // The host does not resolve a loose markdown file from the `notes.md/index.md`
  // spelling the resolver sends (T199), so the request is made and answers null.
  it("toasts for a loose markdown file, asking for exactly the spelling the host cannot resolve, without racing a workspace file", async () => {
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    const open = mountFrame(IN_EPIC_TAB);

    open(linkOn("../sibling/notes.md"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.resolveArtifactByPath.mock.calls).toEqual([
      [
        expect.objectContaining({
          filePath: "epics/epic-1/artifacts/a/sibling/notes.md/index.md",
        }),
      ],
    ]);
    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it.each([
    ["a loose html file", "../sibling/report.html", "a/sibling/report.html"],
    [
      "a file inside an html artifact's folder, which the host answers with the owning artifact",
      "../report/shots/a.png",
      "a/report/shots/a.png",
    ],
  ])(
    "opens %s, asking the host for exactly its spelling and not probing the workspace",
    async (_label, href, treePath) => {
      const filePath = `epics/epic-1/artifacts/${treePath}/index.md`;
      mocks.resolveArtifactByPath.mockImplementation((args) =>
        Promise.resolve(args.filePath === filePath ? FOUND : null),
      );
      mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
      const open = mountFrame(IN_EPIC_TAB);

      open(linkOn(href));
      await vi.waitFor(() => expect(mocks.openTile).toHaveBeenCalled());

      expect(mocks.resolveArtifactByPath.mock.calls).toEqual([
        [expect.objectContaining({ filePath })],
      ]);
      expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it("asks only this Epic's tree about a rooted drive path, and toasts when it is missing", async () => {
    mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
    const open = mountFrame(IN_EPIC_TAB);

    open(linkOn("/C:/repo/secret.txt"));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
    );

    expect(mocks.resolveArtifactByPath.mock.calls).toEqual([
      [
        expect.objectContaining({
          epicId: "epic-1",
          filePath: "epics/epic-1/artifacts/C:/repo/secret.txt/index.md",
        }),
      ],
    ]);
    expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a backslash after the origin",
      "https://artifact-a1--m1.traycer-artifact.invalid\\research/top/index.html",
      ANDROID_PAGE,
    ],
    [
      "an extra slash after the scheme",
      "https:///artifact-a1--m1.traycer-artifact.invalid/research/top/index.html",
      ANDROID_PAGE,
    ],
    [
      "a leading backslash, which the frame reads as a slash",
      "\\research/top/index.html",
      ANDROID_PAGE,
    ],
    ["an encoded backslash", "%5Cresearch/top/index.html", TRAYCER_PAGE],
    [
      "encoded slashes, which the frame keeps as part of a name",
      "..%2F..%2Ftop/index.html",
      TRAYCER_PAGE,
    ],
    [
      "a tab inside a name, which the frame drops",
      "../si\tbling/index.html",
      TRAYCER_PAGE,
    ],
    [
      "a line feed inside a name, which the frame drops",
      "../si\nbling/index.html",
      TRAYCER_PAGE,
    ],
    [
      "a leading no-break space, which the frame keeps as a name",
      " /research/top/index.html",
      TRAYCER_PAGE,
    ],
    [
      "a space before a query, which the frame keeps in the name",
      "/top ?x=1",
      TRAYCER_PAGE,
    ],
    [
      "a space before a fragment, which the frame keeps in the name",
      "/top #part",
      TRAYCER_PAGE,
    ],
    [
      "a protocol-relative address after a leading space, whose host the tree would read as a folder",
      " //artifact-a1--m1/top/",
      TRAYCER_PAGE,
    ],
    [
      "a colon and digits ending a name, which the tree would read as a line",
      "/release:2026",
      TRAYCER_PAGE,
    ],
    [
      "a name whose escape does not decode, which the address never spells",
      "/bad%ZZ/",
      TRAYCER_PAGE,
    ],
    [
      "this Epic's artifact path on disk",
      "/Users/u/.traycer/epics/epic-1/artifacts/a/sibling/index.html",
      TRAYCER_PAGE,
    ],
    [
      "another Epic's artifact path on disk",
      "/Users/u/.traycer/epics/epic-2/artifacts/x/index.html",
      TRAYCER_PAGE,
    ],
  ])(
    "toasts for %s, with no lookup, probe or tile",
    async (_label, href, pageUrl) => {
      mocks.fetchWorkspaceFileExists.mockResolvedValue(true);
      const open = mountFrame(IN_EPIC_TAB);

      open(linkAt(href, pageUrl));
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link"),
      );

      expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
      expect(mocks.fetchWorkspaceFileExists).not.toHaveBeenCalled();
      expect(mocks.openTile).not.toHaveBeenCalled();
    },
  );

  it("toasts for a href that names no file", () => {
    const open = mountFrame(IN_EPIC_TAB);

    open(linkOn("#"));

    expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
  });

  it.each([
    ["no tab to open a tile in", null, "tab-host", true],
    ["no tile host", "tab-1", null, true],
    ["no Epic session", "tab-1", "tab-host", false],
  ])(
    "answers a click with the toast when there is %s",
    (_l, viewTabId, tileHost, epicSession) => {
      const open = mountFrame({ viewTabId, tileHost, epicSession });

      open(linkOn("../sibling/index.html"));

      expect(mocks.toast).toHaveBeenCalledWith("Couldn't open link");
      expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
      expect(mocks.openTile).not.toHaveBeenCalled();
    },
  );
});
