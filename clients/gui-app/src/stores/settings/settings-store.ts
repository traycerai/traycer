import { create } from "zustand";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
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
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";
import {
  DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  isNotificationChimeSound,
  NOTIFICATION_CHIME_EVENT_TYPES,
  type NotificationChimeEventType,
  type NotificationChimeSound,
  type NotificationChimeSoundsByEvent,
} from "@/lib/notifications/notification-chime";
import type { DefaultOpenTarget } from "@/lib/editor/editor-menu-catalog";
import type { TilePlacementCategory } from "@/lib/canvas/tile-open/intent";
import {
  CONTEXT_USAGE_ROW_KEYS,
  isContextUsageRowKey,
  type ContextUsageRowKey,
} from "@/components/chat/context-usage";

export type ThemeMode = "system" | "light" | "dark";
export type EpicNodeIconColorMode = "byType" | "none";
export type LinkOpenMode = "in-app" | "external";
export type LinkKindSetting = "markdown" | "terminal" | "github" | "image";
/** Global default plus per-kind overrides for where an app link opens. */
export interface LinkOpenSettings {
  default: LinkOpenMode | "per-kind";
  markdown: LinkOpenMode;
  terminal: LinkOpenMode;
  github: LinkOpenMode;
  image: LinkOpenMode;
}
export type TilePlacement = "tab" | "split";
/** Browser tiles can additionally float picture-in-picture. */
export type BrowserTilePlacement = TilePlacement | "pip";
export interface TilePlacementSettings {
  default: TilePlacement | "per-category";
  content: TilePlacement;
  conversation: TilePlacement;
  browser: BrowserTilePlacement;
  /**
   * A `/btw` side chat, which is always placed relative to the chat it was
   * asked from: `split` opens it to that pane's right, `tab` as a tab of that
   * pane. Its own row rather than `conversation` because the aside is read
   * BESIDE its conversation - a user who tabs every new agent still wants
   * the aside next to the chat it is about.
   */
  sideChat: TilePlacement;
}
/**
 * Whether a tab the AGENT opens via its browser REPL (`openTab`) reaches the
 * canvas at all. `surface` places it using the browser tile placement; `off`
 * keeps it fully in the background (hidden view + sidebar listing).
 * Deliberately default-off: surfacing is opt-in, unlike the pre-setting
 * behavior which always split the canvas.
 */
export type AgentTabSurfacing = "off" | "surface";

const DEFAULT_LINK_OPEN_MODE: LinkOpenMode = "in-app";
export const DEFAULT_LINK_OPEN_SETTINGS: LinkOpenSettings = {
  default: DEFAULT_LINK_OPEN_MODE,
  markdown: DEFAULT_LINK_OPEN_MODE,
  terminal: DEFAULT_LINK_OPEN_MODE,
  github: DEFAULT_LINK_OPEN_MODE,
  image: DEFAULT_LINK_OPEN_MODE,
};
export const DEFAULT_TILE_PLACEMENT_SETTINGS: TilePlacementSettings = {
  default: "per-category",
  content: "tab",
  conversation: "tab",
  browser: "split",
  sideChat: "split",
};
const DEFAULT_AGENT_TAB_SURFACING: AgentTabSurfacing = "off";
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

/**
 * The readings a task navigator / sidebar row can print inline. Ordered as the
 * chip prints them; the stored list is always a subsequence of this one.
 */
export type NavigatorResourceMetric = "cpu" | "memory" | "processes";
export const NAVIGATOR_RESOURCE_METRICS: ReadonlyArray<NavigatorResourceMetric> =
  ["cpu", "memory", "processes"];
/** Chips are opt-in: a fresh install draws none until a reading is picked. */
export const DEFAULT_NAVIGATOR_RESOURCE_METRICS: ReadonlyArray<NavigatorResourceMetric> =
  [];

export function isNavigatorResourceMetric(
  value: unknown,
): value is NavigatorResourceMetric {
  return value === "cpu" || value === "memory" || value === "processes";
}

