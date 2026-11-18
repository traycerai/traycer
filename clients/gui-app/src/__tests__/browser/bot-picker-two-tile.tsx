import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { FixtureApp } from "./bot-compact-actions-menu-frame";
import { HOST_ID, useSelectedBotId } from "./bot-compact-actions-menu-host";

/**
 * The real Tracy surface with its memory rail open, which is what makes the
 * installed app's shell count a second tile: the rail drawn beside the channel
 * reports itself, and the form resolves for two tiles. Nothing forces the form
 * or the trigger; the case's width decides. The strip is collapsed (the rail)
 * unless the page is asked for `?strip=expanded`.
 */
const expanded =
  new URLSearchParams(window.location.search).get("strip") === "expanded";
useSideTabStripStore.setState({ collapsed: !expanded });

export function TwoTileSurface() {
  const botId = useSelectedBotId();
  useEffect(() => {
    useBotOpenThreadStore
      .getState()
      .setRail(botId, { kind: "memory", back: null });
  }, [botId]);
  return <BotTabSurface botId={botId} hostId={HOST_ID} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("the fixture needs a #root");
createRoot(root).render(
  <FixtureApp>
    <TwoTileSurface />
  </FixtureApp>,
);
