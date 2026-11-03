/**
 * How a host process ended, as the supervisor's previous-exit record
 * (`./host-previous-exit`) names it and `host.status` @1.11 reports it.
 *
 * Its own module, with no Node import, for the reason
 * `./installation-records` is split from its readers: the RPC contract the
 * renderer imports needs the vocabulary as a value, and must never resolve
 * the Node half (`node:path`) of the record.
 *
 * - `out-of-memory` - the V8 heap reached its limit and the process aborted:
 *   the diagnostic report's trigger, or the fatal line on stderr, says so.
 * - `crashed` - any other abnormal end: a nonzero exit, a fatal signal, or
 *   any signal no stop was asked for (an unsolicited SIGKILL or SIGTERM).
 * - `stopped` - ended on purpose: a signal or kill while a stop was asked
 *   for, a forced shutdown, a Windows session ending, a requested restart.
 * - `exited` - a clean exit.
 */
export const HOST_PREVIOUS_EXIT_KINDS = [
  "out-of-memory",
  "crashed",
  "stopped",
  "exited",
] as const;
export type HostPreviousExitKind = (typeof HOST_PREVIOUS_EXIT_KINDS)[number];