// Default font sizes, shared with the Appearance panel so its reset-to-default
// affordance and the store's initial state stay a single source of truth.
export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 12;

// Default worktree branch prefix, shared with the General panel so its
// reset-to-default affordance and the store's initial state stay a single
// source of truth.
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "traycer/";

export const START_PAGE_WALLPAPER_STYLES = [
  "photo",
  "dither",
  "grain",
] as const;
export type StartPageWallpaperStyle =
  (typeof START_PAGE_WALLPAPER_STYLES)[number];
export const DEFAULT_START_PAGE_WALLPAPER_INTENSITY = 0.6;

/**
 * The personal start-page wallpaper's SETTINGS. `null` means no wallpaper. The
 * image bytes live in the appearance blob store
 * (`lib/appearance/start-page-wallpaper.ts`), never here.
 */
export interface StartPageWallpaper {
  readonly style: StartPageWallpaperStyle;
  /** 0..1. Applies to `dither` and `grain` only. */
  readonly intensity: number;
  /**
   * `dither` only: paint the tones from the accent ramp. Off dithers each RGB
   * channel on its own, so the image keeps its own colours.
   */
  readonly tintWithAccent: boolean;
  /**
   * The chosen file's name, or `null` when none is stored. Lives here rather
   * than beside the bytes (the appearance blob store) so metadata is all in
   * one place; `lib/appearance/start-page-wallpaper.ts` writes this row and
   * the blob together from a single entry point per user action, which is
   * what makes it safe to keep here without risking a name left over for an
   * image that is gone.
   */
  readonly name: string | null;
  /**
   * The curated catalog id this image came from, or `null` for a file the
   * user chose themselves. Only the gallery reads it - to ring the tile the
   * stored image came from - so an id whose entry has since left the manifest
   * simply rings nothing, and `name` keeps showing the title it was applied
   * under.
   */
  readonly curatedId: string | null;
}
/**
 * One field of the pinned context breakdown - the same keys the breakdown
 * rows carry, so the picker can only ever name a row the strip knows how to
 * draw.
 */
export type ContextBreakdownField = ContextUsageRowKey;
export const DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS: ReadonlyArray<ContextBreakdownField> =
  CONTEXT_USAGE_ROW_KEYS;

/**
 * How the unpinned context chip draws the remaining percentage: the sentence
 * (`75% context left`), a circular gauge with the number inside, or the gauge
 * on its own with the number left to the label.
 */
export type ContextIndicatorStyle = "text" | "ring" | "ring-only";
export const DEFAULT_CONTEXT_INDICATOR_STYLE: ContextIndicatorStyle = "text";

/**
 * The pin is off until asked for. A constant rather than a literal in the
 * initial state, so Layout's Default preset can BE the default rather than a
 * copy of it (`lib/layout-presets.ts`).
 */
export const DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN = false;

