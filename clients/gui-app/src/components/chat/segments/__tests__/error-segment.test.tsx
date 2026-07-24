import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { ErrorSegment } from "../error-segment";

describe("<ErrorSegment />", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.getState().close();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });
  });

  // Every error - auth included - renders through this component as the
  // failure's durable transcript record. This is the static chrome shared by
  // all codes: the "Error" overline, the code badge, and the message.
  it("renders the error chrome with the code badge and message", () => {
    render(
      <ErrorSegment
        message="Boom went the host"
        code="RUNTIME_THROWN"
        findUnitId={null}
      />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("RUNTIME_THROWN")).toBeDefined();
    expect(screen.getByText("Boom went the host")).toBeDefined();
  });

  it("omits the code badge when there is no code", () => {
    render(
      <ErrorSegment message="Something failed" code={null} findUnitId={null} />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("Something failed")).toBeDefined();
  });

  it("does not copy a hostile transcript code into public report context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const hostileCode = "/Users/alice/private.txt?token=sk-secret";

    render(
      <TooltipProvider>
        <ErrorSegment
          message="Something failed"
          code={hostileCode}
          findUnitId={null}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText(hostileCode)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Agent error",
      message: null,
      code: null,
      source: "Chat",
    });
  });
});
