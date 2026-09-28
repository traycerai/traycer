import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import type { LayoutOverrides, LayoutValues } from "@/lib/layout/layout-values";

/**
 * The three densities, and the arithmetic that turns one of them plus a delta
 * into what the app draws.
 *
 * The values are held as the LAST-APPLIED preset plus the user's own override
 * delta (`LayoutOverrides`). Applying a preset replaces every value with the
 * preset's - the delta is cleared - and leaves the arrangement alone, so
 * placement, order and provider choices survive a change of density. What is
 * changed is measured by difference against the last-applied preset
 * (`layout-diff.ts`).
 */

export type LayoutPresetId = "default" | "compact" | "detailed";

export const LAYOUT_PRESET_IDS: ReadonlyArray<LayoutPresetId> = [
  "default",
  "compact",
  "detailed",
];

/** Each preset's name, as the form, its status line and its toast say it. */
export const PRESET_LABELS: Readonly<Record<LayoutPresetId, string>> = {
  default: "Default",
  compact: "Compact",
  detailed: "Detailed",
};

/**
 * Every region exactly as the app ships it, which is also the Default preset.
 *
 * One constant rather than two, so "Default is the defaults" cannot drift into
 * a copy that lags - and so analytics can say "differs from the SHIPPED
 * Default" (L-46) by reading the same object the preset reads.
 */
export const SHIPPED_DEFAULT_VALUES: LayoutValues = {
  homeTab: { shown: "hidden" },
  usageLimits: {
    shown: "shown",
    bar: true,
    percent: true,
    word: true,
    reset: true,
    amount: "used",
  },
  // CPU and process count, not memory: on a fresh install the host's memory
  // figure is the one a reader cannot act on, and it cost the scarcest row in
  // the app a third chip.
  resourceMonitor: {
    shown: "shown",
    cpu: true,
    memory: false,
    processes: true,
    ramShare: false,
    agentRows: true,
  },
  minimap: { shown: "shown" },
  contextUsage: {
    shown: "shown",
    style: "text",
    pinBreakdown: false,
    pinnedFields: CONTEXT_USAGE_ROW_KEYS,
    compactButton: "shown",
  },
  toolActivity: { size: "chip" },
  thinking: { shown: "shown", size: "chip" },
  timestamps: { shown: "shown" },
  runningAgents: { shown: "shown", size: "full" },
  changedFiles: { shown: "shown", size: "full" },
  background: { shown: "shown", size: "full" },
  todo: { shown: "shown", size: "full" },
  attachImage: { shown: "shown" },
  access: { size: "full" },
  model: { style: "text", reasoningControl: "slider" },
  mic: { shown: "shown" },
  railAgents: { shown: "shown" },
  railTerminals: { shown: "shown" },
  railBrowsers: { shown: "shown" },
  railArtifacts: { shown: "shown" },
  railGitDiff: { shown: "shown" },
  railPullRequests: { shown: "auto" },
  railFileTree: { shown: "shown" },
  railSharing: { shown: "shown" },
  railComments: { shown: "auto" },
};

/**
 * The least chrome that still says everything: every reading present, none of
 * it spelled out.
 *
 * The usage reading keeps its percentage and drops the three things that make
 * it long (the mode word, the bar, the countdown). The composer folds its dock
 * rows and its access picker to chips - each keeps every verb it had - and
 * hides the two elements that have a full route elsewhere: the dictation chord
 * starts voice input, and the palette and `/compact` compact a conversation.
 *
 * Attach image stays shown, alone among the composer's buttons: paste and
 * drag-drop both need the image already in hand, so hiding the button would
 * remove the only way to attach a file from disk. Density shortens a reading;
 * it does not cost a gesture.
 */
