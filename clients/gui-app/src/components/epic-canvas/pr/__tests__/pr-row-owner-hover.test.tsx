import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PrLightItem,
  PrOwnerRef,
} from "@traycer/protocol/host/pr-schemas";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { EpicTreeIndex, EpicTreeNode } from "@/lib/epic-selectors";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrRow, type PrRowEntry } from "@/components/epic-canvas/pr/pr-row";
import { prDetailTileId } from "@/lib/pr/pr-detail-tile";

/**
 * Hovering ANY part of a PR row reveals the chats it came from - the row's
 * owner badges are capped at four and truncate each title to a pill, so on the
 * rows where "which conversation produced this?" is hardest they answer least.
 *
 * Renders the real `PrRow`, not the wrapper alone: the two facts worth holding
 * are that the card opens from the row BODY (not from the badge band) and that
 * the row's title tooltip stands down while the card is showing the same title,
 * and neither is observable with the row stubbed out.
 */

const openTileInEpic =
  vi.fn<(epicId: string, node: EpicCanvasTileRef) => null>();

/** Parent links the epic tree reports, rewritten per test. Empty = all roots. */
let parentByNodeId: Readonly<Record<string, string | null>> = {};

/** Owner ids whose node has been DELETED - the orphaned-binding case. */
let deletedNodeIds: ReadonlySet<string> = new Set<string>();

/** Whether the `OpenEpicStore` session handle exists yet. */
let hasSessionHandle = true;

function treeIndexFromParents(): EpicTreeIndex {
  const nodeById: Record<string, EpicTreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const [id, parentId] of Object.entries(parentByNodeId)) {
    nodeById[id] = {
      id,
      parentId,
      title: id,
      type: "chat",
      status: null,
      createdAt: 0,
      updatedAt: 0,
    };
    if (parentId === null) {
      rootIds.push(id);
      continue;
    }
    if (Object.hasOwn(childrenByParent, parentId)) {
      childrenByParent[parentId].push(id);
    } else {
      childrenByParent[parentId] = [id];
    }
  }
  return { rootIds, childrenByParent, nodeById };
}

let presentNodeIds: readonly string[] = [];

// One fixture drives the id list and both title lookups: a real projection
// cannot hold a node in its id list and fail to resolve its title.
vi.mock("@/lib/epic-selectors", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/epic-selectors")>()),
  useChatById: (id: string | null) =>
    id === null || deletedNodeIds.has(id) ? null : { title: `Chat ${id}` },
  useEpicTerminalAgent: (id: string | null) =>
    id === null || deletedNodeIds.has(id) ? null : { title: `Agent ${id}` },
  useEpicNodeHostId: () => "host-1",
  useEpicTreeIndex: () => treeIndexFromParents(),
  useEpicAgentNodeIds: () => presentNodeIds,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTileInEpic }),
}));

// `EpicSessionGate` reads the RAW context, not the mocked projection hooks, so
// the handle's presence is what decides whether the projection is READ at all.
// Whether the card then renders is a second question the mocked lookups answer
// - on a real current host, whether the store-backed chat records have landed.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () =>
    hasSessionHandle ? { epicId: "epic-1" } : null,
}));

// `hover-card.tsx`'s own default.
const OPEN_DELAY_MS = 500;

const TAB_ID = "tab-with-no-canvas";
const PR_TITLE = "feat(host): bounded reap deferrals + registry accounting";

const BASE_ITEM: PrLightItem = {
  githubHost: "github.com",
  base: { owner: "traycerai", repo: "traycer-internal", prNumber: 5273 },
  prUrl: "https://github.com/traycerai/traycer-internal/pull/5273",
  state: "open",
  liveness: "live",
  observedAt: 1_000,
  isDraft: false,
  title: PR_TITLE,
  baseRefName: "development",
  headRefName: "traycer/presentation-viewer-accounting",
  additions: 10,
  deletions: 2,
  checksRollup: null,
  reviewDecision: null,
  commentCount: 0,
  updatedAt: null,
  repoIdentifier: { owner: "traycerai", repo: "traycer-internal" },
  repoRole: "superproject",
  linkGroupKey: null,
  owners: [],
};

// Mutable, unlike the sibling suite's helper: these go into a
// `Partial<PrLightItem>`, whose `owners` the wire schema declares mutable.
function chatOwners(count: number): PrOwnerRef[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ownerId: `chat-${index + 1}`,
    ownerKind: "chat" as const,
  }));
}

