import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderNoticeSegment } from "../provider-notice-segment";

describe("<ProviderNoticeSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an info-tone notice quietly once completed, with no live pulse", () => {
    render(
      <ProviderNoticeSegment
        status="completed"
        tone="info"
        title="Model verification active"
        message="Trusted access verification enabled."
        details={[]}
        findUnitId={null}
      />,
    );

    expect(screen.getByText("Model verification active")).toBeDefined();
    expect(
      screen.getByText(/Trusted access verification enabled\./),
    ).toBeDefined();
    expect(screen.queryByLabelText("Provider notice active")).toBeNull();
  });

  it("shows the live pulse while streaming", () => {
    render(
      <ProviderNoticeSegment
        status="streaming"
        tone="info"
        title="Safety check in progress"
        message={null}
        details={[]}
        findUnitId={null}
      />,
    );

    expect(screen.getByLabelText("Provider notice active")).toBeDefined();
  });

  it("does not render an expand toggle when there are no details", () => {
    render(
      <ProviderNoticeSegment
        status="completed"
        tone="warning"
        title="Model changed"
        message={null}
        details={[]}
        findUnitId={null}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("expands to reveal detail label/value pairs on click, without showing raw JSON", () => {
    render(
      <ProviderNoticeSegment
        status="completed"
        tone="warning"
        title="Model changed"
        message="Codex switched from gpt-5 to gpt-5-safe."
        details={[
          { label: "Reason", value: "highRiskCyberActivity" },
          { label: "From", value: "gpt-5" },
        ]}
        findUnitId={null}
      />,
    );

    expect(screen.queryByText("Reason")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Reason")).toBeDefined();
    expect(screen.getByText("highRiskCyberActivity")).toBeDefined();
    expect(screen.getByText("From")).toBeDefined();
    expect(screen.getByText("gpt-5")).toBeDefined();
    expect(screen.queryByText(/"type":/)).toBeNull();
  });
});
