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
        noticeKind="model_rerouted"
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
        noticeKind="model_rerouted"
        tone="info"
        title="Safety check in progress"
        message={null}
        details={[]}
        findUnitId={null}
      />,
    );

    expect(screen.getByLabelText("Provider notice active")).toBeDefined();
  });

  it("renders the compact retry presentation with attributed expandable details", () => {
    const { container } = render(
      <ProviderNoticeSegment
        status="streaming"
        noticeKind="harness_message"
        presentation="retry"
        tone="info"
        title="Reconnecting 4/5"
        message={null}
        details={[{ label: "Reported by Codex", value: "Reconnecting… 4/5" }]}
        findUnitId={null}
      />,
    );

    expect(screen.queryByLabelText("Provider notice active")).toBeNull();
    expect(container.querySelectorAll("span.h-px")).toHaveLength(0);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector("svg.lucide-wifi")).not.toBeNull();
    expect(screen.queryByText("Reconnecting… 4/5")).toBeNull();
    expect(
      container.querySelector("[data-find-include]")?.textContent,
    ).toContain("Reconnecting 4/5");
    expect(container.querySelector("[data-find-skip]")).toBeNull();

    const toggle = screen.getByRole("button", {
      name: "Reconnecting 4/5. Reported by Codex. Show details.",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Reconnecting… 4/5")).toBeDefined();
    expect(container.querySelector("[data-find-skip]")?.textContent).toContain(
      "Reconnecting… 4/5",
    );
  });

  // jsdom has no layout, so the wrap/shrink contract is asserted on the merged
  // class list: the size must displace the base `shrink-0` / `whitespace-nowrap`
  // for a long title to wrap instead of overflowing the row.
  it("draws the title toggle with the wrapping inline size", () => {
    render(
      <ProviderNoticeSegment
        status="completed"
        noticeKind="model_rerouted"
        tone="warning"
        title="Model changed"
        message={null}
        details={[{ label: "Reason", value: "highRiskCyberActivity" }]}
        findUnitId={null}
      />,
    );

    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("data-size")).toBe("inline-xs-wrap");
    const tokens = Array.from(toggle.classList);
    for (const token of [
      "min-w-0",
      "max-w-full",
      "shrink",
      "whitespace-normal",
    ]) {
      expect(tokens, token).toContain(token);
    }
    expect(tokens).not.toContain("shrink-0");
    expect(tokens).not.toContain("whitespace-nowrap");
  });

  it("does not render an expand toggle when there are no details", () => {
    render(
      <ProviderNoticeSegment
        status="completed"
        noticeKind="model_rerouted"
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
        noticeKind="model_rerouted"
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
