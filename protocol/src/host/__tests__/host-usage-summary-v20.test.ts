/**
 * `host.usage.summary@2.0` (D21/D27): optional `profileId` + `harnessId`
 * filters.
 *
 * Named `-v20`, not `-minors` (discrepancy from the ticket, which asked for
 * an in-place `@1.1` minor): `hostUsageSummaryRequestSchemaV10` is
 * `.strict()`, and the registry's minor-additivity validator
 * (`versioned-rpc.ts`) refuses ANY field growth on a minor whose previous
 * minor is `.strict()`, confirmed by running
 * `defineFloorAwareVersionedRpcRegistry(...)` with the field added in place.
 * A major is the only way to add this filter; see
 * `hostUsageSummaryRequestSchemaV20`'s own comment.
 */
import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  hostUsageSummaryDowngradeV20ToV10,
  hostUsageSummaryUpgradeV10ToV20,
} from "@traycer/protocol/host/usage-analytics/contracts";
import {
  hostUsageSummaryRequestSchemaV10,
  hostUsageSummaryRequestSchemaV20,
} from "@traycer/protocol/host/usage-analytics/schemas";

const baseV10Request = {
  timezone: "America/Los_Angeles",
  windowDays: 30,
  epicId: null,
};

describe("host.usage.summary@2.0 profileId (D21/D27)", () => {
  it("hostUsageSummaryRequestSchemaV10.strict() still REJECTS profileId - the reason the major exists", () => {
    expect(
      hostUsageSummaryRequestSchemaV10.safeParse({
        ...baseV10Request,
        profileId: "profile-1",
      }).success,
    ).toBe(false);
  });

  it("@1.0 request upgrades to @2.0 unchanged (profileId: null)", () => {
    const upgraded =
      hostUsageSummaryUpgradeV10ToV20.upgradeRequest(baseV10Request);
    expect(upgraded).toEqual({
      ...baseV10Request,
      profileId: null,
      harnessId: null,
    });

    const viaRegistry = upgradeRequestToVersion(
      hostRpcRegistry["host.usage.summary"],
      { major: 1, minor: 0 },
      { major: 2, minor: 0 },
      baseV10Request,
    );
    expect(viaRegistry).toEqual({
      ...baseV10Request,
      profileId: null,
      harnessId: null,
    });
  });

  it("@2.0 with profileId parses", () => {
    const parsed = hostUsageSummaryRequestSchemaV20.parse({
      ...baseV10Request,
      profileId: "profile-1",
    });
    expect(parsed.profileId).toBe("profile-1");
  });

  it("@2.0 -> @1.0 downgrade strips profileId (a narrowing, never DOWNGRADE_UNSUPPORTED)", () => {
    const downgraded = hostUsageSummaryDowngradeV20ToV10.downgradeRequest({
      ...baseV10Request,
      profileId: "profile-1",
      harnessId: "codex",
    });
    expect(downgraded).toEqual({ ok: true, value: baseV10Request });

    const viaRegistry = downgradeRequestAcrossMajors(
      hostRpcRegistry["host.usage.summary"],
      2,
      1,
      { ...baseV10Request, profileId: "profile-1", harnessId: "codex" },
    );
    expect(viaRegistry).toEqual({ ok: true, value: baseV10Request });
  });

  it("hostUsageSummaryRequestSchemaV10.strict() also REJECTS harnessId - the @1.0 line stays frozen", () => {
    expect(
      hostUsageSummaryRequestSchemaV10.safeParse({
        ...baseV10Request,
        harnessId: "codex",
      }).success,
    ).toBe(false);
  });

  it("@2.0 carries harnessId beside profileId (wave-5 O1: the Default account is not provider-scoped without it)", () => {
    const parsed = hostUsageSummaryRequestSchemaV20.parse({
      ...baseV10Request,
      profileId: "ambient",
      harnessId: "codex",
    });
    expect(parsed.harnessId).toBe("codex");
    expect(parsed.profileId).toBe("ambient");
  });
});
