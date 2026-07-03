import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { EpicNodeIconColorPicker } from "@/components/settings/controls/node-icon-color-picker";
import { SettingsNumberInput } from "@/components/settings/controls/settings-number-input";
import { ThemeModeToggle } from "@/components/settings/controls/theme-mode-toggle";
import { ThemePresetPicker } from "@/components/settings/controls/theme-preset-picker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDesktopZoomBridge } from "@/hooks/runner/use-desktop-zoom-bridge";
import { appLogger } from "@/lib/logger";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings/settings-store";

export function AppearanceSettingsPanel() {
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const themePreset = useSettingsStore((state) => state.themePreset);
  const setThemePreset = useSettingsStore((state) => state.setThemePreset);
  const pointerCursors = useSettingsStore((state) => state.pointerCursors);
  const setPointerCursors = useSettingsStore(
    (state) => state.setPointerCursors,
  );
  const uiFontSize = useSettingsStore((state) => state.uiFontSize);
  const setUiFontSize = useSettingsStore((state) => state.setUiFontSize);
  const codeFontSize = useSettingsStore((state) => state.codeFontSize);
  const setCodeFontSize = useSettingsStore((state) => state.setCodeFontSize);
  const artifactIconColorMode = useSettingsStore(
    (state) => state.artifactIconColorMode,
  );
  const setArtifactIconColorMode = useSettingsStore(
    (state) => state.setArtifactIconColorMode,
  );
  const artifactIconColors = useSettingsStore(
    (state) => state.artifactIconColors,
  );
  const setArtifactIconColor = useSettingsStore(
    (state) => state.setArtifactIconColor,
  );
  const resetArtifactIconColors = useSettingsStore(
    (state) => state.resetArtifactIconColors,
  );

  return (
    <SettingsPanelShell title="Appearance">
      <SettingsRow
        label="Theme"
        description="Use light, dark, or match your system."
        control={<ThemeModeToggle value={theme} onChange={setTheme} />}
      />
      <SettingsRow
        label="Preset"
        description="Pick a named palette. Full-palette presets override the base surface."
        control={
          <ThemePresetPicker value={themePreset} onChange={setThemePreset} />
        }
      />
      <SettingsRow
        label="Terminal preview"
        description="Live preview of the xterm.js palette for the active theme."
        control={<TerminalPreview />}
      />
      <SettingsRow
        label="Use pointer cursors"
        description="Change the cursor to a pointer when hovering over interactive elements."
        control={
          <Switch
            checked={pointerCursors}
            onCheckedChange={setPointerCursors}
            aria-label="Use pointer cursors"
          />
        }
      />
      <SettingsRow
        label="Artifact icon colors"
        description="Turn on type-specific colors, or leave node icons neutral."
        control={
          <EpicNodeIconColorPicker
            enabled={artifactIconColorMode === "byType"}
            onEnabledChange={(enabled) => {
              setArtifactIconColorMode(enabled ? "byType" : "none");
            }}
            colors={artifactIconColors}
            onChange={setArtifactIconColor}
            onReset={resetArtifactIconColors}
          />
        }
      />
      <DesktopZoomSettingsRow />
      <SettingsRow
        label="UI font size"
        description="Adjust the base size used for the Traycer UI."
        control={
          <SettingsNumberInput
            value={uiFontSize}
            onChange={setUiFontSize}
            min={10}
            max={24}
            unit="px"
            ariaLabel="UI font size"
          />
        }
      />
      <SettingsRow
        label="Code font size"
        description="Adjust the base size used for code across chats and diffs."
        control={
          <SettingsNumberInput
            value={codeFontSize}
            onChange={setCodeFontSize}
            min={10}
            max={24}
            unit="px"
            ariaLabel="Code font size"
          />
        }
      />
    </SettingsPanelShell>
  );
}

function DesktopZoomSettingsRow() {
  const zoom = useDesktopZoomBridge();
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    if (zoom === null) return;
    let disposed = false;
    void zoom
      .get()
      .then((nextPercent) => {
        if (!disposed) setPercent(nextPercent);
      })
      .catch((err) => {
        appLogger.errorSummary("[zoom] settings read failed", {}, err);
      });
    const subscription = zoom.onChange((nextPercent) => {
      setPercent(nextPercent);
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [zoom]);

  if (zoom === null) {
    return null;
  }

  return (
    <>
      <div className="border-b border-border/40 bg-muted/20 px-5 py-3 text-ui-xs font-semibold text-muted-foreground uppercase">
        Display
      </div>
      <SettingsRow
        label="Zoom"
        description="Scales the whole app; font sizes only adjust typography."
        control={
          <div className="flex items-center gap-2">
            <Select
              value={percent === null ? undefined : String(percent)}
              onValueChange={(value) => {
                const nextPercent = Number.parseInt(value, 10);
                if (!Number.isFinite(nextPercent)) return;
                void zoom.set(nextPercent).catch((err) => {
                  appLogger.errorSummary("[zoom] settings set failed", {}, err);
                });
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Display zoom"
                className="w-[min(40vw,8rem)]"
              >
                <SelectValue placeholder="Loading" />
              </SelectTrigger>
              <SelectContent>
                {zoom.ladder.map((candidate) => (
                  <SelectItem key={candidate} value={String(candidate)}>
                    {formatZoomPercent(candidate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void zoom.reset().catch((err) => {
                  appLogger.errorSummary(
                    "[zoom] settings reset failed",
                    {},
                    err,
                  );
                });
              }}
            >
              <RotateCcw aria-hidden="true" />
              Reset
            </Button>
          </div>
        }
      />
    </>
  );
}

function formatZoomPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/**
 * Pure-CSS-var preview of the active terminal palette. Renders no xterm
 * instance - the fake prompt + ANSI-colored output reads `--term-ansi-*`
 * directly so the cascade re-paints in lockstep with the Preset picker
 * above. Decorative; `aria-hidden` because the surrounding rows already
 * convey the same information textually.
 */
function TerminalPreview() {
  return (
    <div
      className="w-full overflow-hidden rounded-md border border-border bg-background font-mono text-code-sm text-foreground"
      aria-hidden="true"
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-muted px-3 py-1.5">
        <span className="size-2.5 rounded-full bg-[var(--term-ansi-red)]" />
        <span className="size-2.5 rounded-full bg-[var(--term-ansi-yellow)]" />
        <span className="size-2.5 rounded-full bg-[var(--term-ansi-green)]" />
        <span className="ml-2 text-ui-xs text-muted-foreground">terminal</span>
      </div>
      <div className="space-y-0.5 px-3 py-2 leading-snug">
        <div>
          <span className="text-[var(--term-ansi-green)]">$</span>{" "}
          <span>git status</span>
        </div>
        <div className="text-[var(--term-ansi-cyan)]">On branch main</div>
        <div>Changes to be committed:</div>
        <div className="text-[var(--term-ansi-green)]">
          {"  modified: src/index.css"}
        </div>
        <div className="text-[var(--term-ansi-red)]">
          {"  deleted:  legacy/old.ts"}
        </div>
        <div className="text-[var(--term-ansi-yellow)]">
          {"  untracked: foo.txt"}
        </div>
        <div className="rounded-sm bg-[color-mix(in_oklch,var(--primary)_30%,transparent)] px-1 py-0.5">
          <span className="text-[var(--term-ansi-blue)]">$ npm test</span>
        </div>
      </div>
    </div>
  );
}
