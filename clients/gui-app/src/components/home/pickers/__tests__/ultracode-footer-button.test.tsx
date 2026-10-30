import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UltracodeFooterButton } from "@/components/home/pickers/ultracode-footer-button";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import type { UltracodeStyle } from "@/lib/layout/layout-values";

/**
 * The picker's Ultracode row: a native switch named by its label, the exact
 * single-line hint, and a disabled switch (with the normal hint) while the
 * model's eligibility is unknown. Nothing here reads a build constant, so the
 * production build, where the global unreleased switch is off, shows the same
 * row. The trigger draws the request after the effort, as Layout ▸ Model ▸
 * Ultracode asks, only for a requested saved intent.
 */

afterEach(() => {
  cleanup();
});

function renderRow(input: {
  readonly requested: boolean;
  readonly offered: boolean | undefined;
  readonly carried: boolean;
}) {
  const onChange = vi.fn<(next: boolean) => void>();
  render(
    <UltracodeFooterButton
      requested={input.requested}
      offered={input.offered}
      carried={input.carried}
      modelLabel="Opus 5.5"
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("<UltracodeFooterButton />", () => {
  it("an offering model shows the normal hint and turns the request on", () => {
    const onChange = renderRow({
      requested: false,
      offered: true,
      carried: true,
    });

    const toggle = screen.getByRole("switch", { name: "Ultracode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByText("Multi-agent · uses more of your limits"),
    ).toBeDefined();

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("turns a saved request off from an offering model", () => {
    const onChange = renderRow({
      requested: true,
      offered: true,
      carried: true,
    });

    const toggle = screen.getByRole("switch", { name: "Ultracode" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("an excluded model replaces the hint with the reason and cannot be toggled", () => {
    const onChange = renderRow({
      requested: true,
      offered: false,
      carried: true,
    });

    expect(screen.getByText("Not offered for Opus 5.5")).toBeDefined();
    expect(
      screen.queryByText("Multi-agent · uses more of your limits"),
    ).toBeNull();
    const toggle = screen.getByRole("switch", { name: "Ultracode" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unknown eligibility keeps the normal hint on a disabled switch", () => {
    const onChange = renderRow({
      requested: false,
      offered: undefined,
      carried: true,
    });

    expect(
      screen.getByText("Multi-agent · uses more of your limits"),
    ).toBeDefined();
    const toggle = screen.getByRole("switch", { name: "Ultracode" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a surface that cannot carry the request keeps the row, checked and disabled, with the normal hint", () => {
    const onChange = renderRow({
      requested: true,
      offered: true,
      carried: false,
    });

    expect(
      screen.getByText("Multi-agent · uses more of your limits"),
    ).toBeDefined();
    const toggle = screen.getByRole("switch", { name: "Ultracode" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("<HarnessModelTrigger /> Ultracode mark", () => {
  function renderTrigger(
    ultracode: UltracodeStyle | null,
    labelDisplay: "responsive" | "model-only",
  ) {
    render(
      <HarnessModelTrigger
        selection={{ harnessId: "claude", modelSlug: "opus", profileId: null }}
        label="Opus 5.5"
        reasoningLabel="High"
        reasoningStep={null}
        reasoningIndicator="text"
        serviceTierLabel={null}
        serviceTierActive={false}
        ultracode={ultracode}
        profileLabel={null}
        profileAccentDot={null}
        isLoading={false}
        disabled={false}
        labelDisplay={labelDisplay}
      />,
    );
  }

  it.each([
    ["text", "responsive", "ClaudeOpus 5.5·High·Ultracode", false],
    ["text", "model-only", "ClaudeOpus 5.5·Ultracode", false],
    ["icon", "responsive", "ClaudeOpus 5.5·High·", true],
    ["icon-text", "responsive", "ClaudeOpus 5.5·High·Ultracode", true],
    ["icon-text", "model-only", "ClaudeOpus 5.5·Ultracode", true],
  ] as const)(
    "draws the %s style after the %s label",
    (style, labelDisplay, written, icon) => {
      renderTrigger(style, labelDisplay);
      const trigger = screen.getByRole("button");
      expect(trigger.textContent).toBe(written);
      expect(
        within(trigger).queryByTestId("model-ultracode-icon") !== null,
      ).toBe(icon);
      expect(trigger.getAttribute("aria-label")).toBe(
        "Opus 5.5, Thinking High, Ultracode requested",
      );
    },
  );

  it("draws nothing without a request", () => {
    renderTrigger(null, "responsive");
    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toBe("ClaudeOpus 5.5·High");
    expect(within(trigger).queryByTestId("model-ultracode-icon")).toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("Opus 5.5, Thinking High");
  });
});
