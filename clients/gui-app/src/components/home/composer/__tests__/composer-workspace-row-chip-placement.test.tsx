import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import { ChatDockWorkspaceControls } from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The chat's bottom strip, rendered through the component the tile actually
 * mounts.
 *
 * The chips are NOT here any more (A12, L-97). They stand above the composer
 * at its left edge, inside `ChatLowerDock`, where the artifact draws them and
 * where a chip is adjacent to the row it opens. What this suite pins is the
 * negative half of that move: the workspace row is back to the two leaves it
 * names, so a strip mounted beside the picker - the state the move corrects -
 * fails it.
 *
 * The row's `overflow-hidden` is why the move matters beyond looks: it clipped
 * anything a child overhung with, which is what sliced the per-region mark off
 * the chips (C-04) before L-94 deleted that mark outright.
 */
function renderRow() {
  return render(
    <TooltipProvider delay={0}>
      <ChatDockCompactStripProvider
        value={{
          chips: [
            {
              section: "activeAgents",
              glyph: "activeAgents",
              hotspotRef: () => undefined,
              working: false,
              text: "2",
              lineDeltas: null,
              label: "Active agents. 2 running.",
              detail: "2 running",
              pulseToken: null,
            },
          ],
          openSection: null,
          panelId: "dock-panel-1",
          onToggle: vi.fn(),
        }}
      >
        <ComposerWorkspaceRow
          workspaceControls={
            <ChatDockWorkspaceControls
              hostWorkspaceSelector={
                <div data-testid="picker-stub">picker</div>
              }
              usageChip={<div data-testid="usage-chip-stub">usage</div>}
            />
          }
        />
      </ChatDockCompactStripProvider>
    </TooltipProvider>,
  );
}

describe("composer workspace row chip placement", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the picker alone in its cell, ahead of the context-usage cluster", () => {
    renderRow();

    const picker = screen.getByTestId("picker-stub");
    const usage = screen.getByTestId("usage-chip-stub");

    // No compact strip anywhere in the row, and nothing shares the picker's
    // cell, even with chips in context.
    expect(screen.queryByTestId("chat-dock-compact-strip")).toBeNull();
    expect(picker.parentElement?.childElementCount).toBe(1);
    expect(
      picker.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The usage cluster is a direct child of the grid row, not of the cell the
    // picker lives in - the pinned breakdown spans the row, so it has to be.
    expect(usage.parentElement).toBe(picker.parentElement?.parentElement);
  });
});
