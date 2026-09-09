import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  getRetentionProfile,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";
import {
  MAX_RETAINED_TOP_LEVEL_SURFACES,
  retainedTopLevelSurfaceKeys,
} from "@/stores/tabs/top-level-surface-retention";
import { DEFAULT_MAX_WARM_CHAT_SESSIONS } from "@/stores/chats/session-registry";
import { MAX_LINGERING_PLAIN_TERMINALS } from "@/stores/terminals/terminal-session-registry";

// Every consumer of the active profile reads `getRetentionProfile()` lazily,
// so a test that switches it must restore the desktop profile afterward or
// leak the switch into an unrelated suite sharing this module's singleton.
afterEach(() => {
  setRetentionProfile(DESKTOP_RETENTION_PROFILE);
});

describe("RetentionProfile", () => {
  it("the desktop profile matches every plane's own exported constant", () => {
    // Each plane still names its own constant (`MAX_RETAINED_TOP_LEVEL_SURFACES`,
    // `DEFAULT_MAX_LIVE_EPICS`, `DEFAULT_MAX_WARM_CHAT_SESSIONS`,
    // `MAX_LINGERING_PLAIN_TERMINALS`) for its own suites and doc comments to
    // cite; those constants are now defined FROM the desktop profile, not the
    // other way around, so this pins that the binding still agrees.
    expect(DESKTOP_RETENTION_PROFILE.retainedTopLevelSurfaces).toBe(
      MAX_RETAINED_TOP_LEVEL_SURFACES,
    );
    expect(DESKTOP_RETENTION_PROFILE.maxLiveEpics).toBe(DEFAULT_MAX_LIVE_EPICS);
    expect(DESKTOP_RETENTION_PROFILE.maxWarmChatSessions).toBe(
      DEFAULT_MAX_WARM_CHAT_SESSIONS,
    );
    expect(DESKTOP_RETENTION_PROFILE.maxLingeringPlainTerminals).toBe(
      MAX_LINGERING_PLAIN_TERMINALS,
    );
  });

  it("the mobile profile is strictly smaller than desktop in every field", () => {
    expect(MOBILE_RETENTION_PROFILE.maxLiveEpics).toBeLessThan(
      DESKTOP_RETENTION_PROFILE.maxLiveEpics,
    );
    expect(MOBILE_RETENTION_PROFILE.retainedTopLevelSurfaces).toBeLessThan(
      DESKTOP_RETENTION_PROFILE.retainedTopLevelSurfaces,
    );
    expect(MOBILE_RETENTION_PROFILE.maxWarmChatSessions).toBeLessThan(
      DESKTOP_RETENTION_PROFILE.maxWarmChatSessions,
    );
    expect(MOBILE_RETENTION_PROFILE.maxLingeringPlainTerminals).toBeLessThan(
      DESKTOP_RETENTION_PROFILE.maxLingeringPlainTerminals,
    );
  });

  it("keeps the live-epic cap above the retained-surface count on mobile too", () => {
    // The live-epic cap stays ABOVE the surface-retention window on purpose: a
    // surface past its retention window drops its DOM but its session stays
    // warm, so re-entering re-mounts against a live replica instead of a cold
    // open. Pinning this on mobile too, not just desktop, is the point - a
    // profile that inverted the two on the tightest budget would silently
    // defeat the ratio the doc comment on `RetentionProfile` describes.
    expect(MOBILE_RETENTION_PROFILE.maxLiveEpics).toBeGreaterThan(
      MOBILE_RETENTION_PROFILE.retainedTopLevelSurfaces,
    );
  });

  it("getRetentionProfile reflects a profile switched at runtime", () => {
    expect(getRetentionProfile()).toBe(DESKTOP_RETENTION_PROFILE);

    setRetentionProfile(MOBILE_RETENTION_PROFILE);

    expect(getRetentionProfile()).toBe(MOBILE_RETENTION_PROFILE);
  });
});

describe("retainedTopLevelSurfaceKeys honours the active profile", () => {
  it("retains fewer keys once the mobile profile is active, and restores the desktop count when reset", () => {
    const available = ["0", "1", "2", "3", "4", "5"];
    const recency = ["5", "4", "3", "2", "1", "0"];

    const desktopRetained = retainedTopLevelSurfaceKeys(available, [], recency);
    expect(desktopRetained.length).toBe(
      DESKTOP_RETENTION_PROFILE.retainedTopLevelSurfaces,
    );

    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const mobileRetained = retainedTopLevelSurfaceKeys(available, [], recency);
    expect(mobileRetained.length).toBe(
      MOBILE_RETENTION_PROFILE.retainedTopLevelSurfaces,
    );
    expect(mobileRetained.length).toBeLessThan(desktopRetained.length);

    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    const restoredRetained = retainedTopLevelSurfaceKeys(
      available,
      [],
      recency,
    );
    expect(restoredRetained.length).toBe(desktopRetained.length);
  });
});