function renderRow(overrides: Partial<PrLightItem>): void {
  const item: PrLightItem = { ...BASE_ITEM, ...overrides };
  presentNodeIds = item.owners
    .map((owner) => owner.ownerId)
    .filter((id) => !deletedNodeIds.has(id))
    .sort();
  const entry: PrRowEntry = {
    key: "row",
    item,
    tileId: prDetailTileId({
      hostId: "host-1",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer-internal",
      prNumber: 5273,
    }),
    onOpen: () => {},
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>
        <PrRow entry={entry} epicId="epic-1" tabId={TAB_ID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function rowBody(): HTMLElement {
  return screen.getByTestId("pr-row-main");
}

/** Radix's trigger opens on a TIMER, and skips touch pointers outright. */
function hoverRow(): void {
  fireEvent.pointerEnter(rowBody(), { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2);
  });
}

function hoverCard(): HTMLElement | null {
  return screen.queryByTestId("pr-row-owner-hover");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  openTileInEpic.mockReset();
  parentByNodeId = {};
  deletedNodeIds = new Set<string>();
  presentNodeIds = [];
  hasSessionHandle = true;
});

describe("PrRow owner hover card", () => {
  it("opens from the row body and links every owning chat", () => {
    renderRow({ owners: chatOwners(2) });
    expect(hoverCard()).toBeNull();

    hoverRow();

    const card = hoverCard();
    expect(card).not.toBeNull();
    const list = within(card as HTMLElement).getByTestId(
      "pr-row-owner-hover-list",
    );
    expect(within(list).getByLabelText("Open Chat chat-1")).toBeTruthy();
    expect(within(list).getByLabelText("Open Chat chat-2")).toBeTruthy();
  });

  it("lists owners the badge band cannot fit", () => {
    // Six is past `VISIBLE_PR_OWNER_COUNT` + 1, so the band shows three chips
    // and a `+3`. The card is the whole set with no chip budget at all - the
    // reason to put it on the row rather than on the band.
    renderRow({ owners: chatOwners(6) });

    hoverRow();

    const list = within(hoverCard() as HTMLElement).getByTestId(
      "pr-row-owner-hover-list",
    );
    expect(within(list).getAllByTestId("pr-owner-row")).toHaveLength(6);
  });

  it("nests a chat's sub-agents under it rather than repeating the title", () => {
    parentByNodeId = { "chat-1": null, "chat-2": "chat-1" };
    renderRow({ owners: chatOwners(2) });

    hoverRow();

    const card = hoverCard() as HTMLElement;
    expect(within(card).getAllByTestId("pr-owner-child-group")).toHaveLength(1);
  });

  it("opens the owner's tile and dismisses itself", () => {
    renderRow({ owners: chatOwners(2) });
    hoverRow();
    const list = within(hoverCard() as HTMLElement).getByTestId(
      "pr-row-owner-hover-list",
    );

    fireEvent.click(within(list).getByLabelText("Open Chat chat-2"));

    const [epicId, node] = openTileInEpic.mock.calls[0];
    expect(epicId).toBe("epic-1");
    expect(node.id).toBe("chat-2");
    expect(node.type).toBe("chat");
    expect(node.hostId).toBe("host-1");
    // Left open it would sit over the tile it just opened until the pointer
    // happened to leave the row.
    expect(hoverCard()).toBeNull();
  });

  it("heads the card with the full title and stands the row's tooltip down", () => {
    renderRow({ owners: chatOwners(2) });

    // Stood down for the row's whole LIFETIME, not just while the card is
    // showing: both open at 500ms from the same pointer and the title is the
    // row's largest hover target, so a tooltip that armed itself between hovers
    // would still be the second floating surface this exists to prevent. The
    // three sibling tests below assert the inverse - a row with no card keeps
    // it.
    expect(screen.getByTestId("pr-row-title").dataset.slot).toBeUndefined();

    hoverRow();

    // The row's own title band truncates to one line, so the card heading is
    // the only place the whole title stays legible once the tooltip is gone.
    expect(
      within(hoverCard() as HTMLElement).getByTestId("pr-row-owner-hover-title")
        .textContent,
    ).toBe(PR_TITLE);
  });

  it("leaves an ownerless row with its title tooltip and no card", () => {
    renderRow({ owners: [] });

    hoverRow();

    expect(hoverCard()).toBeNull();
    expect(screen.getByTestId("pr-row-title").dataset.slot).toBe(
      "tooltip-trigger",
    );
  });

  it("has no card while no owner resolves to a node", () => {
    // Two ways to land here, one shape. Owner sets are projected from persisted
    // worktree-binding rows and can OUTLIVE their nodes (the all-deleted case
    // `usePresentPrOwners` exists for); and on a current host the titles come
    // from the store-backed record plane, so a live session that has not yet
    // been served `epic.listChatRecords` resolves none of them either. Both
    // mean the same thing to this surface: no card, tooltip stays.
    deletedNodeIds = new Set(["chat-1", "chat-2"]);
    renderRow({ owners: chatOwners(2) });

    hoverRow();

    expect(hoverCard()).toBeNull();
    expect(screen.getByTestId("pr-row-title").dataset.slot).toBe(
      "tooltip-trigger",
    );
  });

  it("renders the row without a card before the epic session lands", () => {
    // The PR list arrives on its OWN host stream, and `EpicSessionProvider`
    // renders children before it holds a handle - so fully-populated rows paint
    // while the epic store session is still null. Every projection read here
    // would throw; the row must survive that window.
    hasSessionHandle = false;
    renderRow({ owners: chatOwners(2) });

    hoverRow();

    expect(hoverCard()).toBeNull();
    expect(screen.getByTestId("pr-row-title").textContent).toBe(PR_TITLE);
  });
});
