import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageBreakdownTable } from "@/components/usage-analytics/usage-breakdown-table";
import type { UsageBreakdownRow } from "@/lib/usage-analytics/usage-breakdown";

afterEach(cleanup);

function row(overrides: Partial<UsageBreakdownRow>): UsageBreakdownRow {
  return {
    harnessId: "claude",
    model: "claude-sonnet-5",
    costUsd: 1.23,
    tokens: 1000,
    factCount: 4,
    provenance: "providerReported",
    ...overrides,
  };
}

describe("UsageBreakdownTable", () => {
  it("renders every value reachable without hovering - the dataviz relief channel for the chart", () => {
    render(
      <UsageBreakdownTable
        rows={[row({ harnessId: "claude", costUsd: 1.23, tokens: 1000 })]}
      />,
    );
    expect(screen.getByRole("cell", { name: "claude" })).not.toBeNull();
    expect(
      screen.getByRole("cell", { name: "claude-sonnet-5" }),
    ).not.toBeNull();
    expect(screen.getByRole("cell", { name: "$1.23" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "1,000" })).not.toBeNull();
  });

  it("fixup-01: never renders a provenance badge or column, regardless of the row's provenance", () => {
    render(<UsageBreakdownTable rows={[row({ provenance: "unpriced" })]} />);
    expect(screen.queryByText("Unpriced")).toBeNull();
    expect(screen.queryByText("Provenance")).toBeNull();
  });

  it("shows an explicit empty state rather than a bare empty table", () => {
    render(<UsageBreakdownTable rows={[]} />);
    expect(screen.getByTestId("usage-breakdown-empty")).not.toBeNull();
  });
});
