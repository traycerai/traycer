import { use, useMemo } from "react";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useNotificationResolveHostId } from "@/hooks/notifications/use-notification-host";
import type { ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import { useImageBlobUrl } from "@/lib/attachments/use-image-blob-url";
import { base64ToBytes } from "@/lib/composer/image-base64";

/** What an uploaded picture is stored as, until its bytes say otherwise. */
const BOT_PICTURE_MEDIA_TYPE = "image/png";

/**
 * An uploaded bot picture as a `blob:` URL, `null` until its bytes arrive. The
 * bytes are a blob of the bot's trunk chat, read like any chat attachment
 * (`epic.readChatAttachment`): through the tab's host inside a tab, else the
 * host that serves the app's directory of bots. Every member reads it, from
 * any host, since the cloud holds it for the bot's environment.
 */
export function useBotPictureUrl(
  botId: string,
  trunkChatId: string,
  hash: string,
): string | null {
  const tabHostId = use(TabHostContext);
  const directoryHostId = useNotificationResolveHostId();
  const hostId = tabHostId ?? directoryHostId;
  const client = useHostClientForHostId(hostId);
  const fetcher = useMemo(
    (): ScopedImageBytesFetcher => ({
      scopeKey: JSON.stringify(["bot-picture", hostId, botId, trunkChatId]),
      fetch: async (wanted, signal) => {
        if (client === null) {
          throw new Error("No host can read this bot's picture yet.");
        }
        const response = await client.requestWithSignal(
          "epic.readChatAttachment",
          { epicId: botId, chatId: trunkChatId, hash: wanted },
          signal,
        );
        if (!response.ok) {
          throw new Error("This bot's picture is not stored yet.");
        }
        const bytes = base64ToBytes(response.bytesBase64);
        if (bytes === null) {
          throw new Error("This bot's picture could not be read.");
        }
        return { bytes, mediaType: response.mediaType };
      },
    }),
    [botId, client, hostId, trunkChatId],
  );
  return useImageBlobUrl(hash, BOT_PICTURE_MEDIA_TYPE, fetcher);
}
