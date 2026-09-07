import type { CloudChatReadOutcome } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";

/** The states in which a cloud chat does NOT render, as something a surface can show. */

export type CloudChatRefusal = {
  readonly title: string;
  readonly body: string;
  /** Whether re-running the read could plausibly change the answer. */
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
        // Deliberately does NOT name the resolved owner.
        // Chat ids are host-minted and can collide, so the row that came back belongs to someone else - and telling this reader whose is a disclosure the refusal exists to prevent.
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
