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
