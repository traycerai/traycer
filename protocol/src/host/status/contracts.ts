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
    /**
     * Open sessions blocking an update drain. `null` means the host did not
     * report a count — NOT that it reported zero. The two are different claims
     * and the drain UI depends on the difference: it names the count in
     * "Apply now — ends N sessions" and then ends that many.
     */
    busySessionCount: z.number().int().nonnegative().nullable(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
  }),
});

// A v1.0 peer never reports busy/update-progress state through this RPC.
//
// `busySessionCount` upgrades to `null`, NOT to `0`. This used to fabricate a
// zero, with a comment observing that no caller distinguished the default from
// a genuinely idle host. That stopped being true: the drain affordance now
// treats an absent count as "no live source" and withholds the destructive
// "Apply now — ends N sessions" force, while a real `0` is an affirmative
// statement that nothing is blocking. Manufacturing the zero here would put
// that affirmative claim in an old host's mouth — the client would believe the
// host had said "no sessions" when it said nothing at all, one negotiation
// layer below where anyone would think to look.
//
// `busy: false` stays a fabricated default: it drives a badge, not a
// destructive action, and there is no affordance whose safety turns on telling
// "not busy" apart from "did not say".
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
    busySessionCount: null,
    updateProgress: null,
  }),
});
