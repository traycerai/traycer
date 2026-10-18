import { createElement, lazy } from "react";
import { Bot } from "lucide-react";
import {
  useBotTabsStore,
  type BotTabRecord,
} from "@/stores/bots/bot-tabs-store";
import { botPathname, botRoute } from "@/lib/routes";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import type { TabKindModule } from "@/stores/tabs/types";
import { TAB_KIND_SPLIT_ELIGIBILITY } from "@/stores/tabs/tab-kind-policy";

const botTabSurface = lazy(() =>
  import("@/components/bots/bot-tab-surface").then((module) => ({
    default: module.BotTabSurface,
  })),
);

/**
 * Module for `kind: "bot"` tabs (Tracy Bots). One tab per bot, deep-linkable
 * at `/bot/{botId}`, backed by the bot-tabs store record that carries the
 * host the tab is bound to for life. The surface wraps itself in
 * `TabHostProvider` with that host, so everything under it - the
 * conversation's `chat.subscribe`, the trunk view, `bot.conversation.send` -
 * addresses the bound host and never the app-wide one.
 *
 * Not duplicable and not openable in another window: a second window would
 * need the record (and its host) handed across, which the draft kind does
 * with a dedicated MOVE flow this tab does not have yet. Closing drops the
 * record; the bot itself is untouched.
 */
export const botTabModule: TabKindModule<"bot", BotTabRecord> = {
  kind: "bot",
  build: (source) => ({
    kind: "bot",
    id: source.botId,
    hostId: source.hostId,
    route: botPathname(source.botId),
    name: source.title,
    icon: Bot,
    canDuplicate: false,
    canOpenInNewWindow: false,
    appearance: null,
  }),
  descriptor: {
    kind: "bot",
    surface: {
      render: (tab) =>
        createElement(botTabSurface, { botId: tab.id, hostId: tab.hostId }),
      canonicalRoute: (tab) => tab.route,
      splitEligibility: TAB_KIND_SPLIT_ELIGIBILITY.bot,
      duplication: "forbidden",
      singleton: "per-instance",
      newWindow: "none",
      readinessScope: "tab-host",
      durableState: { owner: "bot-tabs", eviction: "reconstruct" },
    },
    duplicate: () => null,
    resolveIntent: (tab) => botTabIntent(tab.id),
    routeOptions: (intent) => botRoute(intent.botId),
    activate: () => undefined,
    requestClose: (tab, close) => {
      close({ kind: "bot", id: tab.id });
    },
    requiresCloseConfirm: () => false,
    openInNewWindow: () => undefined,
    matchesPath: (tab, pathname) => pathname === tab.route,
  },
};

/** Whether a bot tab record exists for `botId` - the kind's source check. */
export function isOpenBotTab(botId: string): boolean {
  return Object.hasOwn(useBotTabsStore.getState().tabs, botId);
}
