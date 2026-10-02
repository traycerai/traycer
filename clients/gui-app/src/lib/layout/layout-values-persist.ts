import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import {
  isStringList,
  type AccessValues,
  type ContextUsageValues,
  type LayoutOverrides,
  type LayoutValues,
  type ModelValues,
  type AutoRailValues,
  type ResourceMonitorValues,
  type ShownValues,
  type SizedValues,
  type UsageLimitsValues,
} from "@/lib/layout/layout-values";
import type { ReadingDensity } from "@/lib/layout/reading-density";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * The override delta as some build of the app wrote it, key by key against
 * this build's unions.
 *
 * Re-derived rather than shallow-merged for the reason every resolver in this
 * app is: each value picks a branch on a render path, so a hand-edited
 * `"compact"` on a row that only hides would ask a leaf for a shape it has no
 * case for.
 *
 * Re-deriving is also what makes a RETIRED region cost nothing: the table
 * below names this build's regions, so a key it has never heard of - an
 * `agent` override written before L-136 deleted that region - is simply not
 * read. No migration, no discard pass, no version (P5).
 *
 * **It does not minimize against the base preset, deliberately** (L-133). The
 * delta is what the USER PICKED, not what happens to differ from whichever
 * density is current, and those are two different facts: a pick that the
 * current preset already makes is invisible today and is the user's answer
 * again the moment they switch preset. Minimizing here is what made choosing a
 * density silently destroy every per-region change that density happened to
 * agree with - unrecoverably on the Settings page, which has no Undo (L-108).
 * "Changed" is measured by DIFFERENCE instead, where it always was
 * (`layout-diff.ts`), so a redundant pick costs a few stored bytes and nothing
 * else: no dot, no revert, no count and no analytics property.
 */
export function resolvePersistedOverrides(value: unknown): LayoutOverrides {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const resolved: MutableLayoutOverrides = {
    homeTab: shownPatch(stored.homeTab),
    usageLimits: usageLimitsPatch(stored.usageLimits),
    resourceMonitor: resourceMonitorPatch(stored.resourceMonitor),
    minimap: shownPatch(stored.minimap),
    contextUsage: contextUsagePatch(stored.contextUsage),
    // The same one-leaf `size` shape as Access, so the same resolver.
    toolActivity: accessPatch(stored.toolActivity),
    thinking: sizedPatch(stored.thinking),
    timestamps: shownPatch(stored.timestamps),
    runningAgents: sizedPatch(stored.runningAgents),
    changedFiles: sizedPatch(stored.changedFiles),
    background: sizedPatch(stored.background),
    todo: sizedPatch(stored.todo),
    attachImage: shownPatch(stored.attachImage),
    access: accessPatch(stored.access),
    model: modelPatch(stored.model),
    mic: shownPatch(stored.mic),
    railAgents: railPatch(stored.railAgents),
    railTerminals: railPatch(stored.railTerminals),
    railBrowsers: railPatch(stored.railBrowsers),
    railArtifacts: railPatch(stored.railArtifacts),
    railGitDiff: railPatch(stored.railGitDiff),
    railPullRequests: autoRailPatch(stored.railPullRequests),
    railFileTree: railPatch(stored.railFileTree),
    railSharing: railPatch(stored.railSharing),
    railComments: autoRailPatch(stored.railComments),
  };
  // The table above states every region, so one the resolver found nothing
  // valid in is present and empty; dropping those is what keeps `Object.keys`
  // over the delta a count of the regions a user has actually picked on.
  const writable: Record<string, unknown> = resolved;
  for (const region of Object.keys(writable)) {
    const patch = writable[region];
    if (isRecord(patch) && Object.keys(patch).length === 0) {
      delete writable[region];
    }
  }
  return resolved;
}

type MutableLayoutOverrides = {
  -readonly [K in RegionId]?: Partial<LayoutValues[K]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shownPatch(value: unknown): Partial<ShownValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return stored.shown === "shown" || stored.shown === "hidden"
    ? { shown: stored.shown }
    : {};
}

function sizedPatch(value: unknown): Partial<SizedValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    ...shownPatch(value),
    ...(stored.size === "full" || stored.size === "chip"
      ? { size: stored.size }
      : {}),
  };
}

