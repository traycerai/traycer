import type { ReactNode } from "react";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { ChatIndicatorHostScopes } from "@/components/notifications/chat-indicator-host-scopes";
import type { HeaderTabIndicators } from "./header-tab-presentation";

/**
 * The notification and chat-indicator scopes every tab of a strip reads its
 * leading glyph from, fed by the controller's `indicators`.
 */
export function TabStripIndicatorScope(props: {
  readonly indicators: HeaderTabIndicators;
  readonly children: ReactNode;
}): ReactNode {
  const { indicators } = props;
  return (
    <NotificationIndicatorsProvider indicators={indicators.indicators}>
      <ChatIndicatorHostScopes
        scopes={indicators.chatScopes}
        chatEpicIds={indicators.chatEpicIds}
      >
        {props.children}
      </ChatIndicatorHostScopes>
    </NotificationIndicatorsProvider>
  );
}
