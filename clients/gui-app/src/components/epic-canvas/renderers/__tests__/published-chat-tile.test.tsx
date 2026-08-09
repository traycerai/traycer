import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import type { ChatReplicaReadResponse } from "@traycer/protocol/host/epic/chat-replica-read";
import { TILE_KIND_PUBLISHED_CHAT } from "@/stores/epics/canvas/tile-kinds";
import type { PublishedChatTileRef } from "@/stores/epics/canvas/types";
import type { CloudChatTranscriptState } from "@/lib/chats/cloud-chat-transcript-state";
import { PublishedChatTile } from "@/components/epic-canvas/renderers/published-chat-tile";

// A narrow stand-in for `UseQueryResult`, not the real thing: the tile only
// ever reads `.data` off this query, and hand-building a whole `UseQueryResult`
// (twenty-odd required fields, most meaningless for a synchronous mock) would
// buy nothing but cast noise. Same convention as
// `use-epic-collaborators-query.test.tsx`'s `MockQueryResult` - mock at the
// hook boundary with only the fields the component under test actually uses.
interface MockReplicaQueryResult {
  readonly data: ChatReplicaReadResponse | undefined;
}

const mockUseCloudChatTranscript = vi.fn<() => CloudChatTranscriptState>();
const mockUseChatReplicaRead =
  vi.fn<(args: { readonly enabled: boolean }) => MockReplicaQueryResult>();

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "unreachable",
    hostLabel: "Ada's Mac",
  }),
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
  PublishedChatNotice: () => <div data-testid="published-chat-notice" />,
}));
vi.mock("@/lib/chats/published-chat-source", () => ({
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

function replicaAbsent(): MockReplicaQueryResult {
  return { data: { outcome: { status: "absent" } } };
}

function replicaNotFetched(): MockReplicaQueryResult {
  return { data: undefined };
}

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
});
