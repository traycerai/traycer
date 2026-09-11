import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";
import { FALLBACK_OVERRIDES_DISCLOSURE } from "@/components/settings/panels/fallback/fallback-overrides-copy";

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
  it("renders the RF5 disclosure only after opening the per-failure editor", () => {
    // Literal, and it has already earned the literalness once: this sentence
    // promised that an all-off row "preserves that failure's pre-retry/HOLD
    // behavior", and the engine stopped arming a non-transient notify-only
    // plan - so the page was promising a cancellation window that no longer
    // exists. A pin on the string is what makes the next such divergence a
    // failing test rather than a sentence nobody re-reads.
    expect(FALLBACK_OVERRIDES_DISCLOSURE).toBe(
      "Turning every chip off leaves the brief retry that outages and connection failures start with, and the notification at the end - but no cancellation window; this editor does not author the wire’s per-reason off value, and Notify stays last.",
    );
    const policy: FallbackPolicy = createDefaultFallbackPolicy();
    render(
      <FallbackOverridesMatrix
        policy={policy}
        rungOrder={RUNG_ORDER}
        onChange={vi.fn()}
        status={null}
      />,
    );

    expect(screen.queryByText(FALLBACK_OVERRIDES_DISCLOSURE)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Per-failure overrides/i }),
    );
    expect(screen.getByText(FALLBACK_OVERRIDES_DISCLOSURE)).toBeDefined();
  });
});
