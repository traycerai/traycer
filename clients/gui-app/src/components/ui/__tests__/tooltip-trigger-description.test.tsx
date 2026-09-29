/**
 * `TooltipTrigger` composes its `aria-describedby` from up to three sources:
 * a caller-passed `aria-describedby` prop, the tooltip's own id (only while
 * open, so a closed tooltip never dangles a reference), and any
 * `aria-describedby` already sitting on the `render` element itself (an outer
 * composition may have put one there before this wrapper ever saw it). None
 * of the three may silently drop another.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

afterEach(cleanup);

function idsOf(trigger: Element): ReadonlyArray<string> {
  return (trigger.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

describe("TooltipTrigger aria-describedby composition", () => {
  it("keeps a caller-supplied aria-describedby and adds the tooltip's own id only while open", async () => {
    render(
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger
            aria-describedby="external-help"
            render={<button type="button">Trigger</button>}
          />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });

    expect(idsOf(trigger)).toEqual(["external-help"]);

    fireEvent.focus(trigger);
    const openIds = idsOf(trigger);
    expect(openIds).toContain("external-help");
    expect(openIds).toHaveLength(2);
    const tooltipId = openIds.find((id) => id !== "external-help");
    if (tooltipId === undefined) {
      throw new Error("expected a second id for the open tooltip");
    }
    const tooltip = document.getElementById(tooltipId);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toBe("Tip");

    // Closing on blur is NOT synchronous (matches the underlying primitive),
    // so wait for it rather than asserting the state right after the event.
    fireEvent.blur(trigger);
    await waitFor(() => {
      expect(idsOf(trigger)).toEqual(["external-help"]);
    });
  });

  it("preserves an aria-describedby already on the render element itself", () => {
    render(
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button type="button" aria-describedby="from-render">
                Trigger
              </button>
            }
          />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });

    expect(idsOf(trigger)).toEqual(["from-render"]);

    fireEvent.focus(trigger);
    expect(idsOf(trigger)).toContain("from-render");
    expect(idsOf(trigger)).toHaveLength(2);
  });

  it("carries no description at all when nothing supplies one and the tooltip is closed", () => {
    render(
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger render={<button type="button">Trigger</button>} />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  });

  it("tracks a controlled `open` prop directly, with no hover/focus needed", () => {
    const { rerender } = render(
      <TooltipProvider delay={0}>
        <Tooltip open>
          <TooltipTrigger render={<button type="button">Trigger</button>} />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    expect(idsOf(trigger)).toHaveLength(1);

    rerender(
      <TooltipProvider delay={0}>
        <Tooltip open={false}>
          <TooltipTrigger render={<button type="button">Trigger</button>} />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps the trigger undescribed when the caller cancels the open change", () => {
    const onOpenChange = vi.fn(
      (_next: boolean, details: { cancel: () => void }) => {
        details.cancel();
      },
    );
    render(
      <TooltipProvider delay={0}>
        <Tooltip onOpenChange={onOpenChange}>
          <TooltipTrigger render={<button type="button">Trigger</button>} />
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });

    fireEvent.focus(trigger);

    expect(onOpenChange).toHaveBeenCalled();
    // Cancelled: neither the popup nor its aria association should appear.
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  });
});
