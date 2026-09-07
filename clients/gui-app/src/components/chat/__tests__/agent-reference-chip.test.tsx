import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const navigation = vi.hoisted(() => ({
  openTile: vi.fn<(intent: TileOpenIntent) => void>(),
}));
const openRef = vi.hoisted(() => ({
  value: { id: "agent-1", instanceId: "inst-1", type: "chat" },
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: navigation.openTile }),
}));

vi.mock("@/hooks/epic/use-epic-agent-open-ref", () => ({
  useEpicAgentOpenRef: () => () => openRef.value,
}));

vi.mock("@/components/ui/tooltip-wrapper", () => ({
  TooltipWrapper: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => [
    { id: "agent-1", type: "chat", name: "Planner" },
  ],
  useEpicAgentRoleClaimsByAgentId: () => ({}),
  useOpenEpicId: () => "epic-1",
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

import { AgentReferenceChip } from "@/components/chat/agent-reference-chip";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";

afterEach(() => {
  cleanup();
  navigation.openTile.mockClear();
});

describe("agent reference chip", () => {
  it("opens the agent with an explicit gesture", () => {
    render(<AgentReferenceChip agentId="agent-1" display="text" />);

    fireEvent.click(screen.getByRole("button"));

    // A chip is a button: there is no double-click on it to promote a preview,
    // so `single` would leave the tile evictable by the next preview.
    expect(navigation.openTile).toHaveBeenCalledWith(
      expect.objectContaining({
        node: openRef.value,
        target: { epicId: "epic-1" },
        gesture: "explicit",
        dedupe: true,
      }),
    );
  });

  it("opens a middle-click in the background, which only auxclick carries", () => {
    render(<AgentReferenceChip agentId="agent-1" display="text" />);

    // The browser dispatches `auxclick` for the middle button and no `click`,
    // so an onClick-only chip would never see `modifiers.middle`.
    fireEvent(
      screen.getByRole("button"),
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(navigation.openTile.mock.calls[0]?.[0].modifiers?.middle).toBe(true);
  });

  it("leaves a right-click to the context menu", () => {
    render(<AgentReferenceChip agentId="agent-1" display="text" />);

    fireEvent(
      screen.getByRole("button"),
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }),
    );

    expect(navigation.openTile).not.toHaveBeenCalled();
  });
});
