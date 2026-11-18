/**
 * How long a renderer↔host link may stay down before a surface escalates its
 * copy - the Epic pill's "Reconnecting…" -> "Still reconnecting…", and the
 * phone's stream-syncing strip's "Syncing…" -> "Still syncing…".
 *
 * Needed because a stream failure the host cannot classify now closes
 * RETRYABLE and the client reconnects forever - deliberately, so a blip can
 * never strand a surface. The cost is that the unescalated word no longer
 * implies "back in a moment": a workspace that was actually deleted, or a host
 * that is off, produces the same word indefinitely. A minute is long enough
 * that no ordinary drop, wake, or host restart reaches it, and short enough
 * that a user who is waiting learns the retry is not converging.
 *
 * ONE number, in `lib/` rather than beside either consumer, because it is a
 * fact about how long this app waits before admitting an outage - not about
 * the pill or the strip. Two thresholds would let the pill and the strip
 * disagree about the same outage on the same device, and a user who learns the
 * app's patience should learn it once.
 *
 * Escalation changes only the WORDS - same severity either way. The link
 * genuinely is retrying and there is nothing for the user to do; presenting
 * that as an error would be a false alarm.
 */
export const LINK_DOWN_ESCALATION_MS = 60_000;
