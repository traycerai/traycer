import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  EpicListHtmlArtifactVersionsResponse,
  HtmlArtifactVersion,
} from "@traycer/protocol/host/epic/html-artifact-versions";
import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/artifact-objects";
import type {
  ReadChatAttachmentRequest,
  ReadChatAttachmentResponse,
} from "@traycer/protocol/host/epic/chat-attachment";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentReadClient,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SandboxStatus } from "@/lib/sandbox/bridge-host";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  DeletedArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import { ArtifactRow } from "@/components/chat/segments/artifact-row";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";

const STAMP_SHA = "a".repeat(64);
const HEAD_SHA = "b".repeat(64);
const OTHER_SHA = "c".repeat(64);
const UNKNOWN_SHA = "d".repeat(64);
const ARTIFACT_ID = "art-1";
const HEAD_BYTES_BASE64 = "aGVhZCBieXRlcw=="; // "head bytes"
const HEAD_BYTES_LENGTH = 10;

const STAMP: ToolCallArtifactStamp = {
  artifactId: ARTIFACT_ID,
  title: "My Artifact",
  manifest: {
    files: {
      "index.html": {
        sha256: STAMP_SHA,
        byteLength: 100,
        mediaType: "text/html",
      },
    },
    capturedAt: 1_000,
  },
  originChatId: "chat-1",
};

const PROJECTION: ArtifactProjection = {
  id: ARTIFACT_ID,
  kind: "html",
  title: "My Artifact",
  folderName: "my-artifact",
  parentId: null,
  artifactRoomId: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  status: null,
  createdManually: false,
  layout: "folder",
};

const PROJECTION_WITH_HEAD: ArtifactProjection = {
  ...PROJECTION,
  head: {
    files: {
      "index.html": {
        sha256: HEAD_SHA,
        byteLength: HEAD_BYTES_LENGTH,
        mediaType: "text/html",
        status: "published",
      },
    },
    capturedAt: 2_000,
  },
};

/** Live head is the same bundle the card stamped, so Expand must open Latest. */
const PROJECTION_STAMP_IS_HEAD: ArtifactProjection = {
  ...PROJECTION,
  head: {
    files: {
      "index.html": {
        sha256: STAMP_SHA,
        byteLength: 100,
        mediaType: "text/html",
        status: "published",
      },
    },
    capturedAt: 1_000,
  },
};

const EMPTY_ARTIFACTS: ArtifactsSlice = { byId: {}, allIds: [] };
const EMPTY_DELETED: DeletedArtifactsSlice = { byId: {}, allIds: [] };

interface FakeEpicRowState {
  readonly artifacts: ArtifactsSlice;
  readonly deletedArtifacts: DeletedArtifactsSlice;
}

const storeMocks = vi.hoisted(() => {
  const state: { current: FakeEpicRowState } = {
    current: {
      artifacts: { byId: {}, allIds: [] },
      deletedArtifacts: { byId: {}, allIds: [] },
    },
  };
  return state;
});

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: FakeEpicRowState) => unknown) =>
    selector(storeMocks.current),
}));

const expandMocks = vi.hoisted(() => ({
  openTile: vi.fn<(intent: TileOpenIntent) => null>(() => null),
  coarsePointer: { current: false },
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: expandMocks.openTile }),
}));

vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => expandMocks.coarsePointer.current,
}));

// The real button drives a mutation over the file-save host; this suite only
// needs to know which bundle and host the row binds it to.
vi.mock("@/components/html-artifact/html-artifact-download-button", () => ({
  HtmlArtifactDownloadButton: (props: {
    source: {
      artifactId: string;
      manifest: { files: Record<string, { sha256: string }> };
    };
    title: string;
    hostId: string;
  }) => (
    <button
      type="button"
      aria-label="Download"
      data-testid="download-stub"
      data-host-id={props.hostId}
      data-artifact-id={props.source.artifactId}
      data-entry-sha256={props.source.manifest.files["index.html"].sha256}
    />
  ),
}));

