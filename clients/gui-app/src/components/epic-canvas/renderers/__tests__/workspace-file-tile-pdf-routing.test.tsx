/**
 * PDF routing in the workspace file tile (PDF preview design): - Every `.pdf` routes to the pdf.js viewer tile, streaming over `useFileAsset`, never the text path - there is no host-version gate on this routing decision.
 * The STREAM's own negotiation is the sole authority: an old host's refusal degrades inside `useFileAsset` to the shared fallback placeholder, rather than the router trying to guess the host's age up front. - Fallback statuses render the shared `BinaryPlaceholder` with the PDF-specific copy the hook supplies (e.g. the 20 MiB cap message). - Image routing is unaffected by the PDF branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import type {
  FileAssetRequest,
  FileAssetState,
  FileAssetStatus,
} from "@/hooks/assets/use-file-asset";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";

interface PdfRoutingTestState {
  asset: FileAssetState;
  assetRequests: FileAssetRequest[];
  readFileCalls: number;
  openPaths: Mock;
  triggerOpenExternally: Mock;
  /** Drives the mocked `PdfPreviewLazy` to call `onUnavailable` from an effect. */
  viewerUnavailable: boolean;
}

const state = vi.hoisted((): PdfRoutingTestState => ({
  asset: {
    status: "ready",
    url: "blob:pdf",
    meta: null,
    reason: null,
    totalBytes: null,
    servedFromCache: false,
  },
  assetRequests: [],
  readFileCalls: 0,
  openPaths: vi.fn(),
  triggerOpenExternally: vi.fn(),
  viewerUnavailable: false,
}));

// These tiles resolve the user's default open target, which asks whether the tile's host is the LOCAL one before it may offer Finder.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/hooks/assets/use-file-asset", () => ({
  useFileAsset: (request: FileAssetRequest) => {
    state.assetRequests.push(request);
    return { ...state.asset, reportDecodeFailure: vi.fn() };
  },
}));

// `useHostSupportsMethod` remains a live seam too (the writeFile-support check in `WorkspaceFileTileLive`, which the PDF tile never mounts).
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
  useHostMethodSchemaVersion: () => ({ major: 1, minor: 1 }),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Host A" }),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-A",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => {
    state.readFileCalls += 1;
    return {
      data: { content: "%PDF-garbled", error: null, truncated: false },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/workspace/use-file-edit-session", () => ({
  useFileEditSession: () => ({
    state: null,
    activate: vi.fn(),
    setDraft: vi.fn(),
    flush: vi.fn(),
    retry: vi.fn(),
    resolveKeepMine: vi.fn(),
    resolveUseDisk: vi.fn(),
    reportConflictResolutionError: vi.fn(),
  }),
}));

vi.mock("@/components/diff/use-diff-click-to-edit", () => ({
  useDiffClickToEdit: () => ({}),
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-adapter-context", () => ({
  useRegisterTileFindAdapter: () => undefined,
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-find-adapter",
  () => ({
    createWorkspaceFileFindAdapter: () => ({
      updateEnvironment: vi.fn(),
    }),
  }),
);

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-renderer",
  () => ({
    WorkspaceFileRenderer: (props: { readonly content: string }) => (
      <div data-testid="workspace-source-renderer">{props.content}</div>
    ),
  }),
);

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-markdown-link-provider",
  () => ({
    WorkspaceMarkdownLinkProvider: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);

vi.mock("@/components/diff/file-autosave-status", () => ({
  FileAutosaveStatus: () => null,
}));

vi.mock("@/components/epic-canvas/renderers/dead-tile-banner", () => ({
  WorkspaceFileDeadTileBanner: () => null,
}));

vi.mock("@/hooks/scroll/use-native-div-scroll-restoration", () => ({
  useNativeDivScrollRestoration: () => ({
    scrollContainerRef: { current: null },
    onScroll: vi.fn(),
  }),
}));

vi.mock("@/stores/epics/canvas/workspace-file-reveal-store", () => ({
  clearWorkspaceFileRevealTarget: vi.fn(),
  useWorkspaceFileRevealTarget: () => null,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (value: { contextMetadata: null }) => unknown) =>
    selector({ contextMetadata: null }),
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (value: { defaultEditor: string }) => unknown) =>
    selector({ defaultEditor: "cursor" }),
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({
    mutate: state.openPaths,
    isPending: false,
  }),
}));

vi.mock("@/hooks/editor/use-editor-open-feedback", () => ({
  useEditorOpenFeedback: () => ({
    active: false,
    trigger: state.triggerOpenExternally,
  }),
}));

vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));

