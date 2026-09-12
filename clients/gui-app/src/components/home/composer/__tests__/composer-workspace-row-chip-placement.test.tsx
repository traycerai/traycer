import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import { ChatDockWorkspaceControls } from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The chat's bottom strip, rendered through the component the tile actually
 * mounts: `ChatDockWorkspaceControls` composes the picker and the chips, and
 * `ComposerWorkspaceRow` lays the two cells out.
 *
 * The order of those two children is the whole of the user-facing fix - chips
 * at the tail so the pickers keep their left edge whether or not a chip is
 * there - so it is asserted against the production component. Swapping them
 * there fails this suite.
 */
function renderRow(working: boolean) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactStripProvider
        value={{
          chips: [
            {
              section: "activeAgents",
              glyph: "activeAgents",
              working,
              text: "2",
              lineDeltas: null,
              label: "Active agents. 2 running.",
              pulseToken: null,
            },
          ],
          expanded: new Set(),
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

  it("puts the compact strip last in the left cell, after the picker", () => {
    renderRow(false);

    const picker = screen.getByTestId("picker-stub");
    const strip = screen.getByTestId("chat-dock-compact-strip");
    const cell = picker.parentElement;

    expect(cell).not.toBeNull();
    expect(strip.parentElement).toBe(cell);
    expect(cell?.lastElementChild).toBe(strip);
    expect(strip.previousElementSibling).toBe(picker);
  });

  it("keeps the left cell ahead of the context-usage cluster", () => {
    renderRow(false);

    const strip = screen.getByTestId("chat-dock-compact-strip");
    const usage = screen.getByTestId("usage-chip-stub");

    expect(
      strip.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The usage cluster is a direct child of the grid row, not of the cell the
    // chips live in - the pinned breakdown spans the row, so it has to be.
    expect(usage.parentElement).toBe(strip.parentElement?.parentElement);
  });

  // A running chip is `[icon] N` at EVERY width. It used to print the word for
  // its state too, folded away on a container query against this row, and the
  // width that query measured was the whole of whether the word ever appeared.
  // Nothing in the strip is width-conditional now, so the row's own width can
  // no longer change what a chip says - which is the property worth pinning
  // here, in the ancestor chain the two components form.
  it("draws the running chip the same at every composer width", () => {
    renderRow(true);

    const chip = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(chip.textContent).toBe("2");
    expect(chip.querySelector("[data-chip-working-word]")).toBeNull();
    expect(chip.querySelector("[data-chip-glyph-shimmer]")).not.toBeNull();

    const strip = screen.getByTestId("chat-dock-compact-strip");
    for (const element of [strip, ...strip.querySelectorAll("*")]) {
      expect(element.getAttribute("class") ?? "").not.toMatch(/@(min|max)-/);
    }
  });

  // The chips exist only while the chat has something to say, so their cell
  // must cost nothing when it has nothing: a null strip creates no flex item
  // and therefore no phantom gap ahead of the picker.
  it("renders no strip node at all with no chips", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <ChatDockCompactStripProvider
          value={{ chips: [], expanded: new Set(), onToggle: vi.fn() }}
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

    expect(screen.queryByTestId("chat-dock-compact-strip")).toBeNull();
    const picker = screen.getByTestId("picker-stub");
    expect(picker.parentElement?.childElementCount).toBe(1);
  });
});
