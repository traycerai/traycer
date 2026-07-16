import { THEME_PRESETS } from "@/lib/theme-presets";
import { cn } from "@/lib/utils";
import {
  useSettingsStore,
  type ThemeMode,
} from "@/stores/settings/settings-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

/**
 * Theme act controls. Writes straight to the real settings store, so the
 * theme-applier flips the `<html>` token cascade instantly and the diorama
 * (styled with semantic tokens) repaints live while the cinematic shell
 * around it stays dark. Choices persist - this *is* the appearance setting.
 */
export function OnboardingThemePicker() {
  const theme = useSettingsStore((state) => state.theme);
  const themePreset = useSettingsStore((state) => state.themePreset);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const setThemePreset = useSettingsStore((state) => state.setThemePreset);

  const activePreset = THEME_PRESETS.find((p) => p.id === themePreset);

  return (
    <div className="flex flex-col items-center gap-4 lg:items-start">
      <div
        role="group"
        aria-label="Theme mode"
        className="flex w-fit overflow-hidden rounded-md border border-white/20"
      >
        {MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            aria-pressed={theme === mode.id}
            onClick={() => {
              if (mode.id === theme) return;
              Analytics.getInstance().track(
                AnalyticsEvent.OnboardingThemeChanged,
                { theme: `mode:${mode.id}` },
              );
              setTheme(mode.id);
            }}
            className={cn(
              "px-3 py-1.5 font-mono text-overline uppercase tracking-wider transition-colors duration-200",
              theme === mode.id
                ? "bg-white text-black"
                : "text-white/55 hover:text-white",
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div
        role="group"
        aria-label="Theme preset"
        className="flex w-full max-w-[min(90vw,24rem)] flex-wrap gap-2"
      >
        {THEME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={themePreset === preset.id}
            aria-label={preset.label}
            title={preset.label}
            onClick={() => {
              if (preset.id === themePreset) return;
              Analytics.getInstance().track(
                AnalyticsEvent.OnboardingThemeChanged,
                { theme: `preset:${preset.id}` },
              );
              setThemePreset(preset.id);
            }}
            className={cn(
              "relative size-7 shrink-0 overflow-hidden rounded-full border transition-transform duration-200",
              themePreset === preset.id
                ? "scale-110 border-white"
                : "border-white/25 hover:scale-105 hover:border-white/60",
            )}
            style={{ backgroundColor: preset.swatch }}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-1/3"
              style={{ backgroundColor: preset.accent }}
            />
          </button>
        ))}
      </div>

      <p
        aria-live="polite"
        className="font-mono text-overline uppercase tracking-wider text-white/65"
      >
        {activePreset === undefined ? "" : activePreset.label}
      </p>
    </div>
  );
}
