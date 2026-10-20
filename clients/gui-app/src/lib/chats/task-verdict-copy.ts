/**
 * The words for a chat close that is the cloud's verdict on the task itself,
 * shared by every surface that reports the close: the chat tile's body and
 * the notification. The host's reason for these codes is written for logs,
 * so neither surface shows it.
 */
export interface TaskVerdictCopy {
  readonly headline: string;
  /** The headline as a title, without its full stop. */
  readonly title: string;
  /**
   * A deleted task offers no Try again, since no attempt can open it; missing
   * access keeps it, because the task can be shared.
   */
  readonly offersTryAgain: boolean;
}

/** The verdict copy for a fatal close code, or `null` for any other code. */
export function taskVerdictCopy(code: string): TaskVerdictCopy | null {
  switch (code) {
    case "EPIC_NOT_FOUND":
      return {
        headline: "This task was deleted.",
        title: "This task was deleted",
        offersTryAgain: false,
      };
    case "EPIC_ACCESS_DENIED":
      return {
        headline: "You don't have access to this task.",
        title: "You don't have access to this task",
        offersTryAgain: true,
      };
  }
  return null;
}
