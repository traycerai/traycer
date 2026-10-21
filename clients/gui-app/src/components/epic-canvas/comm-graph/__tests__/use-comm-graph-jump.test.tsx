import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { CommGraphAgentDetailSurface } from "@/components/epic-canvas/comm-graph/comm-graph-agent-detail-surface";
import { useCommGraphJump } from "@/components/epic-canvas/comm-graph/use-comm-graph-jump";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";

/**
 * A mutable directory with the surface the jump hook reads: `findById` answers
 * from whatever the entry is NOW, and `onChange` tells subscribers it moved.
 */
const hostDirectory = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const entries = new Map<string, HostDirectoryEntry>();
  return {
    entries,
    findById: (hostId: string): HostDirectoryEntry | null =>
      entries.get(hostId) ?? null,
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostDirectory: () => hostDirectory,
}));

// One object for the whole file: the real hook memoizes its `openTile`, so the
// jump callbacks only change identity when the hook's own inputs do.
const tileNavigation = vi.hoisted(() => ({ openTile: () => null }));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigation,
}));

function localHost(
  transportDialability: HostDirectoryEntry["transportDialability"],
): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "host-a",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/stream",
    version: "1.0.0",
    transportDialability,
  };
}

function agent(id: string, name: string): CommGraphAgentNode {
  return {
    id,
    kind: "chat",
    name,
    hostId: "host-a",
    parentId: null,
    harnessId: null,
    model: null,
    archived: false,
    archivedAt: null,
    createdAt: 0,
  };
}

const AGENTS = [agent("a", "Orchestrator"), agent("b", "Reviewer")];
const EVENTS: ReadonlyArray<CommGraphEvent> = [
  {
    id: 1,
    timestamp: 10,
    hostId: "host-a",
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hello",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    peerEpicId: null,
  },
];

const AGENT_NAMES: ReadonlyMap<string, string> = new Map(
  AGENTS.map((node) => [node.id, node.name]),
);

// Stable, as the compiled graph tile hands them down: a fresh callback per
// render would re-render the surface for a reason the app never has.
function ignoreOpenAgent(): void {}
function ignoreClose(): void {}

/** The hook feeding the agent detail surface, as the graph tile wires them. */
function JumpSurface() {
  const jump = useCommGraphJump("epic-1", AGENTS, EVENTS);
  return (
    <CommGraphAgentDetailSurface
      agentId="a"
      agents={AGENTS}
      agentNames={AGENT_NAMES}
      events={EVENTS}
      epicId="epic-1"
      initialHistoryCaughtUp
      canOpenAgentForEvent={jump.canOpenAgentForEvent}
      canJump={jump.canJump}
      onJump={jump.jump}
      canJumpToSender={jump.canJumpToSender}
      onJumpToSender={jump.jumpToSender}
      canJumpToCreated={jump.canJumpToCreated}
      onJumpToCreated={jump.jumpToCreated}
      onOpenAgent={ignoreOpenAgent}
      onClose={ignoreClose}
    />
  );
}

afterEach(() => {
  cleanup();
  hostDirectory.entries.clear();
});

describe("useCommGraphJump", () => {
  // The jump callbacks kept their identity when the directory moved, so the
  // compiled surface skipped the panel and the row's endpoints stayed
  // open-agent buttons after the host went offline.
  it("drops a row's open-agent links when its host goes offline", () => {
    hostDirectory.entries.set("host-a", localHost("dialable"));
    render(<JumpSurface />);
    expect(screen.getByRole("button", { name: "Open Reviewer" })).toBeTruthy();

    act(() => {
      hostDirectory.entries.set("host-a", localHost("not-dialable"));
      hostDirectory.emit();
    });

    expect(screen.queryByRole("button", { name: "Open Reviewer" })).toBe(null);
  });
});
