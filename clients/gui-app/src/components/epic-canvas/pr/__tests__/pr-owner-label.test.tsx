import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { EpicTreeIndex, EpicTreeNode } from "@/lib/epic-selectors";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrOwnerBadges } from "@/components/epic-canvas/pr/pr-owner-label";

// Typed to the real signature so `mock.calls` destructures as a tuple. An
// untyped `vi.fn()` hands back `any[]`, which reads fine and asserts nothing.
const openTileInEpic =
  vi.fn<(epicId: string, node: EpicCanvasTileRef) => null>();

/**
 * Parent links the epic tree reports, rewritten per test. Empty means every
 * owner is a root - the flat shape the pre-tree expectations below assume.
 */
let parentByNodeId: Readonly<Record<string, string | null>> = {};

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

/**
 * Owner ids whose node has been DELETED from the epic. The projection no longer
 * holds them, so they resolve to no title - the orphaned-binding case.
 */
let deletedNodeIds: ReadonlySet<string> = new Set<string>();

// Both lookup hooks run unconditionally (rules-of-hooks) with the id gated to
// `null` for the kind that doesn't apply, so each owner resolves through
// exactly one of them. Titled from the id so every chip is distinguishable.
//
// `useEpicAgentNodeIds` and the two lookups are driven by ONE fixture: a real
// projection cannot hold a node in its id list and fail to resolve its title,
// and a mock that let those disagree would test a state the app cannot reach.
vi.mock("@/lib/epic-selectors", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/epic-selectors")>()),
  useChatById: (id: string | null) =>
    id === null || deletedNodeIds.has(id) ? null : { title: `Chat ${id}` },
  useEpicTerminalAgent: (id: string | null) =>
    id === null || deletedNodeIds.has(id) ? null : { title: `Agent ${id}` },
  useEpicNodeHostId: () => "host-1",
  useEpicTreeIndex: () => {
    treeIndexReads += 1;
    return treeIndexFromParents();
  },
  useEpicAgentNodeIds: () => presentNodeIds,
}));

/**
 * How many times the agent tree was subscribed to. A collapsed `+N` chip must
 * not read it at all - see the deferred-subscription test.
 */
let treeIndexReads = 0;

/**
 * Every id the tests hand out, minus the deleted ones. Broad on purpose: the
 * component filters by membership, so the set only has to CONTAIN the owners a
 * test renders.
 */
let presentNodeIds: readonly string[] = [];

function seedPresentNodeIds(owners: readonly PrOwnerRef[]): void {
  presentNodeIds = owners
    .map((owner) => owner.ownerId)
    .filter((id) => !deletedNodeIds.has(id))
    .sort();
}

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTileInEpic }),
}));

// A session HANDLE has to exist for `EpicSessionGate` to render the owner row
// at all - the projection hooks above are mocked, but the gate reads the raw
// context. Only its presence matters here; every projection read this component
// makes is intercepted above, so the handle is never dereferenced.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: "epic-1" }),
}));

function chatOwners(count: number): readonly PrOwnerRef[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ownerId: `chat-${index + 1}`,
    ownerKind: "chat" as const,
  }));
}

function terminalAgentOwners(count: number): readonly PrOwnerRef[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ownerId: `agent-${index + 1}`,
    ownerKind: "terminal-agent" as const,
  }));
}

function renderBadges(owners: readonly PrOwnerRef[]) {
  seedPresentNodeIds(owners);
  return render(
    <TooltipProvider>
      <PrOwnerBadges
        owners={owners}
        epicId="epic-1"
        fallbackHostId="host-1"
        className={undefined}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  openTileInEpic.mockReset();
  parentByNodeId = {};
  deletedNodeIds = new Set<string>();
  presentNodeIds = [];
  treeIndexReads = 0;
});

/**
 * The popover row for an owner, by the label `useChatById` is mocked to give.
 * Scoped to the list: an inline badge carries the same `Open <title>` name, so
 * an unscoped query matches twice for any owner that is also a visible chip.
 */
function ownerRow(ownerId: string): HTMLElement {
  return within(screen.getByTestId("pr-owner-overflow-list")).getByLabelText(
    `Open Chat ${ownerId}`,
  );
}

