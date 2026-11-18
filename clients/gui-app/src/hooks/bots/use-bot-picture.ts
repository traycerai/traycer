import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BotAppearance } from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HomeBotsModel } from "@/lib/home-bots/bots-model";
import { invalidateBotLists } from "@/hooks/bots/use-bot-mutations";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  botPictureLink,
  keepBotPictures,
  nextWantedBotPicture,
  retryBotPictures,
  settleBotPictureRead,
  subscribeBotPictures,
  wantBotPicture,
} from "@/lib/bots/bot-picture-cache";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The hash of the picture a look wears, or `null` for any other mark. A look
 * read at an equal method version arrives unparsed, so the mark is checked
 * here.
 */
export function pictureHashOf(look: BotAppearance | null): string | null {
  const mark: unknown = look?.mark;
  if (typeof mark !== "object" || mark === null) return null;
  if (!("kind" in mark) || mark.kind !== "picture") return null;
  if (!("sha256" in mark) || typeof mark.sha256 !== "string") return null;
  return SHA256.test(mark.sha256) ? mark.sha256 : null;
}

/**
 * The link of the picture `botId`'s look wears, once its bytes are held.
 * Drawing it is what asks for it to be read.
 */
export function useBotPictureLink(
  botId: string,
  look: BotAppearance | null,
): string | null {
  const sha256 = pictureHashOf(look);
  useEffect(
    () => (sha256 === null ? undefined : wantBotPicture(sha256, botId)),
    [sha256, botId],
  );
  return useSyncExternalStore(
    subscribeBotPictures,
    () => (sha256 === null ? null : botPictureLink(sha256)),
    () => null,
  );
}

/** The request a disabled read is keyed by; it is never sent. */
const NO_READ = { botId: "", sha256: "" };

/**
 * Reads the pictures that drawn bots want, through the host that serves the
 * directory, one at a time: the smallest fixed number, which leaves the
 * host's requests to the surface the person is using.
 *
 * Each picture is read once for this client and this answer to whether the
 * host serves the method; a new client or a changed answer reads again. A
 * host without the method is never asked. A picture the bot no longer wears
 * is answered as none, so the lists are read again.
 */
export function useBotPictureLoads(
  client: HostClient<HostRpcRegistry> | null,
  supported: boolean,
  model: HomeBotsModel,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    retryBotPictures();
  }, [client, supported]);

  const next = useSyncExternalStore(
    subscribeBotPictures,
    nextWantedBotPicture,
    () => null,
  );
  const { isSuccess, isError, data } = useHostQuery<
    HostRpcRegistry,
    "bot.readPicture"
  >({
    // One entry per round, so a read begun through an earlier client is
    // neither waited on nor taken: it is cancelled with its entry.
    cacheKeyIdentity: [next?.round ?? null],
    client,
    method: "bot.readPicture",
    params:
      next === null ? NO_READ : { botId: next.botId, sha256: next.sha256 },
    options: {
      enabled: supported && next !== null,
      retry: false,
      staleTime: Infinity,
      gcTime: 0,
    },
  });
  useEffect(() => {
    if (next === null) return;
    if (isError) {
      settleBotPictureRead(next, null);
    } else if (isSuccess) {
      // Unparsed at an equal method version, so the answer is read as is.
      if (data.picture === null) invalidateBotLists(queryClient);
      settleBotPictureRead(next, data.picture ?? null);
    }
  }, [next, isSuccess, isError, data, queryClient]);

  useEffect(() => {
    const worn = new Set<string>();
    for (const group of model.groups) {
      for (const bot of group.bots) {
        const sha256 = pictureHashOf(bot.appearance ?? null);
        if (sha256 !== null) worn.add(sha256);
      }
    }
    keepBotPictures(worn);
  }, [model]);
}
