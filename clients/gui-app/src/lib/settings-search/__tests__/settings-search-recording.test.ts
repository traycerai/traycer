import { describe, expect, it } from "vitest";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { searchSettings } from "@/lib/settings-search/settings-search";

const SOUNDTRACK_DESKTOP: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
  phoneLayout: false,
  soundtrackOffered: true,
  soundtrackRecordingOffered: true,
  soundtrackOn: true,
};

const RECORDING_ANCHOR = "sounds-soundtrack-recording";

function recordingHits(
  query: string,
  context: SettingsAvailabilityContext,
): string[] {
  return searchSettings(query, context).flatMap((result) =>
    result.entry.anchor === RECORDING_ANCHOR ? [result.entry.section] : [],
  );
}

describe("settings search for Record session", () => {
  it.each(["record", "recording"])(
    "finds the row under %s where the desktop can save a recording",
    (query) => {
      expect(recordingHits(query, SOUNDTRACK_DESKTOP)).toEqual([
        "app-notifications",
      ]);
    },
  );

  it.each(["record", "recording"])(
    "does not find it under %s without the save channel",
    (query) => {
      expect(
        recordingHits(query, {
          ...SOUNDTRACK_DESKTOP,
          soundtrackRecordingOffered: false,
        }),
      ).toEqual([]);
    },
  );
});
