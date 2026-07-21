import "../../../../__tests__/test-browser-apis";

import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  domAnimation,
  hasReducedMotionListener,
  LazyMotion,
  prefersReducedMotion,
} from "motion/react";
import type { ReactElement } from "react";

import {
  buildContextUsageRows,
  computeEffectiveContextUsage,
  formatContextUsageRowValue,
} from "@/components/chat/context-usage";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

const RELIABLE_USAGE: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion)";
const defaultMatchMedia = window.matchMedia.bind(window);

function percentLeft(usage: TokenUsage | null): number | null {
  return computeEffectiveContextUsage(usage)?.percentLeft ?? null;
}

function queryCompactContextTrigger() {
  return screen.queryByRole("button", {
    name: /open context usage breakdown/i,
  });
}

function render(ui: ReactElement) {
  const result = testingRender(
    <TooltipProvider delayDuration={0}>
      <LazyMotion features={domAnimation}>{ui}</LazyMotion>
    </TooltipProvider>,
  );
  return {
    ...result,
    rerender: (nextUi: ReactElement) =>
      result.rerender(
        <TooltipProvider delayDuration={0}>
          <LazyMotion features={domAnimation}>{nextUi}</LazyMotion>
        </TooltipProvider>,
      ),
  };
}

function resetMotionReducedMotionPreference(): void {
  prefersReducedMotion.current = null;
  hasReducedMotionListener.current = false;
}

function restoreDefaultMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: defaultMatchMedia,
  });
}

function installReducedMotionPreference(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  resetMotionReducedMotionPreference();
}

function resetContextUsageSettings(): void {
  window.localStorage.clear();
  useSettingsStore.setState({ pinContextUsageBreakdown: false });
  restoreDefaultMatchMedia();
  resetMotionReducedMotionPreference();
}

beforeEach(resetContextUsageSettings);

