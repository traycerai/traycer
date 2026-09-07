import { useContext, useMemo, type ReactNode } from "react";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import type { ChatIndicatorHostScope } from "@/lib/notifications/chat-indicator-scopes";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  EMPTY_INDICATOR_STATE_RESPONSE,
  mergeHostPendingForkIntoCloudIndicators,
  mergeIndicatorStateResponses,
  selectCloudNotificationIndicators,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

/** Notification indicators for chat ids that do not all belong to one host. */

const NO_EPIC_IDS: ReadonlyArray<string> = [];

export function ChatIndicatorHostScopes(props: {
  readonly scopes: ReadonlyArray<ChatIndicatorHostScope>;
  readonly children: ReactNode;
}): ReactNode {
  const isCloud = useNotificationFeedMode() === "cloud";
  const allChatIds = useMemo(
    () => props.scopes.flatMap((scope) => [...scope.chatIds]),
    [props.scopes],
  );
  const cloudRows = useCloudNotificationsStore((state) => state.rows);
  // Only the host-local bits below have to be asked for per host.
  const base = useMemo(
    () =>
      isCloud
        ? selectCloudNotificationIndicators(cloudRows, NO_EPIC_IDS, allChatIds)
        : EMPTY_INDICATOR_STATE_RESPONSE,
    [isCloud, cloudRows, allChatIds],
  );
  return (
    <NotificationIndicatorsProvider indicators={base}>
      <ChatIndicatorHostLayers scopes={props.scopes} isCloud={isCloud}>
        {props.children}
      </ChatIndicatorHostLayers>
    </NotificationIndicatorsProvider>
  );
}

function ChatIndicatorHostLayers(props: {
  readonly scopes: ReadonlyArray<ChatIndicatorHostScope>;
  readonly isCloud: boolean;
  readonly children: ReactNode;
}): ReactNode {
  if (props.scopes.length === 0) return props.children;
  const [head, ...rest] = props.scopes;
  return (
    <ChatIndicatorHostLayer
      hostId={head.hostId}
      chatIds={head.chatIds}
      isCloud={props.isCloud}
    >
      <ChatIndicatorHostLayers scopes={rest} isCloud={props.isCloud}>
        {props.children}
      </ChatIndicatorHostLayers>
    </ChatIndicatorHostLayer>
  );
}

/** One host's answer, folded into whatever the layers above already established. */
function ChatIndicatorHostLayer(props: {
  readonly hostId: string;
  readonly chatIds: ReadonlyArray<string>;
  readonly isCloud: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const host = useHostNotificationIndicators({
    hostId: props.hostId,
    epicIds: NO_EPIC_IDS,
    chatIds: props.chatIds,
    enabled: props.chatIds.length > 0,
  });
  const inherited = useContext(NotificationIndicatorsContext);
  const merged: SurfaceNotificationIndicators = useMemo(
    () =>
      props.isCloud
        ? mergeHostPendingForkIntoCloudIndicators(
            inherited,
            host.data,
            props.hostId,
          )
        : {
            ...mergeIndicatorStateResponses(inherited, host.data),
            // This layer read exactly one host, so its rows file under that
            // host's origin - same rule the single-host hook applies.
            byOriginHostId: {
              ...inherited.byOriginHostId,
              [props.hostId]: mergeIndicatorStateResponses(
                inherited.byOriginHostId?.[props.hostId] ??
                  EMPTY_INDICATOR_STATE_RESPONSE,
                host.data,
              ),
            },
          },
    [props.isCloud, inherited, host.data, props.hostId],
  );
  return (
    <NotificationIndicatorsProvider indicators={merged}>
      {props.children}
    </NotificationIndicatorsProvider>
  );
}
