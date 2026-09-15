import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  hostUsageSummaryRequestSchema,
  hostUsageSummaryRequestSchemaV10,
  hostUsageSummaryResponseSchemaV10,
} from "@traycer/protocol/host/usage-analytics/schemas";

/**
 * `host.usage.summary` - the usage analytics read path (see the
 * replication-and-read-path artifact). Off `RELEASED_FLOOR_METHOD_NAMES`
 * because it is OPTIONAL, not because it is new: `@1.0` is RELEASED and
 * frozen (it is in `released-baseline-surface.json` under `optionalUnary`).
 * This comment said "brand-new, unreleased" until `@2.0`; the sentence was
 * true when written and silently became a licence to edit a shipped line.
 * Check the baseline before believing any such claim, including this one.
 * Registered in
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
 * `host.usage.summary@2.0` - the `plane: "local-only"` request selector.
 *
 * A MAJOR, not a minor, and the reason is mechanical rather than a judgement
 * call: `@1.0`'s request is `.strict()`, so an older peer REJECTS an unknown
 * key instead of stripping it. The versioned-RPC additivity gate refuses the
 * minor outright with "adds field 'plane' to a strict object (an older strict
 * schema rejects the extra key instead of stripping it)" - the growth is not
 * compat-safe within a line, and no amount of host-side gating makes it so,
 * because the rejection happens in the OLD peer's parser.
 *
 * What the selector buys: `servedBy` says which reader answered, and on
 * `@1.0` the host always chose by making the cloud call. The cloud plane is
 * the only plane a cloud-authorized session gets, so no refusal routes to the
 * local reader; for a session holding no cloud verdict every refusal,
 * including the expired bearer that cohort has, is a retriable 503. So it
 * gets no usage panel while sitting on facts its own host recorded locally.
 *
 * Only the CLIENT can tell "my verdict was withdrawn" from "my credential
 * blipped", which is why this is a request field rather than a host-side
 * fallback: serving local on any missing credential would silently answer a
 * signed-in user's blip with this machine's numbers alone.
 *
 * The response is unchanged from `@1.0`. `servedBy: "local"` is already a
 * released value, so nothing downstream of the read learns a new shape.
 */
export const hostUsageSummaryV20 = defineRpcContract({
  method: "host.usage.summary",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: hostUsageSummaryRequestSchema,
  responseSchema: hostUsageSummaryResponseSchemaV10,
});

export const hostUsageSummaryUpgradeV10ToV20 = defineUpgradePath<
  typeof hostUsageSummaryV10,
  typeof hostUsageSummaryV20
>({
  from: hostUsageSummaryV10.schemaVersion,
  to: hostUsageSummaryV20.schemaVersion,
  // No synthesized `plane`. A `@1.0` caller asked the host to choose, and
  // forcing the local reader here would answer a cloud-entitled session from
  // this machine's facts alone - a silently smaller number, with no error.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/**
 * `@2.0` -> `@1.0`. REFUSES a request carrying the selector rather than
 * dropping it, the same shape and for the same reason as
 * `hostNotificationsListDowngradeV22ToV10`.
 *
 * Silently dropping `plane` would restore the cloud round trip on a bearer the
 * caller has just told us not to spend - the precise thing the field exists to
 * prevent - and the response would come back looking exactly like a normal
 * answer. A short-circuit the caller can see beats a plausible answer it
 * cannot distinguish from the real one. A caller that has NOT asked for the
 * selector downgrades cleanly, so a `@2.0` client keeps working against a
 * `@1.0` host for every request it could already express.
 */
export const hostUsageSummaryDowngradeV20ToV10 = defineDowngradePath<
  typeof hostUsageSummaryV20,
  typeof hostUsageSummaryV10
>({
  from: hostUsageSummaryV20.schemaVersion,
  to: hostUsageSummaryV10.schemaVersion,
  downgradeRequest: (request) => {
    if (request.plane !== undefined) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "The local-only usage plane selector has no representation in host.usage.summary@1.0",
        },
      };
    }
    const { plane: _plane, ...rest } = request;
    return { ok: true, value: rest };
  },
  downgradeResponse: (response) => ({ ok: true, value: response }),
});
