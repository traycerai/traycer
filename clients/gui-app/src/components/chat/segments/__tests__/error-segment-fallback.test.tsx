import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentFailure } from "@traycer/protocol/persistence/epic/content-blocks";
import { ErrorSegment } from "../error-segment";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

function renderError(failure: AgentFailure | null) {
  return render(
    <TooltipProvider>
      <TabHostProvider hostId="tab-host-b">
        <ErrorSegment
          turnId={null}
          message="The turn failed."
          code="RUNTIME"
          recoverable
          findUnitId={null}
          harnessId="claude"
          failure={failure}
        />
      </TabHostProvider>
    </TooltipProvider>,
  );
}

describe("ErrorSegment fallback settings link", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the Fallback settings link only for an auth failure", () => {
    const { unmount } = renderError({ reason: "auth" });
    expect(screen.getByRole("button", { name: "Model routing" })).toBeDefined();
    unmount();

    renderError(null);
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
    cleanup();

    renderError({ reason: "rate_limit" });
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
  });

  it("renders a turnId-null error row with no host runtime provider and does not throw", () => {
    expect(() => {
      render(
        <TooltipProvider>
          <ErrorSegment
            turnId={null}
            message="The turn failed."
            code="RUNTIME"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "rate_limit" }}
          />
        </TooltipProvider>,
      );
    }).not.toThrow();
    expect(screen.getByText("The turn failed.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // The two-tone split: a provider refusal (`rate_limit`) reads as
  // "interrupted" - a warning-toned row with the reason's own sentence-case
  // headline and no uppercase ERROR overline or raw code chip - while a turn
  // that genuinely died (`request_rejected`) and a legacy row with no typed
  // reason (`failure === null`) both keep the old destructive rendering. See
  // `agent-failure-presentation.ts` for the classification these three cases
  // pin.
  it("renders the interrupted (warning) tone for a provider refusal, with the reason as its headline and no ERROR overline or code chip", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId="tab-host-b">
          <ErrorSegment
            turnId={null}
            message="Hit a rate limit."
            code="rate_limit"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "rate_limit" }}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    const root = screen
      .getByText("Hit a rate limit.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(root?.className).toContain("border-warning/40");
    expect(root?.className).toContain("bg-warning/5");
    // Falsification: delete the `agentFailureHeadline` call at the row's
    // heading - this literal goes red and only the generic overline remains.
    expect(screen.getByText("Rate limit reached")).toBeDefined();
    expect(screen.queryByText("Error")).toBeNull();
    // The raw code chip is banned on an interrupted row - see
    // `ErrorSegmentHeading`'s doc for why a raw reason code in red monospace
    // is exactly what this classification exists to remove.
    expect(screen.queryByText("rate_limit")).toBeNull();
  });

  it("keeps the destructive (error) tone, the ERROR overline and the code chip for a turn that genuinely died", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId="tab-host-b">
          <ErrorSegment
            turnId={null}
            message="The request was rejected."
            code="REQUEST_REJECTED"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "request_rejected" }}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    const root = screen
      .getByText("The request was rejected.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("error");
    expect(root?.className).toContain("border-destructive/30");
    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("REQUEST_REJECTED")).toBeDefined();
    // No sentence-case headline on this row - "request_rejected" never
    // appears as prose, only inside the raw code chip above.
    expect(screen.queryByText("Request rejected")).toBeNull();
  });

  it("keeps the destructive (error) tone for a legacy row with no typed failure reason", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId="tab-host-b">
          <ErrorSegment
            turnId={null}
            message="Something went wrong."
            code="LEGACY"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={null}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    const root = screen
      .getByText("Something went wrong.")
      .closest("[data-failure-presentation]");
    // Falsification: change `agentFailurePresentation`'s `reason === null`
    // branch from "error" to "interrupted" - a row from before the failure
    // payload existed is nothing anyone can vouch for, and this must stay red.
    expect(root?.getAttribute("data-failure-presentation")).toBe("error");
    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("LEGACY")).toBeDefined();
  });

  it("renders a turnId-bearing error row with no transcript and no host provider and does not throw", () => {
    expect(() => {
      render(
        <TooltipProvider>
          <ErrorSegment
            turnId="turn-a"
            message="The turn failed."
            code="RUNTIME"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "rate_limit" }}
          />
        </TooltipProvider>,
      );
    }).not.toThrow();
    // Falsification: move the host hooks from ManualRungActions up into FallbackManualRungActions above the identity gate — this assertion must go red with the "Host runtime hooks must be used inside a <HostRuntimeProvider>" error.
    expect(screen.getByText("The turn failed.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
