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
  hostUpdateInstallResponseV10Schema,
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
  responseSchema: hostUpdateInstallResponseV10Schema,
});

/** Minor 1 adds `already-updating`, which a 1.0 host never returns. */
export const hostUpdateInstallV11 = defineRpcContract({
  method: "host.update.install",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: hostUpdateInstallRequestSchema,
  responseSchema: hostUpdateInstallResponseSchema,
});

/**
 * Purely additive, in both directions that matter: the request is unchanged,
 * and every v1.0 outcome is still a v1.1 outcome. So neither half rewrites
 * anything — unlike `host.status`, this minor invents no field a v1.0 peer
 * would have to have defaulted.
 */
export const hostUpdateInstallUpgradeV10ToV11 = defineUpgradePath<
  typeof hostUpdateInstallV10,
  typeof hostUpdateInstallV11
>({
  from: hostUpdateInstallV10.schemaVersion,
  to: hostUpdateInstallV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
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
