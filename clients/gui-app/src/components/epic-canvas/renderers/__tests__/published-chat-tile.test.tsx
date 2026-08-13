import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import type { ChatReplicaReadResponse } from "@traycer/protocol/host/epic/chat-replica-read";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { TILE_KIND_PUBLISHED_CHAT } from "@/stores/epics/canvas/tile-kinds";
import type { PublishedChatTileRef } from "@/stores/epics/canvas/types";
import type { CloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";
import type { ChatDeadTileBannerReason } from "@/components/epic-canvas/renderers/dead-tile-banner";
import { PublishedChatTile } from "@/components/epic-canvas/renderers/published-chat-tile";

// A narrow stand-in for `UseQueryResult`, not the real thing: the tile only
// ever reads `.data` and `.isPending` off this query, and hand-building a
// whole `UseQueryResult` (twenty-odd required fields, most meaningless for a
// synchronous mock) would buy nothing but cast noise. Same convention as
// `use-epic-collaborators-query.test.tsx`'s `MockQueryResult` - mock at the
// hook boundary with only the fields the component under test actually uses.
interface MockReplicaQueryResult {
  readonly data: ChatReplicaReadResponse | undefined;
  readonly isPending: boolean;
  /** Absent on the happy paths, like the real result's `false`. */
  readonly isError?: boolean;
  readonly error?: HostRpcError;
}

interface MockHostReachability {
  readonly status: "reachable" | "unreachable";
  readonly hostLabel: string;
}

/**
 * The props the tile handed `ChatDeadTileBannerContainer`, per mount. The
 * container's own hook wiring (clone offer, owner lookup) is `chat-tile`'s
 * unit; what THIS suite owns is which props the copy's tile threads into it -
 * in particular that the ref's `ownerUserId` rides along instead of being
 * re-resolved from the cloud list.
 */
interface DeadTileBannerContainerProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  readonly hostLabel: string;
  readonly reason: ChatDeadTileBannerReason;
  readonly testId: string;
  readonly sourceOwnerUserId?: string;
}

const deadTileBannerContainerProps: DeadTileBannerContainerProps[] = [];

const mockUseCloudChatTranscript = vi.fn<() => CloudChatTranscriptState>();
const mockUseChatReplicaRead =
  vi.fn<(args: { readonly enabled: boolean }) => MockReplicaQueryResult>();
const mockUseHostReachability =
  vi.fn<(hostId: string) => MockHostReachability>();

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => mockUseHostReachability(hostId),
}));
vi.mock("@/hooks/chats/use-cloud-chat-transcript", () => ({
  useCloudChatTranscript: () => mockUseCloudChatTranscript(),
}));
vi.mock("@/hooks/chats/use-chat-replica-read", () => ({
  useChatReplicaRead: (args: { readonly enabled: boolean }) =>
    mockUseChatReplicaRead(args),
}));
// The real banner's Report action reaches for app context this suite does
// not mount; the banner around it (message, Clone button) stays real.
vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));
vi.mock("@/components/epic-canvas/renderers/chat-tile", async () => {
  const { ChatDeadTileBanner } = await vi.importActual<
    typeof import("@/components/epic-canvas/renderers/dead-tile-banner")
  >("@/components/epic-canvas/renderers/dead-tile-banner");
  return {
    ChatTileSessionView: (props: {
      readonly readOnlyNotice: string | null;
    }) => (
      <div data-testid="chat-tile-session-view">{props.readOnlyNotice}</div>
    ),
    // Stubbed at the container boundary - the real container runs the clone
    // offer's host-runtime subscription and the owner lookup's cloud query,
    // neither of which this suite mounts providers for. It records the props
    // and renders the REAL `ChatDeadTileBanner`, so the Clone affordance the
    // tests assert on is the genuine article.
    ChatDeadTileBannerContainer: (props: DeadTileBannerContainerProps) => {
      deadTileBannerContainerProps.push(props);
      return (
        <ChatDeadTileBanner
          hostLabel={props.hostLabel}
          reason={props.reason}
          onClone={() => undefined}
          cloning={false}
          className={undefined}
          testId={props.testId}
        />
      );
    },
  };
});
vi.mock("@/components/epic-canvas/renderers/published-chat-notice", () => ({
  // The notice's own copy is its unit's business; what this suite asserts is
  // WHICH state the tile hands it, so the state kind is surfaced as an attribute.
  PublishedChatNotice: (props: {
    readonly state: { readonly kind: string };
  }) => (
    <div
      data-testid="published-chat-notice"
      data-state-kind={props.state.kind}
    />
  ),
}));
vi.mock("@/lib/chats/published-chat-source-provider", () => ({
  PublishedChatSourceProvider: (props: { readonly children: ReactNode }) => (
    <>{props.children}</>
  ),
}));

