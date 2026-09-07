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

/** v1.1: tri-state catalog override in, resolved inclusion + provenance out. */
export const hostUpdateCheckV11 = defineRpcContract({
  method: "host.update.check",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostUpdateCheckRequestSchemaV11,
  responseSchema: hostUpdateCheckResponseSchemaV11,
});

/**
 * The within-major bridge from v1.0.
 * It never claims `installed-rc`: that provenance asserts a derivation the old peer did not perform, and the Settings copy keyed off it would be a fabricated explanation.
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
 * `@1.1` - the same dispatch, additionally naming the durable update attempt when there is one to name.
 */
export const hostUpdateInstallV11 = defineRpcContract({
  method: "host.update.install",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostUpdateInstallRequestSchema,
  responseSchema: hostUpdateInstallResponseV11Schema,
});

/** `@1.2` advertises explicit downgrade support. */
export const hostUpdateInstallV12 = defineRpcContract({
  method: "host.update.install",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: hostUpdateInstallRequestSchema,
  responseSchema: hostUpdateInstallResponseV11Schema,
});

export const hostUpdateInstallUpgradeV11ToV12 = defineUpgradePath<
  typeof hostUpdateInstallV11,
  typeof hostUpdateInstallV12
>({
  from: hostUpdateInstallV11.schemaVersion,
  to: hostUpdateInstallV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/**
 * A `@1.0` peer said nothing about attempts, so both arms upgrade to `null` - the same "did not report" convention `busySessionCount` / `busyBreakdown` set on `host.status`, and for the same reason: the upgrade path must.
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
 * `@1.1` - the same records, additionally attesting the extracted executable with `executableSha256`.
 * A MINOR is the right shape: the field is additive, host→client, and absent-tolerant on every consumer (old hosts never sent it, and both record schemas normalize a missing value to `null`).
 */
export const hostGetInstallationInfoV11 = defineRpcContract({
  method: "host.getInstallationInfo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostGetInstallationInfoRequestSchema,
  responseSchema: hostGetInstallationInfoResponseV11Schema,
});

/**
 * A `@1.0` peer never reported the attestation, so the upgrade fills `null` - the same "did not report" convention `host.update.install`'s upgrade uses, and for the same reason: an upgrade must not put an affirmative.
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

/** Deregisters that service - which stops this host and does not restart it. */
export const hostServiceDeregisterV10 = defineRpcContract({
  method: "host.service.deregister",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostServiceDeregisterRequestSchema,
  responseSchema: hostServiceDeregisterResponseSchema,
});
