import {
  defineContextualUpgradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  hostDoctorRequestSchema,
  hostDoctorResponseSchema,
  hostGetInstallationInfoRequestSchema,
  hostGetInstallationInfoResponseSchema,
  hostGetInstallationInfoResponseV11Schema,
  hostServiceDeregisterRequestSchema,
  hostServiceDeregisterResponseSchema,
  hostServiceRegisterRequestSchema,
  hostServiceRegisterResponseSchema,
  hostServiceStatusRequestSchema,
  hostServiceStatusResponseSchema,
  hostUpdateCheckRequestSchema,
  hostUpdateCheckRequestSchemaV11,
  hostUpdateCheckResponseSchema,
  hostUpdateCheckResponseSchemaV11,
  hostUpdateInstallRequestSchema,
  hostUpdateInstallResponseSchema,
  hostUpdateInstallResponseV11Schema,
} from "./schemas";

/** Runs the host's own CLI doctor against the host's local installation. */
export const hostDoctorV10 = defineRpcContract({
  method: "host.doctor",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostDoctorRequestSchema,
  responseSchema: hostDoctorResponseSchema,
});

/** Reads the CLI registry listing projected for this host's platform. */
export const hostUpdateCheckV10 = defineRpcContract({
  method: "host.update.check",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostUpdateCheckRequestSchema,
  responseSchema: hostUpdateCheckResponseSchema,
});

/**
 * v1.1: tri-state catalog override in, resolved inclusion + provenance out.
 *
 * The same registry listing as v1.0, asked and answered precisely enough for
 * an installed release candidate to have its own line included by DEFAULT
 * while an explicit "uncheck" can still filter RC rows off that same host.
 */
export const hostUpdateCheckV11 = defineRpcContract({
  method: "host.update.check",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostUpdateCheckRequestSchemaV11,
  responseSchema: hostUpdateCheckResponseSchemaV11,
});

/**
 * The within-major bridge from v1.0. Contextual because the v1.0 RESPONSE
 * cannot answer the new questions on its own — provenance is a fact about the
 * REQUEST, and the framework's response-upgrade context is the only place the
 * originating v1.0 request is still in hand.
 *
 * Request: v1.0 `true` was an explicit ask for RCs and stays `true`. v1.0
 * `false`/omitted becomes the ABSENT (derive) state, NOT `false`: those
 * clients had no way to express explicit exclusion, and their `false` was the
 * old stable-only DEFAULT rather than a deliberate filter. Mapping it to
 * `false` would pin every old client to stable-only even on an RC host,
 * defeating the feature for exactly the peers it most helps.
 *
 * That derive state is spelled by OMITTING the key, not by writing
 * `includePreReleases: undefined`. Both satisfy the contract's type and both
 * read the same under the documented `=== undefined` test, but they are
 * different objects: `{ includePreReleases: undefined }` has an own key, and a
 * v1.1 request parsed off the wire does not. Constructing the same shape both
 * ways keeps `"includePreReleases" in params` from answering differently for
 * one logical request depending on which peer it came from - a divergence a
 * resolver could only discover in production, against an old client.
 *
 * Response: an old host derived nothing, so the bridge reports what the old
 * contract actually meant — `true` becomes `explicit-include`, `false`/omitted
 * becomes stable-only under `stable-default`. It never claims `installed-rc`:
 * that provenance asserts a derivation the old peer did not perform, and the
 * Settings copy keyed off it would be a fabricated explanation.
 */
export const hostUpdateCheckUpgradeV10ToV11 = defineContextualUpgradePath<
  typeof hostUpdateCheckV10,
  typeof hostUpdateCheckV11
>({
  from: hostUpdateCheckV10.schemaVersion,
  to: hostUpdateCheckV11.schemaVersion,
  upgradeRequest: (request) =>
    request.includePreReleases ? { includePreReleases: true } : {},
  upgradeResponse: (response, context) => {
    if (response.outcome !== "ok") return response;
    if (context === undefined) {
      throw new Error(
        "host.update.check v1.0 responses require request context when upgraded to v1.1",
      );
    }
    const requested = context.request.includePreReleases;
    return {
      outcome: "ok",
      manifest: response.manifest,
      effectiveIncludePreReleases: requested,
      includePreReleasesSource: requested
        ? "explicit-include"
        : "stable-default",
    };
  },
});

