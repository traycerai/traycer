import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { LazySidebarTooltipWrapper } from "../lazy-sidebar-hover";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);

describe("LazySidebarTooltipWrapper", () => {
  it("keeps keyboard focus on the trigger after the first-focus mount", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <LazySidebarTooltipWrapper
          label="x"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button type="button" data-testid="leaf">
            leaf
          </button>
        </LazySidebarTooltipWrapper>
      </TooltipProvider>,
    );

    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("leaf"));
    expect(document.activeElement).not.toBe(document.body);
  });
});
