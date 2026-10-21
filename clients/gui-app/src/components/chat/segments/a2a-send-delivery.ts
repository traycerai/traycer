import type { AgentMessageDelivery } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * What a "Sent message" card says about a cross-host send.
 *
 * A send to an agent on another host is queued, not delivered, when the call
 * returns, so the card must not read as an ordinary sent message until the
 * receiving host has taken it. `null` delivery (a same-host send, or a block
 * persisted before the host carried the state) keeps the plain sent card.
 */
export type A2ASendDeliveryView = {
  /** The header's spoken label, in place of "Sent message". */
  readonly srLabel: string;
  /** Short header tag, or null for none. */
  readonly badge: string | null;
  /** One line under the header saying what happened and what it means. */
  readonly note: string;
  readonly tone: "pending" | "delivered" | "undelivered";
};

/** The label for an unknown host: the directory has no row for it yet. */
const UNKNOWN_HOST_LABEL = "the other device";

export function a2aSendDeliveryView(
  delivery: AgentMessageDelivery,
  hostLabel: string | null,
): A2ASendDeliveryView {
  const host =
    hostLabel !== null && hostLabel.length > 0 ? hostLabel : UNKNOWN_HOST_LABEL;
  switch (delivery.state) {
    case "queued":
      return {
        srLabel: "Queued message",
        badge: "queued",
        note: `Queued for ${host}. It is delivered when ${host} picks it up.`,
        tone: "pending",
      };
    case "delivered":
      return {
        srLabel: "Delivered message",
        badge: null,
        note: `Delivered on ${host}.`,
        tone: "delivered",
      };
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
