import type { PrSourceNotice } from "@traycer/protocol/host/pr-schemas";

/**
 * What a paused PR source means, in the user's terms.
 *
 * The host deliberately sends structure (`kind` + `retryAt`) and no prose, so
 * every word a user reads about a pause is written HERE, once, and the panel
 * header and the detail tile header cannot drift into saying different things.
 *
 * Two things it deliberately does not say. It never claims what is on screen -
 * a PR paused before its first successful fetch has no "last data fetched" to
 * show, and the freshness stamp beside the icon already answers that question
 * honestly in both states. And `retryAt: null` gets its own sentence rather
 * than a hidden default: it marks the case where the host is holding back
 * precisely BECAUSE it does not know when GitHub's window resets, and
 * inventing a time there would be a guess presented as a fact.
 */
export function prSourceNoticeMessage(
  notice: PrSourceNotice,
  countdown: string | null,
): string {
  // Switch rather than an `if` with a trailing default: a new notice kind on
  // the wire must be a COMPILE error here, not silently inherit whichever
  // sentence happened to be last. The two kinds mean different things to a
  // user - one is GitHub refusing, the other is Traycer failing to reach it -
  // so quietly reusing either one's copy for a third would be a lie.
  switch (notice.kind) {
    case "rate-limited":
      return countdown === null
        ? "GitHub's rate limit was reached. Pull requests are not refreshing; this resumes automatically once GitHub allows it."
        : `GitHub's rate limit was reached. Pull requests are not refreshing; this resumes in about ${countdown}.`;
    case "backing-off":
      return countdown === null
        ? "Could not reach GitHub. Pull requests are not refreshing; Traycer keeps retrying in the background."
        : `Could not reach GitHub. Pull requests are not refreshing; retrying in about ${countdown}.`;
    default: {
      const unhandled: never = notice.kind;
      throw new Error(`Unhandled PR source notice kind: ${String(unhandled)}`);
    }
  }
}
