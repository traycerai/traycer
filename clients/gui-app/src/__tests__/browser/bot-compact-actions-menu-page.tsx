import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { FixtureApp } from "./bot-compact-actions-menu-frame";
import { HOST_ID, useSelectedBotId } from "./bot-compact-actions-menu-host";

function BotTab() {
  return <BotTabSurface botId={useSelectedBotId()} hostId={HOST_ID} />;
}

export function CompactActionsFixture() {
  return (
    <FixtureApp>
      <BotTab />
    </FixtureApp>
  );
}
