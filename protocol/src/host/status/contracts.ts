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
 * Typed breakdown of {@link hostStatusV12}'s `busySessionCount` total, reused
 * by `host.restart` @1.2 and the unnegotiated `hostRuntimeStatus` awareness
 * field. Counts are non-negative; a missing breakdown is `null` (unknown),
 * never a fabricated zero object.
 */
export const hostBusyBreakdownSchema = z.object({
  workingAgents: z.number().int().nonnegative(),
  activeTerminalAgents: z.number().int().nonnegative(),
  busyTerminals: z.number().int().nonnegative(),
});
export type HostBusyBreakdown = z.infer<typeof hostBusyBreakdownSchema>;

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

/**
 * v1.2 adds a typed `busyBreakdown` beside the existing total.
 *
 * `busySessionCount` is now the breakdown total (`workingAgents` +
 * `activeTerminalAgents` + `busyTerminals`) when the host reports both; old
 * clients keep rendering the single number. `busyBreakdown: null` means the
 * host did not say how the total splits — NOT that every component is zero.
 * The v1.1→v1.2 upgrade therefore writes `null`, following the v1.0→v1.1
 * `busySessionCount: null` precedent: manufacturing `{ workingAgents: 0, ... }`
 * would put an affirmative idle-by-kind claim in an old host's mouth.
 */
export const hostStatusV12 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 2 } as const,
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
     * Total busy items blocking an update drain (the sum of
     * `busyBreakdown` when that is present). `null` means the host did not
     * report a count — NOT that it reported zero.
     */
    busySessionCount: z.number().int().nonnegative().nullable(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
    busyBreakdown: hostBusyBreakdownSchema.nullable(),
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

// A v1.1 peer reports a total and never a typed split. `busyBreakdown`
// upgrades to `null`, NOT to a zero object: a real `{ workingAgents: 0,
// activeTerminalAgents: 0, busyTerminals: 0 }` is an affirmative "idle by
// every kind", while `null` is "did not say". The drain UI that starts to
// name kinds depends on that difference the same way the count UI depends
// on `busySessionCount: null` vs `0`.
export const hostStatusUpgradeV11ToV12 = defineUpgradePath<
  typeof hostStatusV11,
  typeof hostStatusV12
>({
  from: hostStatusV11.schemaVersion,
  to: hostStatusV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    busyBreakdown: null,
  }),
});
