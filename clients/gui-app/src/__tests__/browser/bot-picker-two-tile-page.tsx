import { useEffect } from "react";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { FixtureApp } from "./bot-compact-actions-menu-frame";
import { HOST_ID, useSelectedBotId } from "./bot-compact-actions-menu-host";

/**
 * The real Tracy surface with its memory rail open, which is what makes the
 * installed app's shell count a second tile: the rail drawn beside the channel
 * reports itself, and the form resolves for two tiles. Nothing forces the form
 * or the trigger; the case's width decides.
 */
function TwoTileSurface() {
  const botId = useSelectedBotId();
  useEffect(() => {
    useBotOpenThreadStore
      .getState()
      .setRail(botId, { kind: "memory", back: null });
  }, [botId]);
  return <BotTabSurface botId={botId} hostId={HOST_ID} />;
}

export function TwoTileFixture() {
  return (
    <FixtureApp>
      <TwoTileSurface />
    </FixtureApp>
  );
}
