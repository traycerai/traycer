import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domMax } from "motion/react";
import { ThemeProvider } from "@/providers/theme-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { THEME_PRESETS, type ThemePreset } from "@/lib/theme-presets";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
  type ComposerReasoningFooterControl,
} from "@/stores/settings/layout-store";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
  type ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import type {
  ModelOption,
  ReasoningLevel,
  ReasoningLevelOption,
  ServiceTier,
} from "@/components/home/data/landing-options";
import {
  LeaderHeldContext,
  type LeaderState,
} from "@/providers/keybinding-context";
import { LEADER_SCOPE_MODEL_PICKER } from "@/lib/keybindings/leader-scope";
import { cn } from "@/lib/utils";
import "@/index.css";

// Manual visual-QA fixture for the reasoning slider / Fast leader-badge
// polish: mounts the REAL `HarnessModelPickerModelSettingsFooter` with real
// `index.css`, so the gradient crossfade, the sparkle field, the per-stop
// digit badges and the Fast toggle all render and behave exactly as they do
// inside the picker. Driven manually (navigate here and click around) - it
// is not an automated regression check.

type ThemeModeChoice = "light" | "dark";
type ReasoningOptionCount = 2 | 3 | 4 | 6 | 10;

// Start with the neutral palette shown in the feedback; controls retain the
// preset switch for checking filled-text contrast across actual app themes.
const DEFAULT_PRESET: ThemePreset = "neutral";

function themeModeFromSelect(value: string): ThemeModeChoice {
  return value === "light" ? "light" : "dark";
}

function themePresetFromSelect(value: string): ThemePreset {
  const found = THEME_PRESETS.find((preset) => preset.id === value);
  return found === undefined ? DEFAULT_PRESET : found.id;
}

function reasoningControlFromSelect(
  value: string,
): ComposerReasoningFooterControl {
  return value === "list" ? "list" : "slider";
}

function optionCountFromSelect(value: string): ReasoningOptionCount {
  if (value === "2") return 2;
  if (value === "3") return 3;
  if (value === "4") return 4;
  return value === "10" ? 10 : 6;
}

const PREVIEW_LEVEL_LABELS: Readonly<
  Record<ReasoningOptionCount, readonly string[]>
> = {
  2: ["Low", "High"],
  3: ["Low", "Medium", "High"],
  4: ["Low", "Medium", "High", "Extra High"],
  6: ["Off", "Low", "Medium", "High", "Extra High", "Max"],
  10: Array.from({ length: 10 }, (_, index) =>
    index === 9 ? "Extended reasoning budget" : `Level ${index + 1}`,
  ),
};

function levelOptions(
  count: ReasoningOptionCount,
): ReadonlyArray<ReasoningLevelOption> {
  return PREVIEW_LEVEL_LABELS[count].map((label, index) => ({
    id: `level-${index + 1}`,
    label,
    description: null,
  }));
}

