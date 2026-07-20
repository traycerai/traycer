import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HOVER_PREVIEW_SURFACE_CLASS } from "@/components/ui/hover-preview-surface";

afterEach(cleanup);

describe("hover-preview surface", () => {
  it("renders the HoverCard preview as a popover card, not the inverted label chip", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Trigger</button>
        </HoverCardTrigger>
        <HoverCardContent side="bottom">
          <span data-testid="hover-body">Body</span>
        </HoverCardContent>
      </HoverCard>,
    );
    const content = document.querySelector<HTMLElement>(
      '[data-slot="hover-card-content"]',
    );
    if (content === null) throw new Error("Hover card content did not render");
    const tokens = content.className.split(/\s+/);
    // The workspace and chat/owner hover previews must read as the same card
    // as the composer's @mention preview panel - one shared surface, so the
    // hover-card styles cannot drift apart from it again.
    HOVER_PREVIEW_SURFACE_CLASS.split(/\s+/).forEach((expected) => {
      expect(tokens).toContain(expected);
    });
    expect(tokens).not.toContain("bg-foreground");
    expect(tokens).not.toContain("text-background");
    expect(screen.getByTestId("hover-body")).toBeTruthy();
  });

  it("renders HoverCard content without a visually-hidden accessible clone, so a focusable action is not duplicated", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Trigger</button>
        </HoverCardTrigger>
        <HoverCardContent side="bottom">
          <button type="button" data-testid="hover-action">
            Copy
          </button>
        </HoverCardContent>
      </HoverCard>,
    );
    // A Radix Tooltip mounts a hidden a11y clone of its children (two copies);
    // HoverCard does not - the single copy is why a copy-path button lives
    // safely on this surface but not on a Tooltip.
    expect(screen.getAllByTestId("hover-action")).toHaveLength(1);
  });

  it("keeps label tooltips on the bounded inverted chip surface", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button type="button">Trigger</button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span>Copy</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const content = document.querySelector<HTMLElement>(
      '[data-slot="tooltip-content"]',
    );
    if (content === null) throw new Error("Tooltip content did not render");
    const tokens = content.className.split(/\s+/);
    expect(tokens).toContain("bg-foreground");
    expect(tokens).toContain("text-background");
    expect(tokens).toContain("max-w-xs");
    expect(tokens).toContain("[overflow-wrap:anywhere]");
    expect(tokens).not.toContain("bg-popover");
    expect(document.querySelector(".fill-foreground")).not.toBeNull();
  });
});
