import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import type { UsageHostSplitRow } from "@/lib/usage-analytics/usage-host-split";
import { UsageHostSplit } from "../usage-host-split";

const HOST_ID = "usage-host-opaque";

function row(name: string, nameIsFallback: boolean): UsageHostSplitRow {
  return {
    hostId: HOST_ID,
    name,
    nameIsFallback,
    costUsd: 1,
    tokens: 100,
    factCount: 1,
    shareOfCost: 1,
    provenance: "providerReported",
  };
}

describe("usage host split labels", () => {
  afterEach(() => cleanup());

  it.each([
    ["a named computer", "Studio Mac", false],
    ["an unnamed computer", "Unnamed computer", true],
  ])(
    "uses the safe name in the label and tooltip for %s",
    (_case, name, fallback) => {
      render(
        <TooltipProvider>
          <UsageHostSplit rows={[row(name, fallback)]} />
        </TooltipProvider>,
      );

      const label = screen.getByText(name);
      expect(label.textContent).toBe(name);
      expect(tooltipTextNear(label)).toBe(name);
      expect(
        screen.getByTestId(`usage-host-split-row-${HOST_ID}`).textContent,
      ).not.toContain(HOST_ID);
    },
  );
});
