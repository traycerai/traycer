import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";

const RUNG_ORDER: readonly FallbackRungKind[] = [
  "profile",
  "tier",
  "wait",
  "notify",
];

afterEach(() => {
  cleanup();
});

describe("FallbackOverridesMatrix disclosure", () => {
  it("no longer carries the global all-off paragraph or the chip legend; that guidance is contextual to an open row", () => {
    render(
      <FallbackOverridesMatrix
        policy={createDefaultFallbackPolicy()}
        rungOrder={RUNG_ORDER}
        onChange={vi.fn()}
        onReset={vi.fn()}
        onUndo={vi.fn()}
        undo={null}
        attentionReason={null}
        previewUnconfirmed={false}
        status={null}
      />,
    );
    expect(screen.queryByText(/Turn off every option in a row/)).toBeNull();
    expect(screen.queryByText(/Dashed steps/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Per-failure overrides/i }),
    ).toBeNull();
    expect(screen.getByText("5 problems follow the main plan")).toBeTruthy();
    expect(screen.queryAllByTestId(/^fallback-override-row-/)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getAllByTestId(/^fallback-override-row-/)).toHaveLength(5);
  });
});