export interface SettingsState {
  startPageWallpaper: StartPageWallpaper | null;
  showGreeting: boolean;
  showRecentHistory: boolean;
  setStartPageWallpaper: (wallpaper: StartPageWallpaper | null) => void;
  setShowGreeting: (visible: boolean) => void;
  setShowRecentHistory: (visible: boolean) => void;
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
  /**
   * Which readings the inline resource chip in task navigator/sidebar rows
   * prints, in chip order. An empty list draws no chip at all.
   */
  navigatorResourceMetrics: ReadonlyArray<NavigatorResourceMetric>;
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
  /**
   * What the open-in-editor surfaces default to. Widened past `EditorId`
   * because Finder is a first-class choice in those menus; `"system"` is not,
   * being a PDF routing decision rather than something a user picks.
   */
  defaultEditor: DefaultOpenTarget | null;
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
  /** Where app-rendered http(s) links open: default plus per-kind overrides. */
  linkOpen: LinkOpenSettings;
  /** Origins designated from terminal URL output for the host classifier. */
  browserDevOrigins: ReadonlyArray<string>;
  /** Where a tile lands on the canvas: default plus per-category overrides. */
  tilePlacement: TilePlacementSettings;
  /**
   * What happens visually when the agent opens a browser tab. The agent's
   * REPL tabs are a host capability, separate from link routing, and this
   * preference also governs suppressing them.
   */
  agentTabSurfacing: AgentTabSurfacing;
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
  /** App-wide audible cues selected for each notification event type. */
  notificationChimeSounds: NotificationChimeSoundsByEvent;
  /**
   * The fixed Home tab and its focus view. Opt-in while the view is still
   * filling out: with this off the strip, the routes, the chord and the mobile
   * drawer behave exactly as they did before Home existed.
   */
  homeTabEnabled: boolean;
  /**
   * Which breakdown rows the pinned context strip draws, in the strip's own
   * order. Never empty: the strip with no fields is what unpinning is for, so
   * the toggle refuses to remove the last one. Only read while
   * `pinContextUsageBreakdown` is on.
   */
  pinnedContextBreakdownFields: ReadonlyArray<ContextBreakdownField>;
  /** Shape of the unpinned context chip. */
  contextIndicatorStyle: ContextIndicatorStyle;
  setTheme: (theme: ThemeMode) => void;
  setThemePreset: (preset: ThemePreset) => void;
  setComposerMode: (mode: ComposerMode) => void;
  setPreventSleepWhileRunning: (value: boolean) => void;
  setShowGlobalResourceMonitor: (value: boolean) => void;
  /** Adds or removes one reading; the list keeps chip order either way. */
  toggleNavigatorResourceMetric: (metric: NavigatorResourceMetric) => void;
  /**
   * The whole list at once, for a caller holding a complete answer rather than
   * one chip's - Layout's presets and its reset. Normalized to chip order like
   * the toggle, so the two writers cannot leave the list in two different
   * shapes.
   */
  setNavigatorResourceMetrics: (
    metrics: ReadonlyArray<NavigatorResourceMetric>,
  ) => void;
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
  setDefaultEditor: (id: DefaultOpenTarget | null) => void;
  setVoiceInputEnabled: (value: boolean) => void;
  setVoiceLanguage: (value: string) => void;
  setWorktreeBranchPrefix: (value: string) => void;
  setQuoteReplyEnabled: (value: boolean) => void;
  setLinkOpen: (patch: Partial<LinkOpenSettings>) => void;
  addBrowserDevOrigin: (origin: string) => void;
  removeBrowserDevOrigin: (origin: string) => void;
  setTilePlacement: (patch: Partial<TilePlacementSettings>) => void;
  setAgentTabSurfacing: (mode: AgentTabSurfacing) => void;
  setSteerOnModEnterEnabled: (value: boolean) => void;
  setDiffViewerPreferences: (preferences: DiffViewerPreferences) => void;
  patchDiffViewerPreferences: (patch: DiffViewerPreferencesPatch) => void;
  setWorkspaceFileWordWrap: (value: boolean | null) => void;
  setNotificationChimeSoundForEvent: (
    eventType: NotificationChimeEventType,
    value: NotificationChimeSound,
  ) => void;
  setHomeTabEnabled: (value: boolean) => void;
  togglePinnedContextBreakdownField: (field: ContextBreakdownField) => void;
  /**
   * The whole field list at once, same caller as
   * `setNavigatorResourceMetrics`. Keeps both of the toggle's guarantees - the
   * strip's own order, and never empty - so a preset cannot write a shape the
   * row below it could not produce.
   */
  setPinnedContextBreakdownFields: (
    fields: ReadonlyArray<ContextBreakdownField>,
  ) => void;
  setContextIndicatorStyle: (style: ContextIndicatorStyle) => void;
}

