import { StrictMode, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactVersionObservationEntry,
  ArtifactVersionsListResponse,
  ArtifactVersionsRestoreResponse,
} from "@traycer/protocol/host/epic/artifact-versions";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  clampArtifactVersionHistoryPanelWidthPx,
  DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
  MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
  MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
  useArtifactVersionHistoryPanelStore,
} from "@/stores/epics/artifact-version-history-panel-store";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

interface HostQueryArgs {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly cacheKeyIdentity: readonly unknown[] | undefined;
  readonly options: { readonly enabled: boolean };
}

interface MutationOptions {
  readonly onSuccess?: (response: ArtifactVersionsRestoreResponse) => void;
  readonly onError?: () => void;
}

interface MutationConfig {
  readonly method: string;
  readonly onSuccess?: (
    response: ArtifactVersionsListResponse | ArtifactVersionsRestoreResponse,
  ) => void;
}

interface OpenedChatNode {
  readonly id: string;
  readonly instanceId: string;
  readonly type: "chat";
  readonly name: string;
  readonly hostId: string;
}

const state = vi.hoisted(() => ({
  supportedMethods: new Set<string>(),
  supportError: false,
  supportCalls: [] as string[],
  queryCalls: [] as HostQueryArgs[],
  mutationCalls: [] as Array<{
    readonly method: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }>,
  nodeRefCalls: [] as Array<{
    readonly chatId: string;
    readonly hostId: string;
  }>,
  openedChats: [] as Array<{
    readonly tabId: string;
    readonly node: OpenedChatNode;
  }>,
  historyEntries: [] as ArtifactVersionObservationEntry[],
  historyNextCursor: null as string | null,
  historyIsError: false,
  historyDataUpdatedAt: 1,
  historyRefetchCalls: 0,
  olderEntries: [] as ArtifactVersionObservationEntry[],
  settingsEnabled: true,
  blobByObservationId: new Map<
    string,
    { readonly contentHash: string; readonly markdown: string }
  >(),
  blobErrorObservationIds: new Set<string>(),
  blobRefetchCalls: [] as string[],
  restorePreflight: {
    kind: "preflight",
    imagesMissing: [] as string[],
    threadCount: 0,
    currentHash: "b".repeat(64),
  } satisfies ArtifactVersionsRestoreResponse,
  preflightError: false,
  restoreExecute: null as ArtifactVersionsRestoreResponse | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  epicNodeRefForNodeId: (_state: object, chatId: string, hostId: string) => {
    state.nodeRefCalls.push({ chatId, hostId });
    return {
      id: chatId,
      instanceId: `instance-${chatId}`,
      type: "chat",
      name: "Originating chat",
      hostId,
    } satisfies OpenedChatNode;
  },
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTilePreviewInTab: (tabId: string, node: OpenedChatNode) => {
      state.openedChats.push({ tabId, node });
    },
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string, method: string) => {
    if (state.supportError) throw new Error("negotiation failed");
    state.supportCalls.push(method);
    return state.supportedMethods.has(method);
  },
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: HostQueryArgs) => {
    state.queryCalls.push(args);
    if (args.method === "epic.artifactVersions.list") {
      return {
        data: state.historyIsError
          ? undefined
          : {
              entries: state.historyEntries,
              nextCursor: state.historyNextCursor,
            },
        isLoading: false,
        isError: state.historyIsError,
        dataUpdatedAt: state.historyDataUpdatedAt,
        refetch: () => {
          state.historyRefetchCalls += 1;
        },
      };
    }
    if (args.method === "epic.artifactVersionSettings.get") {
      return {
        data: {
          settings: {
            enabled: state.settingsEnabled,
            retentionDays: 30,
            maxVersionsPerArtifact: 100,
            maxBytesPerArtifact: 16 * 1024 * 1024,
          },
          storage: { referencedBytes: 0, reclaimableBytes: 0 },
        },
        isLoading: false,
        isError: false,
      };
    }
    const observationId = args.params.observationId;
    const blobFailed =
      typeof observationId === "string" &&
      state.blobErrorObservationIds.has(observationId);
    return {
      data:
        typeof observationId === "string" && !blobFailed
          ? state.blobByObservationId.get(observationId)
          : undefined,
      isLoading: false,
      isError: blobFailed,
      refetch: () => {
        if (typeof observationId === "string") {
          state.blobRefetchCalls.push(observationId);
        }
      },
    };
  },
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (_client: null, config: MutationConfig) => ({
    isPending: false,
    variables: { artifactId: "" },
    mutate: (
      variables: Readonly<Record<string, unknown>>,
      options: MutationOptions | undefined,
    ) => {
      state.mutationCalls.push({ method: config.method, variables });
      if (config.method === "epic.artifactVersions.list") {
        config.onSuccess?.({ entries: state.olderEntries, nextCursor: null });
        return;
      }
      if (
        config.method === "epic.artifactVersions.restore" &&
        variables.mode === "preflight"
      ) {
        if (state.preflightError) {
          options?.onError?.();
          return;
        }
        options?.onSuccess?.(state.restorePreflight);
        return;
      }
      if (
        config.method === "epic.artifactVersions.restore" &&
        variables.mode === "execute" &&
        state.restoreExecute !== null
      ) {
        options?.onSuccess?.(state.restoreExecute);
      }
    },
  }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: { readonly children: ReactNode }) => props.children,
  DiffContentPrimitive: (props: { readonly patch: string }) => (
    <pre data-testid="diff-content">{props.patch}</pre>
  ),
}));

