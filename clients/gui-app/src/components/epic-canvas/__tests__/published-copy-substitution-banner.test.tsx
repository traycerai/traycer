/**
 * The canvas substitution rendered through the REAL tile renderer, down to the
 * real `PublishedChatTile` - so the two surfaces that each know how to draw a
 * dead-tile banner are on screen together.
 *
 * Why a third suite: `tab-group-view.test.tsx` stubs `EpicNodeTile`, and
 * `published-chat-tile.test.tsx` mounts the tile alone. Each pins its own
 * half correctly, and neither can see the other's banner - which is how the
 * cross-host offline case shipped with two identical "Bound host is offline"
 * bars and two Clone buttons (2026-09-09). This suite counts them.
 *
 * The seam this suite keeps is `ChatDeadTileBannerContainer`: both mounts
 * go through it, and the real one runs the clone offer's host-runtime
 * subscription and a cloud lookup this provider-less render has no hosts
 * for. The stub renders the real `ChatDeadTileBanner`, so a Clone button on
 * screen is one banner MOUNT - exactly the count under test.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { ChatReplicaReadResponse } from "@traycer/protocol/host/epic/chat-replica-read";
import type { CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { ActiveTabBody } from "@/components/epic-canvas/canvas/tab-group-view";
import type { ChatDeadTileBannerReason } from "@/components/epic-canvas/renderers/dead-tile-banner";
import { resetChatRemoteDeletionRegistryForTesting } from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import type { CloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const CHAT: EpicCanvasTileRef = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat",
  name: "Chat",
  hostId: "host-A",
};

interface TestState {
  /** The Epic session's host - "same host" below means this one. */
  sessionHostId: string;
  /** Hosts `useHostReachability` answers `unreachable` for. */
  readonly unreachableHostIds: Set<string>;
  /** Artifact ids `useEpicArtifact` answers `null` for (swept locally). */
  readonly missingArtifactIds: Set<string>;
  /** Chat ids the cloud list carries as the viewer's own. */
  readonly cloudKnownChatIds: Set<string>;
}

const testState = vi.hoisted((): TestState => ({
  sessionHostId: "host-B",
  unreachableHostIds: new Set(),
  missingArtifactIds: new Set(),
  cloudKnownChatIds: new Set(),
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicArtifact: (id: string) =>
    testState.missingArtifactIds.has(id) ? null : { id, userId: "user-1" },
  useEpicChatRetraction: () => null,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useEpicChatRecordListAuthoritative: () => true,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => null,
  useExistingChatSessionFatalClose: () => null,
}));

// Both the canvas (for the bound host) and the copy tile (for the owner host)
// read this - the same host id in the substitution case, so one answer.
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: (hostId: string) => ({
    status: testState.unreachableHostIds.has(hostId)
      ? "unreachable"
      : "reachable",
    hostLabel: hostId,
    unavailability: null,
    basis: "directory",
    hostKind: "unknown",
  }),
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => testState.sessionHostId,
}));

// No hosts in this render: the canvas's cloud list, the tile's cloud read and
// `BrowserSessionsHostBoundary` all resolve a null client.
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatList: (args: { readonly enabled: boolean }) => ({
    data: args.enabled
      ? {
          chats: [...testState.cloudKnownChatIds].map(
            (chatId): CloudChatSummary => ({
              identity: { taskId: "epic-1", chatId, ownerUserId: "user-1" },
              ownerHostId: "host-A",
              createdAt: 1,
              visibility: "task",
              title: null,
              isTitleEditedByUser: false,
              parentChatId: null,
              isArchived: false,
              runSettingsSummary: null,
              metadataUpdatedAt: 1,
              headSha256: null,
              publishedAt: null,
              throughRecordSeq: null,
              isOwnedByViewer: true,
            }),
          ),
        }
      : undefined,
    error: null,
    isEnabled: args.enabled,
    isError: false,
    isSuccess: args.enabled,
    isPending: false,
    isFetching: false,
  }),
}));

