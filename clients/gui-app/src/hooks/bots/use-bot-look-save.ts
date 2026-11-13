import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  BotAppearance,
  BotListResponse,
  BotUpdateAppearanceResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
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
  type BotLookChange,
  type BotLookPart,
  type BotLookSave,
} from "@/stores/bots/bot-look-save-store";

/** Who a run of saves sends as: the person and host its first choice had. */
interface LookSender {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly userId: string | null;
  readonly hostId: string;
  readonly send: (
    botId: string,
    change: BotLookChange,
  ) => Promise<BotUpdateAppearanceResponse>;
}

let runs = 0;

/**
 * Each bot's save now with a host, settled when it is answered or refused. A
 * run that takes a bot over waits for it: the cloud keeps whichever write
 * arrives last, so two must never be on their way at once.
 */
const flights = new Map<string, Promise<unknown>>();

const BOT_LIST_READS = {
  predicate: (query: { readonly queryKey: readonly unknown[] }) =>
    hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list"),
};

/**
 * How many settings panels are open on each bot. A refusal is a panel's to
 * show, so one that arrives with none open is not kept for a later one.
 */
const openPanels = new Map<string, number>();

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

/**
 * Puts the look the cloud answered with into every cached bot list. A read
 * that left before the save was kept could answer after it with the look
 * from before, so those in flight end first.
 */
async function keepAnsweredLook(
  queryClient: QueryClient,
  botId: string,
  look: BotAppearance | null,
  owned: () => boolean,
): Promise<void> {
  await queryClient.cancelQueries(BOT_LIST_READS);
  // Retired while the reads ended: the lists are no longer this run's to write.
  if (!owned()) return;
  queryClient.setQueriesData<BotListResponse>(BOT_LIST_READS, (cached) => {
    if (cached === undefined || look === null) return cached;
    return {
      ...cached,
      bots: cached.bots.map((bot) =>
        bot.botId === botId ? { ...bot, appearance: look } : bot,
      ),
    };
  });
}

/**
 * Sends `change` and, when it is answered, whatever was chosen meanwhile, one
 * save at a time. A part stays chosen until the last save naming it is
 * answered, so an earlier answer never draws over a later choice.
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
  const stopWatching = sender.client?.onChange(() => {
    if (sender.client?.getRequestContextUserId() === sender.userId) return;
    if (owned()) dropBotLookSave(botId);
  });
  try {
    let next: BotLookChange | null = change;
    const earlier = flights.get(botId);
    if (earlier !== undefined) {
      setBotLookSave(botId, { ...botLookSaveOf(botId), sending: change });
      await earlier;
      if (!owned()) return;
      next = { ...change, ...botLookSaveOf(botId).waiting };
    }
    while (next !== null) {
      const sending: BotLookChange = next;
      setBotLookSave(botId, {
        ...botLookSaveOf(botId),
        sending,
        waiting: null,
      });
      const flight = sender.send(botId, sending).then(
        (response) => ({
          look: response.bot.appearance ?? null,
          refusal: null,
        }),
        (error: unknown) => ({
          look: null,
          refusal:
            error instanceof Error
              ? error.message
              : "The change was not saved.",
        }),
      );
      flights.set(botId, flight);
      const answer = await flight;
      if (flights.get(botId) === flight) flights.delete(botId);
      if (!owned()) return;
      if (answer.refusal === null) {
        await keepAnsweredLook(sender.queryClient, botId, answer.look, owned);
        if (!owned()) return;
      }
      const held = botLookSaveOf(botId);
      // A part chosen again since this save left keeps that later choice.
      const answered = partsOf(sending).filter(
        (part) => held.waiting?.[part] === undefined,
      );
      const refusals: Partial<Record<BotLookPart, string>> = {
        ...held.refusals,
      };
      if (answer.refusal !== null && (openPanels.get(botId) ?? 0) > 0) {
        for (const part of answered) refusals[part] = answer.refusal;
      }
      next = held.waiting;
      settle(botId, {
        ...held,
        chosen: withoutParts(held.chosen, answered),
        sending: null,
        waiting: null,
        refusals,
      });
    }
  } finally {
    stopWatching?.();
  }
  invalidateBotLists(sender.queryClient);
}

/** What a bot's settings read and do about its look's saves. */
export interface BotLookSaver {
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
  const save = useBotLookSaveStore(
    (state) => state.saves[botId] ?? NO_BOT_LOOK_SAVE,
  );
  useEffect(() => {
    openPanels.set(botId, (openPanels.get(botId) ?? 0) + 1);
    return () => {
      const open = (openPanels.get(botId) ?? 1) - 1;
      if (open > 0) {
        openPanels.set(botId, open);
        return;
      }
      openPanels.delete(botId);
      const held = botLookSaveOf(botId);
      if (Object.keys(held.refusals).length === 0) return;
      settle(botId, { ...held, refusals: {} });
    };
  }, [botId]);
  return {
    choose: (change) => {
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
      // takes the bot over and, once that run's save has ended, sends its
      // unanswered parts itself, so they are still saved, in order, by a
      // host that can.
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
          hostId,
          send: (id, parts) => mutateAsync({ botId: id, ...parts }),
        },
        botId,
        runs,
        { ...held.sending, ...held.waiting, ...change },
      );
    },
    saving: (part) =>
      save.sending?.[part] !== undefined || save.waiting?.[part] !== undefined,
    refusal: (part) => save.refusals[part] ?? null,
  };
}
