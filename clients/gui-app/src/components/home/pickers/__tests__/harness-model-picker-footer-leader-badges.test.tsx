import {
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
  type ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type {
  ModelOption,
  ReasoningLevelOption,
} from "@/components/home/data/landing-options";
import {
  LeaderHeldContext,
  type LeaderState,
} from "@/providers/keybinding-context";
import { LEADER_SCOPE_MODEL_PICKER } from "@/lib/keybindings/leader-scope";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// Renders the footer as if the picker's own `⌥`-hold state said so - the
// footer's badges read `LeaderHeldContext` directly (via
// `usePickerFastModeLeader` / `usePickerReasoningLeaderForIndex`), so a real
// alt-held hint needs this context rather than a raw keydown (no
// `KeybindingProvider` is mounted in this unit).
const ALT_HELD_BY_PICKER: LeaderState = {
  modHeld: false,
  altHeld: true,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: LEADER_SCOPE_MODEL_PICKER,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

const ALT_NOT_HELD: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

function levelOptions(count: number): ReadonlyArray<ReasoningLevelOption> {
  return Array.from({ length: count }, (_, i) => ({
    id: `level-${i + 1}`,
    label: `Level ${i + 1}`,
    description: null,
  }));
}

function modelWithFastUpgrade(): ModelOption {
  return {
    harnessId: "codex",
    slug: "gpt-test",
    label: "GPT Test",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: "standard",
    supportedServiceTiers: [
      { id: "standard", label: "Standard", description: null },
      { id: "fast", label: "Fast", description: null },
    ],
    deprecationNotice: null,
    metadata: {},
  };
}

function serviceTierConfig(): ServiceTierFooterConfig {
  return {
    selectedModel: modelWithFastUpgrade(),
    value: "",
    onChange: vi.fn(),
  };
}

function reasoningConfig(disabled: boolean): ReasoningFooterConfig {
  return {
    value: "low",
    options: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    disabled,
    onChange: vi.fn(),
  };
}

function reasoningConfigWithLevels(
  count: number,
  selectedIndex: number,
  disabled: boolean,
): ReasoningFooterConfig {
  const options = levelOptions(count);
  return {
    value: options[selectedIndex].id,
    options,
    disabled,
    onChange: vi.fn(),
  };
}

function renderFooter(
  config: ReasoningFooterConfig,
  leaderState: LeaderState,
): RenderResult {
  return render(
    <LeaderHeldContext.Provider value={leaderState}>
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={config}
        serviceTier={serviceTierConfig()}
      />
    </LeaderHeldContext.Provider>,
  );
}

function renderUnderAltHold(config: ReasoningFooterConfig): void {
  renderFooter(config, ALT_HELD_BY_PICKER);
}

// The Fast button and its digit-0 badge sit in `ModelSettingsFooter` above
// (and independently of) the reasoning group, so ⌥0 must light the same way
// whichever control - list or slider - Layout ▸ Composer ▸ Reasoning renders
// the levels through.
describe.each(["list", "slider"] as const)(
  "<HarnessModelPickerModelSettingsFooter /> Fast leader badge (%s control)",
  (control) => {
    beforeEach(() => {
      useLayoutStore.setState({
        composer: {
          ...DEFAULT_COMPOSER_LAYOUT,
          reasoningFooterControl: control,
        },
      });
    });

    afterEach(() => {
      cleanup();
      useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
    });

    it("shows the Fast digit-0 badge on the rendered Fast button while ⌥ is held", () => {
      renderUnderAltHold(reasoningConfig(false));

      const badge = screen.getByTestId("model-fast-mode-digit-0");
      expect(badge.textContent).toBe("0");
      // The badge itself is `aria-hidden`; the spoken hint lives on the
      // button's own accessible name instead (`pickerLeaderControlLabel`).
      const fastButton = screen.getByRole("button", {
        name: "Fast mode. Press Alt+0 to toggle Fast mode",
      });
      expect(fastButton.contains(badge)).toBe(true);
    });

    it("drops the spoken hint from the Fast button's name once ⌥ is released", () => {
      renderFooter(reasoningConfig(false), ALT_NOT_HELD);

      expect(screen.getByRole("button", { name: "Fast mode" })).not.toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "Fast mode. Press Alt+0 to toggle Fast mode",
        }),
      ).toBeNull();
    });

    it("keeps the Fast digit-0 badge lit even while the reasoning ladder is disabled", () => {
      renderUnderAltHold(reasoningConfig(true));

      expect(screen.getByTestId("model-fast-mode-digit-0")).not.toBeNull();
    });

    // The compact slider puts Fast’s shortcut in its icon slot; list mode
    // keeps the trailing badge beside its label.
    it(`places the Fast badge within the ${control} layout`, () => {
      renderUnderAltHold(reasoningConfig(false));

      const badge = screen.getByTestId("model-fast-mode-digit-0");
      expect(badge.className).toContain(
        control === "slider" ? "left-1/2" : "left-full",
      );
      if (control === "slider") {
        const icon = badge.parentElement?.querySelector("svg");
        expect(icon?.getAttribute("class")).toContain("invisible");
      }
      expect(badge.className).not.toContain("bottom-full");
    });
  },
);

