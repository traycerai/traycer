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
  pointerCursors: boolean;
  uiFontSize: number;
  codeFontSize: number;
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
  setPointerCursors: (value: boolean) => void;
  setUiFontSize: (value: number) => void;
  setCodeFontSize: (value: number) => void;
  setArtifactIconColorMode: (mode: EpicNodeIconColorMode) => void;
  setArtifactIconColor: (type: EpicNodeKind, color: string) => void;
  resetArtifactIconColors: () => void;
  setDefaultEditor: (id: EditorId | null) => void;
  setVoiceInputEnabled: (value: boolean) => void;
  setVoiceLanguage: (value: string) => void;
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
  | "pointerCursors"
  | "uiFontSize"
  | "codeFontSize"
  | "artifactIconColorMode"
  | "artifactIconColors"
  | "defaultEditor"
  | "voiceInputEnabled"
  | "voiceLanguage"
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
): (value: number) => void {
  return (value) => {
    const next = clampFontSize(value);
    set((s) => (s[key] === next ? s : { [key]: next }));
  };
}

function clampFontSize(value: number): number {
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
    pointerCursors: state.pointerCursors,
    uiFontSize: state.uiFontSize,
    codeFontSize: state.codeFontSize,
    artifactIconColorMode: state.artifactIconColorMode,
    artifactIconColors: state.artifactIconColors,
    defaultEditor: state.defaultEditor,
    voiceInputEnabled: state.voiceInputEnabled,
    voiceLanguage: state.voiceLanguage,
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
      pointerCursors: true,
      uiFontSize: 15,
      codeFontSize: 12,
      artifactIconColorMode: "byType",
      artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
      defaultEditor: "vscode",
      voiceInputEnabled: true,
      voiceLanguage: "auto",
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
      setTheme: makeSetter(set, "theme"),
      setThemePreset: makeSetter(set, "themePreset"),
      setDefaultAgentMode: makeSetter(set, "defaultAgentMode"),
      setComposerMode: makeSetter(set, "composerMode"),
      setPreventSleepWhileRunning: makeSetter(set, "preventSleepWhileRunning"),
      setNotifyOnChatTurnComplete: makeSetter(set, "notifyOnChatTurnComplete"),
      setPointerCursors: makeSetter(set, "pointerCursors"),
      setUiFontSize: makeClampedFontSizeSetter(set, "uiFontSize"),
      setCodeFontSize: makeClampedFontSizeSetter(set, "codeFontSize"),
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
