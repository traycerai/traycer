import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  BotAppearance,
  BotListResponse,
  BotUpdateAppearanceResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mayHaveReachedHost } from "@traycer-clients/shared/host-transport/host-messenger";
import { finalRefusalOf } from "@traycer-clients/shared/host-transport/retrying-messenger";
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
 * How a save ended. `unknown` is a save that may have reached the host with
 * no answer back: it may be kept later, so it is neither saved nor refused.
 */
type FlightEnd =
  | { readonly kind: "saved"; readonly look: BotAppearance | null }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unknown" };

/** A save now with a host: the parts it carries, and how it ends. */
interface Flight {
  readonly parts: BotLookChange;
  readonly end: Promise<FlightEnd>;
}

/**
 * Each bot's save now with a host. A run that takes a bot over waits for it
 * to end before sending, so an answered or refused save never lands after a
 * later one. Nothing here orders a save whose end is unknown: only the cloud
 * could, and it keeps whichever write arrives last.
 */
const flights = new Map<string, Flight>();

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

const UNSURE = "This may not have been saved.";

function flightEndOf(error: unknown): FlightEnd {
  if (mayHaveReachedHost(finalRefusalOf(error)) || mayHaveReachedHost(error)) {
    return { kind: "unknown" };
  }
  return {
    kind: "refused",
    message:
      error instanceof Error ? error.message : "The change was not saved.",
  };
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

/** A run of saves: who sends it, for which bot, and how it knows it is live. */
interface LookRun {
  readonly sender: LookSender;
  readonly botId: string;
  /** Whether the bot's entry is still this run's. */
  readonly owned: () => boolean;
}

/**
 * Takes in how a save ended and answers the parts the next save must carry
 * again. A part chosen again since the save left keeps that later choice.
 *
 * - Saved: the lists take the answered look and the parts stop being drawn
 *   over them.
 * - Refused: a save this run sent returns its parts to the held look, with
 *   the message. One inherited from another host's run is carried again:
 *   that host could not save it, and this one may.
 * - Unknown: the parts are not sent again, as the first write may still
 *   land. The lists are read, and a part they do not hold says so.
 */
async function absorb(
  run: LookRun,
  flight: Flight,
  end: FlightEnd,
  inherited: boolean,
): Promise<BotLookChange> {
  const { queryClient } = run.sender;
  const { botId, owned } = run;
  if (end.kind === "saved") {
    await keepAnsweredLook(queryClient, botId, end.look, owned);
  }
  if (end.kind === "unknown") {
    await queryClient.invalidateQueries(BOT_LIST_READS);
  }
  if (!owned()) return {};
  const held = botLookSaveOf(botId);
  const later = { ...(inherited ? held.sending : null), ...held.waiting };
  const ended = partsOf(flight.parts).filter(
    (part) => later[part] === undefined,
  );
  if (end.kind === "refused" && inherited) {
    return withoutParts(flight.parts, partsOf(later));
  }
  const refusals: Partial<Record<BotLookPart, string>> = { ...held.refusals };
  if ((openPanels.get(botId) ?? 0) > 0) {
    for (const part of ended) {
      if (end.kind === "refused") refusals[part] = end.message;
      if (
        end.kind === "unknown" &&
        !listsHold(queryClient, botId, part, flight.parts[part])
      ) {
        refusals[part] = UNSURE;
      }
    }
  }
  setBotLookSave(botId, {
    ...held,
    chosen: withoutParts(held.chosen, ended),
    refusals,
  });
  return {};
}

/**
 * Sends `change` and, when it is answered, whatever was chosen meanwhile, one
 * save at a time. A part stays chosen until the last save naming it has
 * ended, so an earlier answer never draws over a later choice.
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
  const live: LookRun = { sender, botId, owned };
  const stopWatching = sender.client?.onChange(() => {
    if (sender.client?.getRequestContextUserId() === sender.userId) return;
    if (owned()) dropBotLookSave(botId);
  });
  try {
    let next: BotLookChange = change;
    const earlier = flights.get(botId);
    if (earlier !== undefined) {
      // Marked as sending so later choices wait behind this run.
      setBotLookSave(botId, { ...botLookSaveOf(botId), sending: change });
      const again = await absorb(live, earlier, await earlier.end, true);
      if (!owned()) return;
      next = { ...again, ...change, ...botLookSaveOf(botId).waiting };
    }
    while (partsOf(next).length > 0) {
      const parts = next;
      setBotLookSave(botId, {
        ...botLookSaveOf(botId),
        sending: parts,
        waiting: null,
      });
      const flight: Flight = {
        parts,
        end: sender.send(botId, parts).then(
          (response): FlightEnd => ({
            kind: "saved",
            look: response.bot.appearance ?? null,
          }),
          flightEndOf,
        ),
      };
      flights.set(botId, flight);
      const end = await flight.end;
      if (flights.get(botId) === flight) flights.delete(botId);
      if (!owned()) return;
      await absorb(live, flight, end, false);
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
          hostId,
          send: (id, parts) => mutateAsync({ botId: id, ...parts }),
        },
        botId,
        runs,
        {
          // What an earlier run chose and never sent; its save now with a
          // host is taken in when it ends.
          ...(held.sending === flights.get(botId)?.parts ? null : held.sending),
          ...held.waiting,
          ...change,
        },
      );
    },
    saving: (part) =>
      save.sending?.[part] !== undefined || save.waiting?.[part] !== undefined,
    refusal: (part) => save.refusals[part] ?? null,
  };
}