import { ArtifactVersionHistoryEntryPoint } from "../artifact-version-history";

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const HISTORY_METHODS = [
  "epic.artifactVersions.list",
  "epic.artifactVersions.getBlob",
  "epic.artifactVersions.restore",
  "epic.artifactVersionSettings.get",
] as const;

function observation(
  observationId: string,
  chatTitle: string | null,
): ArtifactVersionObservationEntry {
  return {
    observationId,
    contentHash: HASH_A,
    serializerVersion: 1,
    parentContentHash: null,
    provenance: {
      kind: "agent",
      chatId: `chat-${observationId}`,
      turnId: "7",
      harnessId: "claude",
      chatTitle,
    },
    captureStreamId: "stream-a",
    localSeq: 1,
    capturedAt: 1_700_000_000_000,
    available: true,
    degraded: false,
  };
}

let epicHandle: OpenEpicStoreHandle;

function historyTree(handle: OpenEpicStoreHandle | null): ReactNode {
  return (
    <StrictMode>
      <EpicSessionContext.Provider value={handle}>
        <EpicViewTabContext.Provider value="tab-a">
          <ArtifactVersionHistoryEntryPoint artifactId="artifact-a" />
        </EpicViewTabContext.Provider>
      </EpicSessionContext.Provider>
    </StrictMode>
  );
}

function renderHistory(): RenderResult {
  return render(historyTree(epicHandle));
}

function openHistory(): RenderResult {
  const result = renderHistory();
  fireEvent.click(screen.getByTestId("artifact-version-history-entry"));
  expect(screen.queryByTestId("artifact-version-history-entry")).toBeNull();
  expect(screen.getByTestId("artifact-version-history-panel")).toBeTruthy();
  return result;
}

function closeHistory(): void {
  fireEvent.click(screen.getByTestId("artifact-version-history-close"));
  expect(screen.queryByTestId("artifact-version-history-panel")).toBeNull();
  expect(screen.getByTestId("artifact-version-history-entry")).toBeTruthy();
}

