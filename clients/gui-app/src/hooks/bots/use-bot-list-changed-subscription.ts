import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { botListChangedServerFrameSchema } from "@traycer/protocol/host/bot/schemas";
import {
  useStreamMethodSupportFor,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { invalidateBotLists } from "@/hooks/bots/use-bot-mutations";

/** On the APP-WIDE stream client: Home's reading, like its `bot.list`. */
export function useBotListChangedSubscriptionForApp(enabled: boolean): void {
  useBotListChangedSubscription(useWsStreamClient(), enabled);
}

/**
 * Through an explicit host's own stream client: the bot tab's reading, bound
 * to its host for life (dialed as `useBotSubscriptionForHost` dials it).
 */
export function useBotListChangedSubscriptionForHost(
  hostId: string,
  enabled: boolean,
): void {
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  useBotListChangedSubscription(useHostStreamClientFor(target, auth), enabled);
}

/**
 * Keeps `bot.list` current while a bots surface is mounted (Tracy Bots T24):
 * subscribes to `bot.listChanged` on `client` and invalidates every host's
 * `bot.list` on each `changed` frame, the way the app's own bot writes do.
 * The frame carries nothing; the list is refetched.
 *
 * The host holds the subscriber's environment rooms for as long as this
 * stream is open, so it is open only while the caller is mounted and
 * `enabled`, and only on a host that advertises the method; anywhere else
 * nothing is subscribed and the list refreshes on focus as before.
 *
 * A reconnect may have missed a change, so the list is refetched once when
 * the stream comes back.
 */
export function useBotListChangedSubscription(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  const support = useStreamMethodSupportFor(client, "bot.listChanged");
  const active = enabled && support === "supported";

  useEffect(() => {
    if (!active || client === null) return;
    const session = client.subscribe("bot.listChanged", {});
    let closed = false;
    let openedOnce = false;
    session.onServerFrame((envelope) => {
      if (closed) return;
      const parsed = botListChangedServerFrameSchema.safeParse(envelope);
      if (!parsed.success || parsed.data.kind !== "changed") return;
      invalidateBotLists(queryClient);
    });
    session.onStatusChange((status) => {
      if (closed || status !== "open") return;
      if (openedOnce) invalidateBotLists(queryClient);
      openedOnce = true;
    });
    return () => {
      closed = true;
      session.close();
    };
  }, [active, client, queryClient]);
}
