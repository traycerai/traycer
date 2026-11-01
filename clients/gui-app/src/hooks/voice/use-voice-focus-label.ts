import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostClient } from "@/lib/host";
import { useBotRail, type BotRail } from "@/stores/bots/bot-open-thread-store";
import type { VoiceFocus } from "@/stores/voice/voice-session-store";

/** How much of a thread's opening post the focus line shows. */
const THREAD_LABEL_MAX_CHARS = 48;

/** Where the next spoken post goes, in the words the focus line shows. */
export interface VoiceFocusLabel {
  /** The bot's environment; `null` until the lists say. */
  readonly environmentLabel: string | null;
  readonly botTitle: string;
  /** The thread; `null` at the channel's top level. */
  readonly threadLabel: string | null;
}

/**
 * The focus as the strip and the phone view name it: environment › bot ›
 * thread.
 */
export function useVoiceFocusLabel(focus: VoiceFocus): VoiceFocusLabel {
  const appHostId = useEffectiveHostId();
  const appClient = useHostClient();
  const botsSupported = useHostMethodSupport(appHostId, "bot.list") === true;
  const bots = useBotListQuery(appClient, botsSupported);
  const environments = useEnvironmentListQuery(appClient, botsSupported);
  const rail = useBotRail(focus.botId);
  const bot = bots.data?.bots.find((row) => row.botId === focus.botId) ?? null;
  const environmentLabel =
    bot === null
      ? null
      : (environments.data?.environments.find(
          (row) => row.environmentId === bot.environmentId,
        )?.label ?? null);
  return {
    environmentLabel,
    botTitle: bot?.title ?? "Bot",
    threadLabel: threadLabelOf(focus, rail),
  };
}

/**
 * The thread's label: its opening post while the rail remembers the send
 * that opened it, else "Thread"; nothing at the channel's top level.
 */
function threadLabelOf(focus: VoiceFocus, rail: BotRail | null): string | null {
  if (focus.threadId === null) return null;
  if (rail !== null && rail.kind === "thread" && rail.sent !== null) {
    return truncate(rail.sent.text, THREAD_LABEL_MAX_CHARS);
  }
  return "Thread";
}

function truncate(text: string, maxChars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}
