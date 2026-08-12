/**
 * Regression coverage for traycerai/traycer#466 (and the click half of #446):
 * a label-only tooltip swallowing clicks meant for whatever it covers.
 *
 * `TooltipContent`'s `pointer-events-none` is not enough on its own - Radix
 * Popper renders that content inside a same-size positioning wrapper that keeps
 * `pointer-events: auto`, and THAT wrapper won hit-testing. In the workspace
 * folder picker (28px rows, `side="top"` tooltips) it landed on the row above,
 * so clicking that row did nothing. The fix is one rule in `index.css`.
 *
 * jsdom has no layout and cannot hit-test, so the two halves are pinned
 * separately and joined by construction: the CSS rule is read out of
 * `index.css`, and its selector - the exact string, not a copy - is then
 * matched against the wrapper a real Radix tooltip renders. Deleting the rule
 * fails the first half; Radix changing its DOM shape (an extra wrapper level,
 * a renamed attribute) fails the second. The end-to-end proof that the click
 * reaches the covered control needs a real browser and lives outside vitest.
 */
import "../../../../__tests__/test-browser-apis";

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

const INDEX_CSS = readFileSync(
  path.resolve(__dirname, "../../../index.css"),
  "utf8",
);

/** The `pointer-events: none` rule guarding tooltip wrappers, as authored. */
function tooltipWrapperRule(): { selector: string; body: string } | null {
  for (const match of INDEX_CSS.matchAll(
    /([^{}]*\[data-radix-popper-content-wrapper\][^{}]*)\{([^}]*)\}/g,
  )) {
    const body = match[2];
    if (/pointer-events\s*:\s*none/.test(body)) {
      return { selector: match[1].trim(), body };
    }
  }
  return null;
}

afterEach(cleanup);

describe("tooltip hit-testing", () => {
  it("index.css takes the popper wrapper out of hit-testing", () => {
    const rule = tooltipWrapperRule();
    expect(rule).not.toBeNull();
    // Scoped to tooltips only: popovers, dropdowns and hover cards hold real
    // controls and must keep receiving pointer events.
    expect(rule?.selector).toContain('[data-slot="tooltip-content"]');
  });

  it("that selector matches the wrapper a real tooltip renders", () => {
    render(
      <TooltipProvider>
        <TooltipWrapper
          label="Worktrees require a Git repository."
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button type="button">Local</button>
        </TooltipWrapper>
      </TooltipProvider>,
    );
    // Focus, not hover: Radix honours it immediately, where pointer-enter sits
    // behind the 500ms open delay (see `tooltip-probe.ts`).
    fireEvent.focus(screen.getByRole("button", { name: "Local" }));

    const content = screen.getByRole("tooltip");
    const wrapper = content.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.hasAttribute("data-radix-popper-content-wrapper")).toBe(
      true,
    );
    // The rule as authored, applied to the DOM as rendered. jsdom will not
    // compute `pointer-events` from a stylesheet we never load, but it does
    // answer whether the selector selects this node.
    const selector = tooltipWrapperRule()?.selector ?? "";
    expect(wrapper?.matches(selector)).toBe(true);
  });
});
