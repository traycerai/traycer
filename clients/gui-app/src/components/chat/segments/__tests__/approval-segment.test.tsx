import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResolvedApprovalSegment } from "@/components/chat/segments/approval-segment";

describe("<ResolvedApprovalSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the approval input summary in the resolved header", () => {
    render(
      <ResolvedApprovalSegment
        headerFindUnitId={null}
        toolName="bash"
        description="OpenCode requests bash permission"
        inputSummary="find . -name '*.sentry' | head -50"
        inputDetail={null}
        decision={{ approved: false, reason: null }}
        variant="card"
      />,
    );

    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
    expect(screen.getByText("find . -name '*.sentry' | head -50")).toBeTruthy();
  });
});
