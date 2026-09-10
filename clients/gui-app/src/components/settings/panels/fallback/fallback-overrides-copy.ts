// `REASON_ELIGIBLE_RUNGS` is named in the doc below but deliberately NOT
// imported: this module is copy, it reads no eligibility, and an import whose
// only use is a `{@link}` is a lint risk for nothing - typescript-eslint's
// unused-vars rule does not read JSDoc even though `noUnusedLocals` does.
import {
  EXCLUDED_FALLBACK_REASONS,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import {
  HOST_NOTIFICATION_STOPPED_REASONS,
  type HostNotificationStoppedReason,
} from "@traycer/protocol/host/notifications/payloads";

/**
 * The failures the overrides matrix gives a row of its own, in the order the
 * plan's table states them.
 *
 * Derived from the shared taxonomy minus the excluded set rather than
 * hand-listed, so a new stopped reason appears here the day it is added instead
 * of silently missing a row - the Done-when is "covers every `StoppedReason`
 * row exactly", and a hand-written list is how that stops being true.
 */
export const MATRIX_REASONS: readonly HostNotificationStoppedReason[] =
  HOST_NOTIFICATION_STOPPED_REASONS.filter(
    (reason) => !EXCLUDED_FALLBACK_REASONS.has(reason),
  );

/** The five the matrix collapses into one read-only row. */
export const EXCLUDED_MATRIX_REASONS: readonly HostNotificationStoppedReason[] =
  HOST_NOTIFICATION_STOPPED_REASONS.filter((reason) =>
    EXCLUDED_FALLBACK_REASONS.has(reason),
  );

/**
 * Why a step cannot help a failure, per cell.
 *
 * Every ineligible cell carries its own reason, and that is the point rather
 * than a nicety: a dashed chip with no explanation reads as a bug or as
 * something the user has broken, when it is a fact about the failure. "Another
 * profile won't help a provider outage" and "there is nothing to wait for" are
 * different facts with different consequences, and collapsing them into one
 * greyed chip would teach people the matrix is decoration.
 *
 * Total over both axes so a new reason or a new rung cannot ship without a
 * decision here - a `Partial` record would let the first missing cell reach the
 * screen as a chip with no why.
 *
 * The correspondence a test can check is over the cells the matrix READS, which
 * is `MATRIX_REASONS` x `FALLBACK_MATRIX_RUNGS`: within that window, `null`
 * appears exactly where `REASON_ELIGIBLE_RUNGS` lists the rung, and a
 * sentence exactly where it does not. Stating it over the whole record would be
 * false twice, in both cases because the cell is unreachable rather than
 * because the copy is wrong:
 *
 *   - the `notify` column has no chip (it is eligible everywhere and the ladder
 *     filter admits it unconditionally), so it appears in no eligible row and
 *     its cells are null throughout;
 *   - the five excluded reasons draw no row at all, so their cells are null
 *     throughout while their eligible sets are empty.
 *
 * Both are null-where-not-eligible, which is the shape the invariant forbids -
 * so the test scopes to the window rather than the copy inventing sentences no
 * one will ever read.
 */
export const RUNG_INELIGIBILITY_COPY: Readonly<
  Record<
    HostNotificationStoppedReason,
    Readonly<Record<FallbackRungKind, string | null>>
  >
> = {
  rate_limit: { profile: null, tier: null, wait: null, notify: null },
  provider_unavailable: {
    profile: "same servers",
    tier: null,
    wait: "no reset time",
    notify: null,
  },
  billing: {
    profile: null,
    tier: null,
    wait: "nothing to wait for",
    notify: null,
  },
  model_unavailable: {
    profile: "same model",
    tier: null,
    wait: "nothing to wait for",
    notify: null,
  },
  auth: {
    profile: null,
    tier: null,
    wait: "sign in instead",
    notify: null,
  },
  provider_connection_failed: {
    profile: "same network",
    tier: "same network",
    wait: "no reset time",
    notify: null,
  },
  // The five excluded reasons never render chips, so their cells are never
  // read. They are here only because the record is total; see the window the
  // correspondence is stated over, above.
  context_exhausted: { profile: null, tier: null, wait: null, notify: null },
  request_rejected: { profile: null, tier: null, wait: null, notify: null },
  turn_start_timeout: { profile: null, tier: null, wait: null, notify: null },
  missing_terminal_event: {
    profile: null,
    tier: null,
    wait: null,
    notify: null,
  },
  background_work_failed: {
    profile: null,
    tier: null,
    wait: null,
    notify: null,
  },
};

/**
 * What the engine does for this failure REGARDLESS of the steps - the part of
 * the row a user cannot configure and would otherwise be surprised by.
 *
 * Kept separate from the chips because none of it is a preference: the
 * transient retry is not a rung and carries no knobs, billing always notifies
 * even on a successful switch because something needs fixing, and `auth` arms
 * only once a sign-out is settled rather than on one error event.
 */
export const REASON_ROW_NOTES: Readonly<
  Record<HostNotificationStoppedReason, string | null>
> = {
  rate_limit: null,
  provider_unavailable: "retried briefly first",
  billing: "always notifies",
  model_unavailable: null,
  auth: "only once sign-out is confirmed",
  provider_connection_failed: "brief retry, then notify",
  context_exhausted: null,
  request_rejected: null,
  turn_start_timeout: null,
  missing_terminal_event: null,
  background_work_failed: null,
};

/** D142/D146: the matrix authors rung choices, not every wire policy value. */
export const FALLBACK_OVERRIDES_DISCLOSURE =
  "Turning every chip off preserves that failure’s pre-retry/hold behavior and terminal Notify; this editor does not author the wire’s per-reason off value, and Notify stays last.";
