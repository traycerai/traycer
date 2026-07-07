import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { EpicNodeIconColorPicker } from "@/components/settings/controls/node-icon-color-picker";
import { SettingsNumberInput } from "@/components/settings/controls/settings-number-input";
import { NullableFontSizeInput } from "@/components/settings/controls/nullable-font-size-input";
import { FontPicker } from "@/components/settings/controls/font-picker";
import { ThemeModeToggle } from "@/components/settings/controls/theme-mode-toggle";
import { TerminalCursorStylePicker } from "@/components/settings/controls/terminal-cursor-style-picker";
import { ThemePresetPicker } from "@/components/settings/controls/theme-preset-picker";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useDesktopZoomBridge } from "@/hooks/runner/use-desktop-zoom-bridge";
import {
  useRunnerZoomChangeSubscription,
  useRunnerZoomPercentQuery,
  useRunnerZoomResetMutation,
  useRunnerZoomSetMutation,
} from "@/hooks/runner/use-runner-zoom";
import { formatZoomPercent } from "@/lib/windows/format-zoom-percent";
import { Switch } from "@/components/ui/switch";
import {
  useSettingsStore,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_CODE_FONT_SIZE,
  type TerminalCursorStyle,
} from "@/stores/settings/settings-store";
import { cn } from "@/lib/utils";
import { useRunnerInstalledFontsQuery } from "@/hooks/runner/use-runner-installed-fonts-query";

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
  const uiFontFamily = useSettingsStore((state) => state.uiFontFamily);
  const setUiFontFamily = useSettingsStore((state) => state.setUiFontFamily);
  const codeFontFamily = useSettingsStore((state) => state.codeFontFamily);
  const setCodeFontFamily = useSettingsStore(
    (state) => state.setCodeFontFamily,
  );
  const terminalFontFamily = useSettingsStore(
    (state) => state.terminalFontFamily,
  );
  const setTerminalFontFamily = useSettingsStore(
    (state) => state.setTerminalFontFamily,
  );
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useSettingsStore(
    (state) => state.setTerminalFontSize,
  );
  const terminalCursorStyle = useSettingsStore(
    (state) => state.terminalCursorStyle,
  );
  const setTerminalCursorStyle = useSettingsStore(
    (state) => state.setTerminalCursorStyle,
  );
  const terminalCursorBlink = useSettingsStore(
    (state) => state.terminalCursorBlink,
  );
  const setTerminalCursorBlink = useSettingsStore(
    (state) => state.setTerminalCursorBlink,
  );
  const installedFontsQuery = useRunnerInstalledFontsQuery();
  const installedFonts = useMemo(
    () => installedFontsQuery.data ?? [],
    [installedFontsQuery.data],
  );
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
        label="UI font"
        description="Font and size used across the Traycer interface."
        control={
          <div className="flex flex-col items-end gap-2">
            <FontPicker
              value={uiFontFamily}
              onChange={setUiFontFamily}
              options={installedFonts}
              defaultLabel="Figtree (Default)"
              resetTooltip="Reset to default"
              ariaLabel="UI font"
            />
            <SettingsNumberInput
              value={uiFontSize}
              onChange={setUiFontSize}
              min={10}
              max={20}
              unit="px"
              ariaLabel="UI font size"
              defaultValue={DEFAULT_UI_FONT_SIZE}
              resetTooltip="Reset to default"
            />
          </div>
        }
      />
      <SettingsRow
        label="Code font"
        description="Font and size used for code across chats and diffs."
        control={
          <div className="flex flex-col items-end gap-2">
            <FontPicker
              value={codeFontFamily}
              onChange={setCodeFontFamily}
              options={installedFonts}
              defaultLabel="System Default"
              resetTooltip="Reset to default"
              ariaLabel="Code font"
            />
            <SettingsNumberInput
              value={codeFontSize}
              onChange={setCodeFontSize}
              min={10}
              max={24}
              unit="px"
              ariaLabel="Code font size"
              defaultValue={DEFAULT_CODE_FONT_SIZE}
              resetTooltip="Reset to default"
            />
          </div>
        }
      />
      <SettingsRow
        label="Terminal font"
        description="Font and size used in the terminal. Follows the code font until you set them."
        control={
          <div className="flex flex-col items-end gap-2">
            <FontPicker
              value={terminalFontFamily}
              onChange={setTerminalFontFamily}
              options={installedFonts}
              defaultLabel="Same as code font"
              resetTooltip="Use code font"
              ariaLabel="Terminal font"
            />
            <NullableFontSizeInput
              value={terminalFontSize}
              followValue={codeFontSize}
              onChange={setTerminalFontSize}
              min={10}
              max={24}
              ariaLabel="Terminal font size"
              resetTooltip="Follow code size"
            />
          </div>
        }
      />
      <SettingsRow
        label="Terminal cursor"
        description="Shape of the cursor in the terminal."
        control={
          <TerminalCursorStylePicker
            value={terminalCursorStyle}
            onChange={setTerminalCursorStyle}
          />
        }
      />
      <SettingsRow
        label="Blink cursor"
        description="Blink the terminal cursor while the terminal is focused."
        control={
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={setTerminalCursorBlink}
            aria-label="Blink terminal cursor"
          />
        }
      />
    </SettingsPanelShell>
  );
}

