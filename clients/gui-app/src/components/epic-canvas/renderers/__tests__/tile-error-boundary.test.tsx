import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TileErrorBoundary } from "@/components/epic-canvas/renderers/tile-error-boundary";
import type {
  ReportIssueErrorCapture,
  ReportIssueErrorCaptureInput,
} from "@/lib/report-issue-error-capture";
import type { appLogger } from "@/lib/logger";

const captureReportIssueError = vi.hoisted(() =>
  vi.fn((input: ReportIssueErrorCaptureInput): ReportIssueErrorCapture => ({
    cause: {
      type: "Error",
      message: "boom",
      stack: null,
      componentStack: input.componentStack,
      errorCode: null,
      sourceAction: input.sourceAction,
      timestamp: 1,
    },
    correlationId: "correlation-1",
    fingerprint: "fp:v1:test",
    stackFamily: null,
  })),
);
const errorSummary = vi.hoisted(() => vi.fn<typeof appLogger.errorSummary>());

vi.mock("@/lib/report-issue-error-capture", () => ({
  captureReportIssueError,
}));

vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  appLogger: { errorSummary, info: vi.fn(), warn: vi.fn() },
}));

afterEach(() => {
  cleanup();
  // restoreAllMocks() puts back console.error (and any other spyOn target)
  // even when an assertion threw before a per-test restore could run; the
  // module mocks still need their call history cleared explicitly.
  vi.restoreAllMocks();
  captureReportIssueError.mockClear();
  errorSummary.mockClear();
});

function Boom(props: { readonly shouldThrow: boolean }): ReactNode {
  if (props.shouldThrow) throw new Error("tile boom");
  return <div data-testid="tile-body">ok</div>;
}

function ReloadHarness(): ReactNode {
  const [shouldThrow, setShouldThrow] = useState(true);
  return (
    <div>
      <button
        type="button"
        data-testid="stop-throwing"
        onClick={() => setShouldThrow(false)}
      >
        stop throwing
      </button>
      <TileErrorBoundary instanceId="tile-1" resetKey="tile-1">
        <Boom shouldThrow={shouldThrow} />
      </TileErrorBoundary>
    </div>
  );
}

describe("<TileErrorBoundary />", () => {
  it("shows the compact fallback for a crashing tile while a sibling tile keeps rendering", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <div>
        <TileErrorBoundary instanceId="tile-1" resetKey="tile-1">
          <Boom shouldThrow />
        </TileErrorBoundary>
        <TileErrorBoundary instanceId="tile-2" resetKey="tile-2">
          <Boom shouldThrow={false} />
        </TileErrorBoundary>
      </div>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-testid")).toBe("tile-error-tile-1");
    expect(screen.getByText("This tab hit an error.")).not.toBeNull();
    // The sibling tile is untouched - one crash does not blank the canvas.
    expect(screen.getByTestId("tile-body").textContent).toBe("ok");

    expect(captureReportIssueError).toHaveBeenCalledTimes(1);
    const [captureCall] = captureReportIssueError.mock.calls[0];
    expect(captureCall.sourceAction).toBe("Canvas tile");
    expect(errorSummary).toHaveBeenCalledTimes(1);
    const [, summaryDetails] = errorSummary.mock.calls[0];
    expect(summaryDetails).toMatchObject({ instanceId: "tile-1" });
  });

  it("Reload rebuilds the tile once it has stopped throwing", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ReloadHarness />);
    expect(screen.getByRole("alert")).not.toBeNull();

    fireEvent.click(screen.getByTestId("stop-throwing"));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("tile-body").textContent).toBe("ok");
  });
});
