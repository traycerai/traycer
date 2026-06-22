import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceTierToggle } from "@/components/home/toolbar/service-tier-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ModelOption } from "@/components/home/data/landing-options";

function makeModel(overrides: Partial<ModelOption> | undefined): ModelOption {
  return {
    harnessId: "codex",
    slug: "gpt-5.5",
    label: "GPT-5.5",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
    ...(overrides ?? {}),
  };
}

function renderToggle(props: {
  selectedModel: ModelOption | null;
  value: string;
  onChange?: (next: string) => void;
}) {
  return render(
    <TooltipProvider>
      <ServiceTierToggle
        selectedModel={props.selectedModel}
        value={props.value}
        onChange={props.onChange ?? (() => undefined)}
      />
    </TooltipProvider>,
  );
}

describe("<ServiceTierToggle />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when the model is still loading", () => {
    const { container } = renderToggle({ selectedModel: null, value: "" });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the model advertises no tiers", () => {
    const { container } = renderToggle({
      selectedModel: makeModel({ supportedServiceTiers: [] }),
      value: "",
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders the upgrade-tier label even when the live shape lists only the upgrade entry", () => {
    // Mirrors live Codex (0.132.0): `serviceTiers: [{ id: "priority" }]`,
    // no `defaultServiceTier`. The toggle should surface the upgrade.
    renderToggle({
      selectedModel: makeModel({
        supportedServiceTiers: [
          {
            id: "priority",
            label: "Fast",
            description: "1.5x speed",
          },
        ],
      }),
      value: "",
    });
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("Fast");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("skips past the model's defaultServiceTier and surfaces the upgrade tier", () => {
    // The two-tier shape: a literal "default" entry plus an upgrade. The
    // toggle must NOT pick `supportedServiceTiers[0]` (that's the default);
    // it should flip to the non-default tier so clicking ON actually
    // upgrades the speed.
    const onChange = vi.fn();
    renderToggle({
      selectedModel: makeModel({
        defaultServiceTier: "default",
        supportedServiceTiers: [
          { id: "default", label: "Default", description: null },
          { id: "fast", label: "Fast", description: null },
        ],
      }),
      value: "",
      onChange,
    });
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith("fast");
  });

  it("renders as pressed when the stored value matches the upgrade tier id", () => {
    renderToggle({
      selectedModel: makeModel({
        supportedServiceTiers: [
          { id: "priority", label: "Fast", description: null },
        ],
      }),
      value: "priority",
    });
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("toggles OFF (sends empty string) when clicked while active", () => {
    const onChange = vi.fn();
    renderToggle({
      selectedModel: makeModel({
        supportedServiceTiers: [
          { id: "priority", label: "Fast", description: null },
        ],
      }),
      value: "priority",
      onChange,
    });
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("is hidden when the stored preference doesn't match the current model's tier id (sticky preference, no destructive overwrite)", () => {
    // User had `priority` on Codex; now selected a non-Codex model with
    // no tiers. Toggle hides - but the parent's `value` prop stays as
    // `"priority"`. Switching back to a Codex model that advertises
    // `priority` will re-show the toggle with aria-pressed=true. (This
    // is the renderer half of the sticky-preference contract; the wire
    // filter lives in the codex-adapter.)
    const { container } = renderToggle({
      selectedModel: makeModel({
        slug: "claude-sonnet-4-6",
        harnessId: "claude",
        supportedServiceTiers: [],
      }),
      value: "priority",
    });
    expect(container.firstChild).toBeNull();
  });
});