function DesktopZoomSettingsRow() {
  const zoom = useDesktopZoomBridge();
  const zoomQuery = useRunnerZoomPercentQuery(zoom);
  const setMutation = useRunnerZoomSetMutation(zoom);
  const resetMutation = useRunnerZoomResetMutation(zoom);
  useRunnerZoomChangeSubscription(zoom);
  const percent = zoomQuery.data ?? null;

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
              value={percent === null ? "loading" : String(percent)}
              disabled={setMutation.isPending || resetMutation.isPending}
              onValueChange={(value) => {
                const nextPercent = Number.parseInt(value, 10);
                if (!Number.isFinite(nextPercent)) return;
                setMutation.mutate(nextPercent);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Display zoom"
                className="w-[min(40vw,8rem)]"
              >
                <span data-slot="select-value">
                  {percent === null ? "Loading" : formatZoomPercent(percent)}
                </span>
              </SelectTrigger>
              <SelectContent>
                {percent === null ? (
                  <SelectItem value="loading" disabled>
                    Loading
                  </SelectItem>
                ) : null}
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
              disabled={resetMutation.isPending}
              onClick={() => {
                resetMutation.mutate();
              }}
            >
              <RotateCcw aria-hidden="true" />
              Reset
              {resetMutation.isPending ? (
                <AgentSpinningDots
                  className="ml-1 text-current"
                  testId="desktop-zoom-settings-reset-pending"
                  variant="dots2"
                />
              ) : null}
            </Button>
          </div>
        }
      />
    </>
  );
}

/**
 * Pure-CSS-var preview of the active terminal palette. Renders no xterm
 * instance - the fake prompt + ANSI-colored output reads `--term-ansi-*`
 * directly so the cascade re-paints in lockstep with the Preset picker
 * above. Decorative; `aria-hidden` because the surrounding rows already
 * convey the same information textually.
 */
function TerminalPreview() {
  const cursorStyle = useSettingsStore((state) => state.terminalCursorStyle);
  const cursorBlink = useSettingsStore((state) => state.terminalCursorBlink);
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
        <div>
          <span className="text-[var(--term-ansi-green)]">$</span>{" "}
          <PreviewCursor style={cursorStyle} blink={cursorBlink} />
        </div>
      </div>
    </div>
  );
}

// Live cursor glyph for the preview - mirrors the chosen shape/blink so the
// setting is tangible without spinning up an xterm instance. The lit rect uses
// the terminal foreground token so it tracks the active theme.
const PREVIEW_CURSOR_SHAPE_CLASS: Record<TerminalCursorStyle, string> = {
  block: "inset-0",
  bar: "top-0 bottom-0 left-0 w-[2px]",
  underline: "right-0 bottom-0 left-0 h-[2px]",
};

function PreviewCursor(props: { style: TerminalCursorStyle; blink: boolean }) {
  return (
    <span className="relative inline-block h-[1.1em] w-[0.6ch] align-text-bottom">
      <span
        className={cn(
          "absolute bg-foreground",
          PREVIEW_CURSOR_SHAPE_CLASS[props.style],
          props.blink && "motion-safe:animate-caret-blink",
        )}
      />
    </span>
  );
}