/**
 * An always-present rail panel. An earlier build stored `auto` for "follow the
 * panel's rule", and that rule was "always", so it reads as `shown`.
 */
function railPatch(value: unknown): Partial<ShownValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return stored.shown === "auto" ? { shown: "shown" } : shownPatch(value);
}

function autoRailPatch(value: unknown): Partial<AutoRailValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return stored.shown === "auto" ||
    stored.shown === "shown" ||
    stored.shown === "hidden"
    ? { shown: stored.shown }
    : {};
}

/**
 * A reading's density. `density` wins when it is there; an earlier build wrote
 * `display` instead, and `icon` is the one answer that was a choice:
 * `compact`. Every preset set `full`, so a stored `full` reads as the default,
 * `auto`. A record with neither key says nothing and the preset answers.
 */
function densityPatch(
  stored: Record<string, unknown>,
): Partial<{ density: ReadingDensity }> {
  if (
    stored.density === "auto" ||
    stored.density === "compact" ||
    stored.density === "detailed"
  ) {
    return { density: stored.density };
  }
  if (stored.display === "icon") return { density: "compact" };
  if (stored.display === "full") return { density: "auto" };
  return {};
}

function usageLimitsPatch(value: unknown): Partial<UsageLimitsValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    ...shownPatch(value),
    ...(typeof stored.reset === "boolean" ? { reset: stored.reset } : {}),
    ...(stored.amount === "used" || stored.amount === "remaining"
      ? { amount: stored.amount }
      : {}),
    ...densityPatch(stored),
  };
}

function resourceMonitorPatch(value: unknown): Partial<ResourceMonitorValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    ...shownPatch(value),
    ...(typeof stored.cpu === "boolean" ? { cpu: stored.cpu } : {}),
    ...(typeof stored.memory === "boolean" ? { memory: stored.memory } : {}),
    ...(typeof stored.processes === "boolean"
      ? { processes: stored.processes }
      : {}),
    ...(typeof stored.ramShare === "boolean"
      ? { ramShare: stored.ramShare }
      : {}),
    ...(typeof stored.agentRows === "boolean"
      ? { agentRows: stored.agentRows }
      : {}),
    ...densityPatch(stored),
  };
}

function contextUsagePatch(value: unknown): Partial<ContextUsageValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const storedFields = stored.pinnedFields;
  // Held in the breakdown's canonical order rather than in toggle order, so
  // two selections of the same rows can never read as different.
  const pinnedFields = isStringList(storedFields)
    ? CONTEXT_USAGE_ROW_KEYS.filter((key) => storedFields.includes(key))
    : [];
  return {
    ...shownPatch(value),
    ...(stored.style === "text" ||
    stored.style === "ring" ||
    stored.style === "ring-only"
      ? { style: stored.style }
      : {}),
    ...(typeof stored.pinBreakdown === "boolean"
      ? { pinBreakdown: stored.pinBreakdown }
      : {}),
    // An empty selection is not a state the pinned strip has - it would draw
    // an empty row - so it resolves to no override at all.
    ...(pinnedFields.length === 0 ? {} : { pinnedFields }),
    ...(stored.compactButton === "shown" || stored.compactButton === "hidden"
      ? { compactButton: stored.compactButton }
      : {}),
  };
}

/**
 * Access and Model have no Shown (G6), so a `shown` an earlier build stored is
 * not read - the pickers always drew, whatever it said.
 */
function accessPatch(value: unknown): Partial<AccessValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return stored.size === "full" || stored.size === "chip"
    ? { size: stored.size }
    : {};
}

function modelPatch(value: unknown): Partial<ModelValues> {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    ...(stored.style === "text" ||
    stored.style === "bars" ||
    stored.style === "bars-text"
      ? { style: stored.style }
      : {}),
    ...(stored.reasoningControl === "slider" ||
    stored.reasoningControl === "list"
      ? { reasoningControl: stored.reasoningControl }
      : {}),
    ...(stored.toolbarStyle === "flat" || stored.toolbarStyle === "bordered"
      ? { toolbarStyle: stored.toolbarStyle }
      : {}),
  };
}
