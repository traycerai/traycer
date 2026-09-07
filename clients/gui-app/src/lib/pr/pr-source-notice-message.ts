import type { PrSourceNotice } from "@traycer/protocol/host/pr-schemas";

/** What a paused PR source means, in the user's terms. */
/** What has stopped refreshing, as the sentence names it. */
export type PrSourceNoticeSubject = "pull-requests" | "issues";

const NOTICE_SUBJECT_LABEL: Readonly<Record<PrSourceNoticeSubject, string>> = {
  "pull-requests": "Pull requests",
  issues: "Issues",
};

export function prSourceNoticeMessageFor(
  notice: PrSourceNotice,
  countdown: string | null,
  subject: PrSourceNoticeSubject,
): string {
  const what = NOTICE_SUBJECT_LABEL[subject];
  // Switch rather than an `if` with a trailing default: a new notice kind on the wire must be a COMPILE error here, not silently inherit whichever sentence happened to be last.
  // The two kinds mean different things to a user - one is GitHub refusing, the other is Traycer failing to reach it - so quietly reusing either one's copy for a third would be a lie.
  switch (notice.kind) {
    case "rate-limited":
      return countdown === null
        ? `GitHub's rate limit was reached. ${what} are not refreshing; this resumes automatically once GitHub allows it.`
        : `GitHub's rate limit was reached. ${what} are not refreshing; this resumes in about ${countdown}.`;
    case "backing-off":
      return countdown === null
        ? `Could not reach GitHub. ${what} are not refreshing; Traycer keeps retrying in the background.`
        : `Could not reach GitHub. ${what} are not refreshing; retrying in about ${countdown}.`;
    default: {
      const unhandled: never = notice.kind;
      throw new Error(`Unhandled PR source notice kind: ${String(unhandled)}`);
    }
  }
}
