import { EPIC_REPLICAS_MAX_LIVE } from "./budget-limits";

/**
 * The four count caps that decide how much of the app stays RESIDENT while the user is elsewhere,
 * chosen once per shell.
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
 * Selects the profile for this shell. Called by the Capacitor entry's bootstrap next to
 * `setMobileApp`; desktop and the browser never call it and run the desktop profile.
 */
export function setRetentionProfile(profile: RetentionProfile): void {
  activeProfile = profile;
}

export function getRetentionProfile(): RetentionProfile {
  return activeProfile;
}
