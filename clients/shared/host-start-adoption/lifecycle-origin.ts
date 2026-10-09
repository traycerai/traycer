/**
 * Who asked for a host start, carried in the host-start adoption proof and
 * recorded in the supervisor's run state.
 *
 * - `desktop` - Traycer Desktop's `HostController`, which passes the hidden
 *   `--lifecycle-origin desktop` on every CLI call it makes.
 * - `terminal` - anything else that ran the CLI directly: a person, a script,
 *   an agent. The default, so an invocation that predates the flag keeps its
 *   argv shape valid and is described truthfully.
 * - `maintenance` - the relaunch legs of `host update` and `host restart`
 *   (and the detached CLI-upgrade finalizer that completes a restart). They
 *   bring back a run that already existed rather than start a new one, whoever
 *   invoked the command.
 *
 * The origin never decides whether a start runs: every grant runs, whatever
 * its origin (lifecycle mechanics, "Start admission"). It is what `host
 * status` and `host doctor` print, so "why is this host running" has an
 * answer.
 */
export const HOST_START_ORIGINS = [
  "desktop",
  "terminal",
  "maintenance",
] as const;
export type HostStartOrigin = (typeof HOST_START_ORIGINS)[number];

/** The origin of an invocation that did not pass `--lifecycle-origin`. */
export const DEFAULT_HOST_START_ORIGIN = "terminal" satisfies HostStartOrigin;

/** `null` for anything outside the vocabulary. Never throws. */
export function parseHostStartOrigin(value: unknown): HostStartOrigin | null {
  return HOST_START_ORIGINS.find((origin) => origin === value) ?? null;
}

/**
 * The `--lifecycle-origin` option as Commander delivered it. Absent means
 * {@link DEFAULT_HOST_START_ORIGIN}. A value outside the vocabulary never
 * reaches here: the option is declared with `.choices(HOST_START_ORIGINS)`,
 * so Commander refuses it at parse time through the runner's error envelope
 * rather than letting a misspelling be recorded as a terminal start.
 */
export function hostStartOriginFromOption(value: unknown): HostStartOrigin {
  return parseHostStartOrigin(value) ?? DEFAULT_HOST_START_ORIGIN;
}
