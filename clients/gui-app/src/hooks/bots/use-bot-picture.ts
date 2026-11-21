import { useEffect, useRef, useSyncExternalStore } from "react";
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
 * host serves the method; a new client or a changed answer reads again, and
 * so does the host coming back (`hostReady` turning true), so a read that
 * failed while it was away does not stay failed. A host without the method
 * is never asked. A picture the bot no longer wears
 * is answered as none, so the lists are read again. `model` is `null` until
 * the bots are listed.
 */
export function useBotPictureLoads(
  client: HostClient<HostRpcRegistry> | null,
  supported: boolean,
  hostReady: boolean,
  model: HomeBotsModel | null,
): void {
  const queryClient = useQueryClient();
  // A round ends when its client or its answer about the method does, and
  // when the loader leaves: mounting starts none, so a picture already
  // wanted then is asked for once.
  useEffect(() => retryBotPictures, [client, supported]);
  // Only the host coming back starts a round here; staying ready across
  // renders starts none.
  const wasHostReady = useRef(hostReady);
  useEffect(() => {
    if (hostReady && !wasHostReady.current) retryBotPictures();
    wasHostReady.current = hostReady;
  }, [hostReady]);

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
    // No list yet says nothing of what the bots wear, so nothing is dropped.
    if (model === null) return;
    const wornBy = new Map<string, string>();
    for (const group of model.groups) {
      for (const bot of group.bots) {
        const sha256 = pictureHashOf(bot.appearance ?? null);
        if (sha256 !== null) wornBy.set(bot.botId, sha256);
      }
    }
    keepBotPictures(wornBy);
  }, [model]);
}