describe("<ArtifactVersionHistoryEntryPoint />", () => {
  beforeEach(() => {
    useArtifactVersionHistoryPanelStore.setState({
      panelWidthPx: DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    });
    epicHandle = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: noopEpicStreamClientFactory,
      userId: null,
      onAuthError: null,
    });
    state.supportedMethods = new Set(HISTORY_METHODS);
    state.supportError = false;
    state.supportCalls = [];
    state.queryCalls = [];
    state.mutationCalls = [];
    state.nodeRefCalls = [];
    state.openedChats = [];
    state.historyEntries = [];
    state.historyNextCursor = null;
    state.historyIsError = false;
    state.historyDataUpdatedAt = 1;
    state.historyRefetchCalls = 0;
    state.olderEntries = [];
    state.settingsEnabled = true;
    state.blobByObservationId.clear();
    state.blobErrorObservationIds.clear();
    state.blobRefetchCalls = [];
    state.restorePreflight = {
      kind: "preflight",
      imagesMissing: [],
      threadCount: 0,
      currentHash: HASH_B,
    };
    state.preflightError = false;
    state.restoreExecute = null;
  });

  afterEach(() => {
    cleanup();
    epicHandle.dispose();
    vi.restoreAllMocks();
  });

  it("closes without throwing when the Epic session tears down", () => {
    state.historyEntries = [observation("observation-a", "Originating chat")];
    const result = openHistory();

    expect(() => result.rerender(historyTree(null))).not.toThrow();

    expect(screen.queryByTestId("artifact-version-history-panel")).toBeNull();
    expect(screen.queryByTestId("artifact-version-history-entry")).toBeNull();
    expect(screen.queryByText("Version history unavailable")).toBeNull();
  });

  it("unmounts the panel and restores the entry button when closed", () => {
    state.historyEntries = [observation("observation-a", "Originating chat")];
    openHistory();
    closeHistory();
  });

  it("keeps artifact history scoped to the live artifact", () => {
    openHistory();

    expect(screen.queryByTestId("artifact-history-tab-deleted")).toBeNull();
    expect(
      state.queryCalls.some(
        (query) => query.method === "epic.deletedArtifacts.list",
      ),
    ).toBe(false);
  });

  it("loads older versions and drops accumulated pages after a first-page refetch", () => {
    state.historyEntries = [observation("observation-new", "Newest")];
    state.historyNextCursor = "older-cursor";
    state.olderEntries = [observation("observation-old", "Older")];
    const result = openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Load older versions" }),
    );

    expect(screen.getByText("Newest")).toBeTruthy();
    expect(screen.getByText("Older")).toBeTruthy();
    expect(state.mutationCalls).toContainEqual({
      method: "epic.artifactVersions.list",
      variables: {
        epicId: "epic-a",
        artifactId: "artifact-a",
        cursor: "older-cursor",
        limit: 200,
      },
    });

    state.historyEntries = [observation("observation-refetched", "Refetched")];
    state.historyNextCursor = null;
    state.historyDataUpdatedAt = 2;
    result.rerender(historyTree(epicHandle));

    expect(screen.getByText("Refetched")).toBeTruthy();
    expect(screen.queryByText("Older")).toBeNull();
  });

  it("shows a retry control when history loading fails", () => {
    state.historyIsError = true;
    openHistory();

    expect(screen.getByText("Couldn't load version history.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(state.historyRefetchCalls).toBe(1);
  });

  it("maximizes the panel and hides the resize handle", () => {
    state.historyEntries = [observation("observation-a", "Originating chat")];
    openHistory();

    expect(
      screen.getByTestId("artifact-version-history-resize-handle"),
    ).toBeTruthy();
    const maximize = screen.getByTestId("artifact-version-history-maximize");
    expect(maximize.getAttribute("aria-label")).toBe("Maximize panel");

    fireEvent.click(maximize);

    expect(maximize.getAttribute("aria-label")).toBe("Restore panel size");
    expect(
      screen.queryByTestId("artifact-version-history-resize-handle"),
    ).toBeNull();

    fireEvent.click(maximize);

    expect(maximize.getAttribute("aria-label")).toBe("Maximize panel");
    expect(
      screen.getByTestId("artifact-version-history-resize-handle"),
    ).toBeTruthy();
  });

  it("contains unexpected history faults at the artifact header", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    state.supportError = true;

    renderHistory();

    expect(
      screen.getByText("Version history unavailable").getAttribute("role"),
    ).toBe("status");
    expect(consoleError).toHaveBeenCalled();
  });

  it("stays hidden unless every negotiated history method is supported", () => {
    state.supportedMethods.delete("epic.artifactVersions.restore");

    renderHistory();

    expect(new Set(state.supportCalls)).toEqual(new Set(HISTORY_METHODS));
    expect(screen.queryByTestId("artifact-version-history-entry")).toBeNull();
  });

  it("preserves capture order while using observation identity for duplicate content", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    state.historyEntries = [
      observation("observation-new", "Newest snapshot"),
      observation("observation-old", "Older snapshot"),
    ];
    state.blobByObservationId.set("observation-new", {
      contentHash: HASH_A,
      markdown: "new body",
    });
    state.blobByObservationId.set("observation-old", {
      contentHash: HASH_A,
      markdown: "old body",
    });

    openHistory();

    const newest = screen.getByText("Newest snapshot");
    const older = screen.getByText("Older snapshot");
    expect(
      newest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => String(value).includes("same key")),
      ),
    ).toBe(false);

    state.queryCalls = [];
    fireEvent.click(
      screen.getByTestId("artifact-version-observation-observation-old"),
    );

    expect(
      state.queryCalls.some(
        (call) =>
          call.method === "epic.artifactVersions.getBlob" &&
          call.options.enabled &&
          call.params.observationId === "observation-old" &&
          call.cacheKeyIdentity?.[0] === HASH_A,
      ),
    ).toBe(true);
  });

  it("links titled agent provenance to its originating chat and leaves missing chats inert", () => {
    state.historyEntries = [
      observation("observation-linked", "Auth hardening"),
      observation("observation-gone", null),
      {
        ...observation("observation-legacy-restore", null),
        provenance: {
          kind: "restore",
          restoredFromObservationId: null,
          targetHash: HASH_A,
        },
      },
      {
        ...observation("observation-legacy-revive", null),
        provenance: {
          kind: "revive",
          deletionEventId: null,
          targetHash: HASH_A,
        },
      },
    ];

    openHistory();

    const chatLink = screen.getByRole("button", {
      name: "Open chat Auth hardening",
    });
    expect(chatLink.parentElement?.textContent).toBe(
      "Agent · Auth hardening · turn 7",
    );
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          element.textContent === "Agent · chat-observation-gone · turn 7",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Restored from an earlier version.")).toBeTruthy();
    expect(screen.getByText("Restored after deletion.")).toBeTruthy();

    fireEvent.click(chatLink);

    expect(state.nodeRefCalls).toEqual([
      { chatId: "chat-observation-linked", hostId: "host-a" },
    ]);
    expect(state.openedChats).toEqual([
      {
        tabId: "tab-a",
        node: {
          id: "chat-observation-linked",
          instanceId: "instance-chat-observation-linked",
          type: "chat",
          name: "Originating chat",
          hostId: "host-a",
        },
      },
    ]);
  });

  it("keeps frozen versions browsable below the off-state explanation", () => {
    state.settingsEnabled = false;
    state.historyEntries = [
      observation("observation-frozen", "Frozen snapshot"),
    ];
    state.blobByObservationId.set("observation-frozen", {
      contentHash: HASH_A,
      markdown: "frozen body",
    });

    openHistory();

    const explanation = screen.getByText(
      "Version history is off — turn it on in Settings.",
    );
    const frozen = screen.getByText("Frozen snapshot");
    expect(
      explanation.compareDocumentPosition(frozen) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    fireEvent.click(
      screen.getByTestId("artifact-version-observation-observation-frozen"),
    );
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeTruthy();
  });

  it("shows a retry control when a version body cannot be loaded", () => {
    state.historyEntries = [
      observation("observation-failed-body", "Failed body"),
    ];
    state.blobErrorObservationIds.add("observation-failed-body");
    openHistory();

    expect(screen.getByText("Couldn't load this version's body.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(state.blobRefetchCalls).toEqual(["observation-failed-body"]);
  });

  it("restores missing-image history as a new body-only version", () => {
    state.historyEntries = [
      observation("observation-target", "Target snapshot"),
    ];
    state.blobByObservationId.set("observation-target", {
      contentHash: HASH_A,
      markdown: "target body",
    });
    state.restorePreflight = {
      kind: "preflight",
      imagesMissing: [HASH_A],
      threadCount: 0,
      currentHash: HASH_B,
    };
    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );

    expect(
      screen.getByText(
        "It becomes a new version at the top of history. Nothing is deleted.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("You can restore the body only, or cancel."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore body only" }));

    expect(state.mutationCalls).toContainEqual({
      method: "epic.artifactVersions.restore",
      variables: {
        epicId: "epic-a",
        artifactId: "artifact-a",
        targetObservationId: "observation-target",
        mode: "execute",
        expectedCurrentHash: HASH_B,
        bodyOnly: true,
      },
    });
  });

  it("renders the clean restore outcome banner and badge", () => {
    state.historyEntries = [
      observation("observation-original", "Original snapshot"),
      observation("observation-restored", "Restored snapshot"),
    ];
    state.blobByObservationId.set("observation-original", {
      contentHash: HASH_A,
      markdown: "original body",
    });
    state.restoreExecute = {
      kind: "outcome",
      status: "clean",
      newObservationId: "observation-restored",
    };

    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore as new version" }),
    );

    expect(screen.getByText("Restored as a new version.")).toBeTruthy();
    expect(screen.getByText("Restored")).toBeTruthy();
  });

  it("renders the renormalized restore outcome banner and badge", () => {
    state.historyEntries = [
      observation("observation-original", "Original snapshot"),
      observation("observation-restored", "Restored snapshot"),
    ];
    state.blobByObservationId.set("observation-original", {
      contentHash: HASH_A,
      markdown: "original body",
    });
    state.restoreExecute = {
      kind: "outcome",
      status: "renormalized",
      newObservationId: "observation-restored",
    };

    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore as new version" }),
    );

    expect(
      screen.getByText(
        "Restored. Content was re-normalized by a newer editor version — formatting may differ slightly.",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("re-normalized by a newer editor version — review"),
    ).toBeTruthy();
  });

  it("renders the degraded restore outcome banner and badge", () => {
    state.historyEntries = [
      observation("observation-original", "Original snapshot"),
      observation("observation-restored", "Restored snapshot"),
    ];
    state.blobByObservationId.set("observation-original", {
      contentHash: HASH_A,
      markdown: "original body",
    });
    state.restoreExecute = {
      kind: "outcome",
      status: "degraded",
      newObservationId: "observation-restored",
    };

    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore as new version" }),
    );

    expect(
      screen.getByText(
        "Restored as a new version with missing image content. The new row is marked Body only.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Restored with missing image content"),
    ).toBeTruthy();
  });

  it("re-runs preflight after a restore conflict and clears the refreshing state", () => {
    state.historyEntries = [
      observation("observation-target", "Target snapshot"),
    ];
    state.blobByObservationId.set("observation-target", {
      contentHash: HASH_A,
      markdown: "target body",
    });
    state.restoreExecute = { kind: "conflict", currentHash: HASH_A };

    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore as new version" }),
    );

    const preflightCalls = state.mutationCalls.filter(
      (call) =>
        call.method === "epic.artifactVersions.restore" &&
        call.variables.mode === "preflight",
    );
    expect(preflightCalls).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Restore as new version" }),
    ).toBeTruthy();
  });

  it("surfaces a failed restore preflight and allows retry", () => {
    state.historyEntries = [
      observation("observation-target", "Target snapshot"),
    ];
    state.blobByObservationId.set("observation-target", {
      contentHash: HASH_A,
      markdown: "target body",
    });
    state.preflightError = true;
    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );

    expect(
      screen.getByText("Couldn't check the current artifact. Try again."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      state.mutationCalls.filter(
        (call) =>
          call.method === "epic.artifactVersions.restore" &&
          call.variables.mode === "preflight",
      ),
    ).toHaveLength(2);
  });

  it("shows the unavailable copy when an execute call reports unavailable", () => {
    state.historyEntries = [
      observation("observation-target", "Target snapshot"),
    ];
    state.blobByObservationId.set("observation-target", {
      contentHash: HASH_A,
      markdown: "target body",
    });
    state.restoreExecute = { kind: "unavailable", reason: "missing_blob" };

    openHistory();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore as new version" }),
    );

    expect(
      screen.getByText("The saved body for this version is missing."),
    ).toBeTruthy();
  });
});

