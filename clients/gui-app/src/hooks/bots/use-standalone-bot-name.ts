import { standaloneBotName } from "@/lib/home-bots/standalone-bot-name";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/** {@link standaloneBotName} against the app's directory. */
export function useStandaloneBotName(
  botId: string | null,
  name: string,
): string {
  const directory = useStandaloneBotsStore((state) => state.directory);
  return standaloneBotName(directory, botId, name);
}
