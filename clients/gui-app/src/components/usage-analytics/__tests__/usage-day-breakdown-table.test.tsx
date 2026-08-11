import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageDayBreakdownTable } from "@/components/usage-analytics/usage-day-breakdown-table";
import type { UsageDayBreakdownRow } from "@/lib/usage-analytics/usage-breakdown";

afterEach(cleanup);

function row(overrides: Partial<UsageDayBreakdownRow>): UsageDayBreakdownRow {
  return {
    day: "2026-08-09",
    costUsd: 1.23,
    tokens: 1000,
    factCount: 4,
    provenance: "providerReported",
    ...overrides,
  };
}

describe("UsageDayBreakdownTable", () => {
  it("renders every value reachable without hovering", () => {
    render(<UsageDayBreakdownTable rows={[row({})]} />);
    expect(screen.getByRole("cell", { name: "Aug 9" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "$1.23" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "1,000" })).not.toBeNull();
  });

  it("fixup-01: never renders a provenance badge or column, regardless of the row's provenance", () => {
    render(<UsageDayBreakdownTable rows={[row({ provenance: "unpriced" })]} />);
    expect(screen.queryByText("Unpriced")).toBeNull();
    expect(screen.queryByText("Provenance")).toBeNull();
  });

  it("shows an explicit empty state rather than a bare empty table", () => {
    render(<UsageDayBreakdownTable rows={[]} />);
    expect(screen.getByTestId("usage-day-breakdown-empty")).not.toBeNull();
  });
});
