import { join } from "node:path";

/**
 * The stop-intent record: "someone is deliberately stopping this host".
 *
 * Written by the CLI before anything is killed, and read by TWO processes that
 * ask DIFFERENT questions of the same bytes:
 *
 *  - the **supervisor** (`traycer host start`) asks "should I relaunch the
 *    child that just died?" - the record's original and primary purpose. Its
 *    writer, its identity/staleness policy and the whole never-delete rule live
 *    in the CLI's `host/stop-intent.ts`, which owns this file's lifecycle.
 *  - the **host** asks, at SIGTERM, "is the outage I am about to become a
 *    deliberate RESTART?" - so it can publish its restart tombstone (D5/M1)
 *    on a path that has no RPC leg to carry `lifecycle.claimShutdown`'s
 *    intent. A CLI restart of a CLI-owned host is a bare
 *    `launchctl kill TERM` / `systemctl --user stop`; without this record the
 *    host cannot tell that death from a deliberate bounce, and every other
 *    client fails over during a restart that is 15-30s from finishing.
 *
 * The shape lives HERE, in `@traycer/protocol/config`, for the same reason
 * `cliCredentialsPath` does (see `./paths`): both repos must resolve the exact
 * same file and agree on the exact same bytes, and the host cannot import the
 * CLI package. The CLI re-exports these from its `host/stop-intent` for its
 * existing callers.
 *
 * ### THE HOST IS A READER, NEVER A WRITER
 *
 * Nothing on the host side may write, clear, or truncate this file. The
 * supervisor's answer to "have I already served this record" is an IDENTITY it
 * remembers, deliberately NOT a delete - erasing the record is what re-arms a
 * retired supervisor (the full argument is on `hasActionableStopIntent` in the
 * CLI). A second writer would reintroduce exactly that race from a process
 * that cannot even see the supervisor.
 */

const HOST_STOP_INTENT_FILENAME = "stop-intent.json";

/**
 * The record's path, given the host runtime home that contains it.
 *
 * Parameterized by the directory rather than by an `Environment` because the
 * two readers resolve that directory through different (and deliberately
 * different) machinery: the CLI's `hostHomeDir(environment)` applies dev-run
 * slot nesting, while the host resolves its OWN home through the path-only
 * `--host-data-dir` override the supervisor spawned it with. Those two
 * always name the same directory for the same host - the supervisor passes
 * `hostHomeDir(environment)` as that very flag - so taking the directory as
 * input is what makes the agreement structural instead of a slot rule
 * duplicated in two places that can drift.
 */
export function hostStopIntentPath(hostHomeDir: string): string {
  return join(hostHomeDir, HOST_STOP_INTENT_FILENAME);
}

/**
 * Why the host stops, as stated by whoever is stopping it.
 *
 * Only `"restart"` promises a comeback. `"install-swap"` deliberately does not:
 * its relaunch is unbounded (the swap can take as long as it takes), so a host
 * claiming `restarting-expected` for it would promise a return the flow does
 * not keep - the same call `host.update.install` already makes on the RPC leg.
 */
export type StopIntentReason =
  | "stop"
  | "restart"
  | "install-swap"
  | "uninstall";

export interface StopIntent {
  readonly v: 1;
  readonly requestedAt: string;
  readonly requestedByPid: number;
  readonly reason: StopIntentReason;
}

const STOP_INTENT_REASONS: ReadonlySet<string> = new Set<StopIntentReason>([
  "stop",
  "restart",
  "install-swap",
  "uninstall",
]);

/**
 * `null` for anything that is not a well-formed record.
 *
 * Hand-rolled rather than zod, unlike its `./installation-records` siblings,
 * and that is deliberate: this parser is the supervisor's, its
 * torn-file-reads-as-absent bias is load-bearing (leaving a machine hostless
 * on a garbled byte is the worse failure), and the shape moved here byte
 * faithful so no reader's behaviour changes with the move. A zod port would
 * quietly re-decide edge cases the supervisor already depends on - `z.number()`
 * rejects a NaN pid that `typeof` accepts, for one.
 */
export function parseStopIntent(value: unknown): StopIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.requestedAt !== "string") return null;
  if (typeof record.requestedByPid !== "number") return null;
  if (typeof record.reason !== "string") return null;
  if (!STOP_INTENT_REASONS.has(record.reason)) return null;
  return {
    v: 1,
    requestedAt: record.requestedAt,
    requestedByPid: record.requestedByPid,
    reason: record.reason as StopIntentReason,
  };
}

/**
 * Whether `intent` was recorded within `windowMs` of `nowMs` - a SYMMETRIC
 * window, `windowMs` either side.
 *
 * The window is a PARAMETER because the two readers are answering different
 * questions and honestly need different bounds. The supervisor's has to
 * outlive stop -> kill -> settle (minutes). The host's only has to cover the
 * gap between the CLI writing this record and the SIGTERM landing, which is
 * milliseconds - so it uses a much tighter one, and a stale record simply
 * stops meaning "restart" sooner.
 *
 * The forward half is not symmetry for its own sake. A future-dated stamp is
 * still evidence someone asked for a stop (a small skew between writer and
 * reader should not discard a real request), but an UNBOUNDED forward window
 * is a wedge with no expiry at all: a backward wall-clock jump - a VM
 * resuming, NTP correcting a bad clock - leaves the record dated hours ahead
 * and nothing else would ever retire it. Bounding the forward half caps that
 * at the same window the backward half already accepts.
 */
export function isStopIntentWithin(
  intent: StopIntent,
  nowMs: number,
  windowMs: number,
): boolean {
  const requestedAtMs = Date.parse(intent.requestedAt);
  if (Number.isNaN(requestedAtMs)) return false;
  return Math.abs(nowMs - requestedAtMs) < windowMs;
}
