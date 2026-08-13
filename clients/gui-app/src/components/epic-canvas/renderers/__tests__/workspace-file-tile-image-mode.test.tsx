import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type {
  ImageAssetMeta,
  ImageAssetRequest,
  ImageAssetState,
  ImageAssetStatus,
} from "@/hooks/assets/use-image-asset";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";

interface ReadFileState {
  readonly data:
    | {
        readonly content: string;
        readonly error: string | null;
        readonly truncated: boolean;
      }
    | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
}

const state = vi.hoisted(() => ({
  asset: {
    status: "ready" as ImageAssetStatus,
    url: "blob:image" as string | null,
    meta: null as ImageAssetMeta | null,
    reason: null as string | null,
    totalBytes: null as number | null,
    servedFromCache: false,
  } satisfies ImageAssetState,
  assetRequests: [] as ImageAssetRequest[],
  readFileCalls: 0,
  readFile: {
    data: {
      content: "<svg />",
      error: null,
      truncated: false,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } satisfies ReadFileState,
  editSessionCalls: 0,
  findAdapterCalls: 0,
  openPaths: vi.fn(),
  triggerOpenExternally: vi.fn(),
  editSession: {
    state: null,
    activate: vi.fn(),
    setDraft: vi.fn(),
    flush: vi.fn(),
    retry: vi.fn(),
    resolveKeepMine: vi.fn(),
    resolveUseDisk: vi.fn(),
    reportConflictResolutionError: vi.fn(),
  },
}));

vi.mock("@/hooks/assets/use-image-asset", () => ({
  useImageAsset: (request: ImageAssetRequest) => {
    state.assetRequests.push(request);
    // `state.asset` stays the module-level source of truth (tests mutate it
    // directly before a `rerender()`, as before); this counter exists only
    // so `reportDecodeFailure` - which the real hook fires synchronously
    // from a callback, not a prop change - can force ITS OWN re-render
    // without every test needing an explicit `rerender()` call.
    const [, forceRender] = useState(0);
    const reportDecodeFailure = () => {
      state.asset = {
        status: "fallback",
        url: null,
        meta: null,
        reason: "This image could not be decoded.",
        totalBytes: null,
        servedFromCache: false,
      };
      forceRender((count) => count + 1);
    };
    return { ...state.asset, reportDecodeFailure };
  },
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

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => {
    state.readFileCalls += 1;
    return state.readFile;
  },
}));

vi.mock("@/hooks/workspace/use-file-edit-session", () => ({
  useFileEditSession: () => {
    state.editSessionCalls += 1;
    return state.editSession;
  },
}));

vi.mock("@/components/diff/use-diff-click-to-edit", () => ({
  useDiffClickToEdit: () => ({}),
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-adapter-context", () => ({
  useRegisterTileFindAdapter: () => {
    state.findAdapterCalls += 1;
  },
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
  useEditorOpen: () => ({
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
  ImagePreview: (props: {
    readonly status: ImageAssetStatus;
    readonly url: string | null;
    readonly fileName: string;
    readonly onDecodeError: (() => void) | null;
  }) => (
    <div data-testid="workspace-image-preview" data-status={props.status}>
      {props.status === "ready" ? (
        <img
          src={props.url ?? ""}
          alt={props.fileName}
          onError={props.onDecodeError ?? undefined}
        />
      ) : null}
    </div>
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

function resetState(): void {
  state.asset = {
    status: "ready",
    url: "blob:image",
    meta: null,
    reason: null,
    totalBytes: null,
    servedFromCache: false,
  };
  state.assetRequests.length = 0;
  state.readFileCalls = 0;
  state.readFile = {
    data: {
      content: "<svg />",
      error: null,
      truncated: false,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  state.editSessionCalls = 0;
  state.findAdapterCalls = 0;
  state.openPaths.mockReset();
  state.triggerOpenExternally.mockReset();
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  cleanup();
});

describe("<WorkspaceFileTile /> image mode", () => {
  it.each(["png", "jpg", "gif", "webp"])(
    "routes .%s files to the image asset tile before workspace.readFile",
    (extension) => {
      const node = nodeFor(`assets/photo.${extension}`);

      renderTile(node);

      expect(state.readFileCalls).toBe(0);
      expect(state.assetRequests).toEqual([
        {
          method: "workspace",
          workspacePath: "/work/repo",
          filePath: node.filePath,
        },
      ]);
      expect(screen.getByTestId("workspace-file-toolbar")).toBeTruthy();
      expect(
        screen
          .getByTestId("workspace-image-preview")
          .getAttribute("data-status"),
      ).toBe("ready");
      expect(
        screen.getByRole("button", { name: "Open externally" }),
      ).toBeTruthy();
      expect(state.editSessionCalls).toBe(0);
      expect(state.findAdapterCalls).toBe(0);
    },
  );

  it("keeps the text route for a non-image file without an image toolbar action", () => {
    const node = nodeFor("src/index.ts");

    renderTile(node);

    expect(state.readFileCalls).toBeGreaterThan(0);
    expect(screen.getByTestId("workspace-file-toolbar")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open externally" }),
    ).toBeNull();
    expect(screen.getByTestId("workspace-source-renderer")).toBeTruthy();
  });

  it("defaults SVG to image mode and toggles into and back out of source mode", async () => {
    const node = nodeFor("assets/icon.svg");

    renderTile(node);

    expect(state.readFileCalls).toBe(0);
    expect(screen.getByTestId("workspace-image-preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View source" })).toBeTruthy();
    expect(screen.queryByTestId("workspace-source-renderer")).toBeNull();
    expect(state.editSessionCalls).toBe(0);
    expect(state.findAdapterCalls).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "View source" }));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-source-renderer")).toBeTruthy();
    });
    expect(state.readFileCalls).toBeGreaterThan(0);
    expect(state.editSessionCalls).toBeGreaterThan(0);
    expect(state.findAdapterCalls).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "View image" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View image" }));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-image-preview")).toBeTruthy();
    });
    expect(screen.queryByTestId("workspace-source-renderer")).toBeNull();
  });

  it.each([
    "This image could not be loaded.",
    "This file's contents do not match its extension.",
  ])(
    "renders fallback reason %s with one wired Open Externally action",
    (reason) => {
      const node = nodeFor("assets/photo.png");
      state.asset = {
        status: "fallback",
        url: null,
        meta: null,
        reason,
        totalBytes: 42,
        servedFromCache: false,
      };

      renderTile(node);

      expect(screen.getByText(reason)).toBeTruthy();
      expect(screen.getByText("42 bytes")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Open externally" }),
      ).toBeNull();
      const openButton = screen.getByRole("button", {
        name: "Open Externally",
      });

      fireEvent.click(openButton);

      expect(state.triggerOpenExternally).toHaveBeenCalledTimes(1);
      expect(state.openPaths).toHaveBeenCalledWith({
        editorId: "cursor",
        paths: ["/work/repo/assets/photo.png"],
      });
    },
  );

  it("reports a decode error through the hook and recovers once a new asset request resolves ready", () => {
    const rendered = renderTile(nodeFor("assets/photo.png"));

    fireEvent.error(screen.getByRole("img", { name: "photo.png" }));

    expect(screen.getByText("This image could not be decoded.")).toBeTruthy();
    expect(screen.queryByTestId("workspace-image-preview")).toBeNull();

    state.asset = {
      status: "ready",
      url: "blob:image-new",
      meta: null,
      reason: null,
      totalBytes: null,
      servedFromCache: false,
    };
    rendered.rerender(
      <WorkspaceFileTile
        node={nodeFor("assets/next.png")}
        viewTabId="tab-1"
        isActive
      />,
    );

    expect(screen.queryByText("This image could not be decoded.")).toBeNull();
    expect(screen.getByTestId("workspace-image-preview")).toBeTruthy();
  });
});