// A task view's card reads its version history and the comment machinery
// through the host; those boundaries are fed here and everything between them
// runs for real.
const historyMocks = vi.hoisted(() => ({
  page: null as EpicListHtmlArtifactVersionsResponse | null,
}));
const commentsFlag = vi.hoisted(() => ({ enabled: true }));
const NO_COMMENT_THREADS = vi.hoisted(() => []);

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/host/use-host-query")>()),
  useHostQuery: (args: { readonly options: { readonly enabled: boolean } }) => {
    const page = historyMocks.page;
    if (page === null) throw new Error("This test fed no version history.");
    return useQuery(
      queryOptions({
        queryKey: ["artifact-row-test-history"],
        queryFn: () => Promise.resolve(page),
        initialData: page,
        staleTime: Infinity,
        enabled: args.options.enabled,
      }),
    );
  },
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => commentsFlag.enabled,
}));
vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => NO_COMMENT_THREADS,
}));
vi.mock("@/components/comments/anchored-draft-popover", () => ({
  AnchoredDraftPopover: () => null,
}));

interface CapturedFrame {
  readonly source: SandboxFrameProps["source"];
  readonly height: number | null;
  readonly onStatus: (status: SandboxStatus) => void;
}

const sandboxFrameMocks = vi.hoisted(() => {
  const captured: { renders: CapturedFrame[]; mounts: number } = {
    renders: [],
    mounts: 0,
  };
  return captured;
});

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    // Every render pushes a `renders` entry, but `mounts` only grows on an
    // actual mount (empty-deps effect) - the distinction a `key` change
    // (generation bump) relies on, and what the crash test below has to
    // prove rather than infer from "the mock ran again".
    useEffect(() => {
      sandboxFrameMocks.mounts += 1;
    }, []);
    sandboxFrameMocks.renders.push({
      source: props.source,
      height: props.height,
      onStatus: props.onStatus,
    });
    return <div data-testid="sandbox-frame-mock" />;
  },
}));

type ArtifactSandboxSource = Extract<
  SandboxFrameProps["source"],
  { readonly kind: "artifact" }
>;

interface ArtifactFrame {
  readonly source: ArtifactSandboxSource;
  readonly height: number | null;
  readonly onStatus: (status: SandboxStatus) => void;
}

/**
 * Narrows the latest captured frame to the artifact-kind shape every test
 * here actually needs, or throws - never a silent early return that would
 * let a wrong-kind or absent frame read as a passing test.
 */
function requireArtifactFrame(frame: CapturedFrame | undefined): ArtifactFrame {
  if (frame === undefined) {
    throw new Error(
      "Expected the mocked sandbox frame to have rendered, but it never did.",
    );
  }
  if (frame.source.kind !== "artifact") {
    throw new Error(
      `Expected an artifact sandbox source, got "${frame.source.kind}".`,
    );
  }
  return {
    source: frame.source,
    height: frame.height,
    onStatus: frame.onStatus,
  };
}

function latestArtifactFrame(): ArtifactFrame {
  return requireArtifactFrame(sandboxFrameMocks.renders.at(-1));
}

function isArtifactObjectRequest(
  params: EpicReadArtifactObjectRequest | ReadChatAttachmentRequest,
): params is EpicReadArtifactObjectRequest {
  return "sha256" in params;
}

type ArtifactObjectResponder = (
  params: EpicReadArtifactObjectRequest,
  signal: AbortSignal | undefined,
) => Promise<EpicReadArtifactObjectResponse>;

function makeArtifactReadClient(
  respond: ArtifactObjectResponder,
): ChatAttachmentReadClient {
  function requestWithSignal(
    method: "epic.readArtifactObject",
    params: EpicReadArtifactObjectRequest,
    signal: AbortSignal | undefined,
  ): Promise<EpicReadArtifactObjectResponse>;
  function requestWithSignal(
    method: "epic.readChatAttachment",
    params: ReadChatAttachmentRequest,
    signal: AbortSignal | undefined,
  ): Promise<ReadChatAttachmentResponse>;
  function requestWithSignal(
    method: "epic.readArtifactObject" | "epic.readChatAttachment",
    params: EpicReadArtifactObjectRequest | ReadChatAttachmentRequest,
    signal: AbortSignal | undefined,
  ): Promise<EpicReadArtifactObjectResponse | ReadChatAttachmentResponse> {
    if (
      method === "epic.readArtifactObject" &&
      isArtifactObjectRequest(params)
    ) {
      return respond(params, signal);
    }
    return Promise.reject(
      new Error(`Unexpected request in this test: ${method}`),
    );
  }
  return {
    requestWithSignal,
    requestWithSignalRequiringHostMethodVersion() {
      return Promise.reject(
        new Error("Unexpected attachment read in artifact row test"),
      );
    },
  };
}