const NODE: PublishedChatTileRef = {
  id: "published:task-1:user-1:chat-1",
  instanceId: "instance-1",
  type: TILE_KIND_PUBLISHED_CHAT,
  name: "Some agent",
  hostId: "host-1",
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "user-1",
  ownerHostId: "owner-host-1",
};

/**
 * The SAME ref shape the canvas builds when this device's own connected host
 * answers `CHAT_NOT_VISIBLE` for one of its chats (tickets 47/48): the
 * serving host and the owning host are one machine, which is exactly what
 * `hostId === ownerHostId` says. Nothing about it is probed - the copy's
 * footer has to read that off the ref.
 */
const SAME_HOST_NODE: PublishedChatTileRef = {
  ...NODE,
  ownerHostId: NODE.hostId,
};

function refusedUnpublished(): CloudChatTranscriptState {
  const read: CloudChatRead = { chat: null, outcome: { kind: "unpublished" } };
  return { kind: "refused", read };
}

function refusedCorrupt(): CloudChatTranscriptState {
  const read: CloudChatRead = {
    chat: null,
    outcome: {
      kind: "corrupt",
      reason: "head-digest-mismatch",
      message: "This chat could not be verified.",
      diagnostic: "digest mismatch",
    },
  };
  return { kind: "refused", read };
}

function replicaOk(): MockReplicaQueryResult {
  return {
    isPending: false,
    data: {
      outcome: {
        status: "ok",
        chat: {
          chatId: "chat-1",
          title: "Replica title",
          userId: "user-1",
          hostId: "owner-host-1",
          createdAt: 1,
          updatedAt: 2,
        },
        messages: [],
        events: [],
      },
    },
  };
}

/**
 * A replica read whose one message carries a block this build cannot parse -
 * exercises `convertReplicaChat`'s real placeholder-swap path (not mocked
 * here), so `unreadableCount` on the resulting conversion is genuinely `1`,
 * the same way it would be in production.
 */
function replicaOkWithUnreadableBlock(): MockReplicaQueryResult {
  return {
    isPending: false,
    data: {
      outcome: {
        status: "ok",
        chat: {
          chatId: "chat-1",
          title: "Replica title",
          userId: "user-1",
          hostId: "owner-host-1",
          createdAt: 1,
          updatedAt: 2,
        },
        messages: [
          {
            role: "assistant",
            messageId: "m1",
            timestamp: 1,
            turnId: null,
            usage: null,
            sender: {
              type: "agent",
              harnessId: "claude",
              agentId: "a1",
              displayName: null,
              reply: { expectsReply: false },
              inReplyTo: null,
            },
            blocks: [
              {
                blockId: "b1",
                status: "completed",
                timestamp: 1,
                parentBlockId: null,
                // A type outside this build's vocabulary.
                type: "holodeck",
                payload: { deck: 7 },
              },
            ],
          },
        ],
        events: [],
      },
    },
  };
}

function replicaAbsent(): MockReplicaQueryResult {
  return { isPending: false, data: { outcome: { status: "absent" } } };
}

function replicaFailed(code: RpcErrorCode): MockReplicaQueryResult {
  return {
    isPending: false,
    data: undefined,
    isError: true,
    error: new HostRpcError({
      code,
      message: "boom",
      requestId: "r",
      method: "epic.chatReplicaRead",
      fatalDetails: null,
    }),
  };
}

function replicaNotFetched(): MockReplicaQueryResult {
  return { isPending: true, data: undefined };
}

