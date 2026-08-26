/**
 * PDF routing in the workspace file tile (PDF preview design):
 *
 * - `.pdf` + host >= 1.1 -> the pdf.js viewer tile, streaming over
 *   `useFileAsset`, never the text path.
 * - `.pdf` + old host (or no handshake yet) -> the EXACT pre-PDF behavior:
 *   the text path, untouched. Fails closed.
 * - Fallback statuses render the shared `BinaryPlaceholder` with the
 *   PDF-specific copy the hook supplies (e.g. the 20 MiB cap message).
 * - Image routing is unaffected by the PDF branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  FileAssetRequest,
  FileAssetState,
  FileAssetStatus,
} from "@/hooks/assets/use-file-asset";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";

interface PdfRoutingTestState {
  asset: FileAssetState;
  assetRequests: FileAssetRequest[];
  /** `null` = "no handshake yet" - the fails-closed branch under test. */
  assetStreamVersion: SchemaVersion | null;
  readFileCalls: number;
  openPaths: Mock;
  triggerOpenExternally: Mock;
}

const state = vi.hoisted(
  (): PdfRoutingTestState => ({
    asset: {
      status: "ready",
      url: "blob:pdf",
      meta: null,
      reason: null,
      totalBytes: null,
      servedFromCache: false,
    },
    assetRequests: [],
    assetStreamVersion: { major: 1, minor: 1 },
    readFileCalls: 0,
    openPaths: vi.fn(),
    triggerOpenExternally: vi.fn(),
  }),
);

vi.mock("@/hooks/assets/use-file-asset", () => ({
  useFileAsset: (request: FileAssetRequest) => {
    state.assetRequests.push(request);
    return { ...state.asset, reportDecodeFailure: vi.fn() };
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
  useHostMethodSchemaVersion: () => state.assetStreamVersion,
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

// The real module imports pdf.js (worker URL, viewer CSS) - none of which
// belongs in this routing test's jsdom. The routing contract is only "the
// ready state mounts the lazy viewer with the blob URL".
vi.mock("@/components/epic-canvas/pdf-preview/pdf-preview-lazy", () => ({
  PdfPreviewLazy: (props: { readonly url: string }) => (
    <div data-testid="workspace-pdf-preview" data-url={props.url} />
  ),
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
    state.assetStreamVersion = { major: 1, minor: 1 };
    state.readFileCalls = 0;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes a .pdf to the viewer on a 1.1 host, streaming instead of reading text", () => {
    renderTile(nodeFor("docs/report.pdf"));

    const preview = screen.getByTestId("workspace-pdf-preview");
    expect(preview.getAttribute("data-url")).toBe("blob:pdf");
    expect(state.readFileCalls).toBe(0);
    expect(state.assetRequests).toEqual([
      {
        method: "workspace",
        workspacePath: "/work/repo",
        filePath: "docs/report.pdf",
      },
    ]);
  });

  it.each([
    ["no completed handshake", null],
    ["a 1.0 host", { major: 1, minor: 0 }],
  ] as const)(
    "falls back to the pre-PDF text path under %s",
    (_label, version) => {
      state.assetStreamVersion = version;
      renderTile(nodeFor("docs/report.pdf"));

      expect(screen.queryByTestId("workspace-pdf-preview")).toBeNull();
      // The text path IS the pre-PDF behavior - the router must not invent
      // a new degraded state for old hosts.
      expect(state.readFileCalls).toBeGreaterThan(0);
      expect(state.assetRequests).toEqual([]);
    },
  );

  it("renders the shared placeholder with the hook's PDF copy on fallback", () => {
    state.asset = {
      status: "fallback",
      url: null,
      meta: null,
      reason: "This PDF is too large to preview (20 MiB limit).",
      totalBytes: null,
      servedFromCache: false,
    };
    renderTile(nodeFor("docs/report.pdf"));

    expect(
      screen.getByText("This PDF is too large to preview (20 MiB limit)."),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-pdf-preview")).toBeNull();
  });

  it("keeps image routing untouched by the PDF branch", () => {
    renderTile(nodeFor("images/logo.png"));

    expect(screen.getByTestId("workspace-image-preview")).toBeTruthy();
    expect(screen.queryByTestId("workspace-pdf-preview")).toBeNull();
  });
});
