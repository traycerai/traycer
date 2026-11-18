import { createContext } from "react";

export const ChatIndicatorFreshHostsContext = createContext<
  Readonly<Record<string, boolean>>
>({});

import {
  EMPTY_INDICATOR_STATE_RESPONSE,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

export const ChatIndicatorAttestedContext =
  createContext<SurfaceNotificationIndicators>(EMPTY_INDICATOR_STATE_RESPONSE);
