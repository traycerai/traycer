import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  PrActivitySection,
  PrDetailCore,
  PrOwnerRef,
} from "@traycer/protocol/host/pr-schemas";
import type { PrAttentionQueue } from "@/lib/pr/pr-attention-queue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrDetailCard } from "@/components/epic-canvas/pr/pr-detail-card";

/**
 * The "Chats" section is chrome AROUND the owner badges, so it cannot be gated
 * on the same array they are. A PR keeps naming chats the user deleted
 * (worktree bindings cascade on epic delete, not on chat delete) and the badges
 * drop those - which, gated on the raw array, leaves a bordered heading
 * standing over nothing for exactly the case the dropping exists to clean up.
 */
afterEach(cleanup);

let deletedNodeIds: ReadonlySet<string> = new Set<string>();
let presentNodeIds: readonly string[] = [];

vi.mock("@/lib/epic-selectors", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/epic-selectors")>()),
  useChatById: (id: string | null) =>
    id === null || deletedNodeIds.has(id) ? null : { title: `Chat ${id}` },
  useEpicTerminalAgent: () => null,
  useEpicNodeHostId: () => "host-1",
  useEpicTreeIndex: () => ({ rootIds: [], childrenByParent: {}, nodeById: {} }),
  useEpicAgentNodeIds: () => presentNodeIds,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTileInEpic: vi.fn() }),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));

// The card is a session-bound slot now; the gate reads the raw context, which
// the projection mocks above do not supply.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: "epic-1" }),
}));

function buildPrDetailCore(owners: readonly PrOwnerRef[]): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add feature X",
    body: null,
    author: { login: "octocat", avatarUrl: null },
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: "abc123",
    additions: 10,
    deletions: 2,
    checksRollup: { success: 1, failure: 0, pending: 0, total: 1 },
    reviewDecision: null,
    reviewRequests: [],
    commentCount: 0,
    updatedAt: 1_000,
    mergedAt: null,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [...owners],
  };
}

const ACTIVITY: PrActivitySection = {
  observedAt: 1_000,
  items: [],
  isTruncated: false,
};

const QUEUE: PrAttentionQueue = {
  items: [],
  isWindowTruncated: false,
  checkCounts: { passed: 1, failing: 0, pending: 0, total: 1 },
  reviewDecision: null,
};

function renderCard(owners: readonly PrOwnerRef[], deleted: readonly string[]) {
  deletedNodeIds = new Set(deleted);
  presentNodeIds = owners
    .map((owner) => owner.ownerId)
    .filter((id) => !deletedNodeIds.has(id))
    .sort();
  return render(
    <TooltipProvider>
      <PrDetailCard
        core={buildPrDetailCore(owners)}
        activity={ACTIVITY}
        queue={QUEUE}
        epicId="epic-1"
        notLive={false}
        className={undefined}
      />
    </TooltipProvider>,
  );
}

const OWNERS: readonly PrOwnerRef[] = [
  { ownerId: "chat-1", ownerKind: "chat" },
  { ownerId: "chat-2", ownerKind: "chat" },
];

describe("PrDetailCard chats section", () => {
  it("shows the section while at least one owner survives", () => {
    renderCard(OWNERS, ["chat-2"]);

    expect(screen.getByText("Chats")).toBeTruthy();
    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(1);
  });

  it("drops the whole section when every owner has been deleted", () => {
    renderCard(OWNERS, ["chat-1", "chat-2"]);

    // Not just the badges - the heading would otherwise sit over empty space.
    expect(screen.queryByText("Chats")).toBeNull();
    expect(screen.queryByTestId("pr-owner-badges")).toBeNull();
  });

  it("drops the section for a PR that never had owners", () => {
    renderCard([], []);

    expect(screen.queryByText("Chats")).toBeNull();
  });
});