/** The stamped object is evicted; the live head's sha serves real bytes; any other sha is a test-setup bug. */
function makeEvictionClient(): ChatAttachmentReadClient {
  return makeArtifactReadClient((params) => {
    if (params.sha256 === STAMP_SHA) {
      return Promise.resolve({ kind: "unavailable", reason: "missing" });
    }
    if (params.sha256 === HEAD_SHA) {
      return Promise.resolve({
        kind: "bytes",
        bytesBase64: HEAD_BYTES_BASE64,
        offset: 0,
        totalBytes: HEAD_BYTES_LENGTH,
        mediaType: "text/html",
      });
    }
    return Promise.reject(
      new Error(`Unexpected sha256 in this test: ${params.sha256}`),
    );
  });
}

const SCOPE_BASE = {
  epicId: "epic-1",
  chatId: "chat-1",
  hostId: "host-1",
  hostVersion: "1.30.0",
};

function scopeWithClient(
  client: ChatAttachmentReadClient | null,
): ChatAttachmentScopeValue {
  return { ...SCOPE_BASE, client };
}

function renderRow(
  scope: ChatAttachmentScopeValue | null,
  stamp: ToolCallArtifactStamp,
) {
  return render(
    <ChatAttachmentScopeContext.Provider value={scope}>
      <ArtifactRow
        artifact={stamp}
        fallback={<div data-testid="fallback">fallback</div>}
      />
    </ChatAttachmentScopeContext.Provider>,
  );
}

function rerenderRow(
  rerender: (ui: ReactNode) => void,
  scope: ChatAttachmentScopeValue | null,
  stamp: ToolCallArtifactStamp,
) {
  rerender(
    <ChatAttachmentScopeContext.Provider value={scope}>
      <ArtifactRow
        artifact={stamp}
        fallback={<div data-testid="fallback">fallback</div>}
      />
    </ChatAttachmentScopeContext.Provider>,
  );
}

function neverRespond(): Promise<EpicReadArtifactObjectResponse> {
  return new Promise(() => undefined);
}

function lastOpenedIntent(): TileOpenIntent {
  const intent = expandMocks.openTile.mock.calls.at(-1)?.[0];
  if (intent === undefined)
    throw new Error("Expected Open in panel to open a tile.");
  return intent;
}

beforeEach(() => {
  storeMocks.current = {
    artifacts: EMPTY_ARTIFACTS,
    deletedArtifacts: EMPTY_DELETED,
  };
  sandboxFrameMocks.renders = [];
  sandboxFrameMocks.mounts = 0;
  expandMocks.openTile.mockClear();
  expandMocks.coarsePointer.current = false;
  historyMocks.page = null;
  commentsFlag.enabled = true;
});

afterEach(() => {
  cleanup();
});

function savedVersion(
  versionNumber: number,
  sha256: string,
  byteLength: number,
  capturedAt: number,
): HtmlArtifactVersion {
  return {
    id: sha256,
    versionNumber,
    entryPath: "index.html",
    manifest: {
      files: {
        "index.html": { sha256, byteLength, mediaType: "text/html" },
      },
      capturedAt,
    },
  };
}

/** The version the stamp captured, as the artifact's history lists it. */
const V1 = savedVersion(1, STAMP_SHA, 100, 1_000);
const V2 = savedVersion(2, OTHER_SHA, 20, 1_500);
/** What `PROJECTION_WITH_HEAD` serves now. */
const V3 = savedVersion(3, HEAD_SHA, HEAD_BYTES_LENGTH, 2_000);

/** The history page the host answers with, newest first; the first row is the current version. */
function historyOf(
  versions: readonly HtmlArtifactVersion[],
): EpicListHtmlArtifactVersionsResponse {
  return {
    versions: [...versions],
    nextCursor: null,
    currentVersionNumber: versions[0].versionNumber,
  };
}