vi.mock("@/markdown", () => ({
  TraycerMarkdown: () => null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/epic-canvas/image-preview/image-preview", () => ({
  DEFAULT_ANIMATION_MS: 200,
  ImagePreview: (props: { readonly status: FileAssetStatus }) => (
    <div data-testid="workspace-image-preview" data-status={props.status} />
  ),
}));

// Mirrors the real `PdfPreview`'s own accessible landmark (`role="toolbar"`, `aria-label="PDF preview controls"` - pdf-preview.tsx) rather than a bare test id, so "the viewer mounted" is asserted through the same accessible contract a screen reader (or Testing Library's role queries) would see.
vi.mock("@/components/epic-canvas/pdf-preview/pdf-preview-lazy", () => ({
  // The real string, not a re-export via `vi.importActual` - that would drag pdf.js (worker URL, viewer CSS) into this routing test's jsdom, the same reason the whole module is mocked below.
  PDF_VIEWER_UNAVAILABLE_REASON:
    "The PDF viewer could not be loaded on this device.",
  PdfPreviewLazy: (props: {
    readonly url: string;
    readonly onUnavailable: () => void;
  }) => {
    const { onUnavailable } = props;
    useEffect(() => {
      if (state.viewerUnavailable) onUnavailable();
    }, [onUnavailable]);
    return (
      <div
        role="toolbar"
        aria-label="PDF preview controls"
        data-url={props.url}
      />
    );
  },
}));

import { WorkspaceFileTile } from "../workspace-file-tile";

function nodeFor(filePath: string): WorkspaceFileRef {
  const pathParts = filePath.split("/");
  return {
    id: `workspace-file:host-A:/work/repo:${filePath}`,
    instanceId: `instance-${filePath}`,
    type: "workspace-file",
    name: pathParts[pathParts.length - 1] ?? filePath,
    hostId: "host-A",
    workspacePath: "/work/repo",
    filePath,
  };
}

function renderTile(node: WorkspaceFileRef): RenderResult {
  return render(<WorkspaceFileTile node={node} viewTabId="tab-1" isActive />);
}

describe("workspace file tile PDF routing", () => {
  beforeEach(() => {
    state.asset = {
      status: "ready",
      url: "blob:pdf",
      meta: null,
      reason: null,
      totalBytes: null,
      servedFromCache: false,
    };
    state.assetRequests.length = 0;
    state.readFileCalls = 0;
    state.viewerUnavailable = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes every .pdf to the viewer, streaming instead of reading text", () => {
    renderTile(nodeFor("docs/report.pdf"));

    const preview = screen.getByRole("toolbar", {
      name: "PDF preview controls",
    });
    expect(preview.getAttribute("data-url")).toBe("blob:pdf");
    expect(state.readFileCalls).toBe(0);
    expect(state.assetRequests).toEqual([
      {
        method: "workspace",
        workspacePath: "/work/repo",
        filePath: "docs/report.pdf",
      },
    ]);
    // Single-bar contract: the viewer's own toolbar (carrying the path and
    // the Open Externally slot) is the tile's ONLY bar in the ready state.
    expect(screen.queryByTestId("workspace-file-toolbar")).toBeNull();
  });

  it("renders the shared placeholder with the hook's PDF copy on fallback", () => {
    state.asset = {
      status: "fallback",
      url: null,
      meta: null,
      reason: "This PDF is too large to preview.",
      totalBytes: null,
      servedFromCache: false,
    };
    renderTile(nodeFor("docs/report.pdf"));

    expect(screen.getByText("This PDF is too large to preview.")).toBeTruthy();
    expect(
      screen.queryByRole("toolbar", { name: "PDF preview controls" }),
    ).toBeNull();
    // No viewer toolbar without a viewer - the fallback keeps the shared
    // path bar so Open Externally stays reachable.
    expect(screen.getByTestId("workspace-file-toolbar")).toBeTruthy();
  });

  it("swaps to the shared placeholder when the viewer reports itself unavailable", () => {
    state.viewerUnavailable = true;
    renderTile(nodeFor("docs/report.pdf"));

    // The bytes are fine (asset status stays "ready") - only the viewer could not load or start, so the tile falls back to the same fallback layout a stream fallback uses, with the viewer-specific copy.
    expect(
      screen.getByText("The PDF viewer could not be loaded on this device."),
    ).toBeTruthy();
    expect(screen.getByTestId("workspace-file-toolbar")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open Externally" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("toolbar", { name: "PDF preview controls" }),
    ).toBeNull();
  });

  it("keeps image routing untouched by the PDF branch", () => {
    renderTile(nodeFor("images/logo.png"));

    expect(screen.getByTestId("workspace-image-preview")).toBeTruthy();
    expect(
      screen.queryByRole("toolbar", { name: "PDF preview controls" }),
    ).toBeNull();
  });
});