type PersistedSettingsState = Pick<
  SettingsState,
  | "startPageWallpaper"
  | "showGreeting"
  | "showRecentHistory"
  | "theme"
  | "themePreset"
  | "defaultSelection"
  | "defaultReasoning"
  | "defaultServiceTier"
  | "defaultPermission"
  | "composerMode"
  | "preventSleepWhileRunning"
  | "showGlobalResourceMonitor"
  | "navigatorResourceMetrics"
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
  | "linkOpen"
  | "browserDevOrigins"
  | "tilePlacement"
  | "agentTabSurfacing"
  | "steerOnModEnterEnabled"
  | "diffViewerPreferences"
  | "workspaceFileWordWrap"
  | "notificationChimeSounds"
  | "homeTabEnabled"
  | "pinnedContextBreakdownFields"
  | "contextIndicatorStyle"
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
    startPageWallpaper: state.startPageWallpaper,
    showGreeting: state.showGreeting,
    showRecentHistory: state.showRecentHistory,
    theme: state.theme,
    themePreset: state.themePreset,
    defaultSelection: state.defaultSelection,
    defaultReasoning: state.defaultReasoning,
    defaultServiceTier: state.defaultServiceTier,
    defaultPermission: state.defaultPermission,
    composerMode: state.composerMode,
    preventSleepWhileRunning: state.preventSleepWhileRunning,
    showGlobalResourceMonitor: state.showGlobalResourceMonitor,
    navigatorResourceMetrics: state.navigatorResourceMetrics,
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
    linkOpen: state.linkOpen,
    browserDevOrigins: state.browserDevOrigins,
    tilePlacement: state.tilePlacement,
    agentTabSurfacing: state.agentTabSurfacing,
    steerOnModEnterEnabled: state.steerOnModEnterEnabled,
    diffViewerPreferences: state.diffViewerPreferences,
    workspaceFileWordWrap: state.workspaceFileWordWrap,
    notificationChimeSounds: state.notificationChimeSounds,
    homeTabEnabled: state.homeTabEnabled,
    pinnedContextBreakdownFields: state.pinnedContextBreakdownFields,
    contextIndicatorStyle: state.contextIndicatorStyle,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      startPageWallpaper: null,
      showGreeting: true,
      showRecentHistory: true,
      setStartPageWallpaper: makeSetter(set, "startPageWallpaper"),
      setShowGreeting: makeSetter(set, "showGreeting"),
      setShowRecentHistory: makeSetter(set, "showRecentHistory"),
      theme: "system",
      themePreset: DEFAULT_THEME_PRESET,
      defaultSelection: DEFAULT_SELECTION,
      defaultReasoning: DEFAULT_REASONING,
      defaultServiceTier: DEFAULT_SERVICE_TIER,
      defaultPermission: DEFAULT_PERMISSION,
      composerMode: DEFAULT_COMPOSER_MODE,
      preventSleepWhileRunning: false,
      showGlobalResourceMonitor: true,
      navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
      pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
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
      linkOpen: DEFAULT_LINK_OPEN_SETTINGS,
      browserDevOrigins: [],
      tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
      agentTabSurfacing: DEFAULT_AGENT_TAB_SURFACING,
      steerOnModEnterEnabled: true,
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
      workspaceFileWordWrap: null,
      notificationChimeSounds: DEFAULT_NOTIFICATION_CHIME_SOUNDS,
      homeTabEnabled: false,
      pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
      contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
      setTheme: makeSetter(set, "theme"),
      setThemePreset: (themePreset) => {
        if (useThemeLibraryStore.getState().clearSelection())
          set({ themePreset });
      },
      setComposerMode: makeSetter(set, "composerMode"),
      setPreventSleepWhileRunning: makeSetter(set, "preventSleepWhileRunning"),
      setShowGlobalResourceMonitor: makeSetter(
        set,
        "showGlobalResourceMonitor",
      ),
      toggleNavigatorResourceMetric: (metric) => {
        set((s) => {
          const selected = new Set(s.navigatorResourceMetrics);
          if (selected.has(metric)) {
            selected.delete(metric);
          } else {
            selected.add(metric);
          }
          return {
            navigatorResourceMetrics: NAVIGATOR_RESOURCE_METRICS.filter(
              (candidate) => selected.has(candidate),
            ),
          };
        });
      },
      setNavigatorResourceMetrics: (metrics) => {
        const selected = new Set(metrics);
        set({
          navigatorResourceMetrics: NAVIGATOR_RESOURCE_METRICS.filter(
            (candidate) => selected.has(candidate),
          ),
        });
      },
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
      setLinkOpen: (patch) => {
        set((s) => ({ linkOpen: { ...s.linkOpen, ...patch } }));
      },
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
      setTilePlacement: (patch) => {
        set((s) => ({ tilePlacement: { ...s.tilePlacement, ...patch } }));
      },
      setAgentTabSurfacing: makeSetter(set, "agentTabSurfacing"),
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
      setNotificationChimeSoundForEvent: (eventType, value) => {
        set((state) =>
          state.notificationChimeSounds[eventType] === value
            ? state
            : {
                notificationChimeSounds: {
                  ...state.notificationChimeSounds,
                  [eventType]: value,
                },
              },
        );
      },
      setHomeTabEnabled: makeSetter(set, "homeTabEnabled"),
      togglePinnedContextBreakdownField: (field) => {
        set((s) => {
          const selected = new Set(s.pinnedContextBreakdownFields);
          if (selected.has(field)) {
            // The last field stays: an empty strip is what unpinning is for.
            if (selected.size === 1) return s;
            selected.delete(field);
          } else {
            selected.add(field);
          }
          // Re-inserted in canonical order rather than appended, so the strip
          // reads the same whatever order the fields were switched on in.
          return {
            pinnedContextBreakdownFields: CONTEXT_USAGE_ROW_KEYS.filter(
              (candidate) => selected.has(candidate),
            ),
          };
        });
      },
      setPinnedContextBreakdownFields: (fields) => {
        const selected = new Set(fields);
        const next = CONTEXT_USAGE_ROW_KEYS.filter((candidate) =>
          selected.has(candidate),
        );
        // An empty list is not a shape the strip has: unpinning is what hides
        // it, so a caller that names no field gets the full set rather than a
        // strip that draws its label and nothing else.
        set({
          pinnedContextBreakdownFields:
            next.length === 0 ? DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS : next,
        });
      },
      setContextIndicatorStyle: makeSetter(set, "contextIndicatorStyle"),
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
      // could never be reached again. `linkOpen`, `tilePlacement` and
      // `agentTabSurfacing` are resolved from the persisted record rather than
      // from `merged` because this is also where the one-shot migration off
      // their pre-refactor keys runs. Every other field keeps the default
      // shallow merge behavior.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        const persistedMinimapSide = persisted.chatTurnMinimapSide;
        const merged: SettingsState = { ...currentState, ...persisted };
        return {
          ...merged,
          startPageWallpaper: parseStartPageWallpaper(
            persisted.startPageWallpaper,
          ),
          showGreeting:
            typeof persisted.showGreeting === "boolean"
              ? persisted.showGreeting
              : true,
          showRecentHistory:
            typeof persisted.showRecentHistory === "boolean"
              ? persisted.showRecentHistory
              : true,
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
          agentTabSurfacing: resolvePersistedAgentTabSurfacing(persisted),
          linkOpen: resolvePersistedLinkOpen(persisted),
          tilePlacement: resolvePersistedTilePlacement(persisted),
          browserDevOrigins: Array.isArray(merged.browserDevOrigins)
            ? merged.browserDevOrigins.filter(
                (origin) => typeof origin === "string",
              )
            : [],
          workspaceFileWordWrap:
            typeof merged.workspaceFileWordWrap === "boolean"
              ? merged.workspaceFileWordWrap
              : null,
          notificationChimeSounds: resolvePersistedNotificationChimeSounds(
            persisted.notificationChimeSounds,
            persisted.notificationChimeSound,
          ),
          navigatorResourceMetrics: resolvePersistedNavigatorResourceMetrics(
            persisted.navigatorResourceMetrics,
            persisted.showNavigatorResourceStats,
          ),
          // Narrowed rather than merged verbatim, for the same reason
          // `workspaceFileWordWrap` is: this flag gates a tab kind, a route
          // guard and a chord, so a truthy non-boolean rehydrating as-is would
          // switch Home on for a user who never asked for it.
          homeTabEnabled:
            typeof merged.homeTabEnabled === "boolean"
              ? merged.homeTabEnabled
              : false,
          pinnedContextBreakdownFields:
            resolvePersistedPinnedContextBreakdownFields(
              persisted.pinnedContextBreakdownFields,
            ),
          contextIndicatorStyle: isContextIndicatorStyle(
            persisted.contextIndicatorStyle,
          )
            ? persisted.contextIndicatorStyle
            : DEFAULT_CONTEXT_INDICATOR_STYLE,
        };
      },
    },
  ),
);

