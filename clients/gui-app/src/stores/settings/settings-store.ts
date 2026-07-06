import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  DEFAULT_PERMISSION,
  DEFAULT_AGENT_MODE,
  DEFAULT_COMPOSER_MODE,
  DEFAULT_REASONING,
  DEFAULT_SELECTION,
  DEFAULT_SERVICE_TIER,
  type PermissionMode,
  type AgentMode,
  type ComposerMode,
  type HarnessModelSelection,
  type ReasoningLevel,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import {
  DEFAULT_EPIC_NODE_ICON_COLORS,
  normalizeEpicNodeIconColor,
  type EpicNodeIconColors,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";
import { DEFAULT_THEME_PRESET, type ThemePreset } from "@/lib/theme-presets";
import {
  DEFAULT_DIFF_VIEWER_PREFERENCES,
  type DiffViewerPreferences,
  type DiffViewerPreferencesPatch,
} from "@/lib/diff/diff-viewer-preferences";
import { type EditorId } from "@traycer/protocol/host";

export type ThemeMode = "system" | "light" | "dark";
export type EpicNodeIconColorMode = "byType" | "none";
// Mirrors xterm's `cursorStyle` union; kept as our own type so the settings
// surface doesn't take a value import from `@xterm/xterm`.
export type TerminalCursorStyle = "block" | "bar" | "underline";

export const DEFAULT_TERMINAL_CURSOR_STYLE: TerminalCursorStyle = "block";
export const DEFAULT_TERMINAL_CURSOR_BLINK = true;

// Shape drawn when the terminal loses focus (xterm's `cursorInactiveStyle`,
// which never blinks). Bar/underline mirror the chosen shape so the cursor
// keeps its identity on blur; block falls back to a hollow outline so an
// unfocused pane stays visually distinct from a focused non-blinking block.
export type TerminalInactiveCursorStyle =
  TerminalCursorStyle | "outline" | "none";

export function inactiveCursorStyleFor(
  style: TerminalCursorStyle,
): TerminalInactiveCursorStyle {
  return style === "block" ? "outline" : style;
}

// Default font sizes, shared with the Appearance panel so its reset-to-default
// affordance and the store's initial state stay a single source of truth.
export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 12;

export interface SettingsState {
  theme: ThemeMode;
  themePreset: ThemePreset;
  defaultSelection: HarnessModelSelection;
  defaultReasoning: ReasoningLevel;
  defaultServiceTier: ServiceTier;
  defaultPermission: PermissionMode;
  defaultAgentMode: AgentMode;
  /**
   * Landing composer surface (chat vs. terminal-agent launcher). Persisted like
   * the other composer defaults so the chosen mode survives restarts.
   */
  composerMode: ComposerMode;
  preventSleepWhileRunning: boolean;
  /**
   * Show a native OS notification when a chat turn finishes while the app
   * window is not focused. On by default; the macOS notification-permission
   * prompt surfaces on the first unfocused completion.
   */
  notifyOnChatTurnComplete: boolean;
  /**
   * Keep the chat context-window breakdown pinned near the composer instead of
   * the compact-only chip. Global preference, default off; chats without
   * reliable context-window data still render nothing.
   */
  pinContextUsageBreakdown: boolean;
  pointerCursors: boolean;
  uiFontSize: number;
  codeFontSize: number;
  /** Chosen UI font family name, or null to use the default (Figtree). */
  uiFontFamily: string | null;
  /** Chosen code font family name, or null to use the default mono stack. */
  codeFontFamily: string | null;
  /**
   * Chosen terminal font family name, or null to follow `codeFontFamily`
   * (which itself falls back to the default mono stack when unset).
   */
  terminalFontFamily: string | null;
  /** Chosen terminal font size, or null to follow `codeFontSize`. */
  terminalFontSize: number | null;
  /** Cursor shape drawn in the terminal (block/bar/underline). */
  terminalCursorStyle: TerminalCursorStyle;
  /** Whether the terminal cursor blinks while the terminal is focused. */
  terminalCursorBlink: boolean;
  artifactIconColorMode: EpicNodeIconColorMode;
  artifactIconColors: EpicNodeIconColors;
  defaultEditor: EditorId | null;
  /**
   * Voice input (on-device dictation). Opt-in: enabling it surfaces the mic
   * button in the composer and prompts the host to download the STT model.
   */
  voiceInputEnabled: boolean;
  /** BCP-47-ish dictation language hint, or "auto". */
  voiceLanguage: string;
  /**
   * Quote-to-composer affordance. Opt-out: enabling it (default) surfaces a
   * quote button when selecting assistant text, inserting the selection into
   * the chat composer as a blockquote.
   */
  quoteReplyEnabled: boolean;
  /**
   * Shared, user-level diff viewer configuration consumed by every git and
   * snapshot diff renderer. Persisted globally so the choice survives restarts
   * and live-updates all mounted viewers. Tile-local state (collapsed files)
   * is not part of this shape - it stays on the diff tile payload.
   */
  diffViewerPreferences: DiffViewerPreferences;
  setTheme: (theme: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
  setDefaultAgentMode: (mode: AgentMode) => void;
  setComposerMode: (mode: ComposerMode) => void;
  setPreventSleepWhileRunning: (value: boolean) => void;
  setNotifyOnChatTurnComplete: (value: boolean) => void;
  setPinContextUsageBreakdown: (value: boolean) => void;
  setPointerCursors: (value: boolean) => void;
  setUiFontSize: (value: number) => void;
  setCodeFontSize: (value: number) => void;
  setUiFontFamily: (value: string | null) => void;
  setCodeFontFamily: (value: string | null) => void;
  setTerminalFontFamily: (value: string | null) => void;
  setTerminalFontSize: (value: number | null) => void;
  setTerminalCursorStyle: (value: TerminalCursorStyle) => void;
  setTerminalCursorBlink: (value: boolean) => void;
  setArtifactIconColorMode: (mode: EpicNodeIconColorMode) => void;
  setArtifactIconColor: (type: EpicNodeKind, color: string) => void;
  resetArtifactIconColors: () => void;
  setDefaultEditor: (id: EditorId | null) => void;
  setVoiceInputEnabled: (value: boolean) => void;
  setVoiceLanguage: (value: string) => void;
  setQuoteReplyEnabled: (value: boolean) => void;
  setDiffViewerPreferences: (preferences: DiffViewerPreferences) => void;
  patchDiffViewerPreferences: (patch: DiffViewerPreferencesPatch) => void;
}

type PersistedSettingsState = Pick<
  SettingsState,
  | "theme"
  | "themePreset"
  | "defaultSelection"
  | "defaultReasoning"
  | "defaultServiceTier"
  | "defaultPermission"
  | "defaultAgentMode"
  | "composerMode"
  | "preventSleepWhileRunning"
  | "notifyOnChatTurnComplete"
  | "pinContextUsageBreakdown"
  | "pointerCursors"
  | "uiFontSize"
  | "codeFontSize"
  | "uiFontFamily"
  | "codeFontFamily"
  | "terminalFontFamily"
  | "terminalFontSize"
  | "terminalCursorStyle"
  | "terminalCursorBlink"
  | "artifactIconColorMode"
  | "artifactIconColors"
  | "defaultEditor"
  | "voiceInputEnabled"
  | "voiceLanguage"
  | "quoteReplyEnabled"
  | "diffViewerPreferences"
>;

type SetFn = (
  update: (state: SettingsState) => Partial<SettingsState> | SettingsState,
) => void;

function makeSetter<K extends keyof SettingsState>(
  set: SetFn,
  key: K,
): (value: SettingsState[K]) => void {
  return (value) => {
    set((s) => (s[key] === value ? s : { [key]: value }));
  };
}

function makeClampedFontSizeSetter<K extends "uiFontSize" | "codeFontSize">(
  set: SetFn,
  key: K,
  clamp: (value: number) => number,
): (value: number) => void {
  return (value) => {
    const next = clamp(value);
    set((s) => (s[key] === next ? s : { [key]: next }));
  };
}

// The UI font size scales the root font-size, so it is capped tighter than
// code/terminal sizes - anything above 20px starts breaking layout.
function clampUiFontSize(value: number): number {
  return Math.max(10, Math.min(20, Math.round(value)));
}

function clampCodeFontSize(value: number): number {
  return Math.max(10, Math.min(24, Math.round(value)));
}

function partializeSettingsState(state: SettingsState): PersistedSettingsState {
  return {
    theme: state.theme,
    themePreset: state.themePreset,
    defaultSelection: state.defaultSelection,
    defaultReasoning: state.defaultReasoning,
    defaultServiceTier: state.defaultServiceTier,
    defaultPermission: state.defaultPermission,
    defaultAgentMode: state.defaultAgentMode,
    composerMode: state.composerMode,
    preventSleepWhileRunning: state.preventSleepWhileRunning,
    notifyOnChatTurnComplete: state.notifyOnChatTurnComplete,
    pinContextUsageBreakdown: state.pinContextUsageBreakdown,
    pointerCursors: state.pointerCursors,
    uiFontSize: state.uiFontSize,
    codeFontSize: state.codeFontSize,
    uiFontFamily: state.uiFontFamily,
    codeFontFamily: state.codeFontFamily,
    terminalFontFamily: state.terminalFontFamily,
    terminalFontSize: state.terminalFontSize,
    terminalCursorStyle: state.terminalCursorStyle,
    terminalCursorBlink: state.terminalCursorBlink,
    artifactIconColorMode: state.artifactIconColorMode,
    artifactIconColors: state.artifactIconColors,
    defaultEditor: state.defaultEditor,
    voiceInputEnabled: state.voiceInputEnabled,
    voiceLanguage: state.voiceLanguage,
    quoteReplyEnabled: state.quoteReplyEnabled,
    diffViewerPreferences: state.diffViewerPreferences,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      themePreset: DEFAULT_THEME_PRESET,
      defaultSelection: DEFAULT_SELECTION,
      defaultReasoning: DEFAULT_REASONING,
      defaultServiceTier: DEFAULT_SERVICE_TIER,
      defaultPermission: DEFAULT_PERMISSION,
      defaultAgentMode: DEFAULT_AGENT_MODE,
      composerMode: DEFAULT_COMPOSER_MODE,
      preventSleepWhileRunning: false,
      notifyOnChatTurnComplete: true,
      pinContextUsageBreakdown: false,
      pointerCursors: true,
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      codeFontSize: DEFAULT_CODE_FONT_SIZE,
      uiFontFamily: null,
      codeFontFamily: null,
      terminalFontFamily: null,
      terminalFontSize: null,
      terminalCursorStyle: DEFAULT_TERMINAL_CURSOR_STYLE,
      terminalCursorBlink: DEFAULT_TERMINAL_CURSOR_BLINK,
      artifactIconColorMode: "byType",
      artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
      defaultEditor: "vscode",
      voiceInputEnabled: true,
      voiceLanguage: "auto",
      quoteReplyEnabled: true,
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
      setTheme: makeSetter(set, "theme"),
      setThemePreset: makeSetter(set, "themePreset"),
      setDefaultAgentMode: makeSetter(set, "defaultAgentMode"),
      setComposerMode: makeSetter(set, "composerMode"),
      setPreventSleepWhileRunning: makeSetter(set, "preventSleepWhileRunning"),
      setNotifyOnChatTurnComplete: makeSetter(set, "notifyOnChatTurnComplete"),
      setPinContextUsageBreakdown: makeSetter(set, "pinContextUsageBreakdown"),
      setPointerCursors: makeSetter(set, "pointerCursors"),
      setUiFontSize: makeClampedFontSizeSetter(
        set,
        "uiFontSize",
        clampUiFontSize,
      ),
      setCodeFontSize: makeClampedFontSizeSetter(
        set,
        "codeFontSize",
        clampCodeFontSize,
      ),
      setUiFontFamily: makeSetter(set, "uiFontFamily"),
      setCodeFontFamily: makeSetter(set, "codeFontFamily"),
      setTerminalFontFamily: makeSetter(set, "terminalFontFamily"),
      setTerminalFontSize: (value) => {
        const next = value === null ? null : clampCodeFontSize(value);
        set((s) =>
          s.terminalFontSize === next ? s : { terminalFontSize: next },
        );
      },
      setTerminalCursorStyle: makeSetter(set, "terminalCursorStyle"),
      setTerminalCursorBlink: makeSetter(set, "terminalCursorBlink"),
      setArtifactIconColorMode: makeSetter(set, "artifactIconColorMode"),
      setArtifactIconColor: (type, color) => {
        const next = normalizeEpicNodeIconColor(color);
        if (next === null) return;
        set((s) =>
          s.artifactIconColors[type] === next
            ? s
            : {
                artifactIconColors: {
                  ...s.artifactIconColors,
                  [type]: next,
                },
              },
        );
      },
      resetArtifactIconColors: () => {
        set((s) =>
          s.artifactIconColors === DEFAULT_EPIC_NODE_ICON_COLORS
            ? s
            : { artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS },
        );
      },
      setDefaultEditor: (id) => {
        set((s) => (s.defaultEditor === id ? s : { defaultEditor: id }));
      },
      setVoiceInputEnabled: makeSetter(set, "voiceInputEnabled"),
      setVoiceLanguage: makeSetter(set, "voiceLanguage"),
      setQuoteReplyEnabled: makeSetter(set, "quoteReplyEnabled"),
      setDiffViewerPreferences: makeSetter(set, "diffViewerPreferences"),
      patchDiffViewerPreferences: (patch) => {
        set((s) => ({
          diffViewerPreferences: {
            ...s.diffViewerPreferences,
            ...patch,
          },
        }));
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.settings)),
      partialize: partializeSettingsState,
    },
  ),
);
