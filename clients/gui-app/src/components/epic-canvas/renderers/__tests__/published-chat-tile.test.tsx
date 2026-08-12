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
vi.mock("@/components/epic-canvas/renderers/chat-tile", () => ({
  ChatTileSessionView: (props: { readonly readOnlyNotice: string | null }) => (
    <div data-testid="chat-tile-session-view">{props.readOnlyNotice}</div>
  ),
}));
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
