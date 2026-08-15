import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBackupStatusResponse } from "@traycer/protocol/host/epic/chat-backup-status";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { useEpicChatBackupStatus } from "@/components/epic-canvas/panels/epic-chat-backup-status";

const EPIC_ID = "epic-a";
const MINUTE_MS = 60_000;

const mocks = vi.hoisted(() => ({
  data: undefined as ChatBackupStatusResponse | undefined,
  ready: true,
  bound: true,
}));

// The Epic SESSION's host, not the app-wide one: the indicator asks
// `epic.chatBackupStatus` about this Epic's publisher, so a retained tab bound
// to one host must not poll another.
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => (mocks.bound ? "host-session" : null),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : { hostId },
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: mocks.data }),
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ isReady: mocks.ready }),
}));
// Pin only the copy formatter. `useSampledNow` remains real because the
// active/idle classification must still compare against the live clock.
vi.mock("@/lib/relative-time", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relative-time")>()),
  formatRelativeTimestamp: () => "5m ago",
}));
function EpicBackupStatusIndicator(props: { readonly epicId: string }) {
  const status = useEpicChatBackupStatus(props.epicId);
  return status === null ? null : (
    <div role="status" data-severity={status.severity}>
      {status.tooltip}
    </div>
  );
}

describe("useEpicChatBackupStatus", () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.ready = true;
    mocks.bound = true;
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAgentActivity();
  });

  it("stays silent when every chat is backed up", () => {
    mocks.data = {
      chats: [statusRow({ status: "current" })],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the number behind and when backup last advanced", () => {
    mocks.data = {
      chats: [
        statusRow({ chatId: "chat-a", publishedSeq: 2 }),
        statusRow({ chatId: "chat-b", publishedSeq: 1 }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Chat backup behind",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "2 chats not backed up · last backup 5m ago",
    );
  });

  it("names a fork pause instead of reducing it to ordinary lag", () => {
    mocks.data = {
      chats: [
        statusRow({
          halted: { cause: "forked-lineage", since: 3_000 },
        }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Chat backup paused on a fork decision",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "1 chat not backed up",
    );
  });

  it("does not claim a current but paused chat is behind", () => {
    mocks.data = {
      chats: [
        statusRow({
          status: "current",
          halted: { cause: "plan-ineligible", since: 3_000 },
        }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Chat backup paused by plan",
    );
  });

  it("stays silent when local evidence cannot prove publication lag", () => {
    mocks.data = {
      chats: [
        statusRow({
          durableSeq: 3,
          publishedSeq: null,
          status: "unknown",
          lastPublishedAt: null,
        }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows an unknown halted cause without claiming the chat is behind", () => {
    mocks.data = {
      chats: [
        statusRow({
          durableSeq: null,
          publishedSeq: null,
          status: "unknown",
          halted: { cause: "forked-lineage", since: 3_000 },
          lastPublishedAt: null,
        }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Chat backup paused on a fork decision",
    );
  });

  it("prioritizes a failing backup over a simultaneous fork pause", () => {
    mocks.data = {
      chats: [
        statusRow({
          chatId: "chat-fork",
          status: "unknown",
          halted: { cause: "forked-lineage", since: 3_000 },
        }),
        statusRow({
          chatId: "chat-conflict",
          status: "unknown",
          halted: { cause: "conflict", since: 4_000 },
        }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toBe("Chat backup failing");
  });

  it("does not duplicate the app's offline state", () => {
    mocks.ready = false;
    mocks.data = { chats: [statusRow({})] };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays silent when mounted before the host runtime is bound", () => {
    mocks.bound = false;
    mocks.ready = false;
    mocks.data = { chats: [statusRow({})] };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  // ── behind is not one state ──────────────────────────────────────────────

  it("reads a streaming chat's lag as ordinary backup work, not a gap", () => {
    // The live defect: the publisher waits for a chat to quiesce, so a chat the
    // user is watching an agent write is `behind` for the whole turn. That must
    // not present as "not backed up".
    mocks.data = { chats: [statusRow({ chatId: "chat-live" })] };
    publishAgentActivity([
      {
        hostId: "host-session",
        byEpic: {
          [EPIC_ID]: { working: ["chat-live"], turn: ["chat-live"] },
        },
      },
    ]);

    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toBe("Backing up chats");
    expect(screen.getByRole("status").textContent).not.toContain(
      "not backed up",
    );
  });

  it("keeps quiet for a chat that only just stopped, with no live session", () => {
    // After a window reopens there is no working set to read, so the projection
    // timestamp is the only thing separating "quiet for a minute" from "quiet
    // for a day". A minute of quiet is still inside the publisher's debounce.
    registerEpicSession([
      chatProjection("chat-recent", Date.now() - 2 * MINUTE_MS),
    ]);
    mocks.data = { chats: [statusRow({ chatId: "chat-recent" })] };

    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toBe("Backing up chats");
  });

  it("alarms once a behind chat has been idle past the threshold", () => {
    registerEpicSession([
      chatProjection("chat-stale", Date.now() - 90 * MINUTE_MS),
    ]);
    mocks.data = { chats: [statusRow({ chatId: "chat-stale" })] };

    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Chat backup behind",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "1 chat not backed up",
    );
  });

  it("counts only the idle chats, not the ones still being written", () => {
    registerEpicSession([
      chatProjection("chat-live", Date.now()),
      chatProjection("chat-stale", Date.now() - 90 * MINUTE_MS),
    ]);
    mocks.data = {
      chats: [
        statusRow({ chatId: "chat-live" }),
        statusRow({ chatId: "chat-stale" }),
      ],
    };
    publishAgentActivity([
      {
        hostId: "host-session",
        byEpic: { [EPIC_ID]: { working: ["chat-live"], turn: ["chat-live"] } },
      },
    ]);

    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toContain(
      "1 chat not backed up",
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "2 chats not backed up",
    );
  });

  it("keeps alarming for a halted chat the user is actively writing", () => {
    // A halt is not a debounce. The publisher has stopped for this chat, so
    // live activity is no reason to soften the report.
    registerEpicSession([chatProjection("chat-live", Date.now())]);
    mocks.data = {
      chats: [
        statusRow({
          chatId: "chat-live",
          halted: { cause: "conflict", since: 3_000 },
        }),
      ],
    };
    publishAgentActivity([
      {
        hostId: "host-session",
        byEpic: { [EPIC_ID]: { working: ["chat-live"], turn: ["chat-live"] } },
      },
    ]);

    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Chat backup failing",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "1 chat not backed up",
    );
  });

  it("says an oversized halted chat is stopped rather than failing", () => {
    // `too-large` is a BEHIND outcome on the host now - it publishes a bounded
    // prefix. Reaching a halt with this cause means the host could not read the
    // chat's owner from any prefix either, which no retry fixes.
    mocks.data = {
      chats: [
        statusRow({
          status: "unknown",
          halted: { cause: "too-large", since: 3_000 },
        }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId={EPIC_ID} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Chat backup stopped: chat too large",
    );
  });
});

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/**
 * A live epic projection holding `chats`. This is where the indicator reads
 * per-chat last-activity from, so a test that wants a chat to look recently
 * (or anciently) written registers one of these.
 */
function registerEpicSession(chats: readonly ChatProjection[]): void {
  const handle = __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
    createOpenEpicStore({
      epicId: EPIC_ID,
      userId: null,
      streamClientFactory: noopStreamClientFactory,
      onAuthError: null,
    }),
  );
  handle.store.setState({
    chats: {
      allIds: chats.map((chat) => chat.id),
      byId: Object.fromEntries(chats.map((chat) => [chat.id, chat])),
    },
  });
}

function chatProjection(id: string, updatedAt: number): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: updatedAt,
    updatedAt,
    userId: null,
    hostId: "host-session",
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
  };
}

function statusRow(
  overrides: Partial<ChatBackupStatusResponse["chats"][number]>,
): ChatBackupStatusResponse["chats"][number] {
  return {
    chatId: "chat-a",
    durableSeq: 3,
    publishedSeq: 2,
    status: "behind",
    halted: null,
    lastPublishedAt: 1_000,
    ...overrides,
  };
}
