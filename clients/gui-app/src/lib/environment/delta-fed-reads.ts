/** The reads a change to a secret moves: the list, its versions, its rotation. */
export const SECRET_READS = [
  "environment.secrets.list",
  "environment.secrets.versions",
  "environment.secrets.rotation",
] as const;

/**
 * The host reads a change made elsewhere (the dashboard, another host) can
 * move, re-read when the host reports a new revision of the person's
 * settings. A read joins only once it is shown stale without it:
 * `config.env.list` answers the shared value of a variable this host keeps
 * its own value for, which a new revision moves while this host's own env
 * stays as it is.
 */
export const DELTA_FED_READS = [
  ...SECRET_READS,
  "providers.list",
  "config.env.list",
] as const;
