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
    expect(
      screen.getByRole("button", { name: "Fallback settings" }),
    ).toBeDefined();
    unmount();

    renderError(null);
    expect(
      screen.queryByRole("button", { name: "Fallback settings" }),
    ).toBeNull();
    cleanup();

    renderError({ reason: "rate_limit" });
    expect(
      screen.queryByRole("button", { name: "Fallback settings" }),
    ).toBeNull();
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
