import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const navigation = vi.hoisted(() => ({ openTile: vi.fn() }));
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
});
