import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  BotListResponse,
  BotUpdateAppearanceResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  HostTransportFailureError,
  mayHaveReachedHost,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { finalRefusalOf } from "@traycer-clients/shared/host-transport/retrying-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  invalidateBotLists,
  useBotUpdateAppearanceMutation,
} from "@/hooks/bots/use-bot-mutations";
import {
  NO_BOT_LOOK_SAVE,
  botLookSaveOf,
  dropBotLookSave,
  partsOf,
  setBotLookSave,
  useBotLookSaveStore,
  withoutParts,
  withoutBot,
  type BotLookChange,
  type BotLookFlight,
  type BotLookPart,
  type BotLookSave,
} from "@/stores/bots/bot-look-save-store";

/**
 * The rule for a bot's look saves:
 * 1. One save for a bot is on its way at a time, and it owns its parts until
 *    it is done; nothing sends parts another save sent.
 * 2. A save certainly not kept (never left, or `FORBIDDEN`) returns its parts
 *    with the message; any other ending is read back from the bot lists.
 * 3. A run belongs to the person and host that began it: another person
 *    retires it unsent, another host waits for its save and sends only what
 *    was chosen and never sent.
 */

/** Who a run of saves sends as: the person and host its first choice had. */
interface LookSender {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly userId: string | null;
  readonly send: (
    botId: string,
    change: BotLookChange,
  ) => Promise<BotUpdateAppearanceResponse>;
}

let runs = 0;

const BOT_LIST_READS = {
  predicate: (query: { readonly queryKey: readonly unknown[] }) =>
    hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list"),
};

function flightOf(botId: string): BotLookFlight | null {
  const { flights } = useBotLookSaveStore.getState();
  return Object.hasOwn(flights, botId) ? flights[botId] : null;
}

function panelsOpenOn(botId: string): number {
  const { panels } = useBotLookSaveStore.getState();
  return Object.hasOwn(panels, botId) ? panels[botId] : 0;
}

/** Drops a bot's entry once it holds nothing: no choice, save or refusal. */
function settle(botId: string, save: BotLookSave): void {
  const idle =
    save.sending === null &&
    save.waiting === null &&
    partsOf(save.chosen).length === 0 &&
    Object.keys(save.refusals).length === 0;
  if (!idle) {
    setBotLookSave(botId, save);
    return;
  }
  dropBotLookSave(botId);
}

const UNSURE = "This may not have been saved.";

/**
 * Why a save was certainly not kept, or `null` when it may have been. Only
 * two endings are certain: the request never left this client, and the cloud
 * refused the person or the host (`FORBIDDEN`). Any other error, a host's
 * plain failure included, can follow a write the cloud kept.
 */
function refusalOf(error: unknown): string | null {
  if (mayHaveReachedHost(error)) return null;
  if (mayHaveReachedHost(finalRefusalOf(error))) return null;
  const certain =
    error instanceof HostTransportFailureError ||
    (error instanceof HostRpcError && error.code === "FORBIDDEN");
  return certain ? error.message : null;
}

/** Whether every cached list that names the bot holds `value` for `part`. */
function listsHold(
  queryClient: QueryClient,
  botId: string,
  part: BotLookPart,
  value: BotLookChange[BotLookPart],
): boolean {
  const looks = queryClient
    .getQueriesData<BotListResponse>(BOT_LIST_READS)
    .flatMap(([, list]) => list?.bots ?? [])
    .filter((bot) => bot.botId === botId)
    .map((bot) => bot.appearance ?? null);
  return (
    looks.length > 0 &&
    looks.every(
      (look) =>
        JSON.stringify(look?.[part] ?? null) === JSON.stringify(value ?? null),
    )
  );
}

/**
 * Sends `parts` and takes in how the save ended, for whichever run holds the
 * bot by then. A part chosen again since keeps that later choice.
 *
 * - Kept: the lists take the answered look. A read that left before the save
 *   could answer after it with the look from before, so those in flight end
 *   first.
 * - Certainly not kept: the parts return to the held look, with the message.
 * - Anything else: the lists are read, and a part they do not hold says so.
 *
 * `live` turns false when the person who chose is no longer the one signed
 * in: nothing of theirs is written after that.
 */
async function fly(
  sender: LookSender,
  botId: string,
  parts: BotLookChange,
  live: () => boolean,
): Promise<void> {
  const { queryClient } = sender;
  const end = await sender.send(botId, parts).then(
    (response) => ({ look: response.bot.appearance ?? null, error: null }),
    (error: unknown) => ({ look: null, error }),
  );
  if (!live()) return;
  const refusal = end.error === null ? null : refusalOf(end.error);
  if (end.error === null) {
    await queryClient.cancelQueries(BOT_LIST_READS);
    if (!live()) return;
    const { look } = end;
    queryClient.setQueriesData<BotListResponse>(BOT_LIST_READS, (cached) => {
      if (cached === undefined || look === null) return cached;
      return {
        ...cached,
        bots: cached.bots.map((bot) =>
          bot.botId === botId ? { ...bot, appearance: look } : bot,
        ),
      };
    });
  } else if (refusal === null) {
    await queryClient.invalidateQueries(BOT_LIST_READS);
    if (!live()) return;
  }
  const held = botLookSaveOf(botId);
  const later = {
    ...(held.sending === parts ? null : held.sending),
    ...held.waiting,
  };
  const ended = partsOf(parts).filter((part) => later[part] === undefined);
  const refusals: Partial<Record<BotLookPart, string>> = { ...held.refusals };
  if (end.error !== null && panelsOpenOn(botId) > 0) {
    for (const part of ended) {
      if (refusal !== null) refusals[part] = refusal;
      else if (!listsHold(queryClient, botId, part, parts[part])) {
        refusals[part] = UNSURE;
      }
    }
  }
  settle(botId, {
    ...held,
    chosen: withoutParts(held.chosen, ended),
    refusals,
  });
}