/**
 * Non-hook read of the Home-tab flag, for the framework-free seams that gate on
 * it (route guards, the tab command coordinator, the navigation controller and
 * the keybinding dispatcher). Components read `homeTabEnabled` reactively.
 */
export function isHomeTabEnabled(): boolean {
  return useSettingsStore.getState().homeTabEnabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStartPageWallpaper(value: unknown): StartPageWallpaper | null {
  if (!isRecord(value)) return null;
  const style = START_PAGE_WALLPAPER_STYLES.find(
    (candidate) => candidate === value.style,
  );
  if (style === undefined) return null;
  const intensity = value.intensity;
  return {
    style,
    intensity:
      typeof intensity === "number" &&
      Number.isFinite(intensity) &&
      intensity >= 0 &&
      intensity <= 1
        ? intensity
        : DEFAULT_START_PAGE_WALLPAPER_INTENSITY,
    tintWithAccent:
      typeof value.tintWithAccent === "boolean" ? value.tintWithAccent : true,
    // Untrusted input (a chosen file's name): cap its length the way theme
    // names and other user-authored strings are capped elsewhere.
    name: typeof value.name === "string" ? value.name.slice(0, 256) : null,
    curatedId:
      typeof value.curatedId === "string" ? value.curatedId.slice(0, 64) : null,
  };
}

function resolvePersistedNotificationChimeSounds(
  value: unknown,
  legacyValue: unknown,
): NotificationChimeSoundsByEvent {
  const persisted = isRecord(value) ? value : {};
  const legacySound = isNotificationChimeSound(legacyValue)
    ? legacyValue
    : null;
  const resolved: Record<NotificationChimeEventType, NotificationChimeSound> = {
    ...DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  };

  for (const eventType of NOTIFICATION_CHIME_EVENT_TYPES) {
    const eventSound = persisted[eventType];
    const collaborationSound =
      eventType === "info" ? persisted.collaboration : undefined;
    if (isNotificationChimeSound(eventSound)) {
      resolved[eventType] = eventSound;
    } else if (isNotificationChimeSound(collaborationSound)) {
      resolved[eventType] = collaborationSound;
    } else if (legacySound !== null) {
      resolved[eventType] = legacySound;
    }
  }

  return resolved;
}

/**
 * Rehydration for the sidebar resource chip's metric list, doubling as the
 * one-shot migration off the retired `showNavigatorResourceStats` switch: a
 * persisted `true` becomes every metric, `false` becomes none. The list wins
 * whenever it is present, so a user who has since picked a subset keeps it
 * even while the old key is still readable; `partialize` does not list the old
 * key, so the next write drops it. Unknown ids are dropped and the survivors
 * are put back in chip order, so a hand-edited record cannot draw a chip the
 * settings row has no button for.
 */
function resolvePersistedNavigatorResourceMetrics(
  value: unknown,
  legacy: unknown,
): ReadonlyArray<NavigatorResourceMetric> {
  if (Array.isArray(value)) {
    const entries: ReadonlyArray<unknown> = value;
    const selected = new Set(entries.filter(isNavigatorResourceMetric));
    return NAVIGATOR_RESOURCE_METRICS.filter((metric) => selected.has(metric));
  }
  if (typeof legacy === "boolean") {
    return legacy ? [...NAVIGATOR_RESOURCE_METRICS] : [];
  }
  return DEFAULT_NAVIGATOR_RESOURCE_METRICS;
}

export function isLinkOpenMode(value: unknown): value is LinkOpenMode {
  return value === "in-app" || value === "external";
}

export function isLinkOpenDefault(
  value: unknown,
): value is LinkOpenSettings["default"] {
  return isLinkOpenMode(value) || value === "per-kind";
}

export function isTilePlacement(value: unknown): value is TilePlacement {
  return value === "tab" || value === "split";
}

export function isBrowserTilePlacement(
  value: unknown,
): value is BrowserTilePlacement {
  return isTilePlacement(value) || value === "pip";
}

export function isTilePlacementDefault(
  value: unknown,
): value is TilePlacementSettings["default"] {
  return isTilePlacement(value) || value === "per-category";
}

export function isAgentTabSurfacing(
  value: unknown,
): value is AgentTabSurfacing {
  return value === "off" || value === "surface";
}

export function isContextIndicatorStyle(
  value: unknown,
): value is ContextIndicatorStyle {
  return value === "text" || value === "ring" || value === "ring-only";
}

/**
 * Unknown ids are dropped (a row renamed or retired since the value was
 * written), duplicates collapse, and the survivors take canonical order. A
 * list left empty by that - or anything that is not a list - falls back to
 * every field, since the strip is never drawn with none.
 */
function resolvePersistedPinnedContextBreakdownFields(
  value: unknown,
): ReadonlyArray<ContextBreakdownField> {
  if (!Array.isArray(value)) return DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS;
  const selected = new Set(value.filter(isContextUsageRowKey));
  if (selected.size === 0) return DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS;
  return CONTEXT_USAGE_ROW_KEYS.filter((candidate) => selected.has(candidate));
}

/** The configured mode for one link kind; the global default wins unless it
 * defers to the per-kind overrides. */
export function linkOpenModeForKind(
  settings: LinkOpenSettings,
  kind: LinkKindSetting,
): LinkOpenMode {
  return settings.default === "per-kind" ? settings[kind] : settings.default;
}

/** The setting row each placement category reads. Spelled out because the
 * category words are the resolver's and the keys are the store's; a total
 * record keeps the two in step when either side grows. */
const TILE_PLACEMENT_KEY_BY_CATEGORY: Record<
  TilePlacementCategory,
  Exclude<keyof TilePlacementSettings, "default">
> = {
  content: "content",
  conversation: "conversation",
  browser: "browser",
  "side-chat": "sideChat",
};

/** Same shape for tiles: the global default wins unless it defers per
 * category. Only `browser` can answer `pip`. */
export function tilePlacementForCategory(
  settings: TilePlacementSettings,
  category: TilePlacementCategory,
): BrowserTilePlacement {
  return settings.default === "per-category"
    ? settings[TILE_PLACEMENT_KEY_BY_CATEGORY[category]]
    : settings.default;
}

/**
 * Rehydration for the link/tile/agent settings, which doubles as the one-shot
 * migration off the pre-refactor keys (`browserLinkDefaultMode`,
 * `{terminal,markdown}BrowserLinkOpenMode`, `agentTabSurfacingMode`). The old
 * keys are read here and nowhere else; `partialize` does not list them, so the
 * next write drops them. `github` and `image` are new kinds with no legacy
 * value - they take the default.
 */
function resolvePersistedLinkOpen(
  persisted: Record<string, unknown>,
): LinkOpenSettings {
  const stored: Record<string, unknown> = isRecord(persisted.linkOpen)
    ? persisted.linkOpen
    : {};
  return {
    default: resolveLinkOpenDefault(
      stored.default,
      persisted.browserLinkDefaultMode,
    ),
    markdown: resolveLinkOpenMode(
      stored.markdown,
      persisted.markdownBrowserLinkOpenMode,
    ),
    terminal: resolveLinkOpenMode(
      stored.terminal,
      persisted.terminalBrowserLinkOpenMode,
    ),
    github: resolveLinkOpenMode(stored.github, null),
    image: resolveLinkOpenMode(stored.image, null),
  };
}

function resolveLinkOpenDefault(
  value: unknown,
  legacy: unknown,
): LinkOpenSettings["default"] {
  if (isLinkOpenDefault(value)) return value;
  if (isLinkOpenDefault(legacy)) return legacy;
  return DEFAULT_LINK_OPEN_SETTINGS.default;
}

function resolveLinkOpenMode(value: unknown, legacy: unknown): LinkOpenMode {
  if (isLinkOpenMode(value)) return value;
  if (isLinkOpenMode(legacy)) return legacy;
  return DEFAULT_LINK_OPEN_MODE;
}

/**
 * The retired `agentTabSurfacingMode` migrates into `agentTabSurfacing` ONLY
 * (see `resolvePersistedAgentTabSurfacing`). It described what an
 * AGENT-opened tab did, and the new browser placement governs every browser
 * open - so carrying `pip` across would float every link the user clicks,
 * which is not what the old setting ever said. Both legacy values leave the
 * browser placement at its default.
 */
function resolvePersistedTilePlacement(
  persisted: Record<string, unknown>,
): TilePlacementSettings {
  const stored: Record<string, unknown> = isRecord(persisted.tilePlacement)
    ? persisted.tilePlacement
    : {};
  return {
    default: isTilePlacementDefault(stored.default)
      ? stored.default
      : DEFAULT_TILE_PLACEMENT_SETTINGS.default,
    content: isTilePlacement(stored.content)
      ? stored.content
      : DEFAULT_TILE_PLACEMENT_SETTINGS.content,
    conversation: isTilePlacement(stored.conversation)
      ? stored.conversation
      : DEFAULT_TILE_PLACEMENT_SETTINGS.conversation,
    browser: isBrowserTilePlacement(stored.browser)
      ? stored.browser
      : DEFAULT_TILE_PLACEMENT_SETTINGS.browser,
    // Newer than the other rows: a blob written before it existed takes the
    // default, which is the split-beside-the-source the feature always did.
    sideChat: isTilePlacement(stored.sideChat)
      ? stored.sideChat
      : DEFAULT_TILE_PLACEMENT_SETTINGS.sideChat,
  };
}

function resolvePersistedAgentTabSurfacing(
  persisted: Record<string, unknown>,
): AgentTabSurfacing {
  if (isAgentTabSurfacing(persisted.agentTabSurfacing)) {
    return persisted.agentTabSurfacing;
  }
  const legacy = persisted.agentTabSurfacingMode;
  if (legacy === "pip" || legacy === "tile") return "surface";
  return DEFAULT_AGENT_TAB_SURFACING;
}

let crossWindowSyncInstalled = false;

/**
 * Rehydrate this store when another window writes its persisted key (or
 * clears storage entirely - a `null` event key). Exported and guarded
 * (idempotent, no-op outside a DOM) rather than a bare module-scope
 * `window.addEventListener`, so it is callable from app bootstrap and from a
 * test without relying on import order to have wired it up.
 */
export function initSettingsCrossWindowSync(): void {
  if (crossWindowSyncInstalled) return;
  if (typeof window === "undefined") return;
  crossWindowSyncInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === persistKey(STORE_KEYS.settings)) {
      void useSettingsStore.persist.rehydrate();
    }
  });
}

initSettingsCrossWindowSync();
