import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HoverCard } from "@/components/ui/hover-card";
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
      <HoverCard
        trigger={<button type="button">Trigger</button>}
        content={<span data-testid="hover-body">Body</span>}
        appearance="preview"
        semantics={{ role: "tooltip" }}
        side="bottom"
        align="start"
        sideOffset={4}
        enabled
        open
        onOpenChange={null}
        testId={null}
        className={null}
      />,
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
      <HoverCard
        trigger={<button type="button">Trigger</button>}
        content={
          <button type="button" data-testid="hover-action">
            Copy
          </button>
        }
        appearance="preview"
        semantics={{ role: "dialog", label: "Copy" }}
        side="bottom"
        align="start"
        sideOffset={4}
        enabled
        open
        onOpenChange={null}
        testId={null}
        className={null}
      />,
    );
    // Base UI's Popup mounts a single copy of its children - a copy-path
    // button lives safely on this surface with no hidden accessible duplicate.
    expect(screen.getAllByTestId("hover-action")).toHaveLength(1);
  });

  it("renders the appearance='tooltip' HoverCard variant on the inverted chip surface, tagged for CSS opt-out, still without a duplicate accessible clone", () => {
    render(
      <HoverCard
        trigger={<button type="button">Trigger</button>}
        content={
          <button type="button" data-testid="hover-action">
            Copy
          </button>
        }
        appearance="tooltip"
        semantics={{ role: "dialog", label: "Copy" }}
        side="bottom"
        align="start"
        sideOffset={4}
        enabled
        open
        onOpenChange={null}
        testId={null}
        className={null}
      />,
    );
    const content = document.querySelector<HTMLElement>(
      '[data-slot="hover-card-content"]',
    );
    if (content === null) throw new Error("Hover card content did not render");
    // `data-appearance` is what lets a path disclosure's content opt out of
    // `theme-surfaces.css`'s generic popover fill - classes alone are
    // overridden by it, so the attribute itself is the contract, not just a
    // debugging label.
    expect(content.getAttribute("data-appearance")).toBe("tooltip");
    expect(content.hasAttribute("data-open")).toBe(true);
    const tokens = content.className.split(/\s+/);
    expect(tokens).toContain("bg-foreground");
    expect(tokens).toContain("text-background");
    expect(tokens).not.toContain("bg-popover");
    // A path disclosure still needs its copy-path action reachable exactly
    // once, the same guarantee the default (`appearance="preview"`) surface
    // gives above - only the theme changed here, not the mount count.
    expect(screen.getAllByTestId("hover-action")).toHaveLength(1);
  });

  it("keeps label tooltips on the bounded inverted chip surface", () => {
    render(
      <TooltipProvider delay={0}>
        <Tooltip open>
          <TooltipTrigger render={<button type="button">Trigger</button>} />
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