const COMPACT_VALUES: LayoutValues = {
  ...SHIPPED_DEFAULT_VALUES,
  usageLimits: {
    shown: "shown",
    bar: false,
    percent: true,
    word: false,
    reset: false,
    amount: "used",
  },
  resourceMonitor: {
    shown: "shown",
    cpu: true,
    memory: false,
    processes: false,
    ramShare: false,
    // The sidebar's per-agent CPU/RSS/process readout crowds the agent titles
    // out of a narrow row; the status bar's total still reads.
    agentRows: false,
  },
  contextUsage: {
    shown: "shown",
    style: "ring-only",
    pinBreakdown: false,
    // Left at the full set even though the strip is unpinned: the fields only
    // read while the pin is on, so narrowing them here would be a change
    // nothing on screen shows and one a user would meet later, unexplained.
    pinnedFields: CONTEXT_USAGE_ROW_KEYS,
    compactButton: "hidden",
  },
  // Reasoning is commentary on work the transcript already shows, and the
  // time on each message is the last reading in it with no job to do while
  // reading; activity rows stay, since approvals and failures ride them.
  thinking: { shown: "hidden", size: "chip" },
  timestamps: { shown: "hidden" },
  runningAgents: { shown: "shown", size: "chip" },
  changedFiles: { shown: "shown", size: "chip" },
  background: { shown: "shown", size: "chip" },
  todo: { shown: "shown", size: "chip" },
  access: { size: "chip" },
  model: { style: "bars", reasoningControl: "slider" },
  mic: { shown: "hidden" },
};

/**
 * Everything the chrome can say, said: every reading in its long form, and
 * every element the composer can show shown.
 */
const DETAILED_VALUES: LayoutValues = {
  ...SHIPPED_DEFAULT_VALUES,
  usageLimits: {
    shown: "shown",
    bar: true,
    percent: true,
    word: true,
    reset: true,
    amount: "used",
  },
  resourceMonitor: {
    shown: "shown",
    cpu: true,
    memory: true,
    processes: true,
    ramShare: true,
    agentRows: true,
  },
  contextUsage: {
    shown: "shown",
    style: "text",
    pinBreakdown: true,
    pinnedFields: CONTEXT_USAGE_ROW_KEYS,
    compactButton: "shown",
  },
  // Every thinking level spelled out by name, which is what the list does.
  model: { style: "bars-text", reasoningControl: "list" },
  toolActivity: { size: "full" },
  thinking: { shown: "shown", size: "full" },
};

export const PRESET_VALUES: Readonly<Record<LayoutPresetId, LayoutValues>> = {
  default: SHIPPED_DEFAULT_VALUES,
  compact: COMPACT_VALUES,
  detailed: DETAILED_VALUES,
};

/** The base preset's values with the override delta laid over them. */
export function effectiveLayoutValues(
  basePreset: LayoutPresetId,
  overrides: LayoutOverrides,
): LayoutValues {
  const base = PRESET_VALUES[basePreset];
  return {
    homeTab: { ...base.homeTab, ...overrides.homeTab },
    usageLimits: { ...base.usageLimits, ...overrides.usageLimits },
    resourceMonitor: { ...base.resourceMonitor, ...overrides.resourceMonitor },
    minimap: { ...base.minimap, ...overrides.minimap },
    contextUsage: { ...base.contextUsage, ...overrides.contextUsage },
    toolActivity: { ...base.toolActivity, ...overrides.toolActivity },
    thinking: { ...base.thinking, ...overrides.thinking },
    timestamps: { ...base.timestamps, ...overrides.timestamps },
    runningAgents: { ...base.runningAgents, ...overrides.runningAgents },
    changedFiles: { ...base.changedFiles, ...overrides.changedFiles },
    background: { ...base.background, ...overrides.background },
    todo: { ...base.todo, ...overrides.todo },
    attachImage: { ...base.attachImage, ...overrides.attachImage },
    access: { ...base.access, ...overrides.access },
    model: { ...base.model, ...overrides.model },
    mic: { ...base.mic, ...overrides.mic },
    railAgents: { ...base.railAgents, ...overrides.railAgents },
    railTerminals: { ...base.railTerminals, ...overrides.railTerminals },
    railBrowsers: { ...base.railBrowsers, ...overrides.railBrowsers },
    railArtifacts: { ...base.railArtifacts, ...overrides.railArtifacts },
    railGitDiff: { ...base.railGitDiff, ...overrides.railGitDiff },
    railPullRequests: {
      ...base.railPullRequests,
      ...overrides.railPullRequests,
    },
    railFileTree: { ...base.railFileTree, ...overrides.railFileTree },
    railSharing: { ...base.railSharing, ...overrides.railSharing },
    railComments: { ...base.railComments, ...overrides.railComments },
  };
}