// Digit badges on individual thinking-level pills (`model-reasoning-digit-N`)
// under the list control (`ReasoningLevelButton`).
describe("<HarnessModelPickerModelSettingsFooter /> reasoning leader badges (list control)", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, reasoningFooterControl: "list" },
    });
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  });

  it("shows reasoning digit badges 1-9 alongside the Fast badge when levels are enabled", () => {
    renderUnderAltHold(reasoningConfig(false));

    expect(screen.getByTestId("model-fast-mode-digit-0")).not.toBeNull();
    expect(screen.getByTestId("model-reasoning-digit-1").textContent).toBe("1");
    expect(screen.getByTestId("model-reasoning-digit-2").textContent).toBe("2");
  });

  it("hides reasoning digit badges while the ladder is disabled, but keeps the Fast badge", () => {
    renderUnderAltHold(reasoningConfig(true));

    expect(screen.queryByTestId("model-reasoning-digit-1")).toBeNull();
    expect(screen.queryByTestId("model-reasoning-digit-2")).toBeNull();
    // Fast reserves ⌥0 unconditionally - a disabled reasoning ladder must not
    // hide it.
    expect(screen.getByTestId("model-fast-mode-digit-0")).not.toBeNull();
  });

  it("names the spoken hint on the pill's own accessible name, not the (aria-hidden) badge", () => {
    renderUnderAltHold(reasoningConfig(false));

    const lowPill = screen.getByRole("button", {
      name: "Low. Press Alt+1 to set Low",
    });
    expect(
      lowPill.contains(screen.getByTestId("model-reasoning-digit-1")),
    ).toBe(true);
    expect(
      screen.getByTestId("model-reasoning-digit-1").getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("leaves a disabled pill's accessible name unhinted even while ⌥ is held", () => {
    renderUnderAltHold(reasoningConfig(true));

    expect(screen.getByRole("button", { name: "Low" })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Low. Press Alt+1 to set Low" }),
    ).toBeNull();
  });
});

// The slider now carries the same per-stop digit badges the list pills do
// (`ReasoningLevelStop`, restored on top of the track). This block is the
// regression coverage for that restoration and the fixes that came with it:
// the selected stop's badge must survive (only its dot goes to opacity-0, not
// the stop container - the container instead goes `pointer-events-none`), the
// 10th stop still never claims digit "0" (`PICKER_REASONING_LEADER_INDEX_LIMIT`
// caps it, matching the list), and the badges react live to holding/releasing
// the leader modifier.
describe("<HarnessModelPickerModelSettingsFooter /> reasoning leader badges (slider control)", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      composer: {
        ...DEFAULT_COMPOSER_LAYOUT,
        reasoningFooterControl: "slider",
      },
    });
  });

  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  });

  it("shows reasoning digit badges 1-9 on every stop, including the selected one", () => {
    // Six levels, third one (index 2) selected.
    renderFooter(reasoningConfigWithLevels(6, 2, false), ALT_HELD_BY_PICKER);

    expect(screen.getByTestId("model-fast-mode-digit-0")).not.toBeNull();
    for (let digit = 1; digit <= 6; digit += 1) {
      expect(
        screen.getByTestId(`model-reasoning-digit-${digit}`).textContent,
      ).toBe(String(digit));
    }
    // The selected stop (digit 3) is not swallowed by a parent `opacity-0` -
    // only its dot goes transparent, so the badge stays visible and the
    // stop's own `pointer-events-none` is what keeps it inert to clicks.
    const selectedBadge = screen.getByTestId("model-reasoning-digit-3");
    const selectedStop = selectedBadge.closest("button");
    expect(selectedStop).not.toBeNull();
    expect(selectedStop?.className).not.toMatch(/\bopacity-0\b/);
    expect(selectedStop?.className).toContain("pointer-events-none");
  });

  it("reserves digit 0 for Fast on a ten-stop ladder - the tenth stop shows no digit badge", () => {
    renderFooter(reasoningConfigWithLevels(10, 0, false), ALT_HELD_BY_PICKER);

    expect(screen.getByTestId("model-reasoning-digit-9")).not.toBeNull();
    expect(screen.queryByTestId("model-reasoning-digit-0")).toBeNull();
    // Fast still claims "0" on its own button, independent of the ladder.
    expect(screen.getByTestId("model-fast-mode-digit-0").textContent).toBe("0");
  });

  it("hides every stop's digit badge while the ladder is disabled, but keeps the Fast badge", () => {
    renderFooter(reasoningConfigWithLevels(6, 0, true), ALT_HELD_BY_PICKER);

    for (let digit = 1; digit <= 6; digit += 1) {
      expect(screen.queryByTestId(`model-reasoning-digit-${digit}`)).toBeNull();
    }
    expect(screen.getByTestId("model-fast-mode-digit-0")).not.toBeNull();
  });

  it("names the spoken hint on the stop button's own accessible name, not the (aria-hidden) badge", () => {
    renderFooter(reasoningConfigWithLevels(6, 2, false), ALT_HELD_BY_PICKER);

    const stop = screen.getByTestId("model-reasoning-stop-0");
    expect(stop.getAttribute("aria-label")).toBe(
      "Level 1. Press Alt+1 to set Level 1",
    );
    expect(
      screen.getByTestId("model-reasoning-digit-1").getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("leaves a disabled stop's accessible name unhinted even while ⌥ is held", () => {
    renderFooter(reasoningConfigWithLevels(6, 2, true), ALT_HELD_BY_PICKER);

    expect(
      screen.getByTestId("model-reasoning-stop-0").getAttribute("aria-label"),
    ).toBe("Level 1");
  });

  it("shows and hides stop badges live as the leader modifier is held and released", () => {
    const view = renderFooter(
      reasoningConfigWithLevels(6, 0, false),
      ALT_NOT_HELD,
    );

    expect(screen.queryByTestId("model-reasoning-digit-1")).toBeNull();
    expect(screen.queryByTestId("model-fast-mode-digit-0")).toBeNull();

    view.rerender(
      <LeaderHeldContext.Provider value={ALT_HELD_BY_PICKER}>
        <HarnessModelPickerModelSettingsFooter
          pickerOpen
          reasoning={reasoningConfigWithLevels(6, 0, false)}
          serviceTier={serviceTierConfig()}
        />
      </LeaderHeldContext.Provider>,
    );
    expect(screen.getByTestId("model-reasoning-digit-1")).not.toBeNull();
    expect(screen.getByTestId("model-fast-mode-digit-0")).not.toBeNull();

    view.rerender(
      <LeaderHeldContext.Provider value={ALT_NOT_HELD}>
        <HarnessModelPickerModelSettingsFooter
          pickerOpen
          reasoning={reasoningConfigWithLevels(6, 0, false)}
          serviceTier={serviceTierConfig()}
        />
      </LeaderHeldContext.Provider>,
    );
    expect(screen.queryByTestId("model-reasoning-digit-1")).toBeNull();
    expect(screen.queryByTestId("model-fast-mode-digit-0")).toBeNull();
  });
});