// The copy's data: the cloud read settles `unpublished`, the serving host's
// doc replica answers - the same fixture `published-chat-tile.test.tsx` uses
// to reach a rendered transcript without a cloud round-trip.
vi.mock("@/hooks/chats/use-cloud-chat-transcript", () => ({
  useCloudChatTranscript: (): CloudChatTranscriptState => {
    const read: CloudChatRead = {
      chat: null,
      outcome: { kind: "unpublished" },
    };
    return { kind: "refused", read };
  },
}));
vi.mock("@/hooks/chats/use-chat-replica-read", () => ({
  useChatReplicaRead: (): {
    readonly data: ChatReplicaReadResponse;
    readonly isPending: boolean;
    readonly isError: boolean;
  } => ({
    isPending: false,
    isError: false,
    data: {
      outcome: {
        status: "ok",
        chat: {
          chatId: "chat-1",
          title: "Replica title",
          userId: "user-1",
          hostId: "host-A",
          createdAt: 1,
          updatedAt: 2,
        },
        messages: [],
        events: [],
      },
    },
  }),
}));

vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));
vi.mock("@/components/epic-canvas/renderers/published-chat-notice", () => ({
  PublishedChatNotice: () => null,
}));
vi.mock("@/lib/chats/published-chat-source-provider", () => ({
  PublishedChatSourceProvider: (props: { readonly children: ReactNode }) => (
    <>{props.children}</>
  ),
}));

vi.mock("@/components/epic-canvas/renderers/chat-tile", async () => {
  const { ChatDeadTileBanner } = await vi.importActual<
    typeof import("@/components/epic-canvas/renderers/dead-tile-banner")
  >("@/components/epic-canvas/renderers/dead-tile-banner");
  return {
    // Never reached: the substitution replaces the live chat body. Present so
    // the tile renderer's import of it resolves.
    ChatTile: () => null,
    ChatTileSessionView: () => <div data-testid="chat-tile-session-view" />,
    ChatDeadTileBannerContainer: (props: {
      readonly hostLabel: string;
      readonly reason: ChatDeadTileBannerReason;
      readonly showsPublishedCopy: boolean;
      readonly testId: string;
    }) => (
      <ChatDeadTileBanner
        hostLabel={props.hostLabel}
        reason={props.reason}
        ownedByViewer
        cloneAllowed
        showsPublishedCopy={props.showsPublishedCopy}
        onClone={() => undefined}
        cloning={false}
        className={undefined}
        testId={props.testId}
      />
    ),
  };
});

function activeTabBody(): ReactNode {
  return (
    <ActiveTabBody
      activeTab={CHAT}
      epicId="epic-1"
      groupId="group-1"
      tabId="view-tab-1"
      selected
      globallyActive
    />
  );
}

describe("published-copy substitution renders exactly one dead-tile banner", () => {
  afterEach(() => {
    cleanup();
    testState.sessionHostId = "host-B";
    testState.unreachableHostIds.clear();
    testState.missingArtifactIds.clear();
    testState.cloudKnownChatIds.clear();
    resetChatRemoteDeletionRegistryForTesting();
  });

  it("for a cross-host offline owner: the copy tile's banner, and no canvas banner over it", async () => {
    testState.sessionHostId = "host-B";
    testState.unreachableHostIds.add(CHAT.hostId);

    render(activeTabBody());

    await waitFor(() => {
      expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
    });
    // Ablation: restore the copy tile's old "skip when the owner is the
    // serving host" guard, or the canvas's unreachable-host banner, and this
    // reads 2.
    expect(screen.getAllByRole("button", { name: "Clone agent" })).toHaveLength(
      1,
    );
    expect(
      screen.getByTestId(`published-chat-dead-tile-${CHAT.id}`),
    ).not.toBeNull();
    expect(screen.queryByTestId(`chat-dead-tile-${CHAT.id}`)).toBeNull();
    expect(screen.getByText(/Bound host "host-A" is offline/)).not.toBeNull();
  });

  it("for a same-host offline owner with a cloud copy: still one banner", async () => {
    testState.sessionHostId = CHAT.hostId;
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.missingArtifactIds.add(CHAT.id);
    testState.cloudKnownChatIds.add(CHAT.id);

    render(activeTabBody());

    await waitFor(() => {
      expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
    });
    expect(screen.getAllByRole("button", { name: "Clone agent" })).toHaveLength(
      1,
    );
    expect(
      screen.getByTestId(`published-chat-dead-tile-${CHAT.id}`),
    ).not.toBeNull();
    expect(screen.queryByTestId(`chat-dead-tile-${CHAT.id}`)).toBeNull();
  });
});
