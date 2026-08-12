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

/**
 * Notification indicators for chat ids that do NOT all belong to one host.
 *
 * `useNotificationIndicators` is one hook call and therefore one host, which is
 * correct for a surface whose ids are all owned by the same machine. A canvas
 * tab strip is not that surface: tabs bind a `hostId` for life, a strip can hold
 * a retained tab from host B beside a live one on host A, and
 * `host.notifications.indicatorState` is computed over ONE host's SQLite rows.
 * Asking the connected host about every tab's chat id gets both errors at once -
 * host B's `pendingFork` never lights, and a host-minted id that A happens to
 * share lights the wrong tab from an unrelated chat.
 *
 * The fan-out is a nest of providers rather than a loop, because one host is one
 * hook call and the number of hosts is data. Each layer asks its own host about
 * its own ids and folds the answer into what it inherited, so a consumer below
 * still reads one merged, chatId-keyed map through the context it already used.
 *
 * The residual, stated rather than hidden: the merged map is keyed by `chatId`
 * alone, so two DIFFERENT chats on two hosts that share an id still collapse
 * into one entry (their flags OR together). Fixing that means keying the context
 * and every consumer on `(hostId, chatId)`. What this does fix is the far more
 * common pair - the cross-host tab that could never light, and the connected
 * host answering about a chat it has never owned.
 */

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
  // The cloud snapshot is the base every host layer folds into, and it is
  // host-INDEPENDENT: a cloud row produced on any machine is already in this
  // client's snapshot, which is the whole reason cloud mode exists. Only the
  // host-local bits below have to be asked for per host.
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

/**
 * One host's answer, folded into whatever the layers above already established.
 *
 * The two feed modes fold differently for the reason
 * `mergeHostPendingForkIntoCloudIndicators` documents: in cloud mode the feed
 * rows own read state and the approval/interview flags across every host, and
 * only `pendingFork` is host-local truth. In local mode the host response IS the
 * answer, so it merges whole.
 */
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
