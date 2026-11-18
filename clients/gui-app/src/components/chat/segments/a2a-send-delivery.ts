import type { AgentMessageDelivery } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * What a "Sent message" card says about a cross-host send.
 *
 * The sending host learns only of failures (traycer#2421), so a send nothing
 * has failed is the plain sent card: `null` here. The one exception is a send
 * to a host the directory saw offline at send time, which says so; the
 * observation is a hint, so the copy promises no pickup: it names the
 * delivery window the message expires after. A `delivered` stamp, written only by hosts that predate traycer#2421,
 * reads as the plain sent card too.
 */
export type A2ASendDeliveryView = {
  /** The header's spoken label, in place of "Sent message". */
  readonly srLabel: string;
  /** Short header tag, or null for none. */
  readonly badge: string | null;
  /** One line under the header saying what happened and what it means. */
  readonly note: string;
  readonly tone: "sent" | "undelivered";
};

/** The label for an unknown host: the directory has no row for it yet. */
const UNKNOWN_HOST_LABEL = "the other device";

export function a2aSendDeliveryView(
  delivery: AgentMessageDelivery,
  hostLabel: string | null,
): A2ASendDeliveryView | null {
  const host =
    hostLabel !== null && hostLabel.length > 0 ? hostLabel : UNKNOWN_HOST_LABEL;
  switch (delivery.state) {
    case "queued":
      if (!delivery.targetHostOffline) return null;
      return {
        srLabel: "Sent message",
        badge: null,
        note: `Sent. ${host} looked offline; if it is not back online within 24 hours, this expires.`,
        tone: "sent",
      };
    case "delivered":
      return null;
    case "expired":
      return {
        srLabel: "Undelivered message",
        badge: "not delivered",
        note: `Not delivered: ${host} did not pick it up in time, so it was dropped. Send it again if it still matters.`,
        tone: "undelivered",
      };
    case "failed":
      return {
        srLabel: "Undelivered message",
        badge: "not delivered",
        note: `Not delivered: ${host} could not accept it. Send it again if it still matters.`,
        tone: "undelivered",
      };
  }
}
