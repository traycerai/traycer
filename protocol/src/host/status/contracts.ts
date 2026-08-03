import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";

export const hostStatusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
  }),
});

/**
 * Mirror of `traycer-host`'s host-local `HostUpdateProgress` (itself a
 * mirror of `@traycerai/common/types/host` in the internal monorepo - this
 * open-source package cannot depend on it). Set only while a `traycer host
 * update` is actually in flight on this box (Architecture §13, T16);
 * `null` the rest of the time.
 */
export const hostUpdateProgressStateSchema = z.enum(["updating", "failed"]);
export type HostUpdateProgressState = z.infer<
  typeof hostUpdateProgressStateSchema
>;

export const hostStatusUpdateProgressSchema = z.object({
  state: hostUpdateProgressStateSchema,
  error: z.string().nullable(),
});
export type HostStatusUpdateProgress = z.infer<
  typeof hostStatusUpdateProgressSchema
>;

/**
 * v1.1 folds in the T16 busy/drain signal (`host.drainStatus`, since removed
 * - see the RPC backward-compat decision log) as additive `host.status`
 * fields instead of a standalone method name, so the wire method-set stays
 * identical to `host-v1.0.0`. Backs the "My Hosts" busy badge and the
 * client-side update drain-gate copy.
 */
export const hostStatusV11 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
    busy: z.boolean(),
    busySessionCount: z.number().int().nonnegative(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
  }),
});

// A v1.0 peer never reports busy/update-progress state through this RPC -
// default to "not busy, nothing in flight" rather than leaving the newer
// side to special-case a missing field. Safe because a v1.0 host predates
// remote support entirely (Architecture §13); no caller distinguishes this
// default from a genuinely idle host today.
export const hostStatusUpgradeV10ToV11 = defineUpgradePath<
  typeof hostStatusV10,
  typeof hostStatusV11
>({
  from: hostStatusV10.schemaVersion,
  to: hostStatusV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
  }),
});
