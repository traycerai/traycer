import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import type { ReasoningStep } from "@/components/home/pickers/harness-model-picker-presentation";
import type { ComposerReasoningIndicator } from "@/stores/settings/layout-store";

// The glyph's fixed geometry (see `reasoning-bars-glyph.tsx`): a constant
// slot per bar, so the box grows sideways with the count instead of thinning.
const SLOT = 4;
const BAR_WIDTH = SLOT * 0.65;

const SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "gpt-5.5",
  profileId: "work-profile",
};

describe("<HarnessModelTrigger />", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the existing accessible summary when no profile data is provided", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        reasoningStep={{ index: 2, count: 4 }}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay="responsive"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "GPT-5.5, Thinking High",
      }),
    ).toBeDefined();
  });

  it("keeps the profile accessible without repeating its name in the collapsed trigger", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        reasoningStep={{ index: 2, count: 4 }}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel="Work"
        profileAccentDot={{
          profileId: "work-profile",
          accentColor: null,
          label: "work",
        }}
        isLoading={false}
        disabled={false}
        labelDisplay="responsive"
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "GPT-5.5, Thinking High, Work",
    });
    expect(trigger).toBeDefined();
    expect(trigger.textContent).not.toContain("Work");
    expect(trigger.textContent).toContain("W");
    const profileBadge = Array.from(trigger.querySelectorAll("span")).find(
      (element) =>
        element.textContent === "W" && element.className.includes("absolute"),
    );
    expect(profileBadge?.className).toContain("size-3");
    expect(profileBadge?.className).not.toContain("size-3.5");
  });

  it("renders nothing extra when the provider has under 2 profiles - byte-identical to today", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        reasoningStep={{ index: 2, count: 4 }}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay="responsive"
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "GPT-5.5, Thinking High",
    });
    expect(trigger.textContent).not.toContain("Work");
  });

  // jsdom applies no CSS, so the container-query contract is asserted on the
  // class itself: "responsive" opts the label into the narrow-collapse, and
  // "always" (the phone toolbar, which has room) must not.
  it("collapses the label in a narrow container only when responsive", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel={null}
        reasoningStep={null}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay="responsive"
      />,
    );
    expect(screen.getByText("GPT-5.5").className).toContain("@max-lg:hidden");
  });

  it("shows the model name at every width when labelDisplay is model-only", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        reasoningStep={{ index: 2, count: 4 }}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay="model-only"
      />,
    );
    expect(screen.getByText("GPT-5.5").className).not.toContain(
      "@max-lg:hidden",
    );
  });

  it("drops the thinking-effort suffix in model-only, but still announces it", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        reasoningStep={{ index: 2, count: 4 }}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay="model-only"
      />,
    );

    expect(screen.queryByText("High")).toBeNull();
    // The value is still carried by the accessible name, so nothing is lost
    // to assistive tech - only the visual suffix goes.
    expect(
      screen.getByRole("button", { name: "GPT-5.5, Thinking High" }),
    ).toBeDefined();
  });

  it("keeps the thinking-effort suffix in the responsive (desktop) pill", () => {
    render(
      <HarnessModelTrigger
        selection={SELECTION}
        label="GPT-5.5"
        reasoningLabel="High"
        reasoningStep={{ index: 2, count: 4 }}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay="responsive"
      />,
    );
    expect(screen.getByText("High")).toBeDefined();
  });

  describe("reasoning indicator", () => {
    function renderReasoning(
      reasoningIndicator: ComposerReasoningIndicator,
      reasoningLabel: string,
      reasoningStep: ReasoningStep,
    ): void {
      render(
        <HarnessModelTrigger
          selection={SELECTION}
          label="GPT-5.5"
          reasoningLabel={reasoningLabel}
          reasoningStep={reasoningStep}
          reasoningIndicator={reasoningIndicator}
          serviceTierLabel={null}
          serviceTierActive={false}
          profileLabel={null}
          profileAccentDot={null}
          isLoading={false}
          disabled={false}
          labelDisplay="responsive"
        />,
      );
    }

    function barFills(glyph: HTMLElement): ReadonlyArray<string | null> {
      return Array.from(glyph.querySelectorAll("rect")).map((bar) =>
        bar.getAttribute("data-filled"),
      );
    }

    it("renders exactly today's chip in text mode - no glyph", () => {
      renderReasoning("text", "High", { index: 2, count: 4 });

      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.getByText("High")).toBeDefined();
      expect(
        screen.getByRole("button", { name: "GPT-5.5, Thinking High" }),
      ).toBeDefined();
    });

    it("draws 3 bars with 2 filled for the second of three levels", () => {
      renderReasoning("bars", "Medium", { index: 1, count: 3 });

      const glyph = screen.getByRole("img", {
        name: "Thinking: Medium (2 of 3)",
      });
      expect(barFills(glyph)).toEqual(["true", "true", "false"]);
      // Bars replace the name; the accessible summary still carries it.
      expect(screen.queryByText("Medium")).toBeNull();
      expect(
        screen.getByRole("button", { name: "GPT-5.5, Thinking Medium" }),
      ).toBeDefined();
    });

    it("draws 5 bars with 2 filled for the second of five levels", () => {
      renderReasoning("bars", "Low", { index: 1, count: 5 });

      const glyph = screen.getByRole("img", { name: "Thinking: Low (2 of 5)" });
      expect(barFills(glyph)).toEqual([
        "true",
        "true",
        "false",
        "false",
        "false",
      ]);
    });

    it("fills only the first bar at the bottom of the ladder", () => {
      renderReasoning("bars", "Low", { index: 0, count: 4 });

      const glyph = screen.getByRole("img", { name: "Thinking: Low (1 of 4)" });
      expect(barFills(glyph)).toEqual(["true", "false", "false", "false"]);
    });

    it("fills every bar at the top of the ladder", () => {
      renderReasoning("bars", "Max", { index: 3, count: 4 });

      const glyph = screen.getByRole("img", { name: "Thinking: Max (4 of 4)" });
      expect(barFills(glyph)).toEqual(["true", "true", "true", "true"]);
    });

    it("draws a lone level as one full-height bar of normal width", () => {
      renderReasoning("bars", "High", { index: 0, count: 1 });

      const glyph = screen.getByRole("img", {
        name: "Thinking: High (1 of 1)",
      });
      const bars = Array.from(glyph.querySelectorAll("rect"));
      expect(bars).toHaveLength(1);
      expect(Number(bars[0]?.getAttribute("height"))).toBe(16);
      expect(Number(bars[0]?.getAttribute("width"))).toBe(BAR_WIDTH);
    });

    it("draws the bars in ascending height, at a constant width and pitch whatever the count", () => {
      renderReasoning("bars", "Low", { index: 0, count: 3 });
      const threeBars = Array.from(
        screen.getByRole("img").querySelectorAll("rect"),
      );
      cleanup();
      renderReasoning("bars", "Low", { index: 0, count: 7 });
      const sevenBars = Array.from(
        screen.getByRole("img").querySelectorAll("rect"),
      );

      const heights = threeBars.map((bar) =>
        Number(bar.getAttribute("height")),
      );
      expect(heights).toEqual([...heights].sort((a, b) => a - b));
      expect(heights.at(-1)).toBe(16);
      // A seven-level harness (pi) must not shave its bars to hairlines: the
      // slot is fixed and the box grows sideways instead.
      for (const bars of [threeBars, sevenBars]) {
        expect(bars.map((bar) => Number(bar.getAttribute("width")))).toEqual(
          bars.map(() => BAR_WIDTH),
        );
        expect(bars.map((bar) => Number(bar.getAttribute("x")))).toEqual(
          bars.map((_, index) => index * SLOT),
        );
      }
      expect(screen.getByRole("img").getAttribute("viewBox")).toBe(
        `0 0 ${7 * SLOT} 16`,
      );
      expect(screen.getByRole("img").getAttribute("class")).toContain("w-auto");
    });

    it("keeps the name beside the bars in bars-text mode", () => {
      renderReasoning("bars-text", "High", { index: 2, count: 4 });

      const glyph = screen.getByRole("img", {
        name: "Thinking: High (3 of 4)",
      });
      expect(barFills(glyph)).toEqual(["true", "true", "true", "false"]);
      expect(screen.getByText("High")).toBeDefined();
    });

    it("draws every bar empty and keeps the name when the value is not on the ladder", () => {
      renderReasoning("bars", "xhigh", { index: null, count: 3 });

      const glyph = screen.getByRole("img", { name: "Thinking: xhigh" });
      expect(barFills(glyph)).toEqual(["false", "false", "false"]);
      expect(screen.getByText("xhigh")).toBeDefined();
    });

    // A no-thinking level is off, not the bottom rung: pi ships `off` beside
    // six graded levels, so the ladder is 6 bars and none of them is lit.
    it("lights nothing for a zero-effort level, and names it without a position", () => {
      renderReasoning("bars", "Off", { index: null, count: 6 });

      const glyph = screen.getByRole("img", { name: "Thinking: Off" });
      expect(barFills(glyph)).toEqual([
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
      ]);
      expect(screen.getByText("Off")).toBeDefined();
    });

    it("shows no glyph in model-only, whatever the setting", () => {
      render(
        <HarnessModelTrigger
          selection={SELECTION}
          label="GPT-5.5"
          reasoningLabel="High"
          reasoningStep={{ index: 2, count: 4 }}
          reasoningIndicator="bars"
          serviceTierLabel={null}
          serviceTierActive={false}
          profileLabel={null}
          profileAccentDot={null}
          isLoading={false}
          disabled={false}
          labelDisplay="model-only"
        />,
      );

      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.queryByText("High")).toBeNull();
      expect(
        screen.getByRole("button", { name: "GPT-5.5, Thinking High" }),
      ).toBeDefined();
    });
  });
});
