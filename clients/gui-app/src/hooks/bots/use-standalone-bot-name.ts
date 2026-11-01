import { standaloneBotName } from "@/lib/home-bots/standalone-bot-name";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/** {@link standaloneBotName} against the app's bots model. */
export function useStandaloneBotName(
  botId: string | null,
  name: string,
): string {
  const model = useStandaloneBotsStore((state) => state.model);
  return standaloneBotName(model, botId, name);
}
