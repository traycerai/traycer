import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  DEFAULT_PERMISSION,
  DEFAULT_COMPOSER_MODE,
  DEFAULT_REASONING,
  DEFAULT_SELECTION,
  DEFAULT_SERVICE_TIER,
  type PermissionMode,
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
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";

export type ThemeMode = "system" | "light" | "dark";
export type EpicNodeIconColorMode = "byType" | "none";
export type BrowserLinkOpenMode = "in-app" | "external";
export type BrowserLinkDefaultMode = BrowserLinkOpenMode | "per-kind";
/**
 * How a tab the AGENT opens via its browser REPL (`openTab`) is surfaced.
 * `pip` floats it picture-in-picture, `tile` places it on the epic canvas,
 * `off` keeps it fully in the background (hidden view + sidebar listing).
 * Deliberately default-off: surfacing is opt-in, unlike the pre-setting
 * behavior which always split the canvas.
 */
export type AgentTabSurfacingMode = "pip" | "tile" | "off";
export const DEFAULT_AGENT_TAB_SURFACING_MODE: AgentTabSurfacingMode = "off";
const DEFAULT_BROWSER_LINK_OPEN_MODE: BrowserLinkOpenMode = "in-app";
export type MinimapSide = "left" | "right";
export type MinimapPlacement = MinimapSide | "hide";
// Mirrors xterm's `cursorStyle` union; kept as our own type so the settings
// surface doesn't take a value import from `@xterm/xterm`.
export type TerminalCursorStyle = "block" | "bar" | "underline";

export const DEFAULT_TERMINAL_CURSOR_STYLE: TerminalCursorStyle = "block";
export const DEFAULT_TERMINAL_CURSOR_BLINK = true;
export const DEFAULT_MINIMAP_SIDE: MinimapPlacement = "right";

// Shape drawn when the terminal loses focus (xterm's `cursorInactiveStyle`,
// which never blinks). Bar/underline mirror the chosen shape so the cursor
// keeps its identity on blur; block falls back to a hollow outline so an
// unfocused pane stays visually distinct from a focused non-blinking block.
export type TerminalInactiveCursorStyle =
  | TerminalCursorStyle
  | "outline"
  | "none";

export function inactiveCursorStyleFor(
  style: TerminalCursorStyle,
): TerminalInactiveCursorStyle {
  return style === "block" ? "outline" : style;
}

// Default font sizes, shared with the Appearance panel so its reset-to-default
// affordance and the store's initial state stay a single source of truth.
export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 12;

// Default worktree branch prefix, shared with the General panel so its
// reset-to-default affordance and the store's initial state stay a single
// source of truth.
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "traycer/";

