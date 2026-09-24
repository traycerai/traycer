import { join } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "../host/lifecycle/process-start-identity";

/**
 * The desktop presence record: which desktop process is running beside this
 * host, and what should happen to the host when that process is gone.
 *
 * Written by desktop main at launch in every lifecycle mode except `none`,
 * and rewritten whenever its verdict changes (a mode change, a quit-prompt
 * answer, an update-install quit). Read by the CLI supervisor's policy
 * observer, which enforces the verdict once the desktop process is
 * positively dead. The host process never reads it. Shape and parser live
 * HERE for the same cross-package reason as `./host-stop-intent`.
 *
 * A new desktop instance always overwrites the record with its own pid and
 * identity, so a stale record left by a crashed instance is replaced, never
 * reasoned about.
 *
 * ### `processStartIdentity`
 *
 * Required, because a bare pid cannot tell "the desktop is still running"
 * from "the pid was recycled onto an unrelated process". It is the same token
 * the CLI lock and `pid.json` carry, compared with
 * `compareProcessStartIdentity`; its `"unknown"` answer is never evidence of
 * death.
 *
 * Malformed reads as absent, like every record in this directory. Unknown
 * keys are ignored; an `onExit` outside the vocabulary is not, because a
 * reader must never act on a verdict it does not know.
 */

const DESKTOP_PRESENCE_FILENAME = "desktop-presence.json";

/** The record's path, given the host runtime home that contains it. */
export function desktopPresencePath(hostHomeDir: string): string {
  return join(hostHomeDir, DESKTOP_PRESENCE_FILENAME);
}

/**
 * The desktop's standing instruction for the moment its process is gone.
 *
 * - `keep` - leave the host running.
 * - `stop` - stop the host (Linked mode, or a quit prompt answered Stop).
 * - `handoff` - a successor desktop will take over (an update-install quit):
 *   do nothing until one writes its own record or the policy changes. This
 *   is what keeps the host alive through an app update of any length, with
 *   no timeout involved.
 */
export const DESKTOP_PRESENCE_ON_EXIT_VERDICTS = [
  "keep",
  "stop",
  "handoff",
] as const;
export type DesktopPresenceOnExit =
  (typeof DESKTOP_PRESENCE_ON_EXIT_VERDICTS)[number];

export interface DesktopPresence {
  readonly v: 1;
  readonly pid: number;
  readonly processStartIdentity: ProcessStartIdentity;
  readonly onExit: DesktopPresenceOnExit;
  /** The lifecycle policy `rev` this verdict was derived from. */
  readonly policyRev: number;
  readonly writtenAt: string;
}

export const desktopPresenceSchema = lazySchema(() =>
  z.object({
    v: z.literal(1),
    pid: z.number().int().positive(),
    processStartIdentity: z
      .string()
      .refine((value) => isProcessStartIdentity(value)),
    onExit: z.enum(DESKTOP_PRESENCE_ON_EXIT_VERDICTS),
    policyRev: z.number().int().nonnegative(),
    writtenAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  }),
);

/** `null` for anything that is not a well-formed `v: 1` record. Never throws. */
export function parseDesktopPresence(value: unknown): DesktopPresence | null {
  const parsed = desktopPresenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** {@link parseDesktopPresence} over the file's raw text. Never throws. */
export function parseDesktopPresenceText(text: string): DesktopPresence | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return parseDesktopPresence(value);
}

export function serializeDesktopPresence(presence: DesktopPresence): string {
  return `${JSON.stringify(
    {
      v: 1,
      pid: presence.pid,
      processStartIdentity: presence.processStartIdentity,
      onExit: presence.onExit,
      policyRev: presence.policyRev,
      writtenAt: presence.writtenAt,
    },
    null,
    2,
  )}\n`;
}