afterEach(() => {
  cleanup();
  resetContextUsageSettings();
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

describe("buildContextUsageRows", () => {
  function rowsFor(usage: TokenUsage) {
    const effective = computeEffectiveContextUsage(usage);
    if (effective === null) throw new Error("expected reliable usage");
    return buildContextUsageRows(usage, effective);
  }

  it("omits cache and fresh rows when there is no cache", () => {
    const rows = rowsFor({
      inputTokens: 50_000,
      outputTokens: 1_000,
      totalTokens: 51_000,
      contextTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(rows.map((row) => row.key)).toEqual(["used", "output"]);
  });

  it("includes fresh and cache rows when cache values are present", () => {
    const rows = rowsFor({
      inputTokens: 10_000,
      outputTokens: 200,
      totalTokens: 10_200,
      contextTokens: 50_000,
      cacheReadInputTokens: 30_000,
      cacheCreationInputTokens: 10_000,
      contextWindow: 200_000,
    });

    expect(rows.map((row) => row.key)).toEqual([
      "used",
      "fresh",
      "cacheRead",
      "cacheWrite",
      "output",
    ]);
  });

  it("renders the used row as a context-window pair and standalone counts otherwise", () => {
    const rows = rowsFor({
      inputTokens: 50_000,
      outputTokens: 1_000,
      totalTokens: 51_000,
      contextTokens: 50_000,
      contextWindow: 200_000,
    });
    const used = rows.find((row) => row.key === "used");
    const output = rows.find((row) => row.key === "output");
    if (used === undefined || output === undefined) {
      throw new Error("expected used and output rows");
    }

    expect(formatContextUsageRowValue(used)).toBe("50K / 200K");
    expect(formatContextUsageRowValue(output)).toBe("1.0k");
  });
});

describe("ContextUsageChip", () => {
  it("renders nothing when usage is null", () => {
    const { container } = render(<ContextUsageChip usage={null} />);
    expect(container.firstChild).toBe(null);
  });

  it("renders a compact button for a usage with a contextWindow", () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);
    const button = screen.getByRole("button", {
      name: /Context window 75% left/,
    });
    expect(button.textContent).toBe("75% context left");
    expect(screen.queryByTestId("context-usage-pinned-percent-value")).toBe(
      null,
    );
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
      <ContextUsageChip
        usage={{
          inputTokens: 50_000,
          outputTokens: 1_000,
          totalTokens: 51_000,
          contextTokens: 50_000,
        }}
      />,
    );
    expect(container.firstChild).toBe(null);
  });

  it("opens the detailed popover, folds baseline into used, and rounds the context window row", async () => {
    render(
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
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Context window 16% left/,
      }),
    );

    expect(await screen.findByText("Context window")).toBeTruthy();
    expect(screen.getByText("217K / 258K")).toBeTruthy();
    expect(screen.queryByText("Baseline")).toBeNull();
    expect(screen.getByText("Fresh")).toBeTruthy();
    expect(screen.getByText("Cache read")).toBeTruthy();
    expect(screen.queryByText("Cache write")).toBeNull();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("1.0k")).toBeTruthy();
  });

  it("updates the pinned context usage setting from the popover action", async () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Context window 75% left/,
      }),
    );

    const pinButton = await screen.findByRole("button", {
      name: "Pin breakdown",
    });
    pinButton.focus();
    fireEvent.click(pinButton);
    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(true);
    expect(queryCompactContextTrigger()).toBeNull();
    expect(screen.getByTestId("context-usage-pinned-strip")).toBeTruthy();

    const unpinButton = screen.getByRole("button", {
      name: "Unpin context usage breakdown",
    });
    expect(document.activeElement).toBe(unpinButton);

    fireEvent.click(unpinButton);
    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(false);
    expect(
      screen.getByRole("button", {
        name: /Context window 75% left/,
      }),
    ).toBeTruthy();
  });

  it("preserves trigger focus when the popover opens from a pointer action", async () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    const trigger = screen.getByRole("button", {
      name: /Context window 75% left/,
    });
    trigger.focus();
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.click(trigger);

    await screen.findByRole("button", {
      name: "Pin breakdown",
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus to the popover action when the popover opens from keyboard activation", async () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    const trigger = screen.getByRole("button", {
      name: /Context window 75% left/,
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(trigger);

    const pinButton = await screen.findByRole("button", {
      name: "Pin breakdown",
    });
    expect(document.activeElement).toBe(pinButton);
  });

  it("renders the pinned strip when the setting is enabled and reliable usage exists", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    expect(
      screen.queryByRole("button", {
        name: /Context window 75% left/,
      }),
    ).toBeNull();
    expect(queryCompactContextTrigger()).toBeNull();

    const strip = screen.getByTestId("context-usage-pinned-strip");
    expect(
      within(strip).getByTestId("context-usage-pinned-primary").textContent,
    ).toMatch(/Context\s+75%/);
    expect(
      within(strip).getByTestId("context-usage-pinned-percent-value")
        .textContent,
    ).toBe("75");
    expect(within(strip).getByText("50K / 200K")).toBeTruthy();
    expect(within(strip).getByText("1.0k")).toBeTruthy();
    expect(
      within(strip)
        .getByRole("button", {
          name: "Unpin context usage breakdown",
        })
        .hasAttribute("title"),
    ).toBe(false);
  });

  it("keeps detailed popover values on the static text path", async () => {
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Context window 75% left/,
      }),
    );

    expect(await screen.findByText("Context window")).toBeTruthy();
    expect(screen.getByText("75% left")).toBeTruthy();
    expect(screen.getByText("50K / 200K")).toBeTruthy();
    expect(screen.getByText("1.0k")).toBeTruthy();
    expect(screen.queryByTestId("context-usage-pinned-percent-value")).toBe(
      null,
    );
  });

  it("keeps the pinned strip hidden when the setting is enabled without reliable usage", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    const { container } = render(
      <ContextUsageChip
        usage={{
          inputTokens: 50_000,
          outputTokens: 1_000,
          totalTokens: 51_000,
          contextTokens: 50_000,
        }}
      />,
    );

    expect(container.firstChild).toBe(null);
    expect(screen.queryByTestId("context-usage-pinned-strip")).toBeNull();
  });

  it("unpins from the inline pinned strip action", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Unpin context usage breakdown",
      }),
    );

    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(false);
    expect(screen.queryByTestId("context-usage-pinned-strip")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /Context window 75% left/,
      }),
    ).toBeTruthy();
  });

  it("moves focus to the restored compact trigger after focused inline unpin", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    const unpinButton = screen.getByRole("button", {
      name: "Unpin context usage breakdown",
    });
    unpinButton.focus();
    fireEvent.click(unpinButton);

    const trigger = screen.getByRole("button", {
      name: /Context window 75% left/,
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("omits noisy cache rows from the pinned strip when cache values are absent", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    const strip = screen.getByTestId("context-usage-pinned-strip");
    expect(within(strip).getByText("Used")).toBeTruthy();
    expect(within(strip).queryByText("Fresh")).toBeNull();
    expect(within(strip).queryByText("Cache read")).toBeNull();
    expect(within(strip).queryByText("Cache write")).toBeNull();
    expect(within(strip).getByText("Output")).toBeTruthy();
  });

  it("updates the pinned strip from the same usage value", async () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    const { rerender } = render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    expect(queryCompactContextTrigger()).toBeNull();
    expect(screen.getByText("50K / 200K used")).toBeTruthy();

    rerender(
      <ContextUsageChip
        usage={{
          inputTokens: 150_000,
          outputTokens: 2_000,
          totalTokens: 152_000,
          contextTokens: 150_000,
          contextWindow: 200_000,
        }}
      />,
    );

    expect(queryCompactContextTrigger()).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByTestId("context-usage-pinned-percent-value").textContent,
      ).toBe("25");
    });
    expect(screen.getByText("150K / 200K used")).toBeTruthy();
    expect(screen.queryByText("50K / 200K used")).toBeNull();
  });

  it("updates the pinned percent instantly when reduced motion is requested", () => {
    installReducedMotionPreference(true);
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    const { rerender } = render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    expect(
      screen.getByTestId("context-usage-pinned-percent-value").textContent,
    ).toBe("75");

    rerender(
      <ContextUsageChip
        usage={{
          inputTokens: 150_000,
          outputTokens: 2_000,
          totalTokens: 152_000,
          contextTokens: 150_000,
          contextWindow: 200_000,
        }}
      />,
    );

    expect(
      screen.getByTestId("context-usage-pinned-percent-value").textContent,
    ).toBe("25");
  });

  it("marks the pinned strip summary and details with container-query collapse classes", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ContextUsageChip usage={RELIABLE_USAGE} />);

    expect(
      screen.getByTestId("context-usage-pinned-summary").className,
    ).toContain("@max-[34rem]:block");
    expect(
      screen.getByTestId("context-usage-pinned-details").className,
    ).toContain("@max-[34rem]:hidden");
  });
});
