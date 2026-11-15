/**
 * The surface on the host the tab's store names, as the tab draws it: a
 * rebind of the tab moves it. Its own module so a file of components exports
 * nothing else.
 */
import type { ReactNode } from "react";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import {
  BOT_ID,
  TAB_HOST,
} from "@/components/bots/__tests__/bot-tab-surface-harness";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

export function BotSurfaceOnItsHost(): ReactNode {
  const hostId = useTracySurfaceStore((state) => state.hostId);
  return <BotTabSurface botId={BOT_ID} hostId={hostId ?? TAB_HOST} />;
}