export interface SettingsState {
  theme: ThemeMode;
  themePreset: ThemePreset;
  defaultSelection: HarnessModelSelection;
  defaultReasoning: ReasoningLevel;
  defaultServiceTier: ServiceTier;
  defaultPermission: PermissionMode;
  /**
   * Landing composer surface (chat vs. terminal-agent launcher). Persisted like
   * the other composer defaults so the chosen mode survives restarts.
   */
  composerMode: ComposerMode;
  preventSleepWhileRunning: boolean;
  /** Show the app-global resource monitor button in the header. */
  showGlobalResourceMonitor: boolean;
  /** Show inline resource usage chips in task navigator/sidebar rows. */
  showNavigatorResourceStats: boolean;
  /**
   * Keep the chat context-window breakdown pinned near the composer instead of
   * the compact-only chip. Global preference, default off; chats without
   * reliable context-window data still render nothing.
   */
  pinContextUsageBreakdown: boolean;
  /** Shared edge used by chat and artifact minimaps, or `hide` for both. */
  chatTurnMinimapSide: MinimapPlacement;
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
   * Prefix prepended verbatim to the branch name pre-filled when creating a
   * new worktree (no separator is auto-appended - the user types it, e.g.
   * `traycer/`, `anurag/`, `feat-`). Empty string means no prefix.
   */
  worktreeBranchPrefix: string;
  /**
   * Quote-to-composer affordance. Opt-out: enabling it (default) surfaces a
   * quote button when selecting assistant text, inserting the selection into
   * the chat composer as a blockquote.
   */
  quoteReplyEnabled: boolean;
  /** Global default for http(s) links. */
  browserLinkDefaultMode: BrowserLinkDefaultMode;
  /** Terminal plain URL / OSC-8 default used when global mode is per-kind. */
  terminalBrowserLinkOpenMode: BrowserLinkOpenMode;
  /** Markdown anchor default used when global mode is per-kind. */
  markdownBrowserLinkOpenMode: BrowserLinkOpenMode;
  /** Origins designated from terminal URL output for the host classifier. */
  browserDevOrigins: ReadonlyArray<string>;
  /**
   * What happens visually when the agent opens a browser tab. The agent's
   * REPL tabs are a host capability, separate from link routing, and this
   * preference also governs suppressing them.
   */
  agentTabSurfacingMode: AgentTabSurfacingMode;
  /**
   * Cmd/Ctrl+Enter mid-turn steering. Opt-out (default ON): when enabled,
   * pressing Cmd+Enter while a turn is running on a steer-capable harness sends
   * the composer text as a same-turn steering message that jumps the pending
   * queue; plain Enter keeps queueing. Disabling it reverts Cmd+Enter to the
   * plain-Enter submit alias. Idle behavior is identical either way.
   */
  steerOnModEnterEnabled: boolean;
  /**
   * Shared, user-level diff viewer configuration consumed by every git and
   * snapshot diff renderer. Persisted globally so the choice survives restarts
   * and live-updates all mounted viewers. Tile-local state (collapsed files)
   * is not part of this shape - it stays on the diff tile payload.
   */
  diffViewerPreferences: DiffViewerPreferences;
  /**
   * Line wrapping in the workspace file viewer. `null` means the user has made
   * no choice, and the render site resolves it from the pointer type instead -
   * a persisted boolean would carry one device's answer to every other device,
   * and whether wrapping is the right default is a fact about the input
   * hardware, not about the account.
   *
   * Deliberately separate from `diffViewerPreferences.wordWrap`: a file being
   * read is not a diff, and a wrap choice made while reading one must not
   * re-render every open diff.
   */
  workspaceFileWordWrap: boolean | null;
  setTheme: (theme: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
  setComposerMode: (mode: ComposerMode) => void;
  setPreventSleepWhileRunning: (value: boolean) => void;
  setShowGlobalResourceMonitor: (value: boolean) => void;
  setShowNavigatorResourceStats: (value: boolean) => void;
  setPinContextUsageBreakdown: (value: boolean) => void;
  setMinimapSide: (value: MinimapPlacement) => void;
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
  setWorktreeBranchPrefix: (value: string) => void;
  setQuoteReplyEnabled: (value: boolean) => void;
  setBrowserLinkDefaultMode: (mode: BrowserLinkDefaultMode) => void;
  setTerminalBrowserLinkOpenMode: (mode: BrowserLinkOpenMode) => void;
  setMarkdownBrowserLinkOpenMode: (mode: BrowserLinkOpenMode) => void;
  addBrowserDevOrigin: (origin: string) => void;
  removeBrowserDevOrigin: (origin: string) => void;
  setAgentTabSurfacingMode: (mode: AgentTabSurfacingMode) => void;
  setSteerOnModEnterEnabled: (value: boolean) => void;
  setDiffViewerPreferences: (preferences: DiffViewerPreferences) => void;
  patchDiffViewerPreferences: (patch: DiffViewerPreferencesPatch) => void;
  setWorkspaceFileWordWrap: (value: boolean | null) => void;
}

type PersistedSettingsState = Pick<
  SettingsState,
  | "theme"
  | "themePreset"
  | "defaultSelection"
  | "defaultReasoning"
  | "defaultServiceTier"
  | "defaultPermission"
  | "composerMode"
  | "preventSleepWhileRunning"
  | "showGlobalResourceMonitor"
  | "showNavigatorResourceStats"
  | "pinContextUsageBreakdown"
  | "chatTurnMinimapSide"
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
  | "worktreeBranchPrefix"
  | "quoteReplyEnabled"
  | "browserLinkDefaultMode"
  | "terminalBrowserLinkOpenMode"
  | "markdownBrowserLinkOpenMode"
  | "browserDevOrigins"
  | "agentTabSurfacingMode"
  | "steerOnModEnterEnabled"
  | "diffViewerPreferences"
  | "workspaceFileWordWrap"
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
    composerMode: state.composerMode,
    preventSleepWhileRunning: state.preventSleepWhileRunning,
    showGlobalResourceMonitor: state.showGlobalResourceMonitor,
    showNavigatorResourceStats: state.showNavigatorResourceStats,
    pinContextUsageBreakdown: state.pinContextUsageBreakdown,
    chatTurnMinimapSide: state.chatTurnMinimapSide,
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
    worktreeBranchPrefix: state.worktreeBranchPrefix,
    quoteReplyEnabled: state.quoteReplyEnabled,
    browserLinkDefaultMode: state.browserLinkDefaultMode,
    terminalBrowserLinkOpenMode: state.terminalBrowserLinkOpenMode,
    markdownBrowserLinkOpenMode: state.markdownBrowserLinkOpenMode,
    browserDevOrigins: state.browserDevOrigins,
    agentTabSurfacingMode: state.agentTabSurfacingMode,
    steerOnModEnterEnabled: state.steerOnModEnterEnabled,
    diffViewerPreferences: state.diffViewerPreferences,
    workspaceFileWordWrap: state.workspaceFileWordWrap,
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
      composerMode: DEFAULT_COMPOSER_MODE,
      preventSleepWhileRunning: false,
      showGlobalResourceMonitor: true,
      showNavigatorResourceStats: false,
      pinContextUsageBreakdown: false,
      chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
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
      worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
      quoteReplyEnabled: true,
      browserLinkDefaultMode: DEFAULT_BROWSER_LINK_OPEN_MODE,
      terminalBrowserLinkOpenMode: DEFAULT_BROWSER_LINK_OPEN_MODE,
      markdownBrowserLinkOpenMode: DEFAULT_BROWSER_LINK_OPEN_MODE,
      browserDevOrigins: [],
      agentTabSurfacingMode: DEFAULT_AGENT_TAB_SURFACING_MODE,
      steerOnModEnterEnabled: true,
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
      workspaceFileWordWrap: null,
      setTheme: makeSetter(set, "theme"),
      setThemePreset: makeSetter(set, "themePreset"),
      setComposerMode: makeSetter(set, "composerMode"),
      setPreventSleepWhileRunning: makeSetter(set, "preventSleepWhileRunning"),
      setShowGlobalResourceMonitor: makeSetter(
        set,
        "showGlobalResourceMonitor",
      ),
      setShowNavigatorResourceStats: makeSetter(
        set,
        "showNavigatorResourceStats",
      ),
      setPinContextUsageBreakdown: makeSetter(set, "pinContextUsageBreakdown"),
      setMinimapSide: makeSetter(set, "chatTurnMinimapSide"),
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
      setWorktreeBranchPrefix: makeSetter(set, "worktreeBranchPrefix"),
      setQuoteReplyEnabled: makeSetter(set, "quoteReplyEnabled"),
      setBrowserLinkDefaultMode: makeSetter(set, "browserLinkDefaultMode"),
      setTerminalBrowserLinkOpenMode: makeSetter(
        set,
        "terminalBrowserLinkOpenMode",
      ),
      setMarkdownBrowserLinkOpenMode: makeSetter(
        set,
        "markdownBrowserLinkOpenMode",
      ),
      addBrowserDevOrigin: (origin) => {
        set((s) => {
          if (s.browserDevOrigins.includes(origin)) return s;
          return {
            browserDevOrigins: [...s.browserDevOrigins, origin].slice(-50),
          };
        });
      },
      removeBrowserDevOrigin: (origin) => {
        set((s) => {
          const browserDevOrigins = s.browserDevOrigins.filter(
            (candidate) => candidate !== origin,
          );
          return browserDevOrigins.length === s.browserDevOrigins.length
            ? s
            : { browserDevOrigins };
        });
      },
      setAgentTabSurfacingMode: makeSetter(set, "agentTabSurfacingMode"),
      setSteerOnModEnterEnabled: makeSetter(set, "steerOnModEnterEnabled"),
      setDiffViewerPreferences: makeSetter(set, "diffViewerPreferences"),
      patchDiffViewerPreferences: (patch) => {
        set((s) => ({
          diffViewerPreferences: {
            ...s.diffViewerPreferences,
            ...patch,
          },
        }));
      },
      setWorkspaceFileWordWrap: makeSetter(set, "workspaceFileWordWrap"),
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.settings)),
      partialize: partializeSettingsState,
      // Defensive re-derivation of `worktreeBranchPrefix` on every rehydration
      // (mirrors `workspace-folders-store.ts`'s `merge`): a hand-edited or
      // otherwise corrupted localStorage value would otherwise rehydrate
      // verbatim (the default shallow merge takes persisted fields as-is),
      // flow straight into branch composition, and still mount the editor
      // showing it as healthy. `workspaceFileWordWrap` is re-derived for a
      // narrower reason: its `null` carries meaning ("the user has not
      // chosen"), and any non-boolean that rehydrated verbatim would be
      // neither `true`, `false`, nor that third state - a truthy string would
      // read as "wrap on, chosen deliberately" and the pointer-type default
      // could never be reached again. Every other field keeps the default
      // shallow merge behavior.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        const persistedMinimapSide = persisted.chatTurnMinimapSide;
        const merged: SettingsState = { ...currentState, ...persisted };
        return {
          ...merged,
          worktreeBranchPrefix:
            typeof merged.worktreeBranchPrefix === "string" &&
            worktreeBranchPrefixError(merged.worktreeBranchPrefix) === null
              ? merged.worktreeBranchPrefix
              : DEFAULT_WORKTREE_BRANCH_PREFIX,
          chatTurnMinimapSide:
            persistedMinimapSide === "left" ||
            persistedMinimapSide === "right" ||
            persistedMinimapSide === "hide"
              ? persistedMinimapSide
              : DEFAULT_MINIMAP_SIDE,
          agentTabSurfacingMode: isAgentTabSurfacingMode(
            merged.agentTabSurfacingMode,
          )
            ? merged.agentTabSurfacingMode
            : DEFAULT_AGENT_TAB_SURFACING_MODE,
          browserLinkDefaultMode: isBrowserLinkDefaultMode(
            merged.browserLinkDefaultMode,
          )
            ? merged.browserLinkDefaultMode
            : DEFAULT_BROWSER_LINK_OPEN_MODE,
          terminalBrowserLinkOpenMode: isBrowserLinkOpenMode(
            merged.terminalBrowserLinkOpenMode,
          )
            ? merged.terminalBrowserLinkOpenMode
            : DEFAULT_BROWSER_LINK_OPEN_MODE,
          markdownBrowserLinkOpenMode: isBrowserLinkOpenMode(
            merged.markdownBrowserLinkOpenMode,
          )
            ? merged.markdownBrowserLinkOpenMode
            : DEFAULT_BROWSER_LINK_OPEN_MODE,
          browserDevOrigins: Array.isArray(merged.browserDevOrigins)
            ? merged.browserDevOrigins.filter(
                (origin) => typeof origin === "string",
              )
            : [],
          workspaceFileWordWrap:
            typeof merged.workspaceFileWordWrap === "boolean"
              ? merged.workspaceFileWordWrap
              : null,
        };
      },
    },
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBrowserLinkOpenMode(
  value: unknown,
): value is BrowserLinkOpenMode {
  return value === "in-app" || value === "external";
}

export function isBrowserLinkDefaultMode(
  value: unknown,
): value is BrowserLinkDefaultMode {
  return isBrowserLinkOpenMode(value) || value === "per-kind";
}

export function isAgentTabSurfacingMode(
  value: unknown,
): value is AgentTabSurfacingMode {
  return value === "pip" || value === "tile" || value === "off";
}
