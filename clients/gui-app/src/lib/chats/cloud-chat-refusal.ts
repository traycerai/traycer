import type { CloudChatReadOutcome } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";

/**
 * The states in which a cloud chat does NOT render, as something a surface can
 * show.
 *
 * Each arm of the read's outcome has a different remedy, and collapsing them
 * into one "could not open this chat" would throw away the only part a user can
 * act on. The four remedies really are different: publish from the other
 * device, update this app, open the row you meant, contact support.
 *
 * Copy lives here rather than in the component so it is assertable without
 * rendering - and so the GUI and any future surface cannot describe the same
 * refusal differently.
 */

export type CloudChatRefusal = {
  readonly title: string;
  readonly body: string;
  /**
   * Whether re-running the read could plausibly change the answer.
   *
   * `false` for every arm here, and stated explicitly rather than left implied:
   * these are not transport failures. A corrupt publication re-resolves to the
   * same head, an unpublished chat stays unpublished until its owner publishes,
   * and a version refusal is decided by which build is installed. Offering a
   * retry would promise something the button cannot deliver.
   */
  readonly isRetryable: boolean;
};

export function describeCloudChatRefusal(
  outcome: CloudChatReadOutcome,
): CloudChatRefusal | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "unpublished":
      return {
        title: "Not published yet",
        body: "This chat has not been published to the cloud. It will appear here once the device that owns it syncs.",
        isRetryable: false,
      };
    case "needs-newer-app":
      return {
        title: "Needs a newer version of Traycer",
        // The protocol's own phrasing, which names the versions involved. It is
        // written to be renderer-safe and carries no object coordinates.
        body: outcome.message,
        isRetryable: false,
      };
    case "ambiguous-identity":
      return {
        title: "This chat could not be identified",
        // Deliberately does NOT name the resolved owner. Chat ids are
        // host-minted and can collide, so the row that came back belongs to
        // someone else - and telling this reader whose is a disclosure the
        // refusal exists to prevent.
        body: "Another chat in this task shares this one's id, so it could not be opened safely. Try opening it from the list again.",
        isRetryable: false,
      };
    case "corrupt":
      return {
        title: "This chat could not be opened",
        // The protocol's fixed per-reason phrase. The diagnostic - digests,
        // parser complaints - is host-internal and is logged, never rendered.
        body: outcome.message,
        isRetryable: false,
      };
  }
}