beforeEach(() => {
  mockUseHostReachability.mockReturnValue({
    status: "unreachable",
    hostLabel: "Ada's Mac",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  deadTileBannerContainerProps.length = 0;
});

describe("PublishedChatTile - doc-replica fallback", () => {
  it("renders the transcript with the replica lock reason when the cloud read is unpublished and the replica has content", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    expect(view.textContent).toContain("This agent lives on Ada's Mac");
    expect(view.textContent).toContain("showing this device's synced copy");
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
  });

  it("keeps today's notice when the cloud read is unpublished and the replica has no content", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaAbsent());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-notice")).not.toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
  });

  it('says the replica read FAILED rather than repeating "not published yet"', () => {
    // Retries exhausted, `data` undefined - identical to an absent replica from
    // the notice's point of view, and the difference matters: one means no copy
    // exists, the other means the lookup never completed and is worth retrying.
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaFailed("RPC_ERROR"));

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.getByTestId("published-chat-notice").dataset.stateKind).toBe(
      "failed",
    );
  });

  it("keeps the cloud refusal when the serving host has no replica RPC", () => {
    // An older host did not fail - it has no second source at all, so the
    // cloud's own answer is still the honest one.
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaFailed("E_HOST_UNSUPPORTED"));

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.getByTestId("published-chat-notice").dataset.stateKind).toBe(
      "refused",
    );
  });

  it("does not fall back to the replica for a non-unpublished refusal", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedCorrupt());
    // Even if the replica happened to have content, a corrupt-publication
    // refusal must not be masked by it.
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-notice")).not.toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
  });

  it("never enables the replica query for a non-unpublished refusal", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedCorrupt());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(mockUseChatReplicaRead).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("enables the replica query once the cloud read settles unpublished", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(mockUseChatReplicaRead).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("shows the loading state instead of the notice while the replica read is enabled and still pending", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    // Neither the notice NOR the transcript yet - a stale "not published"
    // flash is exactly the bug this branch exists to prevent.
    expect(screen.queryByTestId("chat-tile-loading")).not.toBeNull();
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
  });

  it("uses the reachable-owner sentence once the owner comes back while the replica view is open", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "reachable",
      hostLabel: "Ada's Mac",
    });

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    // The cloud read can stay `unpublished` forever (a legacy chat, or a
    // server declining this viewer the row) even after the owner is back
    // online, so the lock reason must say so honestly instead of repeating
    // the "which is offline" sentence past the point it stopped being true.
    expect(view.textContent).toContain("not available live from this device");
    expect(view.textContent).not.toContain("which is offline");
  });

  it("drops the other-machine phrasing when the copy's owner IS the serving host", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "reachable",
      hostLabel: "Ada's Mac",
    });

    render(
      <PublishedChatTile
        node={SAME_HOST_NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    // Same state as the test above (reachable owner, synced copy) - only the
    // ref differs, and that alone must move the footer off copy that reads
    // the reader's own machine as somewhere else.
    expect(view.textContent).toContain("no longer on this host");
    expect(view.textContent).not.toContain("lives on");
    expect(view.textContent).not.toContain("from this device");
  });

  it("appends the unreadable-item count to the replica lock reason", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOkWithUnreadableBlock());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    expect(view.textContent).toContain(
      "1 item needs a newer version of Traycer to render",
    );
  });
});

describe("PublishedChatTile - dead-tile clone banner", () => {
  it("mounts the clone banner above the transcript when the owner is unreachable and not this host", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    const banner = screen.getByTestId("published-chat-dead-tile-chat-1");
    expect(banner).not.toBeNull();
    // The genuine Clone affordance, not just the banner chrome.
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    // The banner sits ABOVE the transcript, not under it.
    const view = screen.getByTestId("chat-tile-session-view");
    expect(
      banner.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("threads the ref's owner into the container instead of leaving it to the cloud-list lookup", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(deadTileBannerContainerProps).toHaveLength(1);
    expect(deadTileBannerContainerProps[0]).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      chatId: "chat-1",
      sourceHostId: "owner-host-1",
      hostLabel: "Ada's Mac",
      reason: "host-offline",
      testId: "published-chat-dead-tile-chat-1",
      // Off the ref - a post-restart host with swept registry facts cannot
      // answer the lookup, and the ref knew the owner the whole time.
      sourceOwnerUserId: "user-1",
    });
  });

  it("mounts no banner once the owner is reachable", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "reachable",
      hostLabel: "Ada's Mac",
    });

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
  });

  it("mounts no banner when the copy's owner IS the serving host, even while unreachable", () => {
    // The canvas-substitution case: `tab-group-view` already mounts its own
    // banner above this tile there, so a second one here would double it.
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={SAME_HOST_NODE}
        viewTabId="tab-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
    expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
  });
});