/**
 * Sends `change` and, when that save is done, whatever was chosen meanwhile,
 * one save at a time. A part stays chosen until the last save naming it is
 * done, so an earlier answer never draws over a later choice.
 *
 * The run belongs to the person who started it. When the client signs in as
 * anyone else the run is retired at once: its choices stop being drawn, and
 * what it had waiting is never sent as the next person.
 */
async function sendInOrder(
  sender: LookSender,
  botId: string,
  run: number,
  change: BotLookChange,
): Promise<void> {
  const owned = (): boolean => botLookSaveOf(botId).run === run;
  let signedIn = true;
  const stopWatching = sender.client?.onChange(() => {
    if (sender.client?.getRequestContextUserId() === sender.userId) return;
    signedIn = false;
    if (owned()) dropBotLookSave(botId);
  });
  try {
    let next: BotLookChange = change;
    const earlier = flightOf(botId);
    if (earlier !== null) {
      // Marked as sending so later choices wait behind this run.
      setBotLookSave(botId, { ...botLookSaveOf(botId), sending: change });
      await earlier.done;
      if (!owned()) return;
      next = { ...change, ...botLookSaveOf(botId).waiting };
    }
    while (partsOf(next).length > 0) {
      const parts = next;
      setBotLookSave(botId, {
        ...botLookSaveOf(botId),
        sending: parts,
        waiting: null,
      });
      const flight: BotLookFlight = {
        parts,
        done: fly(sender, botId, parts, () => signedIn),
      };
      useBotLookSaveStore.setState((state) => ({
        flights: { ...state.flights, [botId]: flight },
      }));
      await flight.done;
      if (flightOf(botId) === flight) {
        useBotLookSaveStore.setState((state) => ({
          flights: withoutBot(state.flights, botId),
        }));
      }
      if (!owned()) return;
      const held = botLookSaveOf(botId);
      next = held.waiting ?? {};
      settle(botId, { ...held, sending: null, waiting: null });
    }
  } finally {
    stopWatching?.();
  }
  invalidateBotLists(sender.queryClient);
}

/** What a bot's settings read and do about its look's saves. */
export interface BotLookSaver {
  /**
   * Whether the host can change a bot's look at all. Where it cannot, the
   * settings draw nothing and `choose` does nothing.
   */
  readonly supported: boolean;
  /** Draws `change` at once and saves it after any save under way. */
  readonly choose: (change: BotLookChange) => void;
  /** Whether a save naming `part` has not been answered. */
  readonly saving: (part: BotLookPart) => boolean;
  /** Why `part`'s last save was refused; `null` when it was not. */
  readonly refusal: (part: BotLookPart) => string | null;
}

/**
 * A bot's look as its settings change it: a choice shows the moment it is
 * made, on every picture of the bot, and is saved behind it through the host
 * behind `client`. A refused part goes back to the look the bot holds.
 */
export function useBotLookSaver(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string,
  botId: string,
): BotLookSaver {
  const queryClient = useQueryClient();
  const { mutateAsync } = useBotUpdateAppearanceMutation(client);
  const supported =
    useHostMethodSupport(hostId, "bot.updateAppearance") === true;
  const save = useBotLookSaveStore(
    (state) => state.saves[botId] ?? NO_BOT_LOOK_SAVE,
  );
  // A save taken over from another host is still on its way: its parts are
  // in neither `sending` nor `waiting` of the run that holds the bot now.
  const flight = useBotLookSaveStore((state) =>
    Object.hasOwn(state.flights, botId) ? state.flights[botId] : null,
  );
  useEffect(() => {
    const move = (by: number): number => {
      const open = panelsOpenOn(botId) + by;
      useBotLookSaveStore.setState((state) => ({
        panels:
          open > 0
            ? { ...state.panels, [botId]: open }
            : withoutBot(state.panels, botId),
      }));
      return open;
    };
    move(1);
    return () => {
      if (move(-1) > 0) return;
      const held = botLookSaveOf(botId);
      if (Object.keys(held.refusals).length === 0) return;
      settle(botId, { ...held, refusals: {} });
    };
  }, [botId]);
  return {
    supported,
    choose: (change) => {
      if (!supported) return;
      const held = botLookSaveOf(botId);
      const refusals = withoutParts(held.refusals, partsOf(change));
      const chosen = { ...held.chosen, ...change };
      if (held.sending !== null && held.hostId === hostId) {
        setBotLookSave(botId, {
          ...held,
          chosen,
          refusals,
          waiting: { ...held.waiting, ...change },
        });
        return;
      }
      // Nothing is on its way, or a run through another host is: this host
      // takes the bot over and sends once that run's save has ended.
      runs += 1;
      setBotLookSave(botId, {
        chosen,
        refusals,
        sending: null,
        waiting: null,
        run: runs,
        hostId,
      });
      void sendInOrder(
        {
          queryClient,
          client,
          userId: client?.getRequestContextUserId() ?? null,
          send: (id, parts) => mutateAsync({ botId: id, ...parts }),
        },
        botId,
        runs,
        {
          // What an earlier run chose and never sent. Parts of the save
          // now with a host stay that save's.
          ...(held.sending === flightOf(botId)?.parts ? null : held.sending),
          ...held.waiting,
          ...change,
        },
      );
    },
    saving: (part) =>
      flight?.parts[part] !== undefined ||
      save.sending?.[part] !== undefined ||
      save.waiting?.[part] !== undefined,
    refusal: (part) => save.refusals[part] ?? null,
  };
}