const FAST_MODEL: ModelOption = {
  harnessId: "codex",
  slug: "gpt-fixture",
  label: "GPT Fixture",
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

const ALT_NOT_HELD: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

const ALT_HELD_BY_PICKER: LeaderState = {
  modHeld: false,
  altHeld: true,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: LEADER_SCOPE_MODEL_PICKER,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

interface ControlsProps {
  readonly mode: ThemeModeChoice;
  readonly onModeChange: (mode: ThemeModeChoice) => void;
  readonly preset: ThemePreset;
  readonly onPresetChange: (preset: ThemePreset) => void;
  readonly control: ComposerReasoningFooterControl;
  readonly onControlChange: (control: ComposerReasoningFooterControl) => void;
  readonly optionCount: ReasoningOptionCount;
  readonly onOptionCountChange: (count: ReasoningOptionCount) => void;
  readonly fastPresent: boolean;
  readonly onFastPresentChange: (present: boolean) => void;
  readonly altHeld: boolean;
  readonly onAltHeldChange: (held: boolean) => void;
}

function labelClass(): string {
  return "flex flex-col gap-1 text-ui-xs text-muted-foreground";
}

function selectClass(): string {
  return "rounded-md border border-border bg-background px-2 py-1 text-ui-sm text-foreground";
}

function Controls(props: ControlsProps): ReactNode {
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card p-4">
      <label className={labelClass()}>
        Theme mode
        <select
          className={selectClass()}
          value={props.mode}
          onChange={(event) =>
            props.onModeChange(themeModeFromSelect(event.target.value))
          }
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>

      <label className={labelClass()}>
        Theme preset
        <select
          className={selectClass()}
          value={props.preset}
          onChange={(event) =>
            props.onPresetChange(themePresetFromSelect(event.target.value))
          }
        >
          {THEME_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className={labelClass()}>
        Reasoning control
        <select
          className={selectClass()}
          value={props.control}
          onChange={(event) =>
            props.onControlChange(
              reasoningControlFromSelect(event.target.value),
            )
          }
        >
          <option value="slider">Slider</option>
          <option value="list">List</option>
        </select>
      </label>

      <label className={labelClass()}>
        Reasoning options
        <select
          className={selectClass()}
          value={String(props.optionCount)}
          onChange={(event) =>
            props.onOptionCountChange(optionCountFromSelect(event.target.value))
          }
        >
          <option value="2">2 levels</option>
          <option value="3">3 levels</option>
          <option value="4">4 levels (Grok order)</option>
          <option value="6">6 levels</option>
          <option value="10">10 levels</option>
        </select>
      </label>

      <label className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={props.fastPresent}
          onChange={(event) => props.onFastPresentChange(event.target.checked)}
        />
        Fast tier present
      </label>

      <label className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={props.altHeld}
          onChange={(event) => props.onAltHeldChange(event.target.checked)}
        />
        Hold ⌥ (leader owns the picker)
      </label>
    </div>
  );
}

export function Fixture(): ReactNode {
  const [mode, setMode] = useState<ThemeModeChoice>("dark");
  const [preset, setPreset] = useState<ThemePreset>(DEFAULT_PRESET);
  const [control, setControl] =
    useState<ComposerReasoningFooterControl>("slider");
  const [optionCount, setOptionCount] = useState<ReasoningOptionCount>(4);
  const [narrow, setNarrow] = useState(false);
  const [fastPresent, setFastPresent] = useState(true);
  const [altHeld, setAltHeld] = useState(false);
  const options = useMemo(() => levelOptions(optionCount), [optionCount]);
  const [reasoningValue, setReasoningValue] = useState<ReasoningLevel>(
    options[0].id,
  );
  const [serviceTierValue, setServiceTierValue] = useState<ServiceTier>("");

  // Each control mirrors into the same live state the real app reads from -
  // `theme-applier.ts` owns the document element's theme attributes, so the
  // fixture drives it through the store rather than poking the DOM itself.
  useEffect(() => {
    useSettingsStore.setState({ theme: mode });
  }, [mode]);

  useEffect(() => {
    useThemeLibraryStore.setState({
      selected: { light: null, dark: null },
      draft: null,
    });
    useSettingsStore.setState({ themePreset: preset });
  }, [preset]);

  useEffect(() => {
    useLayoutStore.getState().setComposerReasoningFooterControl(control);
  }, [control]);

  const reasoning: ReasoningFooterConfig = {
    value: reasoningValue,
    options,
    disabled: false,
    onChange: setReasoningValue,
  };

  const serviceTier: ServiceTierFooterConfig | null = fastPresent
    ? {
        selectedModel: FAST_MODEL,
        value: serviceTierValue,
        onChange: setServiceTierValue,
      }
    : null;

  const leaderState = altHeld ? ALT_HELD_BY_PICKER : ALT_NOT_HELD;
  const selectedIndex = options.findIndex(
    (option) => option.id === reasoningValue,
  );

  return (
    <div className="min-h-safe-dvh bg-background p-5 text-foreground sm:p-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          A smaller reasoning slider
        </h1>
        <p className="mb-6 mt-2 text-ui-sm text-muted-foreground">
          Compact slider with the selected level aligned to the right edge.
        </p>
        <Controls
          mode={mode}
          onModeChange={setMode}
          preset={preset}
          onPresetChange={setPreset}
          control={control}
          onControlChange={setControl}
          optionCount={optionCount}
          onOptionCountChange={(count) => {
            setOptionCount(count);
            setReasoningValue("level-1");
          }}
          fastPresent={fastPresent}
          onFastPresentChange={setFastPresent}
          altHeld={altHeld}
          onAltHeldChange={setAltHeld}
        />

        <label className="my-5 flex items-center gap-2 text-ui-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={narrow}
            onChange={(event) => setNarrow(event.target.checked)}
          />
          Narrow picker
        </label>

        <div className="max-w-md">
          <div
            className={cn(
              "overflow-visible rounded-lg border border-border bg-popover shadow-sm",
              narrow && "w-[85%]",
            )}
          >
            <div className="px-3 py-3">
              <div className="rounded-md bg-foreground/5 px-3 py-2 text-ui-xs text-muted-foreground">
                Search models
              </div>
              <div className="mt-3 flex items-center justify-between rounded-md bg-foreground/8 px-3 py-2 text-ui-sm">
                <span>Selected model</span>
                <span aria-hidden="true">✓</span>
              </div>
            </div>
            <LeaderHeldContext.Provider value={leaderState}>
              <HarnessModelPickerModelSettingsFooter
                pickerOpen
                reasoning={reasoning}
                serviceTier={serviceTier}
              />
            </LeaderHeldContext.Provider>
          </div>
        </div>
        <p className="mt-8 text-ui-xs text-muted-foreground">
          Current level: {options[selectedIndex]?.label ?? reasoningValue}.
          Fast: {serviceTierValue === "" ? "off" : "on"}. Hold the hint checkbox
          to show shortcut placement. The 10-level option includes a long label.
        </p>
      </div>
    </div>
  );
}

// Layout ▸ Composer ▸ Reasoning control persists across sessions via
// localStorage - start every load from the documented default so the
// fixture's own "Reasoning control" select is the single source of truth.
useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(
  <LazyMotion features={domMax}>
    <ThemeProvider>
      <Fixture />
    </ThemeProvider>
  </LazyMotion>,
);