describe("PrOwnerBadges overflow", () => {
  it("renders every owner inline while the set is small", () => {
    renderBadges(chatOwners(3));

    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(3);
    expect(screen.queryByTestId("pr-owner-overflow")).toBeNull();
  });

  it("does not collapse a single overflowing chip behind an equally wide +1", () => {
    renderBadges(chatOwners(4));

    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(4);
    expect(screen.queryByTestId("pr-owner-overflow")).toBeNull();
  });

  // The reported bug: a large epic wrapped this row into tens of lines.
  it("caps the inline chips and counts the rest once the set is large", () => {
    renderBadges(chatOwners(12));

    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(3);
    expect(screen.getByTestId("pr-owner-overflow").textContent).toBe("+9");
  });

  it("keeps the row to a bounded number of chips however many owners there are", () => {
    renderBadges(chatOwners(60));

    // The whole point: chip count must not grow with the epic.
    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(3);
    expect(screen.getByTestId("pr-owner-overflow").textContent).toBe("+57");
  });

  it("lists every owner in the overflow, not just the hidden tail", () => {
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    // All 12, so a reader who opened the overflow looking for a specific chat
    // does not have to also scan the chips behind it.
    expect(screen.getAllByTestId("pr-owner-row")).toHaveLength(12);
  });

  it("opens the owner's own tile from an overflow row", () => {
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));
    fireEvent.click(screen.getByLabelText("Open Chat chat-12"));

    expect(openTileInEpic).toHaveBeenCalledTimes(1);
    const [epicId, ref] = openTileInEpic.mock.calls[0];
    expect(epicId).toBe("epic-1");
    expect(ref.id).toBe("chat-12");
    expect(ref.type).toBe("chat");
  });

  it("names the overflow chip by the full owner count for assistive tech", () => {
    renderBadges(chatOwners(12));

    // "+9" alone does not say what it is or how many there are in total.
    expect(screen.getByLabelText("Show all 12 chats")).toBeTruthy();
  });

  it("uses 'terminal agents' for an overflow chip's name and heading when every owner is a terminal agent", () => {
    renderBadges(terminalAgentOwners(12));

    expect(screen.getByLabelText("Show all 12 terminal agents")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));
    expect(screen.getByText("Terminal agents this PR came from")).toBeTruthy();
  });

  it("falls back to the kind-neutral 'owners' for a mixed chat/terminal-agent set", () => {
    renderBadges([...chatOwners(6), ...terminalAgentOwners(6)]);

    expect(screen.getByLabelText("Show all 12 owners")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));
    expect(screen.getByText("Owners this PR came from")).toBeTruthy();
  });
});

/**
 * Worktree bindings cascade on epic delete but not on chat delete, so a PR
 * keeps naming owners whose chat is gone. They used to render as bare "Removed
 * chat" text in a row of pills - no title, no tile, nothing to click.
 */
describe("PrOwnerBadges deleted owners", () => {
  it("renders nothing for an owner whose chat has been deleted", () => {
    deletedNodeIds = new Set(["chat-2"]);
    renderBadges(chatOwners(3));

    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(2);
    expect(screen.queryByText("Removed chat")).toBeNull();
  });

  it("counts only surviving owners in the +N chip and its accessible name", () => {
    deletedNodeIds = new Set(["chat-4", "chat-9"]);
    renderBadges(chatOwners(12));

    // 12 owners, 2 deleted: the chip must promise the 10 the popover can list,
    // not the 12 the host still has bindings for.
    expect(screen.getByTestId("pr-owner-overflow").textContent).toBe("+7");
    expect(screen.getByLabelText("Show all 10 chats")).toBeTruthy();
  });

  it("keeps the visible chips full when an early owner is deleted", () => {
    // Without upstream filtering, slicing the first three off the RAW list
    // would render two chips and a hole where chat-1 used to be.
    deletedNodeIds = new Set(["chat-1"]);
    renderBadges(chatOwners(12));

    expect(screen.getAllByTestId("pr-owner-badge")).toHaveLength(3);
    expect(screen.getByLabelText("Open Chat chat-4")).toBeTruthy();
  });

  it("omits deleted owners from the overflow list too", () => {
    deletedNodeIds = new Set(["chat-5"]);
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(screen.getAllByTestId("pr-owner-row")).toHaveLength(11);
    expect(screen.queryByText("Removed chat")).toBeNull();
  });

  it("renders nothing at all when every owner has been deleted", () => {
    deletedNodeIds = new Set(["chat-1", "chat-2", "chat-3"]);
    renderBadges(chatOwners(3));

    expect(screen.queryByTestId("pr-owner-badges")).toBeNull();
  });

  it("re-parents a survivor whose own parent was deleted", () => {
    // The lineage's root is gone, so its children cannot nest under a row that
    // is not there - they become roots rather than vanishing with it.
    deletedNodeIds = new Set(["chat-1"]);
    parentByNodeId = {
      "chat-1": null,
      "chat-2": "chat-1",
      "chat-3": "chat-2",
    };
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(ownerRow("chat-2").style.paddingLeft).toBe("8px");
    expect(ownerRow("chat-3").style.paddingLeft).toBe("24px");
  });
});

