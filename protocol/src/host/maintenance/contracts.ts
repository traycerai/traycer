import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  hostDoctorRequestSchema,
  hostDoctorResponseSchema,
  hostGetInstallationInfoRequestSchema,
  hostGetInstallationInfoResponseSchema,
  hostUpdateCheckRequestSchema,
  hostUpdateCheckResponseSchema,
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
