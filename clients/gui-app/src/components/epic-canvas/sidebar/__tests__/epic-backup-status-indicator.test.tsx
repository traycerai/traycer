import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBackupStatusResponse } from "@traycer/protocol/host/epic/chat-backup-status";
import { EpicBackupStatusIndicator } from "../epic-backup-status-indicator";

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
vi.mock("@/lib/relative-time", () => ({
  useRelativeTimestamp: () => "5m ago",
}));

describe("<EpicBackupStatusIndicator />", () => {
  beforeEach(() => {
    mocks.data = undefined;
    mocks.ready = true;
    mocks.bound = true;
  });

  afterEach(cleanup);

  it("stays silent when every chat is backed up", () => {
    mocks.data = {
      chats: [statusRow({ status: "current" })],
    };
    render(<EpicBackupStatusIndicator epicId="epic-a" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the number behind and when backup last advanced", () => {
    mocks.data = {
      chats: [
        statusRow({ chatId: "chat-a", publishedSeq: 2 }),
        statusRow({ chatId: "chat-b", publishedSeq: 1 }),
      ],
    };
    render(<EpicBackupStatusIndicator epicId="epic-a" />);

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
    render(<EpicBackupStatusIndicator epicId="epic-a" />);

    expect(screen.getByRole("status").textContent).toContain(
      "Backup paused on a fork decision",
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
    render(<EpicBackupStatusIndicator epicId="epic-a" />);

    expect(screen.getByRole("status").textContent).toBe(
      "Backup paused by plan",
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
    render(<EpicBackupStatusIndicator epicId="epic-a" />);
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
    render(<EpicBackupStatusIndicator epicId="epic-a" />);

    expect(screen.getByRole("status").textContent).toBe(
      "Backup paused on a fork decision",
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
    render(<EpicBackupStatusIndicator epicId="epic-a" />);

    expect(screen.getByRole("status").textContent).toBe("Backup failing");
  });

  it("does not duplicate the app's offline state", () => {
    mocks.ready = false;
    mocks.data = { chats: [statusRow({})] };
    render(<EpicBackupStatusIndicator epicId="epic-a" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays silent when mounted before the host runtime is bound", () => {
    mocks.bound = false;
    mocks.ready = false;
    mocks.data = { chats: [statusRow({})] };
    render(<EpicBackupStatusIndicator epicId="epic-a" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

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
