import { useEffect } from "react";
import type {
  BotListResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotListChangedSubscriptionForApp } from "@/hooks/bots/use-bot-list-changed-subscription";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { mainBotIdOf } from "@/lib/bots/bot-main";
import { useHostClient } from "@/lib/host/runtime";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import "@/stores/bots/tracy-entry";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

/** What the bot list says the entry's bot is. */
type TracyResolution =
  | { readonly kind: "unknown" }
  | { readonly kind: "none" }
  | { readonly kind: "bot"; readonly bot: BotRecord };

const UNKNOWN: TracyResolution = { kind: "unknown" };
const NONE: TracyResolution = { kind: "none" };

/**
 * Keeps the fixed Tracy entry (T58) in step with "Show Tracy" and the bot
 * list, once per window. On: the personal environment's main bot gets its
 * tab, bound to this window's host as Home's row opens it, marked as the
 * entry and kept first in the strip. Off, or with no main bot: the entry is
 * released and its tab closed, so Tracy opens from the bots list in an
 * ordinary tab. A list that has not answered changes nothing, so a restored
 * entry stays drawn while it loads. Without bots it reads nothing (see the
 * first effect for what a read off closes).
 */
export function TracyEntryController(): null {
  const show = useSettingsStore((state) => state.showTracy);
  const bots = usePreviewFeature("bots");
  // Closing tabs takes a verdict the record actually carries: a record
  // without the field (a body served below 3.1) reads as off for drawing,
  // never for closing.
  const user = useAuthUser().data ?? null;
  const carriesVerdict = user !== null && user.previewFeatures !== undefined;
  const hostId = useEffectiveHostId();
  const client = useHostClient();
  const supported = useHostMethodSupport(hostId, "bot.list") === true;
  const enabled = show && supported && bots === "on";
  const personal = usePersonalEnvironment(client, enabled);
  const botList = useBotListQuery(client, enabled);
  // The entry is often the only bots surface mounted: a main bot archived or
  // seeded elsewhere refetches the list here too, not only on focus.
  useBotListChangedSubscriptionForApp(enabled);
  const resolution = resolveTracy(
    personal.resolved ? personal.environmentId : null,
    botList.data,
  );
  const bot = resolution.kind === "bot" ? resolution.bot : null;
  const botId = bot?.botId ?? null;
  const title = bot?.title ?? null;

  useEffect(() => {
    // A read off closes every bot tab, the entry's first: nothing in them
    // can answer. Unread, or off from a record carrying no verdict, changes
    // nothing, so a restored entry waits (undrawn) for a real answer rather
    // than closing on every cold start or on an older record's shape.
    if (bots === "off" && carriesVerdict) {
      releaseEveryBotTab();
      return;
    }
    if (bots !== "on") return;
    const store = useBotTabsStore.getState();
    const fixedBotId = store.fixedBotId;
    if (!show) {
      if (fixedBotId !== null) releaseEntry(fixedBotId);
      return;
    }
    if (resolution.kind === "unknown" || hostId === null) return;
    if (fixedBotId !== null && fixedBotId !== botId) releaseEntry(fixedBotId);
    if (botId === null || title === null) return;
    store.openBotTab({ botId, hostId, title });
    store.setFixedBotId(botId);
  }, [botId, bots, carriesVerdict, hostId, resolution.kind, show, title]);

  useEffect(() => {
    // After the change that moved it settles: a reconciliation appends a
    // restored tab, and the move is a transaction of its own.
    const keepFirst = (): void => {
      queueMicrotask(() => {
        const fixedBotId = useBotTabsStore.getState().fixedBotId;
        if (fixedBotId === null) return;
        tabCommandCoordinator.keepSourceRefFirst({
          kind: "bot",
          id: fixedBotId,
        });
      });
    };
    keepFirst();
    const unsubscribeLayout = useTabsStore.subscribe((next, previous) => {
      if (next.items !== previous.items) keepFirst();
    });
    const unsubscribeEntry = useBotTabsStore.subscribe((next, previous) => {
      if (next.fixedBotId !== previous.fixedBotId) keepFirst();
    });
    return () => {
      unsubscribeLayout();
      unsubscribeEntry();
    };
  }, []);

  return null;
}

/** Unlocks first: a locked ref is one the close would refuse to drop. */
function releaseEntry(botId: string): void {
  const store = useBotTabsStore.getState();
  store.setFixedBotId(null);
  store.closeBotTab(botId);
}

function releaseEveryBotTab(): void {
  const store = useBotTabsStore.getState();
  if (store.fixedBotId !== null) releaseEntry(store.fixedBotId);
  for (const botId of Object.keys(useBotTabsStore.getState().tabs)) {
    store.closeBotTab(botId);
  }
}

function resolveTracy(
  personalEnvironmentId: string | null,
  list: BotListResponse | undefined,
): TracyResolution {
  // A host that predates `mainBotIds` cannot say which bot is Tracy.
  if (
    personalEnvironmentId === null ||
    list === undefined ||
    list.mainBotIds === null
  ) {
    return UNKNOWN;
  }
  const botId = mainBotIdOf(list.mainBotIds, personalEnvironmentId);
  const bot = list.bots.find(
    (candidate) => candidate.botId === botId && candidate.archivedAt === null,
  );
  return bot === undefined ? NONE : { kind: "bot", bot };
}
