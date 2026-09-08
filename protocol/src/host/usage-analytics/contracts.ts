import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  hostUsageSummaryRequestSchemaV10,
  hostUsageSummaryRequestSchemaV20,
  hostUsageSummaryResponseSchemaV10,
} from "@traycer/protocol/host/usage-analytics/schemas";

/**
 * `host.usage.summary` - the usage analytics read path (see the
 * replication-and-read-path artifact). Brand-new v1.0 method, unreleased and
 * therefore not on `RELEASED_FLOOR_METHOD_NAMES`; registered in
 * `registry.ts` with `degrade: { kind: "unsupported" }` like
 * `snapshots.getLocalStorageSize` above it. A host that predates this
 * capability simply lacks the method; the client feature-detects at
 * handshake and hides the usage surface rather than treating the miss as a
 * fatal mismatch.
 */
export const hostUsageSummaryV10 = defineRpcContract({
  method: "host.usage.summary",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostUsageSummaryRequestSchemaV10,
  responseSchema: hostUsageSummaryResponseSchemaV10,
});

/**
 * D21/D27: adds optional `profileId` + `harnessId` filters to narrow the
 * totals to one profile on one harness. Response is UNCHANGED -
 * `usageSummarySchema` itself gains no per-profile buckets here; W5-T2 owns
 * that if it turns out to need one.
 *
 * `harnessId` is not separable from `profileId` in practice: the Default
 * account is `effectiveProfileId === null` on EVERY provider, so a
 * profile-only filter answers a per-provider Usage card with every
 * provider's default-account facts (wave-5 review O1). See
 * `hostUsageSummaryRequestSchemaV20` for why the key is `harnessId` rather
 * than `providerId`.
 *
 * A MAJOR (discrepancy from the ticket text, which called for an in-place
 * `@1.1` minor): `hostUsageSummaryRequestSchemaV10` is `.strict()`, and the
 * registry's minor-additivity validator refuses any field growth on a minor
 * whose previous minor is `.strict()` regardless of how the new schema is
 * built - see `hostUsageSummaryRequestSchemaV20`'s own comment. Confirmed by
 * running `defineFloorAwareVersionedRpcRegistry(...)`, which throws
 * "Minor 1.1 for method 'host.usage.summary' request adds field 'profileId'
 * to a strict object" when this line is registered as a minor.
 */
export const hostUsageSummaryV20 = defineRpcContract({
  method: "host.usage.summary",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: hostUsageSummaryRequestSchemaV20,
  responseSchema: hostUsageSummaryResponseSchemaV10,
});

export const hostUsageSummaryUpgradeV10ToV20 = defineUpgradePath<
  typeof hostUsageSummaryV10,
  typeof hostUsageSummaryV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  // An old client only ever meant every profile on every harness.
  upgradeRequest: (request) => ({
    ...request,
    profileId: null,
    harnessId: null,
  }),
  upgradeResponse: (response) => response,
});

/**
 * `profileId`/`harnessId` only ever NARROW a read (see the request's own doc
 * comment), so downgrading to a host that cannot filter is an honest
 * degradation - it returns every profile's totals instead of refusing. Never
 * `DOWNGRADE_UNSUPPORTED`: unlike a write, a read returning MORE than asked
 * is not a silently-wrong target.
 */
export const hostUsageSummaryDowngradeV20ToV10 = defineDowngradePath<
  typeof hostUsageSummaryV20,
  typeof hostUsageSummaryV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => {
    const { profileId: _profileId, harnessId: _harnessId, ...rest } = request;
    return { ok: true, value: rest };
  },
  downgradeResponse: (response) => ({ ok: true, value: response }),
});
