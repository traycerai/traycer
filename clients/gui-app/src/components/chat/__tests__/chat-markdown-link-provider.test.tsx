import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { use, type ReactNode } from "react";
import { ChatMarkdownLinkProvider } from "@/components/chat/chat-markdown-link-provider";
import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";
import { workspaceFileRefFromLinkPath } from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import { workspaceFileTabId } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import * as epicTileNavigationModule from "@/hooks/epic/use-epic-tile-navigation";
import type { EpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import type { FetchResolveArtifactByPathArgs } from "@/lib/host/resolve-artifact-by-path";
import type { ProjectedSidebarNodeOpenArgs } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes, type TilePane } from "@/stores/epics/canvas/tile-tree";
import { useWorkspaceFileRevealStore } from "@/stores/epics/canvas/workspace-file-reveal-store";

const HOST_ID = "host-1";
const ACTIVE_HOST_ID = "host-active";
const OPEN_EPIC_ID = "epic-open";
const EPIC_HANDLE = { store: { getState: vi.fn(), subscribe: vi.fn() } };

const mocks = vi.hoisted(() => ({
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  navigate: vi.fn(),
  resolveArtifactByPath:
    vi.fn<
      (
        args: FetchResolveArtifactByPathArgs,
      ) => Promise<ResolveArtifactByPathResult | null>
    >(),
  openProjectedSidebarNodeInTabWhenAvailable:
    vi.fn<(args: ProjectedSidebarNodeOpenArgs) => () => void>(),
  openOrFocusEpicIntent: vi.fn(
    (input: { epicId: string; focus: EpicRouteFocusLike }) => ({
      kind: "epic" as const,
      epicId: input.epicId,
      tabId: "target-tab",
      focus: input.focus,
    }),
  ),
}));

interface EpicRouteFocusLike {
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly migrationSource: "phase" | undefined;
}

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ request: mocks.request }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => ACTIVE_HOST_ID,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => OPEN_EPIC_ID,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => EPIC_HANDLE,
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

vi.mock("@/lib/tab-navigation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tab-navigation")>(
    "@/lib/tab-navigation",
  );
  return {
    ...actual,
    openOrFocusEpicIntent: (input: {
      epicId: string;
      focus: EpicRouteFocusLike;
    }) => mocks.openOrFocusEpicIntent(input),
    navigateToTabIntent: (
      navigate: (intent: unknown) => void,
      intent: unknown,
    ) => {
      navigate(intent);
    },
  };
});

// A structurally valid artifact link path under the OPEN epic and a FOREIGN
// epic (note the foreign-home prefix to prove root-prefix-agnostic matching).
const SAME_EPIC_ARTIFACT_PATH = `/Users/me/.traycer/epics/${OPEN_EPIC_ID}/artifacts/some-spec/index.md`;
const CROSS_EPIC_ARTIFACT_PATH =
  "/Users/them/.traycer/epics/epic-other/artifacts/parent/child-ticket/index.md";

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useWorkspaceFileRevealStore.setState({ targetsByKey: {} }, true);
  mocks.request.mockReset();
  mocks.navigate.mockReset();
  mocks.resolveArtifactByPath.mockReset();
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReset();
  mocks.openProjectedSidebarNodeInTabWhenAvailable.mockReturnValue(
    () => undefined,
  );
  mocks.openOrFocusEpicIntent.mockClear();
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

function LinkButton(props: {
  readonly label: string;
  readonly link: MarkdownFileLink;
}) {
  const policy = use(MarkdownLinkContext);
  return (
    <button
      type="button"
      onClick={() => {
        policy?.openFileLink(props.link);
      }}
    >
      {props.label}
    </button>
  );
}

function renderProvider(tabId: string, children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatMarkdownLinkProvider
        tabId={tabId}
        hostId={HOST_ID}
        workspaceRoots={["/repo"]}
      >
        {children}
      </ChatMarkdownLinkProvider>
    </QueryClientProvider>,
  );
}

