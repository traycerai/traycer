import { createContext } from "react";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";

export interface NotificationConsumptionScope {
  readonly originHostId: string | null;
  readonly entity: HostNotificationsEntityRef;
}

export type NotificationEntityConsumer = (
  scope: NotificationConsumptionScope,
) => void;

/**
 * Explicit view gestures feed the same read-consumption path as passive focus
 * presence. `null` keeps isolated canvas previews/tests provider-optional.
 */
export const NotificationConsumptionContext =
  createContext<NotificationEntityConsumer | null>(null);