describe("clampArtifactVersionHistoryPanelWidthPx", () => {
  it("clamps finite widths to the configured min and max", () => {
    expect(clampArtifactVersionHistoryPanelWidthPx(300)).toBe(
      MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    );
    expect(clampArtifactVersionHistoryPanelWidthPx(500.4)).toBe(500);
    expect(clampArtifactVersionHistoryPanelWidthPx(1200)).toBe(
      MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    );
  });

  it("falls back to the default width for non-finite values", () => {
    expect(clampArtifactVersionHistoryPanelWidthPx(Number.NaN)).toBe(
      DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    );
    expect(
      clampArtifactVersionHistoryPanelWidthPx(Number.POSITIVE_INFINITY),
    ).toBe(DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX);
  });

  it("persists clamped widths through the panel store setter", () => {
    useArtifactVersionHistoryPanelStore.getState().setPanelWidthPx(2000);
    expect(useArtifactVersionHistoryPanelStore.getState().panelWidthPx).toBe(
      MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    );
    useArtifactVersionHistoryPanelStore.getState().setPanelWidthPx(100);
    expect(useArtifactVersionHistoryPanelStore.getState().panelWidthPx).toBe(
      MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    );
    useArtifactVersionHistoryPanelStore.setState({
      panelWidthPx: DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
    });
  });
});
