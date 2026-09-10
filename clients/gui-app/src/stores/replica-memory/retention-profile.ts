import { EPIC_REPLICAS_MAX_LIVE } from "./budget-limits";

/**
 * The four count caps that decide how much of the app stays RESIDENT while
 * the user is elsewhere, chosen once per shell.
 *
 * All four used to be bare module constants with no platform branch, so the
 * phone ran the desktop numbers: five hidden-but-mounted top-level surfaces
 * (each a full React tree, DOM, editors and chat tiles), five live epic
 * runtimes (each a dedicated worker), six warm chats, six lingering
 * terminals. A desktop renderer has a 4 GB ceiling for that; iOS kills the
 * WebContent process at 2 GB, and the 2026-09-03 field report reached it by
 * opening tasks one after another (lag by six, kill by eight).
 *
 * The retained-surface count is the heavier lever and is lowered furthest.
 * The live-epic cap stays ABOVE it on purpose: a surface past the retention
 * window drops its DOM but its session stays warm, so re-entering re-mounts
 * against a live replica instead of taking a cold open. The chat and
 * terminal pools follow the same ratio.
 *
 * Read lazily by every consumer (registries resolve the cap on each walk,
 * the surface retention on each recompute), so the shell may select the
 * profile whenever its bootstrap runs - it does not have to beat module
 * evaluation of the registries.
 */
export interface RetentionProfile {
  /** Live epic sessions, mounted ones included (`OpenEpicSessionRegistry`). */
  readonly maxLiveEpics: number;
  /** Hidden top-level tabs kept mounted (`TopLevelTabHost`). */
  readonly retainedTopLevelSurfaces: number;
  /** Lease-free warm chat sessions (`ChatSessionRegistry`). */
  readonly maxWarmChatSessions: number;
  /** Lingering plain terminals (`TerminalSessionRegistry`). */
  readonly maxLingeringPlainTerminals: number;
}

/** Electron desktop and the browser: the numbers the app has always run. */
export const DESKTOP_RETENTION_PROFILE: RetentionProfile = Object.freeze({
  maxLiveEpics: EPIC_REPLICAS_MAX_LIVE,
  retainedTopLevelSurfaces: 5,
  maxWarmChatSessions: 6,
  maxLingeringPlainTerminals: 6,
});

/** The installed Capacitor app: a 2 GB process ceiling, one visible tab. */
export const MOBILE_RETENTION_PROFILE: RetentionProfile = Object.freeze({
  maxLiveEpics: 3,
  retainedTopLevelSurfaces: 2,
  maxWarmChatSessions: 3,
  maxLingeringPlainTerminals: 3,
});

/**
 * How long an epic must have had NO visible pane in ANY window before its tabs
 * are parked - every host subscription they cause released, the tabs themselves
 * left open (plan C, decisions C1/C3/C6).
 *
 * A TIME cap beside the four count caps above, and it belongs with them: the
 * counts bound how much stays resident while the user is elsewhere, this bounds
 * how LONG the thing they are looking away from keeps paying for itself. The
 * counts only reclaim under pressure - five live epics is five live epics
 * whether or not anyone has looked at four of them in an hour - so nothing
 * above this line can free a hidden epic on a machine that never reaches a cap.
 *
 * NOT per-profile, unlike the counts. The window is a statement about attention
 * ("no pane of this epic has been on screen for five minutes"), which does not
 * change with the size of the device's memory; what a smaller profile changes
 * is how many epics may be resident at once, and it already says so above.
 *
 * Exported for tests, which pin both arms of the threshold.
 */
export const PARK_HIDDEN_EPIC_AFTER_MS = 5 * 60_000;

let activeProfile: RetentionProfile = DESKTOP_RETENTION_PROFILE;

/**
 * Selects the profile for this shell. Called by the Capacitor entry's
 * bootstrap next to `setMobileApp`; desktop and the browser never call it and
 * run the desktop profile. Tests may set and reset it.
 */
export function setRetentionProfile(profile: RetentionProfile): void {
  activeProfile = profile;
}

export function getRetentionProfile(): RetentionProfile {
  return activeProfile;
}
