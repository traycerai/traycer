import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrOwnerBadges } from "@/components/epic-canvas/pr/pr-owner-label";

// Typed to the real signature so `mock.calls` destructures as a tuple. An
// untyped `vi.fn()` hands back `any[]`, which reads fine and asserts nothing.
const openTileInEpic =
  vi.fn<(epicId: string, node: EpicCanvasTileRef) => null>();

// Both lookup hooks run unconditionally (rules-of-hooks) with the id gated to
// `null` for the kind that doesn't apply, so each owner resolves through
// exactly one of them. Titled from the id so every chip is distinguishable.
vi.mock("@/lib/epic-selectors", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/epic-selectors")>()),
  useChatById: (id: string | null) =>
    id === null ? null : { title: `Chat ${id}` },
  useEpicTerminalAgent: (id: string | null) =>
    id === null ? null : { title: `Agent ${id}` },
  useEpicNodeHostId: () => "host-1",
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTileInEpic }),
}));

function chatOwners(count: number): readonly PrOwnerRef[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ownerId: `chat-${index + 1}`,
    ownerKind: "chat" as const,
  }));
}

function renderBadges(owners: readonly PrOwnerRef[]) {
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
});

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
});
