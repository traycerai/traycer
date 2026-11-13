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
  partsOf,
  setBotLookSave,
  useBotLookSaveStore,
  withoutParts,
  type BotLookChange,
  type BotLookPart,
  type BotLookSave,
} from "@/stores/bots/bot-look-save-store";

type SendLook = (
  botId: string,
  change: BotLookChange,
) => Promise<BotUpdateAppearanceResponse>;

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
  useBotLookSaveStore.setState((state) => ({
    saves: withoutBot(state.saves, botId),
  }));
}

function withoutBot(
  saves: Readonly<Record<string, BotLookSave>>,
  botId: string,
): Record<string, BotLookSave> {
  return Object.fromEntries(
    Object.entries(saves).filter(([id]) => id !== botId),
  );
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
): Promise<void> {
  await queryClient.cancelQueries(BOT_LIST_READS);
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
 */
async function sendInOrder(
  queryClient: QueryClient,
  send: SendLook,
  botId: string,
  change: BotLookChange,
): Promise<void> {
  let next: BotLookChange | null = change;
  while (next !== null) {
    const sending: BotLookChange = next;
    setBotLookSave(botId, { ...botLookSaveOf(botId), sending, waiting: null });
    const refusal = await send(botId, sending).then(
      async (response) => {
        await keepAnsweredLook(
          queryClient,
          botId,
          response.bot.appearance ?? null,
        );
        return null;
      },
      (error: unknown) =>
        error instanceof Error ? error.message : "The change was not saved.",
    );
    const held = botLookSaveOf(botId);
    // A part chosen again since this save left keeps that later choice.
    const answered = partsOf(sending).filter(
      (part) => held.waiting?.[part] === undefined,
    );
    const refusals: Partial<Record<BotLookPart, string>> = {
      ...held.refusals,
    };
    if (refusal !== null && (openPanels.get(botId) ?? 0) > 0) {
      for (const part of answered) refusals[part] = refusal;
    }
    next = held.waiting;
    settle(botId, {
      chosen: withoutParts(held.chosen, answered),
      sending: null,
      waiting: null,
      refusals,
    });
  }
  invalidateBotLists(queryClient);
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
      const chosen: BotLookSave = {
        ...held,
        chosen: { ...held.chosen, ...change },
        refusals: withoutParts(held.refusals, partsOf(change)),
      };
      if (held.sending !== null) {
        setBotLookSave(botId, {
          ...chosen,
          waiting: { ...held.waiting, ...change },
        });
        return;
      }
      setBotLookSave(botId, chosen);
      void sendInOrder(
        queryClient,
        (id, parts) => mutateAsync({ botId: id, ...parts }),
        botId,
        change,
      );
    },
    saving: (part) =>
      save.sending?.[part] !== undefined || save.waiting?.[part] !== undefined,
    refusal: (part) => save.refusals[part] ?? null,
  };
}
