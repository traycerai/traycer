import { join } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The lifecycle policy record: which lifecycle mode the user chose for the
 * host in this host home.
 *
 * Written by the desktop (Settings, the quit prompt's "remember my choice")
 * and by the CLI (`traycer host lifecycle set`), and read by the CLI
 * supervisor (`traycer host start`), which is the only process that enforces
 * it. The host process itself never reads it. Both writers and the enforcer
 * live on different sides of the desktop/CLI boundary, so the file name, the
 * shape and the parser live HERE, the same reason `./host-stop-intent` does.
 *
 * ### Absent is Background
 *
 * No file, an unreadable file and a malformed file all mean
 * {@link HOST_LIFECYCLE_DEFAULT_MODE}. That is the whole upgrade story: every
 * install that predates this record behaves exactly as it did, and a torn
 * write can never park a host. {@link effectiveHostLifecycleMode} is the one
 * place that rule is written down.
 *
 * ### `rev`
 *
 * Monotonic: every write bumps it. Readers stamp the side effects they take
 * with the `rev` they acted on and re-read the file before acting, so an
 * older queued action never overrides a newer choice. It is a counter, not a
 * clock, so a wall-clock step cannot reorder two writes.
 *
 * Unknown keys are ignored rather than rejected, so a later additive field
 * cannot make an otherwise valid `v: 1` record read as Background. A `mode`
 * or `updatedBy` outside the vocabulary below is NOT an additive change: it
 * reads as absent, because a reader must never act on a mode it does not
 * know.
 */

const HOST_LIFECYCLE_POLICY_FILENAME = "lifecycle-policy.json";

/**
 * The record's path, given the host runtime home that contains it. Taken as
 * a directory for the reason `hostStopIntentPath` gives: the CLI and the
 * desktop resolve the host home through different machinery that always
 * names the same directory, so a per-environment or per-dev-slot home carries
 * its own independent policy.
 */
export function hostLifecyclePolicyPath(hostHomeDir: string): string {
  return join(hostHomeDir, HOST_LIFECYCLE_POLICY_FILENAME);
}

/**
 * - `background` - the host starts at login and keeps running after the app
 *   quits (the behaviour before this record existed).
 * - `linked` - the host starts with the app and stops when the app quits or
 *   dies.
 * - `ask` - the host starts with the app; quitting asks whether to stop it.
 * - `stop-if-idle` - as `ask`, but a quit with nothing running stops the host
 *   without asking.
 * - `none` - this machine runs no local host.
 */
export const HOST_LIFECYCLE_MODES = [
  "background",
  "linked",
  "ask",
  "stop-if-idle",
  "none",
] as const;
export type HostLifecycleMode = (typeof HOST_LIFECYCLE_MODES)[number];

/** The mode an absent, unreadable or malformed policy file means. */
export const HOST_LIFECYCLE_DEFAULT_MODE =
  "background" satisfies HostLifecycleMode;

export const HOST_LIFECYCLE_POLICY_WRITERS = ["desktop", "cli"] as const;
export type HostLifecyclePolicyWriter =
  (typeof HOST_LIFECYCLE_POLICY_WRITERS)[number];

export interface HostLifecyclePolicy {
  readonly v: 1;
  readonly rev: number;
  readonly mode: HostLifecycleMode;
  readonly updatedAt: string;
  readonly updatedBy: HostLifecyclePolicyWriter;
}

export const hostLifecyclePolicySchema = lazySchema(() =>
  z.object({
    v: z.literal(1),
    rev: z.number().int().nonnegative(),
    mode: z.enum(HOST_LIFECYCLE_MODES),
    updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    updatedBy: z.enum(HOST_LIFECYCLE_POLICY_WRITERS),
  }),
);

/** `null` for anything that is not a well-formed `v: 1` record. Never throws. */
export function parseHostLifecyclePolicy(
  value: unknown,
): HostLifecyclePolicy | null {
  const parsed = hostLifecyclePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * {@link parseHostLifecyclePolicy} over the file's raw text, so a torn or
 * non-JSON file reads as absent at every reader instead of each one wrapping
 * its own `JSON.parse`.
 */
export function parseHostLifecyclePolicyText(
  text: string,
): HostLifecyclePolicy | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return parseHostLifecyclePolicy(value);
}

export function serializeHostLifecyclePolicy(
  policy: HostLifecyclePolicy,
): string {
  return `${JSON.stringify(
    {
      v: 1,
      rev: policy.rev,
      mode: policy.mode,
      updatedAt: policy.updatedAt,
      updatedBy: policy.updatedBy,
    },
    null,
    2,
  )}\n`;
}

/** The mode in force: the record's, or Background when there is none. */
export function effectiveHostLifecycleMode(
  policy: HostLifecyclePolicy | null,
): HostLifecycleMode {
  return policy === null ? HOST_LIFECYCLE_DEFAULT_MODE : policy.mode;
}

/**
 * Whether a policy write from `previous` to `next` (both EFFECTIVE modes)
 * must bring the registered service definition up to the current launcher
 * form (`traycer host service refresh`).
 *
 * Only a labelled service start can be parked (`decideUnattendedStart`), and
 * a definition written before labelled starts existed launches the host
 * unlabelled - a start the policy can never park. Background parks nothing,
 * so it needs no refresh; every other mode parks, `none` included. Both
 * writers - `traycer host lifecycle set` and the desktop's
 * `HostLifecycleService` - ask this one question, so the trigger cannot
 * drift between them. Re-setting the mode already in force is not a
 * transition; `traycer host service refresh` is the explicit retry.
 */
export function refreshOnModeChange(
  previous: HostLifecycleMode,
  next: HostLifecycleMode,
): boolean {
  return previous !== next && next !== "background";
}
