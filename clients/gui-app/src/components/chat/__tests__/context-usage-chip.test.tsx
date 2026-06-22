import "../../../../__tests__/test-browser-apis";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { computeEffectiveContextUsage } from "@/components/chat/context-usage";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

function percentLeft(usage: TokenUsage | null): number | null {
  return computeEffectiveContextUsage(usage)?.percentLeft ?? null;
}

function withTooltipProvider(node: ReactNode): ReactNode {
  return <TooltipProvider>{node}</TooltipProvider>;
}

afterEach(() => {
  cleanup();
});

describe("percentLeft", () => {
  it("returns null when usage is null", () => {
    expect(percentLeft(null)).toBe(null);
  });

  it("returns null when contextWindow is missing", () => {
    expect(
      percentLeft({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        contextTokens: 10,
      }),
    ).toBe(null);
  });

  it("returns null when contextWindow is zero", () => {
    expect(
      percentLeft({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        contextTokens: 10,
        contextWindow: 0,
      }),
    ).toBe(null);
  });

  it("returns null when no tokens have been used yet", () => {
    expect(
      percentLeft({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        contextWindow: 200_000,
      }),
    ).toBe(null);
  });

  it("uses adapter-normalized contextTokens (Anthropic-style additive)", () => {
    // Claude/OpenCode adapter sums input + cache_read + cache_creation
    // into contextTokens. Renderer just divides.
    expect(
      percentLeft({
        inputTokens: 10_000,
        outputTokens: 200,
        totalTokens: 10_200,
        contextTokens: 50_000,
        cacheReadInputTokens: 30_000,
        cacheCreationInputTokens: 10_000,
        contextWindow: 200_000,
      }),
    ).toBe(75);
  });

  it("includes the harness baseline in used tokens while keeping reported capacity", () => {
    expect(
      percentLeft({
        inputTokens: 100_000,
        outputTokens: 2_000,
        totalTokens: 102_000,
        contextTokens: 102_000,
        contextBaselineTokens: 12_000,
        cacheReadInputTokens: 80_000,
        contextWindow: 272_000,
      }),
    ).toBe(58);
  });

  it("uses adapter-normalized contextTokens (OpenAI-style subset)", () => {
    // Cursor adapter sets contextTokens = inputTokens (cache_read is a
    // SUBSET of input, not additive). Without this normalization the
    // renderer's old additive math read past 100% used.
    expect(
      percentLeft({
        inputTokens: 50_000,
        outputTokens: 1_000,
        totalTokens: 51_000,
        contextTokens: 50_000,
        cacheReadInputTokens: 30_000,
        contextWindow: 200_000,
      }),
    ).toBe(75);
  });

  it("falls back to inputTokens when contextTokens is absent (legacy emit)", () => {
    expect(
      percentLeft({
        inputTokens: 50_000,
        outputTokens: 1_000,
        totalTokens: 51_000,
        contextWindow: 200_000,
      }),
    ).toBe(75);
  });

  it("clamps to 0 when usage exceeds the window", () => {
    expect(
      percentLeft({
        inputTokens: 250_000,
        outputTokens: 0,
        totalTokens: 250_000,
        contextTokens: 250_000,
        contextWindow: 200_000,
      }),
    ).toBe(0);
  });
});

describe("ContextUsageChip", () => {
  it("renders nothing when usage is null", () => {
    const { container } = render(
      withTooltipProvider(<ContextUsageChip usage={null} />),
    );
    expect(container.firstChild).toBe(null);
  });

  it("renders text usage for a usage with a contextWindow", () => {
    render(
      withTooltipProvider(
        <ContextUsageChip
          usage={{
            inputTokens: 50_000,
            outputTokens: 1_000,
            totalTokens: 51_000,
            contextTokens: 50_000,
            contextWindow: 200_000,
          }}
        />,
      ),
    );
    const status = screen.getByRole("status", {
      name: "Context window 75% left",
    });
    expect(status).not.toBeNull();
    expect(status.textContent).toBe("75% context left");
    expect(
      screen
        .getByTestId("context-usage-meter")
        .style.getPropertyValue("--context-usage-percent"),
    ).toBe("25%");
  });

  it("hides when contextWindow is absent (Cursor)", () => {
    // Cursor's SDK exposes `TurnEndedUpdate.usage` but no contextWindow on
    // any public surface, so % can't be computed. We don't fall back to
    // raw token counts - showing tokens without a denominator is
    // misleading, and any hardcoded window would lie. Chip just hides.
    const { container } = render(
      withTooltipProvider(
        <ContextUsageChip
          usage={{
            inputTokens: 50_000,
            outputTokens: 1_000,
            totalTokens: 51_000,
            contextTokens: 50_000,
          }}
        />,
      ),
    );
    expect(container.firstChild).toBe(null);
  });

  it("keeps the detailed hover, folds baseline into used, and rounds the context window row", async () => {
    render(
      withTooltipProvider(
        <ContextUsageChip
          usage={{
            inputTokens: 205_400,
            outputTokens: 1_000,
            totalTokens: 206_400,
            contextTokens: 205_400,
            contextBaselineTokens: 12_000,
            cacheReadInputTokens: 100_000,
            contextWindow: 258_000,
          }}
        />,
      ),
    );
    fireEvent.focus(
      screen.getByRole("status", {
        name: "Context window 16% left",
      }),
    );

    expect(await screen.findAllByText("217K / 258K")).toHaveLength(2);
    expect(screen.queryByText("Baseline")).toBeNull();
    expect(screen.getAllByText("Fresh")).toHaveLength(2);
    expect(screen.getAllByText("Cache read")).toHaveLength(2);
    expect(screen.getAllByText("Output")).toHaveLength(2);
  });
});