/**
 * The reported bug: a PR derived from a chat AND the sub-agents it spawned
 * listed them flat, and since a spawned agent inherits its parent's title the
 * popover read as the same chat repeated once per child.
 *
 * Indent values are the sidebar's own arithmetic (`BASE_PAD_LEFT` 8 +
 * `INDENT_PX` 16 per level), asserted as literals so a change to either
 * constant has to be a deliberate change to this expectation too.
 */
describe("PrOwnerBadges overflow hierarchy", () => {
  /**
   * The forest is only ever LOOKED at through an open popover, but the tree it
   * is built from churns on every rename, reparent and agent create/delete.
   * Subscribing from the collapsed chip would put that rebuild on every `+N`
   * on the surface - once per PR row - for a list nobody has asked to see.
   */
  it("does not read the agent tree until the overflow is opened", () => {
    parentByNodeId = { "chat-1": null, "chat-2": "chat-1" };
    renderBadges(chatOwners(12));

    expect(screen.getByTestId("pr-owner-overflow")).not.toBeNull();
    expect(treeIndexReads).toBe(0);

    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    // Read once the reader asks for it, and the nesting still arrives.
    expect(treeIndexReads).toBeGreaterThan(0);
    expect(ownerRow("chat-2").style.paddingLeft).toBe("24px");
  });

  it("nests a spawned sub-agent under the owner it was spawned from", () => {
    parentByNodeId = {
      "chat-1": null,
      "chat-2": "chat-1",
      "chat-3": "chat-2",
      "chat-4": null,
    };
    // chats 5-12 have no tree node at all - a deleted node is a root too.
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(ownerRow("chat-1").style.paddingLeft).toBe("8px");
    expect(ownerRow("chat-2").style.paddingLeft).toBe("24px");
    expect(ownerRow("chat-3").style.paddingLeft).toBe("40px");
    // Its own root, not a child of the lineage it happens to follow.
    expect(ownerRow("chat-4").style.paddingLeft).toBe("8px");
    // One nested `<ul>` per level that actually has children.
    expect(
      document.querySelectorAll('[data-testid="pr-owner-child-group"]'),
    ).toHaveLength(2);
  });

  /**
   * `role="tree"` advertises a composite widget - roving focus, arrow-key
   * navigation, selection - and this list implements none of it: the rows are
   * plain buttons and the forest never collapses. Nesting is carried by the
   * `<ul>`/`<li>` structure instead, so the announced interaction cannot
   * promise more than the markup delivers.
   */
  it("announces a plain nested list rather than an unimplemented tree widget", () => {
    parentByNodeId = { "chat-1": null, "chat-2": "chat-1" };
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
    const list = screen.getByTestId("pr-owner-overflow-list");
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("aria-label")).toBe("Chats this PR came from");
    // The nesting itself survives the role removal.
    expect(
      list.querySelectorAll('[data-testid="pr-owner-child-group"]'),
    ).toHaveLength(1);
  });

  /**
   * jsdom has no layout engine, so this pins the CLASS CONTRACT the scrolling
   * depends on rather than observing a scroll. The original bug was a
   * `ScrollArea` under a `max-h` with no definite height, whose viewport
   * resolved to `auto` - it never scrolled and the rows painted outside the
   * popover.
   */
  it("caps the popover against measured space and viewport, never a fixed rem", () => {
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    const list = screen.getByTestId("pr-owner-overflow-list");
    // The list is the scroller, and may shrink under its content so a cap bites.
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("min-h-0");

    const content = list.parentElement;
    expect(content).not.toBeNull();
    // Without this the rows paint straight past the popover's own box.
    expect(content?.className).toContain("overflow-hidden");
    const heightCap = /max-h-\[[^\]]*\]/.exec(content?.className ?? "")?.[0];
    expect(heightCap).toBeDefined();
    expect(heightCap).toContain("--radix-popover-content-available-height");
    // A fixed rem would hold a long list to the same few rows on a display with
    // room for twice as many - layout surfaces here size fluidly.
    expect(heightCap).toContain("vh");
    expect(heightCap).not.toContain("rem");
  });

  /**
   * Same jsdom caveat as the height cap above: this pins the class contract, not
   * an observed layout. The width used to be SET (`w-[min(80vw,20rem)]`), so a
   * two-row list painted a mostly-empty column and a deep lineage - whose indent
   * eats the title column that IS the reason to open this list - got no more
   * room on a display with plenty. It is now sized by content and only capped.
   */
  it("sizes the popover to its content and caps the width rather than setting it", () => {
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    const content = screen.getByTestId("pr-owner-overflow-list").parentElement;
    expect(content).not.toBeNull();
    const className = content?.className ?? "";
    // Content-sized, not a fixed column: no `w-<size>` utility survives.
    expect(className).toContain("w-max");
    expect(/(?:^|\s)w-(?!max\b)[^\s]+/.test(className)).toBe(false);

    const widthCap = /max-w-\[[^\]]*\]/.exec(className)?.[0];
    expect(widthCap).toBeDefined();
    // Never wider than the space Radix measured, nor than the viewport - and
    // each var needs a fallback, since an unmeasured one invalidates `min()`
    // and drops the cap entirely.
    expect(widthCap).toContain(
      "var(--radix-popover-content-available-width,100vw)",
    );
    expect(widthCap).toContain("vw");
  });

  it("lists every owner exactly once however the tree nests them", () => {
    parentByNodeId = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, index) => [
        `chat-${index + 1}`,
        index === 0 ? null : `chat-${index}`,
      ]),
    );
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(screen.getAllByTestId("pr-owner-row")).toHaveLength(12);
  });

  it("stops indenting past the popover's depth cap so a deep row keeps its title", () => {
    parentByNodeId = Object.fromEntries(
      Array.from({ length: 12 }, (_unused, index) => [
        `chat-${index + 1}`,
        index === 0 ? null : `chat-${index}`,
      ]),
    );
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    // Depth 5 is the cap: 5 * 16 + 8. Everything deeper shares that column.
    expect(ownerRow("chat-6").style.paddingLeft).toBe("88px");
    expect(ownerRow("chat-12").style.paddingLeft).toBe("88px");
  });

  it("keeps an owner at the top level when its parent is not itself an owner", () => {
    // `chat-2`'s parent is a chat the PR did NOT come from - promoting it to a
    // root beats inventing a row for a chat that is not in the set.
    parentByNodeId = {
      "chat-1": null,
      "chat-2": "chat-outside-the-set",
      "chat-outside-the-set": null,
    };
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(ownerRow("chat-2").style.paddingLeft).toBe("8px");
    expect(
      screen.queryByLabelText("Open Chat chat-outside-the-set"),
    ).toBeNull();
  });

  it("still lists every owner when the tree holds a parent cycle", () => {
    // Concurrent reparents on two peers can leave a cycle in the CRDT tree.
    // Neither member is reachable from a root, so a naive walk drops both.
    parentByNodeId = { "chat-1": "chat-2", "chat-2": "chat-1" };
    renderBadges(chatOwners(12));
    fireEvent.click(screen.getByTestId("pr-owner-overflow"));

    expect(screen.getAllByTestId("pr-owner-row")).toHaveLength(12);
    expect(ownerRow("chat-1")).toBeTruthy();
    expect(ownerRow("chat-2")).toBeTruthy();
  });
});
