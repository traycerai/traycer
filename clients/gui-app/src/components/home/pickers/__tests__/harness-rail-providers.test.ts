import { describe, expect, it } from "vitest";
import type { HarnessOption } from "@/components/home/data/landing-options";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { visibleRailEntries } from "@/components/home/pickers/harness-rail-providers";

function harness(id: "claude" | "codex"): HarnessOption {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    availabilityPending: false,
  };
}

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

describe("splitRailEntriesForHarness (via visibleRailEntries)", () => {
  it("maps the ambient profile's rail entry to profileId null, not the wire sentinel", () => {
    const entries = visibleRailEntries(
      [harness("claude")],
      [],
      new Set(),
      new Map([
        [
          "claude",
          [
            profile("ambient", "ambient", "Claude Terminal account"),
            profile("work-uuid", "managed", "Work"),
          ],
        ],
      ]),
    );

    expect(entries).toHaveLength(2);
    // The ambient entry must commit `null` - the same "ambient" value every
    // other run/session-level profileId and the composer's memory keying
    // use - not the wire array's literal "ambient" sentinel.
    expect(entries[0]).toMatchObject({
      profileId: null,
      label: "Claude Code - Claude Terminal account",
    });
    expect(entries[1]).toMatchObject({
      profileId: "work-uuid",
      label: "Claude Code - Work",
    });
  });

  it("renders a single profileId:null entry for a harness with under 2 profiles", () => {
    const entries = visibleRailEntries(
      [harness("codex")],
      [],
      new Set(),
      new Map([
        ["codex", [profile("ambient", "ambient", "Codex Terminal account")]],
      ]),
    );

    expect(entries).toEqual([
      {
        harness: harness("codex"),
        profileId: null,
        label: "Codex",
        degraded: false,
        profileBadge: null,
      },
    ]);
  });
});
