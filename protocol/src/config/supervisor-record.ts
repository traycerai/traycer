import { join } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "../host/lifecycle/process-start-identity";

/**
 * The supervisor record: which CLI supervisor (`traycer host start`) is
 * running this host, and which contracts it enforces.
 *
 * Written by the supervisor when it admits a start and removed when it
 * exits. Read by the desktop and by `traycer host status` / `host doctor` to
 * answer one question: does the RUNNING supervisor honour the lifecycle
 * policy at all? An older supervisor keeps running through a CLI upgrade
 * until the next host restart, and it enforces nothing, so a newer desktop
 * must be able to tell "set, and enforced" from "set, restart the host to
 * apply". Shape and parser live HERE for the same cross-package reason as
 * `./host-stop-intent`.
 *
 * `capabilities` is an OPEN vocabulary: a reader checks for the names it
 * knows with {@link supervisorRecordHasCapability} and ignores the rest, so
 * a newer supervisor advertising more never makes its record unreadable to
 * an older desktop. Malformed reads as absent, which a reader treats exactly
 * like an old supervisor: nothing is known to be enforced.
 *
 * The record is removed on a clean exit only, so a reader checks that the
 * process it names still runs: `pid` for liveness, and `startIdentity` - the
 * supervisor's kernel start stamp - to tell it from an unrelated process the
 * OS handed the same pid (after a reboot, typically). `startIdentity` is
 * optional on the wire: a record written before it existed, or one whose
 * value is not a start identity, parses with `null`, which leaves liveness
 * as the only check.
 *
 * `admittedAs` answers the desktop's second question - may it act on this
 * run at all? (`SUPERVISOR_RUN_ADMITTED_AS`) - and is optional on the wire
 * the same way.
 */

const SUPERVISOR_RECORD_FILENAME = "supervisor.json";

/** The record's path, given the host runtime home that contains it. */
export function supervisorRecordPath(hostHomeDir: string): string {
  return join(hostHomeDir, SUPERVISOR_RECORD_FILENAME);
}

/**
 * The supervisor parks unattended starts, observes the desktop presence
 * record and runs the lifecycle teardown, per the lifecycle policy.
 */
export const SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1 = "lifecycle-policy-v1";

/**
 * How the supervisor's run was started, as a reader outside the CLI needs it.
 * The CLI's own admission (`granted`, `unattended`, `foreground`) stays in its
 * private run state; this is its public half.
 *
 * - `service` - the service manager launched it: at login, as a relaunch, or
 *   because the desktop or a `traycer host` command started the service. The
 *   run the lifecycle mode governs.
 * - `foreground` - a person ran `traycer host start` in a terminal. The mode
 *   does not govern it, and the desktop leaves it alone: it never stops,
 *   restarts or updates over it (the CLI refuses those with
 *   `E_HOST_NOT_SERVICE_RUN`).
 */
export const SUPERVISOR_RUN_ADMITTED_AS = ["service", "foreground"] as const;
export type SupervisorRunAdmittedAs =
  (typeof SUPERVISOR_RUN_ADMITTED_AS)[number];

export interface SupervisorRecord {
  readonly v: 1;
  readonly pid: number;
  readonly cliVersion: string;
  readonly capabilities: readonly string[];
  readonly startedAt: string;
  /** The supervisor's start identity, or `null` when unknown. */
  readonly startIdentity: ProcessStartIdentity | null;
  /**
   * How the run was started, or `null` when the record does not say (one
   * written before the field existed).
   */
  readonly admittedAs: SupervisorRunAdmittedAs | null;
}

export const supervisorRecordSchema = lazySchema(() =>
  z.object({
    v: z.literal(1),
    pid: z.number().int().positive(),
    cliVersion: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
    startedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    // Absent, `null` or not a start identity: `null`, never a malformed
    // record - the field only ever adds a check (see above).
    startIdentity: z
      .string()
      .refine((value) => isProcessStartIdentity(value))
      .nullable()
      .catch(null),
    // Same rule: absent, `null` or an unknown value reads `null`, which
    // says nothing either way.
    admittedAs: z.enum(SUPERVISOR_RUN_ADMITTED_AS).nullable().catch(null),
  }),
);

/** `null` for anything that is not a well-formed `v: 1` record. Never throws. */
export function parseSupervisorRecord(value: unknown): SupervisorRecord | null {
  const parsed = supervisorRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** {@link parseSupervisorRecord} over the file's raw text. Never throws. */
export function parseSupervisorRecordText(
  text: string,
): SupervisorRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return parseSupervisorRecord(value);
}

export function serializeSupervisorRecord(record: SupervisorRecord): string {
  return `${JSON.stringify(
    {
      v: 1,
      pid: record.pid,
      cliVersion: record.cliVersion,
      capabilities: [...record.capabilities],
      startedAt: record.startedAt,
      startIdentity: record.startIdentity,
      admittedAs: record.admittedAs,
    },
    null,
    2,
  )}\n`;
}

/**
 * Whether the running supervisor advertises `capability`. An absent record
 * (`null`) advertises nothing: that is an old supervisor, or none at all.
 */
export function supervisorRecordHasCapability(
  record: SupervisorRecord | null,
  capability: string,
): boolean {
  return record !== null && record.capabilities.includes(capability);
}
