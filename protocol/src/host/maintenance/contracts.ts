import {
  defineRpcContract,
  defineUpgradePath,
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
  hostUpdateCheckResponseSchema,
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
