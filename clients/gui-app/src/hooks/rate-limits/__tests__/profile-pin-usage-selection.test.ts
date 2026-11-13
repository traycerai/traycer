import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  legacyProfile,
  pinProfile,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  resolveStatusBarProfileIds,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly aliases: readonly string[];
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: "authenticated",
    aliases: input.aliases,
    personNotice: null,
    terminalOnThisComputer: false,
    otherNames: [],
  });
}

const side = managed({ profileId: "side-row", label: "Side", aliases: [] });
const work = managed({
  profileId: "work-row",
  label: "Work",
  aliases: ["alias-work"],
});

function selection(input: {
  readonly shown: ReadonlyArray<string | null>;
  readonly lastUsed: string | null;
}): RateLimitProfileSelection {
  return {
    shownProfiles: { codex: input.shown },
    lastProfileByHarness:
      input.lastUsed === null ? {} : { codex: input.lastUsed },
  };
}

describe("resolveStatusBarProfileIds pin", () => {
  it("a checked alias draws the canonical row and not the first row", () => {
    expect(
      resolveStatusBarProfileIds(
        selection({ shown: ["alias-work"], lastUsed: null }),
        "codex",
        [side, work],
      ),
    ).toEqual(["work-row"]);
  });

  it("a remembered alias draws the canonical row", () => {
    expect(
      resolveStatusBarProfileIds(
        selection({ shown: [], lastUsed: "alias-work" }),
        "codex",
        [side, work],
      ),
    ).toEqual(["work-row"]);
  });

  it("a checked id that names no row is skipped and the first row is drawn", () => {
    expect(
      resolveStatusBarProfileIds(
        selection({ shown: ["missing-id"], lastUsed: null }),
        "codex",
        [side, work],
      ),
    ).toEqual(["side-row"]);
  });

  it("a 10.10-shaped list draws the named row and the first row for an unknown id", () => {
    const olderSide = legacyProfile({
      profileId: "side-row",
      label: "Side",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const olderWork = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    expect(
      resolveStatusBarProfileIds(
        selection({ shown: ["work-row"], lastUsed: null }),
        "codex",
        [olderSide, olderWork],
      ),
    ).toEqual(["work-row"]);
    expect(
      resolveStatusBarProfileIds(
        selection({ shown: ["missing-id"], lastUsed: null }),
        "codex",
        [olderSide, olderWork],
      ),
    ).toEqual(["side-row"]);
  });
});