/** The row inside a task's view tab and tile host; `null` renders it outside a task view. */
function taskTree(
  viewTabId: string | null,
  scope: ChatAttachmentScopeValue,
  stamp: ToolCallArtifactStamp,
): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <EpicViewTabContext.Provider value={viewTabId}>
          <TabHostContext.Provider value="host-1">
            <ChatAttachmentScopeContext.Provider value={scope}>
              <ArtifactRow
                artifact={stamp}
                fallback={<div data-testid="fallback">fallback</div>}
              />
            </ChatAttachmentScopeContext.Provider>
          </TabHostContext.Provider>
        </EpicViewTabContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function toolbarButtons(): (string | null)[] {
  return within(screen.getByRole("toolbar", { name: "HTML artifact controls" }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
}

function servedEntrySha256(): string {
  return latestArtifactFrame().source.manifest.files["index.html"].sha256;
}

describe("<ArtifactRow />", () => {
  it("renders the fallback when there is no attachment scope", () => {
    renderRow(null, STAMP);

    expect(screen.getByTestId("fallback")).toBeTruthy();
    expect(screen.queryByTestId("artifact-row")).toBeNull();
  });

  it("shows a loading placeholder while the projection has not arrived yet (pending)", () => {
    renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);

    expect(screen.getByText("Loading artifact")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-frame-mock")).toBeNull();
    expect(screen.queryByText("This artifact was deleted.")).toBeNull();
    expect(sandboxFrameMocks.mounts).toBe(0);
  });

  it("shows a loading placeholder when the client is not ready yet, even though the projection is live", () => {
    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    const { rerender } = renderRow(scopeWithClient(null), STAMP);

    expect(screen.getByText("Loading artifact")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-frame-mock")).toBeNull();

    rerenderRow(
      rerender,
      scopeWithClient(makeArtifactReadClient(neverRespond)),
      STAMP,
    );

    expect(screen.queryByText("Loading artifact")).toBeNull();
    expect(screen.getByTestId("sandbox-frame-mock")).toBeTruthy();
  });

  it("renders the deleted placeholder once the tombstone is confirmed", () => {
    storeMocks.current = {
      artifacts: EMPTY_ARTIFACTS,
      deletedArtifacts: {
        byId: {
          [ARTIFACT_ID]: {
            id: ARTIFACT_ID,
            kind: "html",
            title: "My Artifact",
            deletedAt: "2026-01-01T00:00:00Z",
            status: null,
          },
        },
        allIds: [ARTIFACT_ID],
      },
    };
    renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);

    expect(screen.getByText("This artifact was deleted.")).toBeTruthy();
    expect(screen.queryByText("Loading artifact")).toBeNull();
    expect(screen.queryByTestId("sandbox-frame-mock")).toBeNull();
  });

  it("stays pending until the projection arrives, then mounts", () => {
    const { rerender } = renderRow(
      scopeWithClient(makeArtifactReadClient(neverRespond)),
      STAMP,
    );

    expect(screen.getByText("Loading artifact")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-frame-mock")).toBeNull();
    expect(sandboxFrameMocks.mounts).toBe(0);

    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    rerenderRow(
      rerender,
      scopeWithClient(makeArtifactReadClient(neverRespond)),
      STAMP,
    );

    expect(screen.queryByText("Loading artifact")).toBeNull();
    expect(sandboxFrameMocks.mounts).toBe(1);
    const frame = latestArtifactFrame();
    expect(frame.source.treePath).toBe("my-artifact");
    expect(frame.source.entryPath).toBe("index.html");
  });

  it("preserves the resolved frame while the record is merely absent, then removes it on a confirmed tombstone", () => {
    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    const client = makeArtifactReadClient(neverRespond);
    const { rerender } = renderRow(scopeWithClient(client), STAMP);
    const resolved = latestArtifactFrame();
    expect(sandboxFrameMocks.mounts).toBe(1);

    // The record lane drops the entry WITHOUT a tombstone - e.g. a
    // reconnect gap. The row must keep showing what it already resolved,
    // not flash to "Loading artifact" or unmount the live document.
    storeMocks.current = {
      artifacts: EMPTY_ARTIFACTS,
      deletedArtifacts: EMPTY_DELETED,
    };
    rerenderRow(rerender, scopeWithClient(client), STAMP);

    expect(screen.queryByText("Loading artifact")).toBeNull();
    expect(screen.queryByText("This artifact was deleted.")).toBeNull();
    const stillResolved = latestArtifactFrame();
    expect(stillResolved.source).toBe(resolved.source);
    expect(sandboxFrameMocks.mounts).toBe(1);

    // Now a tombstone confirms the delete: the preserved frame is removed.
    storeMocks.current = {
      artifacts: EMPTY_ARTIFACTS,
      deletedArtifacts: {
        byId: {
          [ARTIFACT_ID]: {
            id: ARTIFACT_ID,
            kind: "html",
            title: "My Artifact",
            deletedAt: "2026-01-01T00:00:00Z",
            status: null,
          },
        },
        allIds: [ARTIFACT_ID],
      },
    };
    rerenderRow(rerender, scopeWithClient(client), STAMP);

    expect(screen.getByText("This artifact was deleted.")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-frame-mock")).toBeNull();
  });

  it("mounts the sandbox frame with the stamped manifest when the object has not been evicted", () => {
    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);

    expect(screen.queryByText("Showing latest")).toBeNull();
    const frame = latestArtifactFrame();
    expect(frame.source.manifest).toBe(STAMP.manifest);
    expect(frame.source.treePath).toBe("my-artifact");
    expect(frame.source.entryPath).toBe("index.html");
  });

  it("serves the live head and shows 'Showing latest' once the stamped object is confirmed evicted (own-SHA eviction), and reads real head bytes while rejecting an unexpected sha", async () => {
    storeMocks.current = {
      artifacts: {
        byId: { [ARTIFACT_ID]: PROJECTION_WITH_HEAD },
        allIds: [ARTIFACT_ID],
      },
      deletedArtifacts: EMPTY_DELETED,
    };
    renderRow(scopeWithClient(makeEvictionClient()), STAMP);
    const beforeEviction = latestArtifactFrame();

    await act(async () => {
      await beforeEviction.source.readSpan(
        STAMP_SHA,
        0,
        10,
        new AbortController().signal,
      );
    });

    expect(screen.getByText("Showing latest")).toBeTruthy();
    const afterEviction = latestArtifactFrame();
    expect(afterEviction.source.manifest).toEqual(PROJECTION_WITH_HEAD.head);

    // The new source actually serves the head's own bytes, not just a
    // state label - and a sha the test never authorized must reject rather
    // than silently resolve.
    const headRead = await afterEviction.source.readSpan(
      HEAD_SHA,
      0,
      HEAD_BYTES_LENGTH,
      new AbortController().signal,
    );
    expect("bytes" in headRead).toBe(true);
    if ("bytes" in headRead) {
      expect(headRead.totalBytes).toBe(HEAD_BYTES_LENGTH);
      expect(headRead.mediaType).toBe("text/html");
      expect(new TextDecoder().decode(headRead.bytes)).toBe("head bytes");
    }

    await expect(
      afterEviction.source.readSpan(
        UNKNOWN_SHA,
        0,
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow(`Unexpected sha256 in this test: ${UNKNOWN_SHA}`);
  });

  it("keeps serving the live head and the same source across an equal-content stamp clone after eviction", async () => {
    storeMocks.current = {
      artifacts: {
        byId: { [ARTIFACT_ID]: PROJECTION_WITH_HEAD },
        allIds: [ARTIFACT_ID],
      },
      deletedArtifacts: EMPTY_DELETED,
    };
    const client = makeEvictionClient();
    const { rerender } = renderRow(scopeWithClient(client), STAMP);
    const beforeEviction = latestArtifactFrame();

    await act(async () => {
      await beforeEviction.source.readSpan(
        STAMP_SHA,
        0,
        10,
        new AbortController().signal,
      );
    });
    expect(screen.getByText("Showing latest")).toBeTruthy();
    const evicted = latestArtifactFrame();

    const equalStamp: ToolCallArtifactStamp = {
      artifactId: STAMP.artifactId,
      title: STAMP.title,
      manifest: {
        files: {
          "index.html": {
            sha256: STAMP_SHA,
            byteLength: 100,
            mediaType: "text/html",
          },
        },
        capturedAt: 1_000,
      },
      originChatId: STAMP.originChatId,
    };
    expect(equalStamp.manifest).not.toBe(STAMP.manifest);
    rerenderRow(rerender, scopeWithClient(client), equalStamp);

    expect(screen.getByText("Showing latest")).toBeTruthy();
    const afterRerender = latestArtifactFrame();
    expect(afterRerender.source).toBe(evicted.source);
  });

  it("treats a missing SIBLING object as unrelated and keeps the stamped state (outside missing)", async () => {
    storeMocks.current = {
      artifacts: {
        byId: { [ARTIFACT_ID]: PROJECTION_WITH_HEAD },
        allIds: [ARTIFACT_ID],
      },
      deletedArtifacts: EMPTY_DELETED,
    };
    const client = makeArtifactReadClient(() =>
      Promise.resolve({ kind: "unavailable", reason: "missing" }),
    );
    renderRow(scopeWithClient(client), STAMP);
    const mounted = latestArtifactFrame();

    await act(async () => {
      await mounted.source.readSpan(
        OTHER_SHA,
        0,
        10,
        new AbortController().signal,
      );
    });

    expect(screen.queryByText("Showing latest")).toBeNull();
    const after = latestArtifactFrame();
    expect(after.source.manifest).toBe(STAMP.manifest);
  });

  it("passes a downloading-then-ready response through without marking the object missing", async () => {
    vi.useFakeTimers();
    try {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      let calls = 0;
      const client = makeArtifactReadClient(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            kind: "downloading",
            receivedBytes: 0,
            totalBytes: 2,
          });
        }
        return Promise.resolve({
          kind: "bytes",
          bytesBase64: "aGk=",
          offset: 0,
          totalBytes: 2,
          mediaType: "text/html",
        });
      });
      renderRow(scopeWithClient(client), STAMP);
      const mounted = latestArtifactFrame();

      const resultPromise = mounted.source.readSpan(
        STAMP_SHA,
        0,
        2,
        new AbortController().signal,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      const result = await resultPromise;

      expect("unavailable" in result).toBe(false);
      expect(screen.queryByText("Showing latest")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the same source reference across a rerender with an equal-content stamp", () => {
    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    const client = makeArtifactReadClient(neverRespond);
    const { rerender } = renderRow(scopeWithClient(client), STAMP);
    const first = latestArtifactFrame();

    const equalStamp: ToolCallArtifactStamp = {
      artifactId: STAMP.artifactId,
      title: STAMP.title,
      manifest: {
        files: {
          "index.html": {
            sha256: STAMP_SHA,
            byteLength: 100,
            mediaType: "text/html",
          },
        },
        capturedAt: 1_000,
      },
      originChatId: STAMP.originChatId,
    };
    expect(equalStamp.manifest).not.toBe(STAMP.manifest);
    rerenderRow(rerender, scopeWithClient(client), equalStamp);

    const second = latestArtifactFrame();
    expect(second.source).toBe(first.source);
  });

  it("keeps the same source reference when an unrelated store slice changes", () => {
    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    const client = makeArtifactReadClient(neverRespond);
    const { rerender } = renderRow(scopeWithClient(client), STAMP);
    const first = latestArtifactFrame();

    const unrelatedId = "art-unrelated";
    const unrelatedProjection: ArtifactProjection = {
      ...PROJECTION,
      id: unrelatedId,
      title: "Unrelated",
      folderName: "unrelated",
    };
    storeMocks.current = {
      artifacts: {
        byId: { [ARTIFACT_ID]: PROJECTION, [unrelatedId]: unrelatedProjection },
        allIds: [ARTIFACT_ID, unrelatedId],
      },
      deletedArtifacts: EMPTY_DELETED,
    };
    rerenderRow(rerender, scopeWithClient(client), STAMP);

    const second = latestArtifactFrame();
    expect(second.source).toBe(first.source);
  });

  it("shows a Reload action on crash and performs a real remount on click (generation bump)", () => {
    storeMocks.current = {
      artifacts: { byId: { [ARTIFACT_ID]: PROJECTION }, allIds: [ARTIFACT_ID] },
      deletedArtifacts: EMPTY_DELETED,
    };
    renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);
    const mounted = latestArtifactFrame();
    expect(sandboxFrameMocks.mounts).toBe(1);

    act(() => {
      mounted.onStatus("crashed");
    });

    expect(screen.getByText("This artifact stopped responding.")).toBeTruthy();
    const reload = screen.getByRole("button", { name: "Reload" });
    expect(screen.queryByTestId("sandbox-frame-mock")).toBeNull();

    fireEvent.click(reload);

    expect(screen.queryByText("This artifact stopped responding.")).toBeNull();
    expect(screen.getByTestId("sandbox-frame-mock")).toBeTruthy();
    // Exactly one more MOUNT (not merely one more render of the same
    // instance) - the `key={generation}` bump proven by lifecycle, not by
    // the mock function having been called again.
    expect(sandboxFrameMocks.mounts).toBe(2);
  });
  describe("inline Open in panel", () => {
    function expectLatestExpand(): void {
      const intent = lastOpenedIntent();
      expect(intent).toMatchObject({
        node: {
          id: ARTIFACT_ID,
          type: "html",
          name: "My Artifact",
          hostId: "host-1",
        },
        target: { epicId: "epic-1" },
        dedupe: true,
        source: "direct_ui",
        adoptHtmlVersion: true,
      });
      expect(intent.node).not.toHaveProperty("htmlVersion");
    }

    it("opens a stamp older than the live head pinned to that capture", () => {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION_WITH_HEAD },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);

      fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));

      // `dedupe: true` keeps a second click on the artifact's one tile; the
      // executor adopts this pin so the tile shows the card's older capture.
      expect(lastOpenedIntent()).toMatchObject({
        node: {
          id: ARTIFACT_ID,
          type: "html",
          name: "My Artifact",
          hostId: "host-1",
          htmlVersion: {
            manifest: { files: STAMP.manifest.files, capturedAt: 1_000 },
            entryPath: "index.html",
          },
        },
        target: { epicId: "epic-1" },
        dedupe: true,
        source: "direct_ui",
        adoptHtmlVersion: true,
      });
    });

    it("opens Latest from a Showing latest card, with no pin", async () => {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION_WITH_HEAD },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      renderRow(scopeWithClient(makeEvictionClient()), STAMP);
      await act(async () => {
        await latestArtifactFrame().source.readSpan(
          STAMP_SHA,
          0,
          10,
          new AbortController().signal,
        );
      });
      expect(screen.getByText("Showing latest")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));

      expectLatestExpand();
    });

    it("opens Latest from a stamped card whose capture is the live head", () => {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION_STAMP_IS_HEAD },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);
      expect(screen.queryByText("Showing latest")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));

      expectLatestExpand();
    });

    it("keeps Open in panel working once the card is expanded, on the same frame and with the same pin", () => {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION_WITH_HEAD },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);
      expect(sandboxFrameMocks.mounts).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "Expand" }));
      const dialog = screen.getByRole("dialog", { name: "My Artifact" });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Open in panel" }),
      );

      expect(within(dialog).getByTestId("download-stub")).toBeTruthy();
      expect(lastOpenedIntent()).toMatchObject({
        node: {
          id: ARTIFACT_ID,
          type: "html",
          hostId: "host-1",
          htmlVersion: {
            manifest: { files: STAMP.manifest.files, capturedAt: 1_000 },
            entryPath: "index.html",
          },
        },
        target: { epicId: "epic-1" },
        adoptHtmlVersion: true,
      });
      // Raising the card must not reload the page it shows.
      expect(sandboxFrameMocks.mounts).toBe(1);
    });

    it("hands the download the same host and artifact, and grows its touch target on a coarse pointer", () => {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      expandMocks.coarsePointer.current = true;
      renderRow(scopeWithClient(makeArtifactReadClient(neverRespond)), STAMP);

      const download = screen.getByTestId("download-stub");
      expect(download.dataset.hostId).toBe("host-1");
      expect(download.dataset.artifactId).toBe(ARTIFACT_ID);
      expect(
        screen.getByRole("button", { name: "Open in panel" }).dataset.size,
      ).toBe("icon-touch");
    });
  });

  describe("in a task view", () => {
    function serveArtifact(projection: ArtifactProjection): void {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: projection },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
    }

    function serveCaptureAsCurrent(): void {
      serveArtifact(PROJECTION_STAMP_IS_HEAD);
      historyMocks.page = historyOf([V1]);
    }

    function serveChangedSinceCapture(): void {
      serveArtifact(PROJECTION_WITH_HEAD);
      historyMocks.page = historyOf([V3, V2, V1]);
    }

    function renderTaskRow(client: ChatAttachmentReadClient) {
      return render(taskTree("tab-1", scopeWithClient(client), STAMP));
    }

    function versionButtonLabel(): string | null {
      return screen
        .getByRole("button", { name: /HTML version history/ })
        .getAttribute("aria-label");
    }

    function commentsButton(): HTMLButtonElement {
      const button = screen.getByRole("button", { name: "Comments" });
      if (!(button instanceof HTMLButtonElement))
        throw new Error("Comments is not a button");
      return button;
    }

    async function pickFromVersionMenu(
      user: UserEvent,
      row: RegExp,
    ): Promise<void> {
      await user.click(
        screen.getByRole("button", { name: /HTML version history/ }),
      );
      await user.click(screen.getByRole("menuitemradio", { name: row }));
    }

    it("opens on a capture that is the current version, with the picker and a live Comments toggle", () => {
      serveCaptureAsCurrent();
      renderTaskRow(makeArtifactReadClient(neverRespond));

      expect(versionButtonLabel()).toBe("HTML version history: Latest");
      expect(commentsButton().disabled).toBe(false);
      expect(servedEntrySha256()).toBe(STAMP_SHA);
      expect(toolbarButtons()).toEqual([
        "HTML version history: Latest",
        "Download",
        "Open in panel",
        "Comments",
        "Expand",
      ]);
    });

    it("keeps an older capture on show under its version number, with Comments unavailable", () => {
      serveChangedSinceCapture();
      renderTaskRow(makeArtifactReadClient(neverRespond));

      expect(versionButtonLabel()).toBe("HTML version history: v1 of 3");
      expect(commentsButton().disabled).toBe(true);
      expect(servedEntrySha256()).toBe(STAMP_SHA);
      expect(toolbarButtons()).toEqual([
        "HTML version history: v1 of 3",
        "Download",
        "Open in panel",
        "Comments",
        "Expand",
      ]);
    });

    it("moves to the current version when the reader picks Latest, and Open in panel then follows Latest", async () => {
      serveChangedSinceCapture();
      renderTaskRow(makeArtifactReadClient(neverRespond));

      await pickFromVersionMenu(userEvent.setup(), /Latest/);

      expect(servedEntrySha256()).toBe(HEAD_SHA);
      expect(versionButtonLabel()).toBe("HTML version history: Latest");
      expect(commentsButton().disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
      expect(lastOpenedIntent().node).not.toHaveProperty("htmlVersion");
    });

    it("moves to the version the reader picks, and Download and Open in panel follow it", async () => {
      serveChangedSinceCapture();
      renderTaskRow(makeArtifactReadClient(neverRespond));

      await pickFromVersionMenu(userEvent.setup(), /Version 2/);

      expect(servedEntrySha256()).toBe(OTHER_SHA);
      expect(versionButtonLabel()).toBe("HTML version history: v2 of 3");
      expect(commentsButton().disabled).toBe(true);
      expect(screen.getByTestId("download-stub").dataset.entrySha256).toBe(
        OTHER_SHA,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
      expect(lastOpenedIntent().node).toMatchObject({
        htmlVersion: {
          manifest: { files: { "index.html": { sha256: OTHER_SHA } } },
          entryPath: "index.html",
        },
      });
    });

    it("opens on the capture again after a remount, whatever the reader had picked", async () => {
      serveChangedSinceCapture();
      const client = makeArtifactReadClient(neverRespond);
      const first = renderTaskRow(client);
      await pickFromVersionMenu(userEvent.setup(), /Latest/);
      expect(servedEntrySha256()).toBe(HEAD_SHA);

      first.unmount();
      renderTaskRow(client);

      expect(versionButtonLabel()).toBe("HTML version history: v1 of 3");
      expect(servedEntrySha256()).toBe(STAMP_SHA);
    });

    it("serves the current version, with the picker and a live Comments toggle, when the capture is evicted", async () => {
      serveChangedSinceCapture();
      renderTaskRow(makeEvictionClient());

      await act(async () => {
        await latestArtifactFrame().source.readSpan(
          STAMP_SHA,
          0,
          10,
          new AbortController().signal,
        );
      });

      expect(screen.getByText("Showing latest")).toBeTruthy();
      expect(versionButtonLabel()).toBe("HTML version history: Latest");
      expect(commentsButton().disabled).toBe(false);
      expect(servedEntrySha256()).toBe(HEAD_SHA);
    });

    it("offers the picker but no Comments control on an older version when frame comments are off", () => {
      commentsFlag.enabled = false;
      serveChangedSinceCapture();
      renderTaskRow(makeArtifactReadClient(neverRespond));

      expect(versionButtonLabel()).toBe("HTML version history: v1 of 3");
      expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
    });

    it("keeps the same frame through Expand and carries the toolbar into the raised surface", () => {
      serveCaptureAsCurrent();
      renderTaskRow(makeArtifactReadClient(neverRespond));
      expect(sandboxFrameMocks.mounts).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "Expand" }));

      const dialog = screen.getByRole("dialog", { name: "My Artifact" });
      expect(
        within(dialog).getByRole("button", { name: "Zoom in" }),
      ).toBeTruthy();
      for (const name of [
        "HTML version history: Latest",
        "Download",
        "Open in panel",
        "Comments",
        "More actions",
      ]) {
        expect(within(dialog).getByRole("button", { name })).toBeTruthy();
      }
      expect(sandboxFrameMocks.mounts).toBe(1);
    });
  });

  describe("outside a task view", () => {
    it("is the plain card, with Download, Open in panel and Expand and no picker or Comments", () => {
      storeMocks.current = {
        artifacts: {
          byId: { [ARTIFACT_ID]: PROJECTION_STAMP_IS_HEAD },
          allIds: [ARTIFACT_ID],
        },
        deletedArtifacts: EMPTY_DELETED,
      };
      historyMocks.page = historyOf([V1]);
      render(
        taskTree(
          null,
          scopeWithClient(makeArtifactReadClient(neverRespond)),
          STAMP,
        ),
      );

      expect(toolbarButtons()).toEqual(["Download", "Open in panel", "Expand"]);
      expect(
        screen.queryByRole("button", { name: /HTML version history/ }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
    });
  });
});
