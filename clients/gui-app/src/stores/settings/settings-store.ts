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
import {
  DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  isNotificationChimeSound,
  NOTIFICATION_CHIME_EVENT_TYPES,
  type NotificationChimeEventType,
  type NotificationChimeSound,
  type NotificationChimeSoundsByEvent,
} from "@/lib/notifications/notification-chime";

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
};
export const DEFAULT_AGENT_TAB_SURFACING: AgentTabSurfacing = "off";
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
  | "linkOpen"
  | "browserDevOrigins"
  | "tilePlacement"
  | "agentTabSurfacing"
  | "steerOnModEnterEnabled"
  | "diffViewerPreferences"
  | "workspaceFileWordWrap"
  | "notificationChimeSounds"
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
    linkOpen: state.linkOpen,
    browserDevOrigins: state.browserDevOrigins,
    tilePlacement: state.tilePlacement,
    agentTabSurfacing: state.agentTabSurfacing,
    steerOnModEnterEnabled: state.steerOnModEnterEnabled,
    diffViewerPreferences: state.diffViewerPreferences,
    workspaceFileWordWrap: state.workspaceFileWordWrap,
    notificationChimeSounds: state.notificationChimeSounds,
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
      linkOpen: DEFAULT_LINK_OPEN_SETTINGS,
      browserDevOrigins: [],
      tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
      agentTabSurfacing: DEFAULT_AGENT_TAB_SURFACING,
      steerOnModEnterEnabled: true,
      diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
      workspaceFileWordWrap: null,
      notificationChimeSounds: DEFAULT_NOTIFICATION_CHIME_SOUNDS,
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
        };
      },
    },
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/** The configured mode for one link kind; the global default wins unless it
 * defers to the per-kind overrides. */
export function linkOpenModeForKind(
  settings: LinkOpenSettings,
  kind: LinkKindSetting,
): LinkOpenMode {
  return settings.default === "per-kind" ? settings[kind] : settings.default;
}

/** Same shape for tiles: the global default wins unless it defers per
 * category. Only `browser` can answer `pip`. */
export function tilePlacementForCategory(
  settings: TilePlacementSettings,
  category: "content" | "conversation" | "browser",
): BrowserTilePlacement {
  return settings.default === "per-category"
    ? settings[category]
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
 * `agentTabSurfacingMode` carried the browser placement inside it: `pip`
 * floated, `tile` split the canvas. Surfacing and placement are separate
 * settings now, so the old value seeds both.
 */
/** The browser placement the retired `agentTabSurfacingMode` carried. */
function legacyBrowserPlacement(mode: unknown): BrowserTilePlacement | null {
  if (mode === "pip") return "pip";
  if (mode === "tile") return "split";
  return null;
}

function resolvePersistedTilePlacement(
  persisted: Record<string, unknown>,
): TilePlacementSettings {
  const stored: Record<string, unknown> = isRecord(persisted.tilePlacement)
    ? persisted.tilePlacement
    : {};
  const legacyBrowser = legacyBrowserPlacement(persisted.agentTabSurfacingMode);
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
      : (legacyBrowser ?? DEFAULT_TILE_PLACEMENT_SETTINGS.browser),
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
