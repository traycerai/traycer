import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { HomeBotsGroup, HomeBotsModel } from "@/lib/home-bots/bots-model";

/**
 * The order the person gave the channel column (Tracy Bots, decision 151):
 * the sections by environment id, and each section's channels by bot id.
 * Either may be partial or name ids the model no longer carries.
 */
export interface BotColumnArrangement {
  readonly sectionOrder: ReadonlyArray<string>;
  readonly channelOrder: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * The model in the person's order: the sections `sectionOrder` names first,
 * in its order, then the rest in the model's; within a section, the bots its
 * `channelOrder` entry names first, then the rest in the model's. An id the
 * model does not carry is skipped, so a new bot or environment joins at the
 * end of its list and a gone one leaves no gap.
 */
export function arrangeBotsModel(
  model: HomeBotsModel,
  arrangement: BotColumnArrangement,
): HomeBotsModel {
  const groups = orderByIds(
    model.groups,
    arrangement.sectionOrder,
    (group) => group.environmentId,
  ).map((group): HomeBotsGroup => {
    if (!Object.hasOwn(arrangement.channelOrder, group.environmentId)) {
      return group;
    }
    return {
      ...group,
      bots: orderByIds(
        group.bots,
        arrangement.channelOrder[group.environmentId],
        (bot: BotRecord) => bot.botId,
      ),
    };
  });
  return { groups, botCount: model.botCount };
}

function orderByIds<T>(
  items: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
  idOf: (item: T) => string,
): ReadonlyArray<T> {
  if (order.length === 0) return items;
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const placed: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item === undefined) continue;
    placed.push(item);
    byId.delete(id);
  }
  // What is left keeps the model's order: a Map iterates in insertion order.
  return [...placed, ...byId.values()];
}
