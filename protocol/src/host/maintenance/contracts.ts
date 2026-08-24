import {
  defineContextualUpgradePath,
  defineRpcContract,
} from "@traycer/protocol/framework/index";
import {
  hostDoctorRequestSchema,
  hostDoctorResponseSchema,
  hostGetInstallationInfoRequestSchema,
  hostGetInstallationInfoResponseSchema,
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

/** Returns this slot's shared on-disk installation records, or tree-run state. */
export const hostGetInstallationInfoV10 = defineRpcContract({
  method: "host.getInstallationInfo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostGetInstallationInfoRequestSchema,
  responseSchema: hostGetInstallationInfoResponseSchema,
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