function requireOnlyPane(tabId: string): TilePane {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error(`Expected tab ${tabId}`);
  const panes = collectPanes(canvas.root);
  if (panes.length !== 1) throw new Error("Expected one canvas pane");
  return panes[0];
}

function requirePreviewTileContentId(tabId: string): string {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error(`Expected tab ${tabId}`);
  const pane = requireOnlyPane(tabId);
  if (pane.previewTabId === null) throw new Error("Expected preview tab");
  const tile = canvas.tilesByInstanceId[pane.previewTabId];
  if (tile === undefined) throw new Error("Expected preview tile payload");
  return tile.id;
}

function previewTabId(tabId: string): string | null {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  const panes = collectPanes(canvas.root);
  if (panes.length !== 1) return null;
  return panes[0].previewTabId;
}

function expectedWorkspaceFileContentId(linkPath: string): string {
  const ref = workspaceFileRefFromLinkPath(HOST_ID, ["/repo"], linkPath);
  if (ref === null) throw new Error("Expected a resolvable workspace-file ref");
  return ref.id;
}

describe("ChatMarkdownLinkProvider", () => {
  it("routes rendered markdown file links through the shared tile navigation hook", () => {
    const openTilePreviewInTab = vi.fn<
      EpicTileNavigation["openTilePreviewInTab"]
    >(() => null);
    const hookSpy = vi
      .spyOn(epicTileNavigationModule, "useEpicTileNavigation")
      .mockReturnValue({
        openTileInTab: vi.fn(() => null),
        openTilePreviewInTab,
        openTileInEpic: vi.fn(() => null),
        openTilePreviewInEpic: vi.fn(() => null),
      });
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    try {
      renderProvider(
        tabId,
        <AgentReferenceMarkdown
          isStreaming={false}
          markdown="[Open app](src/app.ts)"
          proseSize="compact"
          quotable={false}
        />,
      );

      fireEvent.click(screen.getByRole("link", { name: "Open app" }));

      expect(openTilePreviewInTab).toHaveBeenCalledWith(
        tabId,
        expect.objectContaining({
          id: workspaceFileTabId(HOST_ID, "/repo", "src/app.ts"),
        }),
      );
    } finally {
      hookSpy.mockRestore();
    }
  });

  it("opens chat file links as replaceable preview tabs", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic 1");

    renderProvider(
      tabId,
      <>
        <LinkButton
          label="Open app"
          link={{
            path: "src/app.ts",
            line: null,
            col: null,
            isDirectory: false,
          }}
        />
        <LinkButton
          label="Open route"
          link={{
            path: "src/route.ts",
            line: null,
            col: null,
            isDirectory: false,
          }}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open app" }));
    expect(requirePreviewTileContentId(tabId)).toBe(
      workspaceFileTabId(HOST_ID, "/repo", "src/app.ts"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open route" }));
    const pane = requireOnlyPane(tabId);
    expect(pane.tabInstanceIds).toHaveLength(1);
    expect(requirePreviewTileContentId(tabId)).toBe(
      workspaceFileTabId(HOST_ID, "/repo", "src/route.ts"),
    );
  });

  it("declines a relative file link when no workspace roots are bound (the no-binding failure mode #2 fixes upstream)", () => {
    // With zero roots, a relative link cannot be tied to any workspace, so the
    // policy opens nothing. This is exactly the dead-click a no-binding chat
    // hit before the chat tile started feeding the link policy its composer
    // fallback roots (`useWorkspaceMentionRoots(mentionRoots, true)`); the chat
    // tile now resolves the global fallback so this empty-roots case no longer
    // reaches the provider for an epic-workspace chat.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    render(
      <QueryClientProvider client={queryClient}>
        <ChatMarkdownLinkProvider
          tabId={tabId}
          hostId={HOST_ID}
          workspaceRoots={[]}
        >
          <LinkButton
            label="Open relative"
            link={{
              path: "src/app.ts",
              line: null,
              col: null,
              isDirectory: false,
            }}
          />
        </ChatMarkdownLinkProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open relative" }));

    expect(previewTabId(tabId)).toBeNull();
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
  });

  it("opens a same-epic artifact link as a preview tile via the projection waiter, stamped with the active host", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-same",
      kind: "spec",
    });
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderProvider(
      tabId,
      <LinkButton
        label="Open artifact"
        link={{
          path: SAME_EPIC_ARTIFACT_PATH,
          line: null,
          col: null,
          isDirectory: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));

    // The RPC is resolved against the ACTIVE host and the open epic id.
    await waitFor(() => {
      expect(mocks.resolveArtifactByPath).toHaveBeenCalledTimes(1);
    });
    expect(mocks.resolveArtifactByPath).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: ACTIVE_HOST_ID,
        epicId: OPEN_EPIC_ID,
        filePath: SAME_EPIC_ARTIFACT_PATH,
      }),
    );

    // Same epic: opens via the projection waiter, passing the PREVIEW opener
    // (D3) and the active host as the fallback. No cross-epic navigation.
    await waitFor(() => {
      expect(
        mocks.openProjectedSidebarNodeInTabWhenAvailable,
      ).toHaveBeenCalledTimes(1);
    });
    const openArgs =
      mocks.openProjectedSidebarNodeInTabWhenAvailable.mock.calls[0][0];
    expect(openArgs.tabId).toBe(tabId);
    expect(openArgs.nodeId).toBe("artifact-same");
    expect(openArgs.fallbackHostId).toBe(ACTIVE_HOST_ID);
    expect(typeof openArgs.openTileInTab).toBe("function");
    expect(mocks.navigate).not.toHaveBeenCalled();
    // It claimed the click without falling through to a file preview.
    expect(previewTabId(tabId)).toBeNull();
  });

  it("lets an external click supersede a slow artifact resolution", async () => {
    let resolveArtifact: (
      value: ResolveArtifactByPathResult | null,
    ) => void = () => undefined;
    mocks.resolveArtifactByPath.mockReturnValue(
      new Promise((resolve) => {
        resolveArtifact = resolve;
      }),
    );
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderProvider(
      tabId,
      <AgentReferenceMarkdown
        isStreaming={false}
        markdown={`[Artifact](${SAME_EPIC_ARTIFACT_PATH}) [External](https://example.com)`}
        proseSize="compact"
        quotable={false}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Artifact" }));
    await waitFor(() =>
      expect(mocks.resolveArtifactByPath).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("link", { name: "External" }));
    await act(async () => {
      resolveArtifact({ artifactId: "stale-artifact", kind: "spec" });
      await Promise.resolve();
    });

    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(previewTabId(tabId)).toBeNull();
  });

  it("navigates and focuses a cross-epic artifact link with a fresh focusedAt", async () => {
    mocks.resolveArtifactByPath.mockResolvedValue({
      artifactId: "artifact-cross",
      kind: "ticket",
    });
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    const before = Date.now();

    renderProvider(
      tabId,
      <LinkButton
        label="Open foreign artifact"
        link={{
          path: CROSS_EPIC_ARTIFACT_PATH,
          line: null,
          col: null,
          isDirectory: false,
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open foreign artifact" }),
    );

    await waitFor(() => {
      expect(mocks.openOrFocusEpicIntent).toHaveBeenCalledTimes(1);
    });
    const intentInput = mocks.openOrFocusEpicIntent.mock.calls[0][0];
    expect(intentInput.epicId).toBe("epic-other");
    expect(intentInput.focus).toEqual(
      expect.objectContaining({
        focusArtifactId: "artifact-cross",
        focusThreadId: undefined,
        migrationSource: undefined,
      }),
    );
    expect(intentInput.focus.focusedAt).toBeGreaterThanOrEqual(before);
    // Navigation fired; nothing opened in the source tab.
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
    expect(previewTabId(tabId)).toBeNull();
  });

  it("makes an artifact link a no-op when it resolves to null and its index.md is outside the chat roots", async () => {
    // SAME_EPIC_ARTIFACT_PATH lives under ~/.traycer, outside the chat's
    // workspaceRoots (["/repo"]). Before the CL-1 boundary fix the null-resolve
    // fallback synthesized a workspace from the path's dirname and previewed the
    // raw index.md; CL-1 removed that synthesis, so an out-of-root artifact path
    // yields no workspace-file ref and the click degrades to a safe no-op — no
    // pane, no navigation, no projection open. (The degrade-to-file-preview
    // fallback still fires for artifact paths that resolve within a bound root.)
    mocks.resolveArtifactByPath.mockResolvedValue(null);
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    renderProvider(
      tabId,
      <LinkButton
        label="Open unresolved"
        link={{
          path: SAME_EPIC_ARTIFACT_PATH,
          line: null,
          col: null,
          isDirectory: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open unresolved" }));

    await waitFor(() => {
      expect(mocks.resolveArtifactByPath).toHaveBeenCalledTimes(1);
    });
    // Let the resolve's `.then` null-fallback branch flush, then confirm the
    // out-of-root path opened nothing.
    await waitFor(() => {
      expect(previewTabId(tabId)).toBeNull();
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(
      mocks.openProjectedSidebarNodeInTabWhenAvailable,
    ).not.toHaveBeenCalled();
  });

  it("treats a non-artifact path as a normal file preview without calling the RPC", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    renderProvider(
      tabId,
      <LinkButton
        label="Open file"
        link={{
          path: "src/deep/module.ts",
          line: null,
          col: null,
          isDirectory: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(requirePreviewTileContentId(tabId)).toBe(
      workspaceFileTabId(HOST_ID, "/repo", "src/deep/module.ts"),
    );
    expect(mocks.resolveArtifactByPath).not.toHaveBeenCalled();
  });

  it("records a reveal target on the file content id when a line is present, then opens the preview", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    const contentId = expectedWorkspaceFileContentId("src/app.ts");

    renderProvider(
      tabId,
      <LinkButton
        label="Open line"
        link={{ path: "src/app.ts", line: 1177, col: 5, isDirectory: false }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open line" }));

    // The reveal target is keyed on the (tabId, content id) composite and set
    // before the tab opens, so it lands only on this tab's preview (CL-6).
    expect(
      useWorkspaceFileRevealStore.getState().targetsByKey[
        `${tabId}\u0000${contentId}`
      ],
    ).toEqual({ line: 1177, col: 5, nonce: 1 });
    // The file still opens as a normal preview tab.
    expect(requirePreviewTileContentId(tabId)).toBe(contentId);
  });

  it("does not record a reveal target for a file link without a line", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    renderProvider(
      tabId,
      <LinkButton
        label="Open plain"
        link={{ path: "src/app.ts", line: null, col: null, isDirectory: false }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open plain" }));

    expect(useWorkspaceFileRevealStore.getState().targetsByKey).toEqual({});
  });

  it("reuses the same tab and bumps the reveal nonce when a different line is clicked on an open file", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    const contentId = expectedWorkspaceFileContentId("src/app.ts");

    renderProvider(
      tabId,
      <>
        <LinkButton
          label="Line 10"
          link={{ path: "src/app.ts", line: 10, col: null, isDirectory: false }}
        />
        <LinkButton
          label="Line 20"
          link={{ path: "src/app.ts", line: 20, col: null, isDirectory: false }}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Line 10" }));
    expect(
      useWorkspaceFileRevealStore.getState().targetsByKey[
        `${tabId}\u0000${contentId}`
      ],
    ).toEqual({ line: 10, col: null, nonce: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Line 20" }));
    // Same content id -> single tab; the channel re-fires with a bumped nonce.
    expect(requireOnlyPane(tabId).tabInstanceIds).toHaveLength(1);
    expect(
      useWorkspaceFileRevealStore.getState().targetsByKey[
        `${tabId}\u0000${contentId}`
      ],
    ).toEqual({ line: 20, col: null, nonce: 2 });
  });
});
