import { join } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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

export interface SupervisorRecord {
  readonly v: 1;
  readonly pid: number;
  readonly cliVersion: string;
  readonly capabilities: readonly string[];
  readonly startedAt: string;
}

export const supervisorRecordSchema = lazySchema(() =>
  z.object({
    v: z.literal(1),
    pid: z.number().int().positive(),
    cliVersion: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
    startedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
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