/** Starts the CLI-owned, detached update swap for an explicitly chosen version. */
export const hostUpdateInstallV10 = defineRpcContract({
  method: "host.update.install",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostUpdateInstallRequestSchema,
  responseSchema: hostUpdateInstallResponseSchema,
});

/**
 * `@1.1` — the same dispatch, additionally naming the durable update attempt
 * when there is one to name. See
 * {@link hostUpdateInstallResponseV11Schema} for the per-arm semantics, which
 * are asymmetric on purpose (`already-updating` carries the id; `accepted`
 * carries `null` until ticket 07 wires the adoption acknowledgement).
 */
export const hostUpdateInstallV11 = defineRpcContract({
  method: "host.update.install",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostUpdateInstallRequestSchema,
  responseSchema: hostUpdateInstallResponseV11Schema,
});

/**
 * A `@1.0` peer said nothing about attempts, so both arms upgrade to `null` —
 * the same "did not report" convention `busySessionCount` / `busyBreakdown` set
 * on `host.status`, and for the same reason: the upgrade path must not put an
 * affirmative claim in an old peer's mouth. A `@1.0` host may well be running
 * an update; it simply has no way to name it, and a consumer that reads `null`
 * as "no attempt" would be inventing the one fact this field exists to carry.
 */
export const hostUpdateInstallUpgradeV10ToV11 = defineUpgradePath<
  typeof hostUpdateInstallV10,
  typeof hostUpdateInstallV11
>({
  from: hostUpdateInstallV10.schemaVersion,
  to: hostUpdateInstallV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) =>
    response.outcome === "accepted" || response.outcome === "already-updating"
      ? { ...response, attemptId: null }
      : response,
});

/** Returns this slot's shared on-disk installation records, or tree-run state. */
export const hostGetInstallationInfoV10 = defineRpcContract({
  method: "host.getInstallationInfo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostGetInstallationInfoRequestSchema,
  responseSchema: hostGetInstallationInfoResponseSchema,
});

/**
 * `@1.1` — the same records, additionally attesting the extracted executable
 * with `executableSha256`.
 *
 * v1.2.0 froze `@1.0` before that field existed, so serving it there is a
 * host→client divergence at a released version. A MINOR is the right shape:
 * the field is additive, host→client, and absent-tolerant on every consumer
 * (old hosts never sent it, and both record schemas normalize a missing value
 * to `null`). A major would demand downgrade bridges for a case the fleet
 * already handles.
 */
export const hostGetInstallationInfoV11 = defineRpcContract({
  method: "host.getInstallationInfo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostGetInstallationInfoRequestSchema,
  responseSchema: hostGetInstallationInfoResponseV11Schema,
});

/**
 * A `@1.0` peer never reported the attestation, so the upgrade fills `null` —
 * the same "did not report" convention `host.update.install`'s upgrade uses,
 * and for the same reason: an upgrade must not put an affirmative claim in an
 * old peer's mouth. `null` is already the value both record readers produce for
 * a legacy record with no attestation, so no consumer sees a novel shape.
 */
export const hostGetInstallationInfoUpgradeV10ToV11 = defineUpgradePath<
  typeof hostGetInstallationInfoV10,
  typeof hostGetInstallationInfoV11
>({
  from: hostGetInstallationInfoV10.schemaVersion,
  to: hostGetInstallationInfoV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) =>
    response.status === "managed"
      ? {
          ...response,
          installRecord: {
            ...response.installRecord,
            executableSha256: null,
          },
          stagedRecord:
            response.stagedRecord === null
              ? null
              : { ...response.stagedRecord, executableSha256: null },
        }
      : response,
});

/** Reads the OS service registration + run state for this host's environment. */
export const hostServiceStatusV10 = defineRpcContract({
  method: "host.service.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostServiceStatusRequestSchema,
  responseSchema: hostServiceStatusResponseSchema,
});

/** Registers (or re-registers) the OS service that supervises this host. */
export const hostServiceRegisterV10 = defineRpcContract({
  method: "host.service.register",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostServiceRegisterRequestSchema,
  responseSchema: hostServiceRegisterResponseSchema,
});

/** Deregisters that service — which stops this host and does not restart it. */
export const hostServiceDeregisterV10 = defineRpcContract({
  method: "host.service.deregister",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostServiceDeregisterRequestSchema,
  responseSchema: hostServiceDeregisterResponseSchema,
});
